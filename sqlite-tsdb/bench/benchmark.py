#!/usr/bin/env python3
import argparse
import json
import math
import os
import sqlite3
import statistics
import struct
import tempfile
import time
from pathlib import Path
from typing import Callable, Iterable


def sample_batch(series_count: int, point: int, step_ms: int):
    base = 1_700_000_000_000
    ts = base + point * step_ms
    rows = []
    for series in range(1, series_count + 1):
        kind = series % 4
        if kind == 0:
            value = float(series)
        elif kind == 1:
            value = float(point)
        elif kind == 2:
            value = float((point // 20) % 2)
        else:
            value = math.sin(point / 100.0) * series
        rows.append((series, ts, value))
    return rows


def packed_batch(rows: list[tuple[int, int, float]]) -> bytearray:
    data = bytearray(16 + len(rows) * 24)
    struct.pack_into("<4sHHII", data, 0, b"TSI1", 1, 24, len(rows), 0)
    for index, row in enumerate(rows):
        struct.pack_into("<qqd", data, 16 + index * 24, *row)
    return data


def configure(db: sqlite3.Connection) -> None:
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute("PRAGMA cache_size=-16384")


def timed(function: Callable[[], object]) -> tuple[float, object]:
    started = time.perf_counter()
    result = function()
    return time.perf_counter() - started, result


def database_bytes(db: sqlite3.Connection) -> tuple[int, int]:
    page_count = db.execute("PRAGMA page_count").fetchone()[0]
    free_count = db.execute("PRAGMA freelist_count").fetchone()[0]
    page_size = db.execute("PRAGMA page_size").fetchone()[0]
    return page_count * page_size, (page_count - free_count) * page_size


def query_benchmark(
    db: sqlite3.Connection,
    series_ids: list[int],
    lower: int,
    upper: int,
    repeats: int,
) -> tuple[float, int]:
    placeholders = ",".join("?" for _ in series_ids)
    sql = (
        "SELECT series_id,ts,value FROM samples "
        f"WHERE series_id IN ({placeholders}) AND ts>=? AND ts<=? "
        "ORDER BY series_id,ts"
    )
    params = [*series_ids, lower, upper]
    durations = []
    row_count = 0
    for _ in range(repeats):
        duration, rows = timed(lambda: db.execute(sql, params).fetchall())
        durations.append(duration)
        row_count = len(rows)
    return statistics.median(durations), row_count


def packed_query_benchmark(
    db: sqlite3.Connection,
    series_ids: list[int],
    lower: int,
    upper: int,
    repeats: int,
) -> tuple[float, int, int]:
    placeholders = ",".join("?" for _ in series_ids)
    sql = (
        "SELECT series_id,tsdb_pack(ts,value) FROM samples "
        f"WHERE series_id IN ({placeholders}) AND ts>=? AND ts<=? "
        "GROUP BY series_id ORDER BY series_id"
    )
    params = [*series_ids, lower, upper]
    durations = []
    point_count = 0
    packed_bytes = 0
    for _ in range(repeats):
        duration, rows = timed(lambda: db.execute(sql, params).fetchall())
        durations.append(duration)
        point_count = sum(struct.unpack_from("<I", row[1], 8)[0] for row in rows)
        packed_bytes = sum(len(row[1]) for row in rows)
    return statistics.median(durations), point_count, packed_bytes


def build_row_database(
    path: Path,
    extension: str,
    series_count: int,
    points_per_series: int,
    step_ms: int,
) -> tuple[sqlite3.Connection, float]:
    db = sqlite3.connect(path)
    db.enable_load_extension(True)
    db.load_extension(extension)
    db.enable_load_extension(False)
    configure(db)
    db.executescript(
        "CREATE TABLE samples("
        "series_id INTEGER NOT NULL,ts INTEGER NOT NULL,value REAL NOT NULL,"
        "PRIMARY KEY(series_id,ts)) WITHOUT ROWID;"
        "CREATE INDEX samples_ts ON samples(ts);"
    )

    def ingest() -> None:
        for point in range(points_per_series):
            db.execute("BEGIN")
            db.executemany(
                "INSERT INTO samples(series_id,ts,value) VALUES(?,?,?) "
                "ON CONFLICT(series_id,ts) DO UPDATE SET value=excluded.value",
                sample_batch(series_count, point, step_ms),
            )
            db.commit()

    ingest_seconds, _ = timed(ingest)
    return db, ingest_seconds


def build_tsdb_database(
    path: Path,
    extension: str,
    series_count: int,
    points_per_series: int,
    step_ms: int,
) -> tuple[sqlite3.Connection, float, float]:
    db = sqlite3.connect(path)
    db.enable_load_extension(True)
    db.load_extension(extension)
    db.enable_load_extension(False)
    configure(db)
    db.execute(
        "CREATE VIRTUAL TABLE samples USING tsdb("
        "block_span_ms=21600000,max_block_points=2048)"
    )

    def ingest() -> None:
        sql = (
            "INSERT INTO samples(series_id,ts,value) "
            "SELECT series_id,ts,value FROM tsdb_batch(?)"
        )
        for point in range(points_per_series):
            rows = sample_batch(series_count, point, step_ms)
            db.execute(sql, (packed_batch(rows),))
            db.commit()

    ingest_seconds, _ = timed(ingest)
    base = 1_700_000_000_000
    cutoff = base + points_per_series * step_ms + 21_600_000

    def compact() -> None:
        db.execute(
            "INSERT INTO samples(control,arg1,arg2) "
            "VALUES('compact-before',?,1000000)",
            (cutoff,),
        )
        db.commit()

    compact_seconds, _ = timed(compact)
    return db, ingest_seconds, compact_seconds


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("extension")
    parser.add_argument("--series", type=int, default=250)
    parser.add_argument("--points", type=int, default=2880)
    parser.add_argument("--step-ms", type=int, default=30000)
    parser.add_argument("--query-series", type=int, default=10)
    parser.add_argument("--query-repeats", type=int, default=7)
    parser.add_argument("--json")
    args = parser.parse_args()
    extension = os.path.abspath(args.extension)
    base = 1_700_000_000_000
    end = base + (args.points - 1) * args.step_ms
    query_lower = max(base, end - 24 * 60 * 60 * 1000)
    query_series = list(range(1, min(args.series, args.query_series) + 1))

    with tempfile.TemporaryDirectory(prefix="sqlite-tsdb-bench-") as directory:
        root = Path(directory)
        row_db, row_ingest = build_row_database(
            root / "row.sqlite",
            extension,
            args.series,
            args.points,
            args.step_ms,
        )
        tsdb_db, tsdb_ingest, compact = build_tsdb_database(
            root / "tsdb.sqlite",
            extension,
            args.series,
            args.points,
            args.step_ms,
        )
        row_db.execute("VACUUM")
        tsdb_db.execute("VACUUM")
        row_db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        tsdb_db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

        row_file_bytes, row_used_bytes = database_bytes(row_db)
        tsdb_file_bytes, tsdb_used_bytes = database_bytes(tsdb_db)
        row_query, row_query_rows = query_benchmark(
            row_db,
            query_series,
            query_lower,
            end,
            args.query_repeats,
        )
        tsdb_query, tsdb_query_rows = query_benchmark(
            tsdb_db,
            query_series,
            query_lower,
            end,
            args.query_repeats,
        )
        if row_query_rows != tsdb_query_rows:
            raise RuntimeError(
                f"query row mismatch: row={row_query_rows}, tsdb={tsdb_query_rows}"
            )
        row_packed_query, row_packed_points, row_packed_bytes = packed_query_benchmark(
            row_db,
            query_series,
            query_lower,
            end,
            args.query_repeats,
        )
        tsdb_packed_query, tsdb_packed_points, tsdb_packed_bytes = packed_query_benchmark(
            tsdb_db,
            query_series,
            query_lower,
            end,
            args.query_repeats,
        )
        if row_packed_points != tsdb_packed_points or row_packed_bytes != tsdb_packed_bytes:
            raise RuntimeError("packed query mismatch")

        retention_cutoff = base + ((args.points // 2) * args.step_ms)

        def row_retention() -> None:
            row_db.execute("DELETE FROM samples WHERE ts < ?", (retention_cutoff,))
            row_db.commit()

        def tsdb_retention() -> None:
            tsdb_db.execute(
                "INSERT INTO samples(control,arg1) VALUES('delete-before',?)",
                (retention_cutoff,),
            )
            tsdb_db.commit()

        row_retention_seconds, _ = timed(row_retention)
        tsdb_retention_seconds, _ = timed(tsdb_retention)
        row_remaining = row_db.execute("SELECT count(*) FROM samples").fetchone()[0]
        tsdb_remaining = tsdb_db.execute("SELECT count(*) FROM samples").fetchone()[0]
        if row_remaining != tsdb_remaining:
            raise RuntimeError(
                f"retention mismatch: row={row_remaining}, tsdb={tsdb_remaining}"
            )
        row_integrity = row_db.execute("PRAGMA integrity_check").fetchone()[0]
        tsdb_integrity = tsdb_db.execute("PRAGMA integrity_check").fetchone()[0]
        if row_integrity != "ok" or tsdb_integrity != "ok":
            raise RuntimeError(
                f"integrity failure: row={row_integrity}, tsdb={tsdb_integrity}"
            )

        sample_count = args.series * args.points
        result = {
            "series": args.series,
            "points_per_series": args.points,
            "sample_count": sample_count,
            "row": {
                "ingest_seconds": row_ingest,
                "query_median_seconds": row_query,
                "packed_query_median_seconds": row_packed_query,
                "packed_query_bytes": row_packed_bytes,
                "retention_seconds": row_retention_seconds,
                "file_bytes": row_file_bytes,
                "used_bytes": row_used_bytes,
            },
            "tsdb": {
                "ingest_seconds": tsdb_ingest,
                "compact_seconds": compact,
                "query_median_seconds": tsdb_query,
                "packed_query_median_seconds": tsdb_packed_query,
                "packed_query_bytes": tsdb_packed_bytes,
                "retention_seconds": tsdb_retention_seconds,
                "file_bytes": tsdb_file_bytes,
                "used_bytes": tsdb_used_bytes,
            },
            "ratios": {
                "ingest_tsdb_over_row": tsdb_ingest / row_ingest,
                "query_tsdb_over_row": tsdb_query / row_query,
                "packed_query_tsdb_over_row": tsdb_packed_query / row_packed_query,
                "retention_tsdb_over_row": tsdb_retention_seconds
                / row_retention_seconds,
                "storage_tsdb_over_row": tsdb_used_bytes / row_used_bytes,
            },
        }
        print(json.dumps(result, indent=2))
        if args.json:
            Path(args.json).write_text(json.dumps(result, indent=2) + "\n")
        row_db.close()
        tsdb_db.close()


if __name__ == "__main__":
    main()
