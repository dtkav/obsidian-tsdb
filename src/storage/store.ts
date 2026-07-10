import * as SQLite from "wa-sqlite";
import SQLiteAsyncESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import {
	Labels,
	Matcher,
	NAME_LABEL,
	canonicalLabels,
	compileMatchers,
} from "../labels";
import { AdapterChunkVFS, ChunkAdapter } from "./chunk-vfs";
import { NodeFileVFS, deleteNodeDatabaseFiles } from "./node-file-vfs";
import {
	OPFS_VFS_NAME,
	createOpfsVfs,
	deleteOpfsDatabaseFiles,
} from "./opfs-vfs";

export interface Point {
	/** Unix milliseconds. */
	t: number;
	v: number;
}

export interface StoredSample {
	labels: Labels; // must include __name__
	ts: number; // unix ms
	value: number;
}

export interface SeriesData {
	labels: Labels; // includes __name__
	points: Point[]; // ascending by t
}

export interface StoreStats {
	seriesCount: number;
	sampleCount: number;
	oldestSampleMs: number | null;
	newestSampleMs: number | null;
	/** Logical database size (page_count × page_size). */
	sizeBytes: number;
	/** Samples ingested in the trailing hour (for growth estimates). */
	samplesLastHour: number;
}

export interface QuickStoreStats {
	seriesCount: number;
	/**
	 * Null when answering quickly would require scanning the samples table.
	 * Use stats() only in offline/explicit diagnostics that can afford a full
	 * table count.
	 */
	sampleCount: number | null;
	oldestSampleMs: number | null;
	newestSampleMs: number | null;
	sizeBytes: number;
	samplesLastHour: number | null;
}

export interface OpenOptions {
	/** Embedded wasm binary; omitted in tests (loaded from disk). */
	wasmBinary?: ArrayBuffer | Uint8Array;
	dbName?: string;
	location: StoreLocation;
	/** Disable destructive recovery when opening a database as a migration source. */
	recoverCorruption?: boolean;
}

export interface MetricsStoreLike {
	readonly isOpen: boolean;
	readonly recoveredFromCorruption: boolean;
	ingest(samples: StoredSample[]): Promise<void>;
	importSamples(samples: StoredSample[]): Promise<void>;
	select(
		matchers: Matcher[],
		startMs: number,
		endMs: number
	): Promise<SeriesData[]>;
	seriesMatching(
		matchers: Matcher[],
		startMs?: number,
		endMs?: number
	): Promise<Labels[]>;
	labelNames(matchers?: Matcher[]): Promise<string[]>;
	labelValues(labelName: string, matchers?: Matcher[]): Promise<string[]>;
	deleteBefore(cutoffMs: number): Promise<void>;
	quickStats(): Promise<QuickStoreStats>;
	stats(): Promise<StoreStats>;
	close(): Promise<void>;
}

export interface ExportSamplesOptions {
	batchSize?: number;
	adaptiveBatching?: {
		minBatchSize?: number;
		maxBatchSize?: number;
		growBelowMs?: number;
		shrinkAboveMs?: number;
	};
	onBatch(samples: StoredSample[]): Promise<void>;
	onProgress?(progress: { samples: number; batches: number }): void;
}

export interface ExportSamplesResult {
	samples: number;
	batches: number;
}

export type StoreLocation =
	| {
			kind: "chunks";
			adapter: ChunkAdapter;
			/** Folder holding the chunked database files. */
			directory: string;
	  }
	| {
			kind: "node-file";
			/** Folder holding the desktop metrics.sqlite file. */
			directory: string;
	  }
	| {
			kind: "opfs";
	  };

interface CachedSeries {
	id: number;
	labels: Labels;
}

interface IngestRow {
	labels: Labels;
	seriesKey: string;
	ts: number;
	value: number;
}

interface IngestOptions {
	updateExisting: boolean;
}

