# Native Benchmark Results

Measured on 2026-07-10 with SQLite 3.37.2 and GCC 11.4 on the local Linux
workspace. Both engines used WAL journaling, `synchronous=NORMAL`, a 16 MiB
cache, and one committed transaction per simulated scrape.

These are development measurements, not cross-machine claims. Raw JSON is in
`results-30s.json`, `results-1s.json`, and `results-wasm.json`.

## Wasm Boundary

Measured through wa-sqlite's JavaScript API using the async Wasm artifact,
with 50 series and 720 thirty-second scrapes (36,000 samples):

| Measurement | SQLite rows | sqlite-tsdb | Ratio |
| --- | ---: | ---: | ---: |
| Ingest | 1,318.3 ms | 697.0 ms | 0.53x |
| Compaction | n/a | 561.6 ms | n/a |
| Raw selected-series query | 24.9 ms | 49.8 ms | 2.00x |
| Packed selected-series query | 24.9 ms | 15.7 ms | 0.63x |
| Delete half of history | 131.7 ms | 59.9 ms | 0.45x |

The baseline follows the plugin's existing prepared-row write path. TSDB uses
one `TSI1` BLOB per scrape, so it crosses the JavaScript/Wasm boundary once per
batch. TSDB ingestion plus compaction was 1,258.6 ms, slightly faster than the
1,318.3 ms row baseline. Raw TSDB queries pay decoding overhead; packed output
avoids one host callback per point and is the intended Obsidian query path.

The in-memory `page_count` result at this small scale is not a storage result:
SQLite retains freed pages until vacuum or reuse. The native file benchmarks
below remain the meaningful storage measurements.

## Thirty-Second Scrapes

Workload: 250 series, 2,880 points per series, 720,000 samples total.

| Measurement | SQLite rows | sqlite-tsdb | Ratio |
| --- | ---: | ---: | ---: |
| Ingest | 22.425 s | 32.489 s | 1.45x |
| Compaction | n/a | 2.231 s | n/a |
| Selected-series query | 35.8 ms | 49.2 ms | 1.38x |
| Packed selected-series query | 18.4 ms | 23.9 ms | 1.30x |
| Delete half of history | 695.1 ms | 134.8 ms | 0.19x |
| Database size | 22,319,104 B | 6,844,416 B | 0.31x |

## One-Second Scrapes

Workload: 100 series, 3,600 points per series, 360,000 samples total.

| Measurement | SQLite rows | sqlite-tsdb | Ratio |
| --- | ---: | ---: | ---: |
| Ingest | 12.129 s | 16.541 s | 1.36x |
| Compaction | n/a | 0.962 s | n/a |
| Selected-series query | 61.3 ms | 65.4 ms | 1.07x |
| Packed selected-series query | 16.1 ms | 23.8 ms | 1.48x |
| Delete half of history | 226.4 ms | 72.9 ms | 0.32x |
| Database size | 10,772,480 B | 1,990,656 B | 0.18x |

## Stability Results

- GCC and Clang strict-warning builds passed.
- Deterministic codec and virtual-table tests passed.
- AddressSanitizer and UndefinedBehaviorSanitizer passed. LeakSanitizer is
  disabled because it cannot run under the workspace's ptrace sandbox.
- 50 randomized seeds with 5,000 operations each passed: 250,000 total
  inserts, packed inserts, overwrites, late writes, compactions, retentions,
  rollbacks, range queries, packed queries, closes, and reopens.
- Every randomized database passed `PRAGMA integrity_check` before and after
  reopen.
- 100,000 libFuzzer inputs passed under ASan and UBSan.
- Deliberately corrupted block payloads were rejected.

The long randomized run found one cursor bug: an overlapping sparse block with
no actual point inside the query range leaked an internal `SQLITE_ROW` status
from `xFilter`. A regression test now covers that case, and the complete
250,000-operation run passed after the fix.

## Interpretation

The current implementation prioritizes storage and retention:

- Compacted storage is 69-82% smaller than the equivalent indexed row table.
- Retention is 3.1-5.2x faster.
- Native committed ingestion is 36-45% slower.
- Native range queries range from 7% to 38% slower.

Packed transport reduces host-language result materialization, but the native
benchmark does not model JavaScript/Wasm call overhead. The Wasm build must be
benchmarked independently before the Obsidian adapter selects this engine.

Not tested yet:

- Forced process termination during a commit.
- Concurrent readers and writers; the target Obsidian store serializes all
  operations.
- Compatibility across SQLite versions or CPU architectures.
