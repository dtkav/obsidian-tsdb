import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import * as SQLite from "wa-sqlite";
import SQLiteAsyncESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import {
	LEGACY_DB_FILENAME,
	TSDB_DIRNAME,
	findLegacyStorageMigrationSource,
	prepareWorkerOpfsOpenPlan,
	prepareStoreOpenPlan,
} from "../src/storage/backend";
import {
	CHUNK_SIZE,
	ChunkAdapter,
	migrateLegacySnapshot,
	readChunkedDatabaseImage,
} from "../src/storage/chunk-vfs";
import {
	NodeFileVFS,
	nodeStorageDirectoryForAdapter,
	readNodeFileDatabase,
	writeNodeFileDatabase,
} from "../src/storage/node-file-vfs";
import {
	DEFAULT_CHUNK_DB_NAME,
	DEFAULT_NODE_DB_NAME,
	MetricsStore,
} from "../src/storage/store";

const WASM = readFileSync("node_modules/wa-sqlite/dist/wa-sqlite-async.wasm");
const NAME = "__name__";

export interface FakeAdapter extends ChunkAdapter {
	files: Map<string, ArrayBuffer | string>;
	dirs: Set<string>;
}

function makeAdapter(): FakeAdapter {
	const files = new Map<string, ArrayBuffer | string>();
	const dirs = new Set<string>();
	return {
		files,
		dirs,
		exists: async (path) => files.has(path) || dirs.has(path),
		mkdir: async (path) => {
			dirs.add(path);
		},
		read: async (path) => {
			const value = files.get(path);
			if (typeof value !== "string") throw new Error("ENOENT: " + path);
			return value;
		},
		write: async (path, data) => {
			files.set(path, data);
		},
		readBinary: async (path) => {
			const value = files.get(path);
			if (!(value instanceof ArrayBuffer)) throw new Error("ENOENT: " + path);
			return value.slice(0);
		},
		writeBinary: async (path, data) => {
			files.set(path, data.slice(0));
		},
		remove: async (path) => {
			files.delete(path);
		},
	};
}

