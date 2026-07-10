# sqlite-tsdb

`sqlite-tsdb` is an experimental SQLite virtual table for embedded numeric
time-series storage. Applications assign integer series ids; the extension
stores `(series_id, timestamp_ms, value)` samples.

The extension is independent of Obsidian, Prometheus, and wa-sqlite. It builds
as a normal SQLite loadable extension and can also be statically linked.

## Status

This is a pre-release implementation. The SQL and block formats are not yet
stable. Use it only with data that can be recreated.

Implemented:

- Last-write-wins inserts keyed by `(series_id, ts)`.
- Indexed mutable hot storage.
- Scheduled compaction into losslessly compressed per-series blocks.
- Delta-of-delta timestamp compression.
- Adaptive raw or XOR-varint floating-point encoding.
- Hot/cold merged range reads.
- Late replacement of already compacted samples.
- Block-level retention with boundary-block rewriting.
- CRC validation over block headers and payloads.
- Fixed-width packed batch input through `tsdb_batch(?)`.
- Direct packed batch ingestion with exact new-sample accounting.
- Packed per-series query output through `tsdb_pack(ts, value)`.

Not implemented yet:

- Published, versioned Wasm artifacts.
- Exact constant-time global/per-series statistics.
- Individual SQL `UPDATE` or `DELETE` operations.
- Stable on-disk compatibility guarantees.

## Build

Requirements: a C11 compiler, `make`, and SQLite development headers.

```bash
make
make test
make sanitize
make benchmark
```

See [`bench/RESULTS.md`](bench/RESULTS.md) for the current native measurements
and stability results.

The [`adapters/wa-sqlite`](adapters/wa-sqlite) directory contains the thin
static-link adapter used to build a wa-sqlite artifact for browser and Obsidian
hosts. The storage engine itself has no wa-sqlite dependency.

## Usage

```sql
.load ./build/sqlite_tsdb

CREATE VIRTUAL TABLE samples USING tsdb(
  block_span_ms=21600000,
  max_block_points=2048
);

INSERT INTO samples(series_id, ts, value)
VALUES (1, 1700000000000, 42.5);

SELECT series_id, ts, value
FROM samples
WHERE series_id = 1
  AND ts BETWEEN 1700000000000 AND 1700003600000
ORDER BY ts;
```

High-boundary-cost runtimes can insert a `TSI1` batch in one statement:

```sql
INSERT INTO samples(series_id, ts, value)
SELECT series_id, ts, value FROM tsdb_batch(?);
```

For the lowest boundary overhead, ingest the BLOB directly. `arg2=1`
overwrites existing samples, while `arg2=0` leaves them unchanged:

```sql
BEGIN;
INSERT INTO samples(control, arg1, arg2)
VALUES ('ingest-batch', ?, 1);

-- Exact timestamps added by this batch, replaced by the next batch call.
SELECT ts, sample_count FROM samples_changes;
COMMIT;
```

They can return one compressed BLOB per series instead of one SQL row per
sample:

```sql
SELECT series_id, tsdb_pack(ts, value)
FROM samples
WHERE series_id IN (1, 2, 3) AND ts BETWEEN ? AND ?
GROUP BY series_id;
```

The packed formats are versioned but remain unstable before the first release.

Compact fully closed buckets, with a maximum number of buckets per call:

```sql
INSERT INTO samples(control, arg1, arg2)
VALUES ('compact-before', 1700007200000, 16);
```

Apply retention:

```sql
INSERT INTO samples(control, arg1)
VALUES ('delete-before', 1700000000000);
```

Timestamps must be nonnegative signed 64-bit millisecond values. NaN is
rejected; infinities and negative zero are preserved.

## Design

Each virtual table owns three SQLite shadow tables:

- `<name>_head`: mutable rows with a composite primary key.
- `<name>_blocks`: immutable compressed chunks grouped by series and fixed time
  bucket.
- `<name>_changes`: transient per-timestamp counts for the most recent direct
  batch ingest.

Open buckets stay in the head table. Compaction only seals complete buckets,
avoiding repeated decompression and recompression during normal ingestion.
Late writes return to the head and override cold values during reads. A later
compaction reconciles them into the block.

SQLite remains responsible for transactions, journaling, locking, and the
database file. The extension does not access files or the network.
