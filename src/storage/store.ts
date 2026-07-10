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

export interface OpenOptions {
	/** Embedded wasm binary; omitted in tests (loaded from disk). */
	wasmBinary?: ArrayBuffer | Uint8Array;
	dbName?: string;
	location: StoreLocation;
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

const CHUNK_VFS_NAME = "tsdb-chunks";
const NODE_FILE_VFS_NAME = "tsdb-node-file";
export const DEFAULT_CHUNK_DB_NAME = "metrics";
export const DEFAULT_NODE_DB_NAME = "metrics.sqlite";

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
`;

/**
 * Time-series store on wa-sqlite (Asyncify build) over either a desktop
 * Node-backed SQLite file or the vault-adapter chunk VFS fallback.
 */
export class MetricsStore {
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
		recoveredFromCorruption: boolean
	) {
		this.sqlite3 = sqlite3;
		this.db = db;
		this.recoveredFromCorruption = recoveredFromCorruption;
	}

	get isOpen(): boolean {
		return !this.closing && !this.closed;
	}

	static async open(options: OpenOptions): Promise<MetricsStore> {
		const dbName =
			options.dbName ??
			(options.location.kind === "node-file"
				? DEFAULT_NODE_DB_NAME
				: DEFAULT_CHUNK_DB_NAME);
		const openOnce = async (
			recoveredFromCorruption: boolean
		): Promise<MetricsStore> => {
			const module: unknown = await SQLiteAsyncESMFactory(
				options.wasmBinary ? { wasmBinary: options.wasmBinary } : {}
			);
			const sqlite3 = SQLite.Factory(module);
			const vfsName =
				options.location.kind === "node-file"
					? NODE_FILE_VFS_NAME
					: CHUNK_VFS_NAME;
			sqlite3.vfs_register(createVfs(vfsName, options.location), false);
			const db = await sqlite3.open_v2(
				dbName,
				SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE,
				vfsName
			);
			const store = new MetricsStore(sqlite3, db, recoveredFromCorruption);
			await store.init();
			return store;
		};

		try {
			return await openOnce(false);
		} catch (error) {
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
				"INSERT OR REPLACE INTO samples (series_id, ts, value) VALUES (?, ?, ?)"
			);
		}
		return this.insertSampleStmt;
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
		return this.enqueue(() => this.ingestLocked(samples));
	}

	private async ingestLocked(samples: StoredSample[]): Promise<void> {
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
			const stmt = await this.getInsertSampleStmt();
			for (const row of rows) {
				const seriesId = this.seriesByKey.get(row.seriesKey)?.id;
				if (seriesId === undefined) {
					throw new Error("tsdb: series cache miss during ingest");
				}
				this.sqlite3.bind_collection(stmt, [seriesId, row.ts, row.value]);
				try {
					await this.sqlite3.step(stmt);
				} finally {
					await this.resetPreparedStatement(stmt);
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

		const result: SeriesData[] = [];
		await this.withStatement(
			"SELECT ts, value FROM samples WHERE series_id = ? AND ts >= ? AND ts <= ? ORDER BY ts",
			async (stmt) => {
				for (const series of matched) {
					this.sqlite3.bind_collection(stmt, [
						series.id,
						Math.floor(startMs),
						Math.ceil(endMs),
					]);
					const points: Point[] = [];
					while ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
						const row = this.sqlite3.row(stmt);
						points.push({ t: row[0] as number, v: row[1] as number });
					}
					await this.sqlite3.reset(stmt);
					if (points.length > 0) {
						result.push({ labels: series.labels, points });
					}
				}
			}
		);
		return result;
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
			await this.withStatement(
				"DELETE FROM samples WHERE ts < ?",
				async (stmt) => {
					this.sqlite3.bind_collection(stmt, [Math.floor(cutoffMs)]);
					await this.sqlite3.step(stmt);
				}
			);
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
		const stmts = [this.insertSeriesStmt, this.insertSampleStmt];
		this.insertSeriesStmt = null;
		this.insertSampleStmt = null;
		for (const stmt of stmts) {
			if (stmt !== null) await this.sqlite3.finalize(stmt);
		}
	}
}

function createVfs(vfsName: string, location: StoreLocation) {
	if (location.kind === "node-file") {
		return new NodeFileVFS(vfsName, location.directory);
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