async function openStore(adapter: FakeAdapter = makeAdapter()) {
	const store = await MetricsStore.open({
		location: {
			kind: "chunks",
			adapter,
			directory: "tsdb",
		},
		wasmBinary: WASM,
	});
	return { store, adapter };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "tsdb-node-vfs-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("MetricsStore (wa-sqlite over chunked adapter VFS)", () => {
	it("round-trips samples through ingest/select", async () => {
		const { store } = await openStore();
		expect(store.recoveredFromCorruption).toBe(false);
		await store.ingest([
			{ labels: { [NAME]: "m", job: "a" }, ts: 1000, value: 1 },
			{ labels: { [NAME]: "m", job: "a" }, ts: 2000, value: 2 },
			{ labels: { [NAME]: "m", job: "b" }, ts: 1500, value: 5 },
		]);

		const all = await store.select(
			[{ name: NAME, op: "=", value: "m" }],
			0,
			10_000
		);
		expect(all).toHaveLength(2);

		const onlyA = await store.select(
			[
				{ name: NAME, op: "=", value: "m" },
				{ name: "job", op: "=", value: "a" },
			],
			0,
			10_000
		);
		expect(onlyA).toHaveLength(1);
		expect(onlyA[0].points).toEqual([
			{ t: 1000, v: 1 },
			{ t: 2000, v: 2 },
		]);
		await store.close();
	});

	it("supports regex matchers and time-range filtering", async () => {
		const { store } = await openStore();
		await store.ingest([
			{ labels: { [NAME]: "http_total", code: "200" }, ts: 1000, value: 1 },
			{ labels: { [NAME]: "http_total", code: "500" }, ts: 1000, value: 2 },
			{ labels: { [NAME]: "http_total", code: "503" }, ts: 9000, value: 3 },
		]);

		const errors = await store.select(
			[
				{ name: NAME, op: "=", value: "http_total" },
				{ name: "code", op: "=~", value: "5.." },
			],
			0,
			10_000
		);
		expect(errors).toHaveLength(2);

		const windowed = await store.select(
			[{ name: NAME, op: "=", value: "http_total" }],
			0,
			5000
		);
		expect(windowed).toHaveLength(2);
		await store.close();
	});

	it("lists label names and values", async () => {
		const { store } = await openStore();
		await store.ingest([
			{ labels: { [NAME]: "m", job: "a", zone: "eu" }, ts: 1, value: 1 },
			{ labels: { [NAME]: "n", job: "b" }, ts: 1, value: 1 },
		]);
		expect(await store.labelNames()).toEqual([NAME, "job", "zone"]);
		expect(await store.labelValues("job")).toEqual(["a", "b"]);
		expect(
			await store.labelValues("job", [{ name: NAME, op: "=", value: "m" }])
		).toEqual(["a"]);
		await store.close();
	});

	it("prunes old samples and empty series", async () => {
		const { store } = await openStore();
		await store.ingest([
			{ labels: { [NAME]: "old" }, ts: 1000, value: 1 },
			{ labels: { [NAME]: "new" }, ts: 9000, value: 1 },
		]);
		await store.deleteBefore(5000);
		expect((await store.stats()).sampleCount).toBe(1);
		expect(await store.seriesMatching([])).toEqual([{ [NAME]: "new" }]);
		await store.close();
	});

	it("persists across close and reopen on the same adapter files", async () => {
		const adapter = makeAdapter();
		const first = await openStore(adapter);
		await first.store.ingest([
			{ labels: { [NAME]: "m" }, ts: 1234, value: 42 },
		]);
		await first.store.close();

		// Chunk + meta files must exist on "disk" now.
		expect(adapter.files.has("tsdb/metrics.meta")).toBe(true);
		expect(adapter.files.has("tsdb/metrics.c0")).toBe(true);

		const second = await openStore(adapter);
		const data = await second.store.select(
			[{ name: NAME, op: "=", value: "m" }],
			0,
			9999
		);
		expect(data).toHaveLength(1);
		expect(data[0].points[0]).toEqual({ t: 1234, v: 42 });
		await second.store.close();
	});

	it("recovers from corrupt database chunks by starting fresh", async () => {
		const adapter = makeAdapter();
		adapter.dirs.add("tsdb");
		adapter.files.set("tsdb/metrics.meta", JSON.stringify({ size: 8192 }));
		const garbage = new Uint8Array(CHUNK_SIZE);
		garbage.fill(0xab);
		adapter.files.set("tsdb/metrics.c0", garbage.buffer.slice(0));

		const { store } = await openStore(adapter);
		expect(store.recoveredFromCorruption).toBe(true);
		expect((await store.stats()).sampleCount).toBe(0);
		await store.close();
	});

	it("drops NaN values and overwrites duplicate timestamps", async () => {
		const { store } = await openStore();
		await store.ingest([
			{ labels: { [NAME]: "m" }, ts: 1000, value: NaN },
			{ labels: { [NAME]: "m" }, ts: 2000, value: 1 },
			{ labels: { [NAME]: "m" }, ts: 2000, value: 2 },
		]);
		const data = await store.select(
			[{ name: NAME, op: "=", value: "m" }],
			0,
			9999
		);
		expect(data[0].points).toEqual([{ t: 2000, v: 2 }]);
		await store.close();
	});

	it("maintains quick stats on the write path", async () => {
		const { store } = await openStore();
		const now = Date.now();
		await store.ingest([
			{ labels: { [NAME]: "m" }, ts: now - 120_000, value: 1 },
			{ labels: { [NAME]: "m" }, ts: now - 1_000, value: 2 },
			{ labels: { [NAME]: "m" }, ts: now - 1_000, value: 3 },
		]);

		let quick = await store.quickStats();
		expect(quick.sampleCount).toBe(2);
		expect(quick.samplesLastHour).toBe(2);
		expect(quick.oldestSampleMs).toBe(Math.round(now - 120_000));
		expect(quick.newestSampleMs).toBe(Math.round(now - 1_000));

		await store.deleteBefore(now - 60_000);
		quick = await store.quickStats();
		expect(quick.sampleCount).toBe(1);
		expect(quick.samplesLastHour).toBe(1);
		expect(quick.oldestSampleMs).toBe(Math.round(now - 1_000));
		await store.close();
	});

	it("serializes concurrent operations (Asyncify forbids reentrancy)", async () => {
		const { store } = await openStore();
		const batch = (name: string, base: number) =>
			Array.from({ length: 50 }, (_, i) => ({
				labels: { [NAME]: name },
				ts: base + i * 1000,
				value: i,
			}));
		// Fire overlapping transactions and reads without awaiting in between —
		// this reproduced "cannot start a transaction within a transaction"
		// and subsequent wasm traps before the op queue existed.
		await Promise.all([
			store.ingest(batch("a", 0)),
			store.deleteBefore(-1),
			store.ingest(batch("b", 0)),
			store.select([{ name: NAME, op: "=", value: "a" }], 0, 1e9),
			store.stats(),
			store.ingest(batch("c", 0)),
			store.deleteBefore(-1),
		]);
		const stats = await store.stats();
		expect(stats.sampleCount).toBe(150);
		expect(stats.seriesCount).toBe(3);
		await store.close();
	});

	it("rejects new operations after close begins", async () => {
		const { store } = await openStore();
		const closing = store.close();
		await expect(
			store.ingest([{ labels: { [NAME]: "late" }, ts: 1, value: 1 }])
		).rejects.toThrow(/closing/);
		await closing;
	});

	it(
		"handles a multi-chunk database (spans chunk boundaries)",
		async () => {
			const { store } = await openStore();
			// ~200 series x 50 samples is enough to cross 64 KiB chunks.
			const batch = [];
			for (let s = 0; s < 200; s++) {
				for (let i = 0; i < 50; i++) {
					batch.push({
						labels: { [NAME]: "bulk", idx: String(s) },
						ts: i * 1000,
						value: s + i,
					});
				}
			}
			await store.ingest(batch);
			const stats = await store.stats();
			expect(stats.sampleCount).toBe(10_000);
			expect(stats.seriesCount).toBe(200);
			const one = await store.select(
				[
					{ name: NAME, op: "=", value: "bulk" },
					{ name: "idx", op: "=", value: "137" },
				],
				0,
				60_000
			);
			expect(one[0].points).toHaveLength(50);
			await store.close();
		},
		10_000
	);

	it("batches wide selects across many matching series", async () => {
		const { store } = await openStore();
		const batch = Array.from({ length: 325 }, (_, i) => ({
			labels: { [NAME]: "fanout", idx: String(i) },
			ts: 1000,
			value: i,
		}));
		await store.ingest(batch);

		const data = await store.select(
			[{ name: NAME, op: "=", value: "fanout" }],
			0,
			2000
		);

		expect(data).toHaveLength(325);
		expect(data[0]).toEqual({
			labels: { [NAME]: "fanout", idx: "0" },
			points: [{ t: 1000, v: 0 }],
		});
		expect(data[324]).toEqual({
			labels: { [NAME]: "fanout", idx: "324" },
			points: [{ t: 1000, v: 324 }],
		});
		await store.close();
	});

	it("streams all samples in export batches", async () => {
		const { store } = await openStore();
		await store.ingest([
			{ labels: { [NAME]: "exported", series: "a" }, ts: 1000, value: 1 },
			{ labels: { [NAME]: "exported", series: "a" }, ts: 2000, value: 2 },
			{ labels: { [NAME]: "exported", series: "b" }, ts: 1500, value: 3 },
		]);
		const batches: Array<Array<{ ts: number; value: number }>> = [];
		const result = await store.exportSamples({
			batchSize: 2,
			onBatch: async (samples) => {
				batches.push(samples.map((sample) => ({
					ts: sample.ts,
					value: sample.value,
				})));
			},
		});

		expect(result).toEqual({ samples: 3, batches: 2 });
		expect(batches).toEqual([
			[
				{ ts: 1000, value: 1 },
				{ ts: 2000, value: 2 },
			],
			[{ ts: 1500, value: 3 }],
		]);
		await store.close();
	});
});

