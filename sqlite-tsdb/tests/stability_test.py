#!/usr/bin/env python3
import argparse
import math
import os
import random
import sqlite3
import struct
import tempfile
from pathlib import Path


def float_bits(value: float) -> bytes:
    return struct.pack("<d", value)


def random_value(rng: random.Random) -> float:
    choice = rng.randrange(20)
    if choice == 0:
        return -0.0
    if choice == 1:
        return math.inf
    if choice == 2:
        return -math.inf
    if choice < 8:
        return float(rng.randrange(-1000, 1001))
    return rng.uniform(-1_000_000.0, 1_000_000.0)


def encode_batch(rows: list[tuple[int, int, float]]) -> bytearray:
    batch = bytearray(16 + len(rows) * 24)
    struct.pack_into("<4sHHII", batch, 0, b"TSI1", 1, 24, len(rows), 0)
    for index, row in enumerate(rows):
        struct.pack_into("<qqd", batch, 16 + index * 24, *row)
    return batch


def open_database(path: str, extension: str) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.enable_load_extension(True)
    db.load_extension(extension)
    db.enable_load_extension(False)
    return db


def actual_rows(
    db: sqlite3.Connection,
    series_ids: list[int] | None = None,
    lower: int = 0,
    upper: int = (1 << 63) - 1,
    context: str = "",
) -> list[tuple[int, int, bytes]]:
    params: list[int] = []
    where = ["ts >= ?", "ts <= ?"]
    params.extend([lower, upper])
    if series_ids:
        where.append(f"series_id IN ({','.join('?' for _ in series_ids)})")
        params.extend(series_ids)
    sql = (
        "SELECT series_id, ts, value FROM samples "
        f"WHERE {' AND '.join(where)} ORDER BY series_id, ts"
    )
    cursor = db.execute(sql, params)
    result = []
    for row in cursor:
        if len(row) != 3:
            retry = db.execute(sql, params).fetchmany(3)
            shadow = {
                "head": db.execute("SELECT count(*) FROM samples_head").fetchone()[0],
                "blocks": db.execute("SELECT count(*) FROM samples_blocks").fetchone()[0],
            }
            raise AssertionError(
                f"virtual row has {len(row)} columns; {context}; "
                f"description={cursor.description}; sql={sql}; params={params}; "
                f"row={row!r}; retry={retry!r}; shadow={shadow}"
            )
        series, ts, value = row
        result.append((series, ts, float_bits(value)))
    return result


def expected_rows(
    model: dict[tuple[int, int], float],
    series_ids: list[int] | None = None,
    lower: int = 0,
    upper: int = (1 << 63) - 1,
) -> list[tuple[int, int, bytes]]:
    selected = set(series_ids) if series_ids else None
    rows = []
    for (series, ts), value in model.items():
        if selected is not None and series not in selected:
            continue
        if lower <= ts <= upper:
            rows.append((series, ts, float_bits(value)))
    return sorted(rows)


def assert_matches(
    db: sqlite3.Connection,
    model: dict[tuple[int, int], float],
    rng: random.Random,
    context: str = "",
) -> None:
    if rng.randrange(3) == 0:
        series_ids = sorted(rng.sample(range(1, 21), rng.randrange(1, 6)))
    else:
        series_ids = None
    lower = rng.randrange(0, 180_000)
    upper = rng.randrange(lower, 220_001)
    actual = actual_rows(db, series_ids, lower, upper, context)
    expected = expected_rows(model, series_ids, lower, upper)
    if actual != expected:
        raise AssertionError(
            f"range mismatch {context} series={series_ids} range={lower}..{upper}\n"
            f"actual={actual[:20]}\nexpected={expected[:20]}"
        )