const CHUNK_VFS_NAME = "tsdb-chunks";
const NODE_FILE_VFS_NAME = "tsdb-node-file";
export const DEFAULT_CHUNK_DB_NAME = "metrics";
export const DEFAULT_NODE_DB_NAME = "metrics.sqlite";
const META_SAMPLE_COUNT = "sample_count";
const META_OLDEST_SAMPLE_MS = "oldest_sample_ms";
const META_NEWEST_SAMPLE_MS = "newest_sample_ms";
const META_ROLLUP_1M_STARTED_MS = "rollup_1m_started_ms";
const ROLLUP_BUCKET_MS = 60_000;
const SELECT_SERIES_BATCH_SIZE = 250;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS series (
	id INTEGER PRIMARY KEY,
	labels_key TEXT NOT NULL UNIQUE,
	labels_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS samples (
	series_id INTEGER NOT NULL,
	ts INTEGER NOT NULL,
	value REAL NOT NULL,
	PRIMARY KEY (series_id, ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples (ts);
CREATE TABLE IF NOT EXISTS store_meta (
	key TEXT PRIMARY KEY,
	value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sample_rollup_1m (
	bucket_ms INTEGER PRIMARY KEY,
	sample_count INTEGER NOT NULL
);
`;

/**
 * Time-series store on wa-sqlite (Asyncify build) over a desktop SQLite file,
 * worker OPFS, or the vault-adapter chunk VFS fallback.
 */
export class MetricsStore implements MetricsStoreLike {
	private sqlite3: SQLiteAPI;
	private db: number;
	readonly recoveredFromCorruption: boolean;
	private closing = false;
	private closed = false;
	private closePromise: Promise<void> | null = null;

	private seriesByKey = new Map<string, CachedSeries>();
	private allSeries: CachedSeries[] = [];
	private insertSeriesStmt: number | null = null;
	private insertSampleStmt: number | null = null;
	private updateSampleStmt: number | null = null;

	/**
	 * wa-sqlite's Asyncify build forbids reentrant calls: while one
	 * statement is suspended in VFS I/O, a second sqlite3 call corrupts the
	 * Asyncify state machine (BEGIN-in-BEGIN errors, then wasm traps). All
	 * public operations are therefore serialized through this queue.
	 */
	private queue: Promise<unknown> = Promise.resolve();

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		if (this.closing || this.closed) {
			return Promise.reject(new Error("tsdb: metrics store is closing"));
		}
		const run = this.queue.then(fn, fn);
		this.queue = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	private constructor(
		sqlite3: SQLiteAPI,
		db: number,
		recoveredFromCorruption: boolean,
		private vfs: CloseableVfs | null
	) {
		this.sqlite3 = sqlite3;
		this.db = db;
		this.recoveredFromCorruption = recoveredFromCorruption;
	}

	get isOpen(): boolean {
		return !this.closing && !this.closed;
	}

	static async open(options: OpenOptions): Promise<MetricsStore> {
		const dbName = options.dbName ?? defaultDbNameForLocation(options.location);
		const openOnce = async (
			recoveredFromCorruption: boolean
		): Promise<MetricsStore> => {
			const module: unknown = await SQLiteAsyncESMFactory(
				options.wasmBinary ? { wasmBinary: options.wasmBinary } : {}
			);
			const sqlite3 = SQLite.Factory(module);
			const vfsName = vfsNameForLocation(options.location);
			const vfs = createVfs(vfsName, options.location, dbName) as SQLiteVFS &
				CloseableVfs;
			try {
				await vfs.isReady;
				sqlite3.vfs_register(vfs, false);
				const db = await sqlite3.open_v2(
					dbName,
					SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE,
					vfsName
				);
				const store = new MetricsStore(
					sqlite3,
					db,
					recoveredFromCorruption,
					vfs
				);
				await store.init();
				return store;
			} catch (error) {
				await Promise.resolve(vfs.close?.()).catch(() => undefined);
				throw error;
			}
		};

		try {
			return await openOnce(false);
		} catch (error) {
			if (options.recoverCorruption === false) throw error;
			// Unreadable/corrupt database: wipe the active backend and start fresh.
			console.error(
				"tsdb: stored database unreadable, starting fresh",
				error
			);
			await wipeDatabaseFiles(options.location, dbName);
			return await openOnce(true);
		}
	}

	private async init(): Promise<void> {
		await this.sqlite3.exec(this.db, "PRAGMA journal_mode=PERSIST");
		await this.sqlite3.exec(this.db, "PRAGMA synchronous=NORMAL");
		await this.sqlite3.exec(this.db, "PRAGMA cache_size=-4096"); // 4 MiB
		await this.sqlite3.exec(this.db, SCHEMA);
		await this.loadSeriesCache();
		await this.initializeStatsMetadata();
	}

	/** Run `fn` against the single prepared statement in `sql`. */
	private async withStatement<T>(
		sql: string,
		fn: (stmt: number) => Promise<T>
	): Promise<T> {
		let result!: T;
		for await (const stmt of this.sqlite3.statements(this.db, sql)) {
			result = await fn(stmt);
		}
		return result;
	}

	private async prepareStatement(sql: string): Promise<number> {
		const sqlString = this.sqlite3.str_new(this.db, sql);
		try {
			const prepared = await this.sqlite3.prepare_v2(
				this.db,
				this.sqlite3.str_value(sqlString)
			);
			if (!prepared) {
				throw new Error("tsdb: SQLite did not prepare a statement");
			}
			return prepared.stmt;
		} finally {
			this.sqlite3.str_finish(sqlString);
		}
	}

	private async getInsertSeriesStmt(): Promise<number> {
		if (this.insertSeriesStmt === null) {
			this.insertSeriesStmt = await this.prepareStatement(
				"INSERT INTO series (labels_key, labels_json) VALUES (?, ?) RETURNING id"
			);
		}
		return this.insertSeriesStmt;
	}

	private async getInsertSampleStmt(): Promise<number> {
		if (this.insertSampleStmt === null) {
			this.insertSampleStmt = await this.prepareStatement(
				"INSERT OR IGNORE INTO samples (series_id, ts, value) VALUES (?, ?, ?)"
			);
		}
		return this.insertSampleStmt;
	}

	private async getUpdateSampleStmt(): Promise<number> {
		if (this.updateSampleStmt === null) {
			this.updateSampleStmt = await this.prepareStatement(
				"UPDATE samples SET value = ? WHERE series_id = ? AND ts = ?"
			);
		}
		return this.updateSampleStmt;
	}

	private async resetPreparedStatement(stmt: number): Promise<void> {
		try {
			await this.sqlite3.reset(stmt);
		} catch (error) {
			await this.discardPreparedStatement(stmt);
			throw error;
		}
	}

	private async discardPreparedStatement(stmt: number): Promise<void> {
		if (this.insertSeriesStmt === stmt) this.insertSeriesStmt = null;
		if (this.insertSampleStmt === stmt) this.insertSampleStmt = null;
		if (this.updateSampleStmt === stmt) this.updateSampleStmt = null;
		await this.sqlite3.finalize(stmt).catch(() => undefined);
	}

	private async loadSeriesCache(): Promise<void> {
		this.seriesByKey.clear();
		this.allSeries = [];
		await this.sqlite3.exec(
			this.db,
			"SELECT id, labels_key, labels_json FROM series",
			(row) => {
				const cached: CachedSeries = {
					id: row[0] as number,
					labels: JSON.parse(row[2] as string) as Labels,
				};
				this.seriesByKey.set(row[1] as string, cached);
				this.allSeries.push(cached);
			}
		);
	}

	private async initializeStatsMetadata(): Promise<void> {
		if ((await this.getMetaNumber(META_SAMPLE_COUNT)) !== null) return;

		let hasSamples = false;
		await this.sqlite3.exec(this.db, "SELECT 1 FROM samples LIMIT 1", () => {
			hasSamples = true;
		});
		if (hasSamples) return;

		await this.setMetaNumber(META_SAMPLE_COUNT, 0);
		await this.setMetaNumber(
			META_ROLLUP_1M_STARTED_MS,
			bucketStart(Date.now() - 3600_000)
		);
	}

	private async getMetaNumber(key: string): Promise<number | null> {
		let value: number | null = null;
		await this.withStatement(
			"SELECT value FROM store_meta WHERE key = ?",
			async (stmt) => {
				this.sqlite3.bind_collection(stmt, [key]);
				if ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
					value = this.sqlite3.row(stmt)[0] as number;
				}
			}
		);
		return value;
	}

	private async setMetaNumber(key: string, value: number): Promise<void> {
		await this.withStatement(
			"INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			async (stmt) => {
				this.sqlite3.bind_collection(stmt, [key, Math.trunc(value)]);
				await this.sqlite3.step(stmt);
			}
		);
	}

	private async setMetaMinNumber(key: string, value: number): Promise<void> {
		await this.withStatement(
			"INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = min(value, excluded.value)",
			async (stmt) => {
				this.sqlite3.bind_collection(stmt, [key, Math.trunc(value)]);
				await this.sqlite3.step(stmt);
			}
		);
	}

	private async setMetaMaxNumber(key: string, value: number): Promise<void> {
		await this.withStatement(
			"INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = max(value, excluded.value)",
			async (stmt) => {
				this.sqlite3.bind_collection(stmt, [key, Math.trunc(value)]);
				await this.sqlite3.step(stmt);
			}
		);
	}

	private async deleteMetaNumbers(keys: string[]): Promise<void> {
		if (keys.length === 0) return;
		await this.withStatement(
			"DELETE FROM store_meta WHERE key = ?",
			async (stmt) => {
				for (const key of keys) {
					this.sqlite3.bind_collection(stmt, [key]);
					await this.sqlite3.step(stmt);
					await this.resetPreparedStatement(stmt);
				}
			}
		);
	}

	private async incrementKnownMetaNumber(
		key: string,
		delta: number
	): Promise<boolean> {
		await this.withStatement(
			"UPDATE store_meta SET value = max(0, value + ?) WHERE key = ?",
			async (stmt) => {
				this.sqlite3.bind_collection(stmt, [Math.trunc(delta), key]);
				await this.sqlite3.step(stmt);
			}
		);
		return this.sqlite3.changes(this.db) > 0;
	}

	private async refreshKnownSampleBounds(): Promise<void> {
		let oldest: number | null = null;
		let newest: number | null = null;
		await this.sqlite3.exec(
			this.db,
			"SELECT ts FROM samples ORDER BY ts ASC LIMIT 1",
			(row) => {
				oldest = row[0] as number;
			}
		);
		await this.sqlite3.exec(
			this.db,
			"SELECT ts FROM samples ORDER BY ts DESC LIMIT 1",
			(row) => {
				newest = row[0] as number;
			}
		);
		if (oldest === null || newest === null) {
			await this.deleteMetaNumbers([
				META_OLDEST_SAMPLE_MS,
				META_NEWEST_SAMPLE_MS,
			]);
			return;
		}
		await this.setMetaNumber(META_OLDEST_SAMPLE_MS, oldest);
		await this.setMetaNumber(META_NEWEST_SAMPLE_MS, newest);
	}

	private async addRollupCounts(
		bucketCounts: Map<number, number>
	): Promise<void> {
		if (bucketCounts.size === 0) return;
		await this.withStatement(
			"INSERT INTO sample_rollup_1m (bucket_ms, sample_count) VALUES (?, ?) ON CONFLICT(bucket_ms) DO UPDATE SET sample_count = sample_count + excluded.sample_count",
			async (stmt) => {
				for (const [bucketMs, count] of bucketCounts) {
					this.sqlite3.bind_collection(stmt, [bucketMs, count]);
					await this.sqlite3.step(stmt);
					await this.resetPreparedStatement(stmt);
				}
			}
		);
	}

	private async subtractRollupCounts(
		bucketCounts: Map<number, number>
	): Promise<void> {
		if (bucketCounts.size === 0) return;
		await this.withStatement(
			"UPDATE sample_rollup_1m SET sample_count = max(0, sample_count - ?) WHERE bucket_ms = ?",
			async (stmt) => {
				for (const [bucketMs, count] of bucketCounts) {
					this.sqlite3.bind_collection(stmt, [count, bucketMs]);
					await this.sqlite3.step(stmt);
					await this.resetPreparedStatement(stmt);
				}
			}
		);
		await this.sqlite3.exec(
			this.db,
			"DELETE FROM sample_rollup_1m WHERE sample_count <= 0"
		);
	}

	private async collectRollupCountsBefore(
		cutoffMs: number
	): Promise<Map<number, number>> {
		const bucketCounts = new Map<number, number>();
		await this.withStatement(
			"SELECT ts - (ts % ?), count(*) FROM samples WHERE ts < ? GROUP BY 1",
			async (stmt) => {
				this.sqlite3.bind_collection(stmt, [
					ROLLUP_BUCKET_MS,
					Math.floor(cutoffMs),
				]);
				while ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
					const row = this.sqlite3.row(stmt);
					bucketCounts.set(row[0] as number, row[1] as number);
				}
			}
		);
		return bucketCounts;
	}

	private async createMissingSeries(rows: IngestRow[]): Promise<void> {
		const missing = new Map<string, Labels>();
		for (const row of rows) {
			if (this.seriesByKey.has(row.seriesKey)) continue;
			if (!missing.has(row.seriesKey)) missing.set(row.seriesKey, row.labels);
		}
		if (missing.size === 0) return;

		const stmt = await this.getInsertSeriesStmt();
		for (const [key, labels] of missing) {
			this.sqlite3.bind_collection(stmt, [key, JSON.stringify(labels)]);
			let id: number | null = null;
			try {
				if ((await this.sqlite3.step(stmt)) !== SQLite.SQLITE_ROW) {
					throw new Error("tsdb: SQLite did not return a series id");
				}
				id = this.sqlite3.row(stmt)[0] as number;
			} finally {
				await this.resetPreparedStatement(stmt);
			}
			if (id === null) {
				throw new Error("tsdb: SQLite did not return a series id");
			}
			const cached: CachedSeries = { id, labels };
			this.seriesByKey.set(key, cached);
			this.allSeries.push(cached);
		}
	}

	/** Append a batch of samples in one transaction (durable on commit). */
	ingest(samples: StoredSample[]): Promise<void> {
		if (samples.length === 0) return Promise.resolve();
		return this.enqueue(() =>
			this.ingestLocked(samples, { updateExisting: true })
		);
	}

	/** Copy historical samples without rewriting rows that are already present. */
	importSamples(samples: StoredSample[]): Promise<void> {
		if (samples.length === 0) return Promise.resolve();
		return this.enqueue(() =>
			this.ingestLocked(samples, { updateExisting: false })
		);
	}

	private async ingestLocked(
		samples: StoredSample[],
		options: IngestOptions
	): Promise<void> {
		const rows: IngestRow[] = [];
		for (const sample of samples) {
			if (!Number.isFinite(sample.ts)) continue;
			// SQLite stores NaN as NULL; drop such samples instead.
			if (Number.isNaN(sample.value)) continue;
			rows.push({
				labels: sample.labels,
				seriesKey: canonicalLabels(sample.labels),
				ts: Math.round(sample.ts),
				value: sample.value,
			});
		}
		if (rows.length === 0) return;

		await this.sqlite3.exec(this.db, "BEGIN");
		try {
			await this.createMissingSeries(rows);
			const insertStmt = await this.getInsertSampleStmt();
			const updateStmt = options.updateExisting
				? await this.getUpdateSampleStmt()
				: null;
			let insertedRows = 0;
			let oldestInserted: number | null = null;
			let newestInserted: number | null = null;
			const bucketCounts = new Map<number, number>();
			for (const row of rows) {
				const seriesId = this.seriesByKey.get(row.seriesKey)?.id;
				if (seriesId === undefined) {
					throw new Error("tsdb: series cache miss during ingest");
				}
				this.sqlite3.bind_collection(insertStmt, [seriesId, row.ts, row.value]);
				let inserted = false;
				try {
					await this.sqlite3.step(insertStmt);
					inserted = this.sqlite3.changes(this.db) > 0;
				} finally {
					await this.resetPreparedStatement(insertStmt);
				}
				if (inserted) {
					insertedRows++;
					oldestInserted =
						oldestInserted === null ? row.ts : Math.min(oldestInserted, row.ts);
					newestInserted =
						newestInserted === null ? row.ts : Math.max(newestInserted, row.ts);
					const bucketMs = bucketStart(row.ts);
					bucketCounts.set(bucketMs, (bucketCounts.get(bucketMs) ?? 0) + 1);
					continue;
				}

				if (updateStmt !== null) {
					this.sqlite3.bind_collection(updateStmt, [
						row.value,
						seriesId,
						row.ts,
					]);
					try {
						await this.sqlite3.step(updateStmt);
					} finally {
						await this.resetPreparedStatement(updateStmt);
					}
				}
			}
			if (insertedRows > 0) {
				const metadataKnown = await this.incrementKnownMetaNumber(
					META_SAMPLE_COUNT,
					insertedRows
				);
				if (metadataKnown) {
					if (oldestInserted !== null) {
						await this.setMetaMinNumber(
							META_OLDEST_SAMPLE_MS,
							oldestInserted
						);
					}
					if (newestInserted !== null) {
						await this.setMetaMaxNumber(
							META_NEWEST_SAMPLE_MS,
							newestInserted
						);
					}
					await this.addRollupCounts(bucketCounts);
				}
			}
			await this.sqlite3.exec(this.db, "COMMIT");
		} catch (error) {
			await this.sqlite3.exec(this.db, "ROLLBACK").catch(() => undefined);
			await this.loadSeriesCache().catch(() => undefined);
			throw error;
		}
	}

	private matchSeries(matchers: Matcher[]): CachedSeries[] {
		const predicate = compileMatchers(matchers);
		return this.allSeries.filter((series) => predicate(series.labels));
	}

	/** Matching series with raw samples in [startMs, endMs]; empty omitted. */
	select(
		matchers: Matcher[],
		startMs: number,
		endMs: number
	): Promise<SeriesData[]> {
		return this.enqueue(() => this.selectLocked(matchers, startMs, endMs));
	}

	private async selectLocked(
		matchers: Matcher[],
		startMs: number,
		endMs: number
	): Promise<SeriesData[]> {
		const matched = this.matchSeries(matchers);
		if (matched.length === 0) return [];

		const pointsBySeriesId = new Map<number, Point[]>();
		const lo = Math.floor(startMs);
		const hi = Math.ceil(endMs);
		for (let i = 0; i < matched.length; i += SELECT_SERIES_BATCH_SIZE) {
			const batch = matched.slice(i, i + SELECT_SERIES_BATCH_SIZE);
			const placeholders = batch.map(() => "?").join(",");
			await this.withStatement(
				`SELECT series_id, ts, value FROM samples WHERE series_id IN (${placeholders}) AND ts >= ? AND ts <= ? ORDER BY series_id, ts`,
				async (stmt) => {
					this.sqlite3.bind_collection(stmt, [
						...batch.map((series) => series.id),
						lo,
						hi,
					]);
					while ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
						const row = this.sqlite3.row(stmt);
						const seriesId = row[0] as number;
						const points = pointsBySeriesId.get(seriesId) ?? [];
						points.push({ t: row[1] as number, v: row[2] as number });
						pointsBySeriesId.set(seriesId, points);
					}
				}
			);
		}

		return matched.flatMap((series) => {
			const points = pointsBySeriesId.get(series.id);
			return points && points.length > 0
				? [{ labels: series.labels, points }]
				: [];
		});
	}

	seriesMatching(
		matchers: Matcher[],
		startMs?: number,
		endMs?: number
	): Promise<Labels[]> {
		return this.enqueue(() => this.seriesMatchingLocked(matchers, startMs, endMs));
	}

	private async seriesMatchingLocked(
		matchers: Matcher[],
		startMs?: number,
		endMs?: number
	): Promise<Labels[]> {
		const matched = this.matchSeries(matchers);
		if (startMs === undefined && endMs === undefined) {
			return matched.map((series) => series.labels);
		}
		const lo = Math.floor(startMs ?? 0);
		const hi = Math.ceil(endMs ?? Number.MAX_SAFE_INTEGER);
		const result: Labels[] = [];
		await this.withStatement(
			"SELECT 1 FROM samples WHERE series_id = ? AND ts >= ? AND ts <= ? LIMIT 1",
			async (stmt) => {
				for (const series of matched) {
					this.sqlite3.bind_collection(stmt, [series.id, lo, hi]);
					if ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
						result.push(series.labels);
					}
					await this.sqlite3.reset(stmt);
				}
			}
		);
		return result;
	}

	async labelNames(matchers: Matcher[] = []): Promise<string[]> {
		const source =
			matchers.length > 0 ? this.matchSeries(matchers) : this.allSeries;
		const names = new Set<string>();
		for (const series of source) {
			for (const key of Object.keys(series.labels)) names.add(key);
		}
		return Array.from(names).sort();
	}

	async labelValues(
		labelName: string,
		matchers: Matcher[] = []
	): Promise<string[]> {
		const source =
			matchers.length > 0 ? this.matchSeries(matchers) : this.allSeries;
		const values = new Set<string>();
		for (const series of source) {
			const value = series.labels[labelName];
			if (value !== undefined) values.add(value);
		}
		return Array.from(values).sort();
	}

	/** Delete samples older than the cutoff; prune series left empty. */
	deleteBefore(cutoffMs: number): Promise<void> {
		return this.enqueue(() => this.deleteBeforeLocked(cutoffMs));
	}

	private async deleteBeforeLocked(cutoffMs: number): Promise<void> {
		await this.sqlite3.exec(this.db, "BEGIN");
		try {
			const hasRollups =
				(await this.getMetaNumber(META_ROLLUP_1M_STARTED_MS)) !== null;
			const deletedBuckets = hasRollups
				? await this.collectRollupCountsBefore(cutoffMs)
				: new Map<number, number>();
			let deletedRows = 0;
			await this.withStatement(
				"DELETE FROM samples WHERE ts < ?",
				async (stmt) => {
					this.sqlite3.bind_collection(stmt, [Math.floor(cutoffMs)]);
					await this.sqlite3.step(stmt);
					deletedRows = this.sqlite3.changes(this.db);
				}
			);
			if (deletedRows > 0) {
				const metadataKnown = await this.incrementKnownMetaNumber(
					META_SAMPLE_COUNT,
					-deletedRows
				);
				if (metadataKnown) {
					await this.refreshKnownSampleBounds();
					if (hasRollups) await this.subtractRollupCounts(deletedBuckets);
				}
			}
			await this.sqlite3.exec(
				this.db,
				"DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series_id FROM samples)"
			);
			await this.sqlite3.exec(this.db, "COMMIT");
		} catch (error) {
			await this.sqlite3.exec(this.db, "ROLLBACK").catch(() => undefined);
			throw error;
		}
		await this.loadSeriesCache();
	}

	stats(): Promise<StoreStats> {
		return this.enqueue(() => this.statsLocked());
	}

	quickStats(): Promise<QuickStoreStats> {
		return this.enqueue(() => this.quickStatsLocked());
	}

	countSamples(): Promise<number> {
		return this.enqueue(() => this.countSamplesLocked());
	}

	exportSamples(options: ExportSamplesOptions): Promise<ExportSamplesResult> {
		return this.enqueue(() => this.exportSamplesLocked(options));
	}

	private async exportSamplesLocked(
		options: ExportSamplesOptions
	): Promise<ExportSamplesResult> {
		let batchSize = Math.max(1, Math.floor(options.batchSize ?? 1000));
		const adaptive = options.adaptiveBatching;
		const minBatchSize = Math.max(
			1,
			Math.floor(adaptive?.minBatchSize ?? batchSize)
		);
		const maxBatchSize = Math.max(
			minBatchSize,
			Math.floor(adaptive?.maxBatchSize ?? batchSize)
		);
		const growBelowMs = adaptive?.growBelowMs ?? 1200;
		const shrinkAboveMs = adaptive?.shrinkAboveMs ?? 8000;
		const batch: StoredSample[] = [];
		let samples = 0;
		let batches = 0;

		const flush = async () => {
			if (batch.length === 0) return;
			const pending = batch.splice(0);
			const started = Date.now();
			await options.onBatch(pending);
			const elapsedMs = Date.now() - started;
			if (adaptive) {
				if (elapsedMs < growBelowMs && batchSize < maxBatchSize) {
					batchSize = Math.min(maxBatchSize, batchSize * 2);
				} else if (elapsedMs > shrinkAboveMs && batchSize > minBatchSize) {
					batchSize = Math.max(minBatchSize, Math.floor(batchSize / 2));
				}
			}
			samples += pending.length;
			batches++;
			options.onProgress?.({ samples, batches });
		};

		await this.withStatement(
			`SELECT series.labels_json, samples.ts, samples.value
			 FROM samples
			 JOIN series ON series.id = samples.series_id
			 ORDER BY samples.series_id, samples.ts`,
			async (stmt) => {
				while ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
					const row = this.sqlite3.row(stmt);
					batch.push({
						labels: JSON.parse(row[0] as string) as Labels,
						ts: row[1] as number,
						value: row[2] as number,
					});
					if (batch.length >= batchSize) await flush();
				}
			}
		);
		await flush();
		return { samples, batches };
	}

	private async quickStatsLocked(): Promise<QuickStoreStats> {
		const stats: QuickStoreStats = {
			seriesCount: this.allSeries.length,
			sampleCount: await this.getMetaNumber(META_SAMPLE_COUNT),
			oldestSampleMs: await this.getMetaNumber(META_OLDEST_SAMPLE_MS),
			newestSampleMs: await this.getMetaNumber(META_NEWEST_SAMPLE_MS),
			sizeBytes: 0,
			samplesLastHour: null,
		};
		await this.sqlite3.exec(
			this.db,
			"SELECT (SELECT * FROM pragma_page_count()) * (SELECT * FROM pragma_page_size())",
			(row) => {
				stats.sizeBytes = (row[0] as number) ?? 0;
			}
		);
		const hourAgo = Date.now() - 3600_000;
		const rollupStartedMs = await this.getMetaNumber(
			META_ROLLUP_1M_STARTED_MS
		);
		if (rollupStartedMs !== null && rollupStartedMs <= bucketStart(hourAgo)) {
			await this.withStatement(
				"SELECT coalesce(sum(sample_count), 0) FROM sample_rollup_1m WHERE bucket_ms >= ?",
				async (stmt) => {
					this.sqlite3.bind_collection(stmt, [bucketStart(hourAgo)]);
					if ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
						stats.samplesLastHour =
							(this.sqlite3.row(stmt)[0] as number) ?? 0;
					}
				}
			);
		}
		return stats;
	}

	private async countSamplesLocked(): Promise<number> {
		let count = 0;
		await this.sqlite3.exec(this.db, "SELECT count(*) FROM samples", (row) => {
			count = (row[0] as number) ?? 0;
		});
		return count;
	}

	private async statsLocked(): Promise<StoreStats> {
		const stats: StoreStats = {
			seriesCount: 0,
			sampleCount: 0,
			oldestSampleMs: null,
			newestSampleMs: null,
			sizeBytes: 0,
			samplesLastHour: 0,
		};
		await this.sqlite3.exec(
			this.db,
			"SELECT (SELECT count(*) FROM series), count(*), min(ts), max(ts) FROM samples",
			(row) => {
				stats.seriesCount = (row[0] as number) ?? 0;
				stats.sampleCount = (row[1] as number) ?? 0;
				stats.oldestSampleMs = row[2] as number | null;
				stats.newestSampleMs = row[3] as number | null;
			}
		);
		await this.sqlite3.exec(
			this.db,
			"SELECT (SELECT * FROM pragma_page_count()) * (SELECT * FROM pragma_page_size())",
			(row) => {
				stats.sizeBytes = (row[0] as number) ?? 0;
			}
		);
		const hourAgo = Date.now() - 3600_000;
		await this.withStatement(
			"SELECT count(*) FROM samples WHERE ts >= ?",
			async (stmt) => {
				this.sqlite3.bind_collection(stmt, [hourAgo]);
				if ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
					stats.samplesLastHour = (this.sqlite3.row(stmt)[0] as number) ?? 0;
				}
			}
		);
		return stats;
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.queue
			.then(async () => {
				await this.finalizePreparedStatements();
				await this.sqlite3.close(this.db);
				await this.vfs?.close?.();
				this.vfs = null;
			})
			.then(
				() => {
					this.closed = true;
				},
				(error) => {
					this.closed = true;
					throw error;
				}
		);
		return this.closePromise;
	}

	private async finalizePreparedStatements(): Promise<void> {
		const stmts = [
			this.insertSeriesStmt,
			this.insertSampleStmt,
			this.updateSampleStmt,
		];
		this.insertSeriesStmt = null;
		this.insertSampleStmt = null;
		this.updateSampleStmt = null;
		for (const stmt of stmts) {
			if (stmt !== null) await this.sqlite3.finalize(stmt);
		}
	}
}

function bucketStart(ts: number): number {
	return Math.floor(ts / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;
}

function defaultDbNameForLocation(location: StoreLocation): string {
	return location.kind === "chunks"
		? DEFAULT_CHUNK_DB_NAME
		: DEFAULT_NODE_DB_NAME;
}

function vfsNameForLocation(location: StoreLocation): string {
	if (location.kind === "node-file") return NODE_FILE_VFS_NAME;
	if (location.kind === "opfs") return OPFS_VFS_NAME;
	return CHUNK_VFS_NAME;
}

interface CloseableVfs {
	isReady?: Promise<unknown>;
	close?: () => Promise<void> | void;
}

function createVfs(vfsName: string, location: StoreLocation, dbName: string) {
	if (location.kind === "node-file") {
		return new NodeFileVFS(vfsName, location.directory);
	}
	if (location.kind === "opfs") {
		return createOpfsVfs(dbName);
	}
	return new AdapterChunkVFS(vfsName, location.adapter, location.directory);
}

/** Remove files for the active database backend (corruption recovery). */
export async function wipeDatabaseFiles(
	location: StoreLocation,
	dbName: string
): Promise<void> {
	if (location.kind === "node-file") {
		await deleteNodeDatabaseFiles(location.directory, dbName);
		return;
	}
	if (location.kind === "opfs") {
		await deleteOpfsDatabaseFiles(dbName);
		return;
	}
	const vfs = new AdapterChunkVFS(
		CHUNK_VFS_NAME + "-wipe",
		location.adapter,
		location.directory
	);
	for (const name of [dbName, `${dbName}-journal`]) {
		try {
			await vfs.deleteStoredFile(name);
		} catch (error) {
			console.warn(`tsdb: could not wipe ${name}`, error);
		}
	}
}

export { NAME_LABEL };