describe("MetricsStore (wa-sqlite over Node file VFS)", () => {
	it("replaces an incompatible row-format database", async () => {
		await withTempDir(async (dir) => {
			const module = await SQLiteAsyncESMFactory({ wasmBinary: WASM });
			const sqlite3 = SQLite.Factory(module);
			const vfs = new NodeFileVFS("legacy-row-format", dir);
			sqlite3.vfs_register(vfs, false);
			const db = await sqlite3.open_v2(
				DEFAULT_NODE_DB_NAME,
				SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE,
				vfs.name
			);
			await sqlite3.exec(
				db,
				"CREATE TABLE samples(series_id INTEGER, ts INTEGER, value REAL)"
			);
			await sqlite3.close(db);

			const store = await MetricsStore.open({
				location: { kind: "node-file", directory: dir },
				wasmBinary: WASM,
			});
			expect(store.recoveredFromCorruption).toBe(true);
			expect((await store.stats()).sampleCount).toBe(0);
			await store.close();
		});
	});

	it("persists samples in a normal metrics.sqlite file", async () => {
		await withTempDir(async (dir) => {
			const first = await MetricsStore.open({
				location: { kind: "node-file", directory: dir },
				wasmBinary: WASM,
			});
			await first.ingest([
				{ labels: { [NAME]: "node_metric" }, ts: 1234, value: 99 },
			]);
			await first.close();

			expect(
				readFileSync(join(dir, DEFAULT_NODE_DB_NAME)).byteLength
			).toBeGreaterThan(0);

			const second = await MetricsStore.open({
				location: { kind: "node-file", directory: dir },
				wasmBinary: WASM,
			});
			expect(second.recoveredFromCorruption).toBe(false);
			const data = await second.select(
				[{ name: NAME, op: "=", value: "node_metric" }],
				0,
				9999
			);
			expect(data[0].points).toEqual([{ t: 1234, v: 99 }]);
			await second.close();
		});
	});

	it("can seed a Node sqlite file from existing chunk files", async () => {
		await withTempDir(async (dir) => {
			const adapter = makeAdapter();
			const chunk = await openStore(adapter);
			await chunk.store.ingest([
				{ labels: { [NAME]: "chunk_metric" }, ts: 2000, value: 7 },
			]);
			await chunk.store.close();

			const image = await readChunkedDatabaseImage(
				adapter,
				"tsdb",
				DEFAULT_CHUNK_DB_NAME
			);
			expect(image).not.toBeNull();
			await writeNodeFileDatabase(dir, DEFAULT_NODE_DB_NAME, image!);

			const store = await MetricsStore.open({
				location: { kind: "node-file", directory: dir },
				wasmBinary: WASM,
			});
			const data = await store.select(
				[{ name: NAME, op: "=", value: "chunk_metric" }],
				0,
				9999
			);
			expect(data[0].points).toEqual([{ t: 2000, v: 7 }]);
			await store.close();
		});
	});
});