def run_seed(extension: str, seed: int, operations: int) -> None:
    rng = random.Random(seed)
    model: dict[tuple[int, int], float] = {}
    with tempfile.TemporaryDirectory(prefix="sqlite-tsdb-stability-") as directory:
        path = str(Path(directory) / "metrics.sqlite")
        db = open_database(path, extension)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=NORMAL")
        db.execute(
            "CREATE VIRTUAL TABLE samples USING tsdb("
            "block_span_ms=10000,max_block_points=64)"
        )

        for operation in range(operations):
            choice = rng.randrange(100)
            if choice < 58:
                series = rng.randrange(1, 21)
                ts = rng.randrange(0, 2201) * 100
                value = random_value(rng)
                db.execute(
                    "INSERT INTO samples(series_id,ts,value) VALUES(?,?,?)",
                    (series, ts, value),
                )
                model[(series, ts)] = value
            elif choice < 68:
                rows = []
                for _ in range(rng.randrange(1, 20)):
                    series = rng.randrange(1, 21)
                    ts = rng.randrange(0, 2201) * 100
                    value = random_value(rng)
                    rows.append((series, ts, value))
                    model[(series, ts)] = value
                db.execute(
                    "INSERT INTO samples(series_id,ts,value) "
                    "SELECT series_id,ts,value FROM tsdb_batch(?)",
                    (encode_batch(rows),),
                )
            elif choice < 78:
                cutoff = rng.randrange(1, 23) * 10_000
                db.execute(
                    "INSERT INTO samples(control,arg1,arg2) "
                    "VALUES('compact-before',?,?)",
                    (cutoff, rng.randrange(1, 20)),
                )
            elif choice < 85:
                cutoff = rng.randrange(0, 2201) * 100
                db.execute(
                    "INSERT INTO samples(control,arg1) VALUES('delete-before',?)",
                    (cutoff,),
                )
                model = {
                    key: value for key, value in model.items() if key[1] >= cutoff
                }
            elif choice < 93:
                assert_matches(db, model, rng, f"operation={operation} query")
                series = rng.randrange(1, 21)
                packed = db.execute(
                    "SELECT tsdb_pack(ts,value) FROM samples WHERE series_id=?",
                    (series,),
                ).fetchone()[0]
                expected_count = sum(1 for key in model if key[0] == series)
                if expected_count == 0:
                    if packed is not None:
                        raise AssertionError("empty series returned a packed block")
                elif struct.unpack_from("<I", packed, 8)[0] != expected_count:
                    raise AssertionError("packed result count mismatch")
            elif choice < 97:
                before = dict(model)
                db.commit()
                db.execute("BEGIN")
                for _ in range(5):
                    series = rng.randrange(1, 21)
                    ts = rng.randrange(0, 2201) * 100
                    value = random_value(rng)
                    db.execute(
                        "INSERT INTO samples(series_id,ts,value) VALUES(?,?,?)",
                        (series, ts, value),
                    )
                db.rollback()
                model = before
            else:
                db.commit()
                db.close()
                db = open_database(path, extension)
                assert_matches(db, model, rng, f"operation={operation} reopen")

            if operation % 100 == 0:
                db.commit()
                assert_matches(db, model, rng, f"operation={operation} checkpoint")

        db.commit()
        assert actual_rows(db) == expected_rows(model)
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise AssertionError(f"integrity_check failed: {integrity}")
        db.close()

        db = open_database(path, extension)
        assert actual_rows(db) == expected_rows(model)
        db.close()


def assert_corruption_detected(extension: str) -> None:
    db = open_database(":memory:", extension)
    db.execute(
        "CREATE VIRTUAL TABLE samples USING tsdb("
        "block_span_ms=1000,max_block_points=64)"
    )
    db.executemany(
        "INSERT INTO samples(series_id,ts,value) VALUES(1,?,?)",
        [(ts, float(ts)) for ts in range(0, 1000, 100)],
    )
    db.execute(
        "INSERT INTO samples(control,arg1,arg2) "
        "VALUES('compact-before',1000,10)"
    )
    payload = bytearray(db.execute("SELECT payload FROM samples_blocks").fetchone()[0])
    payload[-1] ^= 0x80
    db.execute("UPDATE samples_blocks SET payload=?", (payload,))
    try:
        db.execute("SELECT * FROM samples").fetchall()
    except sqlite3.DatabaseError:
        pass
    else:
        raise AssertionError("corrupt block was accepted")
    db.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("extension")
    parser.add_argument("--seeds", type=int, default=5)
    parser.add_argument("--start-seed", type=int, default=0)
    parser.add_argument("--operations", type=int, default=1000)
    args = parser.parse_args()
    extension = os.path.abspath(args.extension)

    assert_corruption_detected(extension)
    for seed in range(args.start_seed, args.start_seed + args.seeds):
        try:
            run_seed(extension, seed, args.operations)
        except Exception as error:
            raise RuntimeError(f"stability failure at seed {seed}") from error
    print(
        f"stability tests passed: {args.seeds} seeds x "
        f"{args.operations} operations"
    )


if __name__ == "__main__":
    main()
