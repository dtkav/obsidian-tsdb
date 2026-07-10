# Native Benchmark Results

Measured on 2026-07-10 with SQLite 3.37.2 and GCC 11.4 on the local Linux
workspace. Both engines used WAL journaling, `synchronous=NORMAL`, a 16 MiB
cache, and one committed transaction per simulated scrape.

These are development measurements, not cross-machine claims. Raw JSON is in
`results-30s.json`, `results-1s.json`, and `results-wasm.json`.

## Wasm Boundary

Measured through wa-sqlite's JavaScript API using the synchronous `-Oz` Wasm
artifact, with 50 series and 720 thirty-second scrapes (36,000 samples). The
table reports medians from three final runs; timing variance in the shared
development environment is significant:

| Measurement | SQLite rows | sqlite-tsdb | Ratio |
| --- | ---: | ---: | ---: |
| Ingest | 443.2 ms | 356.8 ms | 0.81x |
| Compaction | n/a | 135.0 ms | n/a |
| Raw selected-series query | 13.0 ms | 14.6 ms | 1.12x |
| Packed selected-series query | 13.0 ms | 8.2 ms | 0.63x |
| Delete half of history | 32.4 ms | 22.9 ms | 0.71x |

The baseline uses prepared row writes. TSDB uses one direct `TSI1` BLOB per
scrape and reports exact newly inserted timestamps through a shadow table.
Packed output avoids one host callback per point and is the intended Obsidian
query path.

The synchronous artifact is about 555 KB, compared with 1.14 MB for the
Asyncify artifact. In one paired final run, synchronous TSDB ingest was
421.5 ms versus 628.5 ms async, compaction was 92.8 ms versus 174.1 ms, and
packed query was 6.3 ms versus 8.4 ms. The Obsidian OPFS worker therefore uses
the synchronous artifact with `AccessHandlePoolVFS`; promise-based fallback
VFSes retain the async build.

An `-O3` comparison reduced TSDB ingest to 242-257 ms in two runs but increased
the sync Wasm to about 1.01 MB, 83% larger than `-Oz`. The default remains
`-Oz`; `TSDB_OPT_LEVEL=-O3` is available for size-insensitive builds.

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