describe("storage backend selection", () => {
	it("does not touch Node modules for mobile-style adapters", () => {
		let attemptedNodeLoad = false;
		const directory = nodeStorageDirectoryForAdapter({}, "tsdb", {
			nodeFileBackendAvailable: () => {
				attemptedNodeLoad = true;
				throw new Error("node should not be loaded");
			},
			joinNodePath: () => {
				throw new Error("node path should not be used");
			},
		});

		expect(directory).toBeNull();
		expect(attemptedNodeLoad).toBe(false);
	});

	it("uses the Node backend only for filesystem adapters when available", () => {
		const directory = nodeStorageDirectoryForAdapter(
			{ getBasePath: () => "/vault" },
			".obsidian/plugins/tsdb",
			{
				nodeFileBackendAvailable: () => true,
				joinNodePath: (...parts) => parts.join("/"),
			}
		);

		expect(directory).toBe("/vault/.obsidian/plugins/tsdb");
		expect(
			nodeStorageDirectoryForAdapter(
				{ getBasePath: () => "/vault" },
				".obsidian/plugins/tsdb",
				{ nodeFileBackendAvailable: () => false }
			)
		).toBeNull();
	});

	it("plans chunk storage for mobile-style adapters and migrates legacy snapshots", async () => {
		const adapter = makeAdapter();
		const legacy = new Uint8Array(CHUNK_SIZE + 7);
		legacy.fill(0x42);
		adapter.files.set(
			`plugin/${LEGACY_DB_FILENAME}`,
			legacy.buffer.slice(0)
		);

		const plan = await prepareStoreOpenPlan({
			adapter,
			pluginDir: "plugin",
			wasmBinary: WASM,
		});

		expect(plan.backend).toBe("chunks");
		expect(plan.location).toEqual({
			kind: "chunks",
			adapter,
			directory: `plugin/${TSDB_DIRNAME}`,
		});
		expect(adapter.files.has(`plugin/${LEGACY_DB_FILENAME}`)).toBe(false);
		expect(
			JSON.parse(
				adapter.files.get(`plugin/${TSDB_DIRNAME}/metrics.meta`) as string
			)
		).toEqual({ size: legacy.byteLength });
	});

	it("plans node-file storage for desktop filesystem adapters", async () => {
		await withTempDir(async (dir) => {
			const adapter = Object.assign(makeAdapter(), {
				getBasePath: () => dir,
			});

			const plan = await prepareStoreOpenPlan({
				adapter,
				pluginDir: ".obsidian/plugins/tsdb",
				wasmBinary: WASM,
			});

			expect(plan.backend).toBe("node-file");
			expect(plan.dbName).toBe(DEFAULT_NODE_DB_NAME);
			expect(plan.location).toEqual({
				kind: "node-file",
				directory: join(dir, ".obsidian/plugins/tsdb"),
			});
		});
	});

	it("finds a desktop sqlite migration source", async () => {
		await withTempDir(async (dir) => {
			const adapter = Object.assign(makeAdapter(), {
				getBasePath: () => dir,
			});
			const nodeDirectory = join(dir, ".obsidian/plugins/tsdb");
			const seed = new Uint8Array([1, 2, 3, 4]);
			await writeNodeFileDatabase(nodeDirectory, DEFAULT_NODE_DB_NAME, seed);

			const source = await findLegacyStorageMigrationSource({
				adapter,
				pluginDir: ".obsidian/plugins/tsdb",
			});

			expect(source).toMatchObject({
				backend: "node-file",
				label: "desktop SQLite",
				dbName: DEFAULT_NODE_DB_NAME,
				sizeBytes: seed.byteLength,
			});
		});
	});

	it("finds a chunked migration source on mobile-style adapters", async () => {
		const adapter = makeAdapter();
		adapter.files.set(
			`plugin/${TSDB_DIRNAME}/${DEFAULT_CHUNK_DB_NAME}.meta`,
			JSON.stringify({ size: 1234 })
		);

		const source = await findLegacyStorageMigrationSource({
			adapter,
			pluginDir: "plugin",
		});

		expect(source).toMatchObject({
			backend: "chunks",
			label: "vault chunks",
			dbName: DEFAULT_CHUNK_DB_NAME,
			sizeBytes: 1234,
		});
	});

	it("skips OPFS worker planning when the worker probe fails", async () => {
		const adapter = makeAdapter();

		const plan = await prepareWorkerOpfsOpenPlan({
			adapter,
			pluginDir: "plugin",
			probe: async () => ({ ok: false, error: "no sync handles" }),
		});

		expect(plan).toBeNull();
	});

	it("plans OPFS worker storage without raw-seeding desktop sqlite", async () => {
		await withTempDir(async (dir) => {
			const adapter = Object.assign(makeAdapter(), {
				getBasePath: () => dir,
			});
			const nodeDirectory = join(dir, ".obsidian/plugins/tsdb");
			const seed = new Uint8Array([1, 2, 3, 4]);
			await writeNodeFileDatabase(nodeDirectory, DEFAULT_NODE_DB_NAME, seed);

			const plan = await prepareWorkerOpfsOpenPlan({
				adapter,
				pluginDir: ".obsidian/plugins/tsdb",
				probe: async () => ({ ok: true }),
			});

			expect(plan?.backend).toBe("worker-opfs");
			expect(plan?.dbName).toBe("tsdb/metrics.sqlite");
			expect(
				await readNodeFileDatabase(nodeDirectory, DEFAULT_NODE_DB_NAME)
			).toEqual(seed);
		});
	});

	it("leaves desktop sqlite untouched while planning OPFS", async () => {
		await withTempDir(async (dir) => {
			const adapter = Object.assign(makeAdapter(), {
				getBasePath: () => dir,
			});
			const nodeDirectory = join(dir, ".obsidian/plugins/tsdb");
			const seed = new Uint8Array([1, 2, 3, 4]);
			await writeNodeFileDatabase(nodeDirectory, DEFAULT_NODE_DB_NAME, seed);

			const plan = await prepareWorkerOpfsOpenPlan({
				adapter,
				pluginDir: ".obsidian/plugins/tsdb",
				probe: async () => ({ ok: true }),
			});

			expect(plan?.backend).toBe("worker-opfs");
			expect(
				await readNodeFileDatabase(nodeDirectory, DEFAULT_NODE_DB_NAME)
			).toEqual(seed);
		});
	});

	it("namespaces OPFS worker storage by vault identity", async () => {
		const adapter = makeAdapter();
		const live1 = await prepareWorkerOpfsOpenPlan({
			adapter,
			pluginDir: "plugin",
			namespace: "/vaults/live1",
			probe: async () => ({ ok: true }),
		});
		const live2 = await prepareWorkerOpfsOpenPlan({
			adapter,
			pluginDir: "plugin",
			namespace: "/vaults/live2",
			probe: async () => ({ ok: true }),
		});

		expect(live1?.backend).toBe("worker-opfs");
		expect(live2?.backend).toBe("worker-opfs");
		expect(live1?.dbName).not.toBe(live2?.dbName);
		expect(live1?.dbName).toMatch(/^plugin-[a-z0-9]+\/metrics\.sqlite$/);
		expect(live2?.dbName).toMatch(/^plugin-[a-z0-9]+\/metrics\.sqlite$/);
	});

	it("plans OPFS worker storage without raw-seeding chunked data", async () => {
		const adapter = makeAdapter();
		const chunkStore = await MetricsStore.open({
			location: {
				kind: "chunks",
				adapter,
				directory: `plugin/${TSDB_DIRNAME}`,
			},
			wasmBinary: WASM,
		});
		await chunkStore.ingest([
			{ labels: { [NAME]: "chunk_seed" }, ts: 3000, value: 11 },
		]);
		await chunkStore.close();

		const plan = await prepareWorkerOpfsOpenPlan({
			adapter,
			pluginDir: "plugin",
			probe: async () => ({ ok: true }),
		});

		expect(plan?.backend).toBe("worker-opfs");
		expect(plan?.dbName).toBe("plugin/metrics.sqlite");
		expect(
			await findLegacyStorageMigrationSource({
				adapter,
				pluginDir: "plugin",
			})
		).toMatchObject({ backend: "chunks", label: "vault chunks" });
	});

	it("leaves chunked data untouched while planning OPFS", async () => {
		const adapter = makeAdapter();
		adapter.files.set(
			`plugin/${TSDB_DIRNAME}/${DEFAULT_CHUNK_DB_NAME}.meta`,
			JSON.stringify({ size: 4 })
		);
		adapter.files.set(
			`plugin/${TSDB_DIRNAME}/${DEFAULT_CHUNK_DB_NAME}.c0`,
			new Uint8Array([1, 2, 3, 4]).buffer
		);

		const plan = await prepareWorkerOpfsOpenPlan({
			adapter,
			pluginDir: "plugin",
			probe: async () => ({ ok: true }),
		});

		expect(plan?.backend).toBe("worker-opfs");
		expect(adapter.files.has(
			`plugin/${TSDB_DIRNAME}/${DEFAULT_CHUNK_DB_NAME}.meta`
		)).toBe(true);
		expect(adapter.files.has(
			`plugin/${TSDB_DIRNAME}/${DEFAULT_CHUNK_DB_NAME}.c0`
		)).toBe(true);
	});

	it("plans OPFS worker storage without raw-seeding a legacy snapshot", async () => {
		const adapter = makeAdapter();
		const legacy = new Uint8Array(CHUNK_SIZE + 17);
		legacy.fill(0x7d);
		adapter.files.set(
			`plugin/${LEGACY_DB_FILENAME}`,
			legacy.buffer.slice(0)
		);

		const plan = await prepareWorkerOpfsOpenPlan({
			adapter,
			pluginDir: "plugin",
			probe: async () => ({ ok: true }),
		});

		expect(plan?.backend).toBe("worker-opfs");
		expect(plan?.dbName).toBe("plugin/metrics.sqlite");
		expect(adapter.files.has(`plugin/${LEGACY_DB_FILENAME}`)).toBe(true);
	});
});

describe("migrateLegacySnapshot", () => {
	it("re-chunks a legacy whole-file snapshot and removes it", async () => {
		const adapter = makeAdapter();
		const legacy = new Uint8Array(CHUNK_SIZE + 1234);
		for (let i = 0; i < legacy.length; i++) legacy[i] = i % 251;
		adapter.files.set("plugin/metrics.db", legacy.buffer.slice(0));

		const migrated = await migrateLegacySnapshot(
			adapter,
			"plugin/metrics.db",
			"tsdb",
			"metrics"
		);
		expect(migrated).toBe(true);
		expect(adapter.files.has("plugin/metrics.db")).toBe(false);
		expect(JSON.parse(adapter.files.get("tsdb/metrics.meta") as string)).toEqual(
			{ size: legacy.length }
		);
		const chunk0 = new Uint8Array(
			adapter.files.get("tsdb/metrics.c0") as ArrayBuffer
		);
		expect(chunk0[100]).toBe(100 % 251);
		expect(adapter.files.has("tsdb/metrics.c1")).toBe(true);

		// Second run is a no-op.
		expect(
			await migrateLegacySnapshot(adapter, "plugin/metrics.db", "tsdb", "metrics")
		).toBe(false);
	});
});
