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
	adapter: ChunkAdapter;
	/** Folder holding the chunked database files. */
	directory: string;
	/** Embedded wasm binary; omitted in tests (loaded from disk). */
	wasmBinary?: ArrayBuffer | Uint8Array;
	dbName?: string;
}

interface CachedSeries {
	id: number;
	labels: Labels;
}

const VFS_NAME = "tsdb-chunks";
const DEFAULT_DB_NAME = "metrics";

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
 * Time-series store on wa-sqlite (Asyncify build) over the chunked
 * vault-adapter VFS: every committed transaction is persisted incrementally
 * through SQLite's own journal — no whole-image snapshots, no Node APIs.
 */
export class MetricsStore {
	private sqlite3: SQLiteAPI;
	private db: number;

	private seriesByKey = new Map<string, CachedSeries>();
	private allSeries: CachedSeries[] = [];

	/**
	 * wa-sqlite's Asyncify build forbids reentrant calls: while one
	 * statement is suspended in VFS I/O, a second sqlite3 call corrupts the
	 * Asyncify state machine (BEGIN-in-BEGIN errors, then wasm traps). All
	 * public operations are therefore serialized through this queue.
	 */
	private queue: Promise<unknown> = Promise.resolve();

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	private constructor(sqlite3: SQLiteAPI, db: number) {
		this.sqlite3 = sqlite3;
		this.db = db;
	}

	static async open(options: OpenOptions): Promise<MetricsStore> {
		const dbName = options.dbName ?? DEFAULT_DB_NAME;
		const openOnce = async (): Promise<MetricsStore> => {
			const module = await SQLiteAsyncESMFactory(
				options.wasmBinary ? { wasmBinary: options.wasmBinary } : {}
			);
			const sqlite3 = SQLite.Factory(module);
			sqlite3.vfs_register(
				new AdapterChunkVFS(VFS_NAME, options.adapter, options.directory),
				false
			);
			const db = await sqlite3.open_v2(
				dbName,
				SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE,
				VFS_NAME
			);
			const store = new MetricsStore(sqlite3, db);
			await store.init();
			return store;
		};

		try {
			return await openOnce();
		} catch (error) {
			// Unreadable/corrupt database: wipe the chunk files and start fresh.
			console.error(
				"tsdb: stored database unreadable, starting fresh",
				error
			);
			await wipeDatabaseFiles(options.adapter, options.directory, dbName);
			return await openOnce();
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

	private async loadSeriesCache(): Promise<void> {
		this.seriesByKey.clear();
		this.allSeries = [];
		await this.sqlite3.exec(
			this.db,
			"SELECT id, labels_key, labels_json FROM series",
			(row) => {
				const cached: CachedSeries = {
					id: row[0] as number,
					labels: JSON.parse(row[2] as string),
				};
				this.seriesByKey.set(row[1] as string, cached);
				this.allSeries.push(cached);
			}
		);
	}

	private async getOrCreateSeries(labels: Labels): Promise<number> {
		const key = canonicalLabels(labels);
		const existing = this.seriesByKey.get(key);
		if (existing) return existing.id;

		const id = await this.withStatement(
			"INSERT INTO series (labels_key, labels_json) VALUES (?, ?) RETURNING id",
			async (stmt) => {
				this.sqlite3.bind_collection(stmt, [key, JSON.stringify(labels)]);
				await this.sqlite3.step(stmt);
				return this.sqlite3.row(stmt)[0] as number;
			}
		);
		const cached: CachedSeries = { id, labels };
		this.seriesByKey.set(key, cached);
		this.allSeries.push(cached);
		return cached.id;
	}

	/** Append a batch of samples in one transaction (durable on commit). */
	ingest(samples: StoredSample[]): Promise<void> {
		if (samples.length === 0) return Promise.resolve();
		return this.enqueue(() => this.ingestLocked(samples));
	}

	private async ingestLocked(samples: StoredSample[]): Promise<void> {
		await this.sqlite3.exec(this.db, "BEGIN");
		try {
			await this.withStatement(
				"INSERT OR REPLACE INTO samples (series_id, ts, value) VALUES (?, ?, ?)",
				async (stmt) => {
					for (const sample of samples) {
						if (!Number.isFinite(sample.ts)) continue;
						// SQLite stores NaN as NULL; drop such samples instead.
						if (Number.isNaN(sample.value)) continue;
						const seriesId = await this.getOrCreateSeries(sample.labels);
						this.sqlite3.bind_collection(stmt, [
							seriesId,
							Math.round(sample.ts),
							sample.value,
						]);
						await this.sqlite3.step(stmt);
						await this.sqlite3.reset(stmt);
					}
				}
			);
			await this.sqlite3.exec(this.db, "COMMIT");
		} catch (error) {
			await this.sqlite3.exec(this.db, "ROLLBACK").catch(() => undefined);
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
		return this.enqueue(() => this.sqlite3.close(this.db).then(() => undefined));
	}
}

/** Remove all chunk/meta files of a database (corruption recovery). */
export async function wipeDatabaseFiles(
	adapter: ChunkAdapter,
	directory: string,
	dbName: string
): Promise<void> {
	const vfs = new AdapterChunkVFS(VFS_NAME + "-wipe", adapter, directory);
	for (const name of [dbName, `${dbName}-journal`]) {
		try {
			await vfs.deleteStoredFile(name);
		} catch (error) {
			console.warn(`tsdb: could not wipe ${name}`, error);
		}
	}
}

export { NAME_LABEL };
