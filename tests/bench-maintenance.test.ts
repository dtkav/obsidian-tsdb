import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { MetricsStore } from "../src/storage/store";

// Maintenance throughput benchmark: ingest a realistic stream, then time the
// compaction, retention, finalize and vacuum batches exactly as the plugin
// issues them. Opt in with TSDB_BENCH=1; it takes minutes and writes a
// multi-hundred-megabyte database to a temp dir.

const LOG = process.env.TSDB_BENCH_LOG ?? join(tmpdir(), "tsdb-bench.log");
const SERIES = Number(process.env.TSDB_BENCH_SERIES ?? 300);
const HOURS = Number(process.env.TSDB_BENCH_HOURS ?? 8);
const STEP_MS = 1000;
const BATCH_SECONDS = 10;
const HOUR = 3600 * 1000;
const WASM = readFileSync("node_modules/wa-sqlite/dist/wa-sqlite-async.wasm");

function log(line: string): void {
	const stamped = `${new Date().toISOString()} ${line}`;
	appendFileSync(LOG, stamped + "\n");
	console.log(stamped);
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(name: string, durations: number[], units: number, unitName: string): void {
	const total = durations.reduce((a, b) => a + b, 0);
	log(
		`${name}: batches=${durations.length} ${unitName}=${units} ` +
			`p50=${percentile(durations, 0.5).toFixed(1)}ms ` +
			`p95=${percentile(durations, 0.95).toFixed(1)}ms ` +
			`max=${Math.max(0, ...durations).toFixed(1)}ms ` +
			`busy=${(total / 1000).toFixed(1)}s ` +
			`rate=${(units / Math.max(0.001, total / 1000)).toFixed(0)} ${unitName}/s`
	);
}

describe.skipIf(!process.env.TSDB_BENCH)("maintenance throughput", () => {
	it("measures compaction, retention and vacuum batches on a realistic store", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tsdb-bench-"));
		const dbPath = join(dir, "metrics.sqlite");
		const fileSize = () => {
			try {
				return statSync(dbPath).size;
			} catch {
				return -1;
			}
		};
		const store = await MetricsStore.open({
			location: { kind: "node-file", directory: dir },
			wasmBinary: WASM,
		});
		try {
			const labels = Array.from({ length: SERIES }, (_, i) => ({
				__name__: `bench_metric_${i % 25}`,
				job: "bench",
				instance: `inst-${i % 7}`,
				idx: String(i),
			}));
			const nowMs = Date.now();
			const startMs = nowMs - HOURS * HOUR;
			const batches = Math.floor((HOURS * HOUR) / (BATCH_SECONDS * STEP_MS));
			log(`ingest: series=${SERIES} hours=${HOURS} batches=${batches}`);
			const ingestStarted = performance.now();
			let ingested = 0;
			for (let b = 0; b < batches; b++) {
				const samples = [];
				for (let s = 0; s < BATCH_SECONDS; s++) {
					const ts = startMs + (b * BATCH_SECONDS + s) * STEP_MS;
					for (let i = 0; i < SERIES; i++) {
						samples.push({ labels: labels[i], ts, value: Math.sin(ts / 60000 + i) * 100 + i });
					}
				}
				await store.ingest(samples);
				ingested += samples.length;
				if (b % 360 === 0) {
					log(`  ingest batch ${b}/${batches} samples=${ingested} file=${(fileSize() / 1048576).toFixed(0)}MB`);
				}
			}
			const ingestSeconds = (performance.now() - ingestStarted) / 1000;
			log(`ingest done: samples=${ingested} in ${ingestSeconds.toFixed(0)}s (${(ingested / ingestSeconds).toFixed(0)}/s) file=${(fileSize() / 1048576).toFixed(0)}MB`);

			// Compaction as the plugin drives it: oldest closed bucket, 512 points.
			const compactMs: number[] = [];
			let compacted = 0;
			let result;
			const compactStarted = performance.now();
			do {
				const t = performance.now();
				result = await store.compactBeforeBatch(nowMs, 512);
				compactMs.push(performance.now() - t);
				compacted += result.compactedPoints;
				if (compactMs.length % 500 === 0) {
					log(`  compaction batch ${compactMs.length} points=${compacted} oldest=${result.oldestUncompactedMs} last=${compactMs[compactMs.length - 1].toFixed(1)}ms`);
				}
			} while (!result.complete && performance.now() - compactStarted < 20 * 60 * 1000);
			summarize("compaction", compactMs, compacted, "points");
			log(`compaction complete=${result.complete} file=${(fileSize() / 1048576).toFixed(0)}MB`);

			// Retention with a 2 h window so the same 6 h block math applies.
			const cutoffMs = nowMs - 2 * HOUR;
			const retentionMs: number[] = [];
			let deleted = 0;
			let del;
			do {
				const t = performance.now();
				del = await store.deleteBeforeBatch(cutoffMs, 2048);
				retentionMs.push(performance.now() - t);
				deleted += del.deletedSamples ?? 0;
			} while (!del.complete && retentionMs.length < 100000);
			summarize("retention", retentionMs, deleted, "samples");
			for (const phase of ["metadata", "series"] as const) {
				const t = performance.now();
				await store.finalizeRetention(del.cutoffMs, phase);
				log(`finalize ${phase}: ${(performance.now() - t).toFixed(1)}ms`);
			}
			log(`retention complete file=${(fileSize() / 1048576).toFixed(0)}MB`);

			const vacuumMs: number[] = [];
			let reclaimed = 0;
			let vac;
			do {
				const t = performance.now();
				vac = await store.vacuumBatch(256);
				vacuumMs.push(performance.now() - t);
				reclaimed += vac.reclaimedPages;
			} while (!vac.complete && vac.reclaimedPages > 0 && vacuumMs.length < 100000);
			summarize("vacuum", vacuumMs, reclaimed, "pages");
			log(`vacuum complete=${vac.complete} remaining=${vac.remainingPages} pageCount=${vac.pageCount} pageSize=${vac.pageSize} file=${(fileSize() / 1048576).toFixed(0)}MB`);

			const stats = await store.stats();
			log(`stats: ${JSON.stringify(stats)}`);
			expect(result.complete).toBe(true);
		} finally {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 3_600_000);
});

// Marginal cost of a compaction batch: time 64-point and 512-point batches on
// the same store. If both cost about the same, the batch cost is fixed
// overhead and shrinking batches only lowers throughput.
describe.skipIf(!process.env.TSDB_BENCH_LIMITS)("compaction batch cost by size", () => {
	it("times 64-point and 512-point batches on fully closed data", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tsdb-bench-limits-"));
		const store = await MetricsStore.open({
			location: { kind: "node-file", directory: dir },
			wasmBinary: WASM,
		});
		try {
			const series = 300;
			const labels = Array.from({ length: series }, (_, i) => ({
				__name__: `bench_metric_${i % 25}`,
				job: "bench",
				idx: String(i),
			}));
			const nowMs = Date.now();
			// Two hours of data that ended a day ago: every bucket is closed.
			const startMs = nowMs - 26 * HOUR;
			const batches = (2 * HOUR) / (BATCH_SECONDS * STEP_MS);
			for (let b = 0; b < batches; b++) {
				const samples = [];
				for (let s = 0; s < BATCH_SECONDS; s++) {
					const ts = startMs + (b * BATCH_SECONDS + s) * STEP_MS;
					for (let i = 0; i < series; i++) {
						samples.push({ labels: labels[i], ts, value: Math.sin(ts / 60000 + i) * 100 + i });
					}
				}
				await store.ingest(samples);
			}
			log(`limits: ingested ${batches * BATCH_SECONDS * series} closed samples`);
			for (const limit of [64, 512, 64, 512, 2048]) {
				const durations: number[] = [];
				let points = 0;
				for (let i = 0; i < 150; i++) {
					const t = performance.now();
					const result = await store.compactBeforeBatch(nowMs, limit);
					durations.push(performance.now() - t);
					points += result.compactedPoints;
					if (result.complete) break;
				}
				summarize(`limit=${limit}`, durations, points, "points");
			}
		} finally {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 1_800_000);
});

// Bytes per sample in the hot head table versus compacted blocks, for values
// that change every second and for values that never change.
describe.skipIf(!process.env.TSDB_BENCH_CODEC)("storage cost per sample", () => {
	it("compares head rows with compacted blocks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tsdb-bench-codec-"));
		const store = await MetricsStore.open({
			location: { kind: "node-file", directory: dir },
			wasmBinary: WASM,
		});
		try {
			const series = 200;
			const nowMs = Date.now();
			const startMs = nowMs - 26 * HOUR;
			const labels = Array.from({ length: series }, (_, i) => ({
				__name__: i < series / 2 ? "changing" : "constant",
				job: "bench",
				idx: String(i),
			}));
			const batches = HOUR / (BATCH_SECONDS * STEP_MS);
			for (let b = 0; b < batches; b++) {
				const samples = [];
				for (let s = 0; s < BATCH_SECONDS; s++) {
					const ts = startMs + (b * BATCH_SECONDS + s) * STEP_MS;
					for (let i = 0; i < series; i++) {
						const value = i < series / 2 ? Math.sin(ts / 60000 + i) * 100 + i : 42;
						samples.push({ labels: labels[i], ts, value });
					}
				}
				await store.ingest(samples);
			}
			const internals = store as unknown as { sqlite3: any; db: number };
			const query = async (sql: string) => {
				let out: unknown[] = [];
				await internals.sqlite3.exec(internals.db, sql, (row: unknown[]) => { out = row; });
				return out;
			};
			const pageSize = Number((await query("PRAGMA page_size"))[0]);
			const livePages = async () =>
				Number((await query("PRAGMA page_count"))[0]) -
				Number((await query("PRAGMA freelist_count"))[0]);
			const headRows = Number((await query("SELECT count(*) FROM samples_head"))[0]);
			const pagesWithHead = await livePages();
			let result;
			do {
				result = await store.compactBeforeBatch(nowMs, 2048);
			} while (!result.complete);
			const pagesWithBlocks = await livePages();
			const [blockCount, blockPoints, payloadBytes] = await query(
				"SELECT count(*), sum(sample_count), sum(length(payload)) FROM samples_blocks"
			);
			const perName = [];
			for (const name of ["changing", "constant"]) {
				const row = await query(
					`SELECT sum(b.sample_count), sum(length(b.payload)) FROM samples_blocks b
					 JOIN series s ON s.id = b.series_id WHERE s.labels_json LIKE '%"${name}"%'`
				);
				perName.push(`${name}: ${(Number(row[1]) / Number(row[0])).toFixed(2)} B/sample payload`);
			}
			log(
				`codec: headRows=${headRows} livePagesWithHead=${pagesWithHead} (${((pagesWithHead * pageSize) / headRows).toFixed(1)} B/sample as hot rows) | ` +
					`after compaction: blocks=${blockCount} points=${blockPoints} livePages=${pagesWithBlocks} (${((pagesWithBlocks * pageSize) / Number(blockPoints)).toFixed(2)} B/sample on pages, ` +
					`${(Number(payloadBytes) / Number(blockPoints)).toFixed(2)} B/sample payload) | ${perName.join(", ")}`
			);
			expect(result.complete).toBe(true);
		} finally {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 900_000);
});
