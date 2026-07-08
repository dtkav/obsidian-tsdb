import { StoredSample } from "./store";

/** Subset of Obsidian's DataAdapter that the WAL needs (fakeable in tests). */
export interface WalAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	append(path: string, data: string): Promise<void>;
	write(path: string, data: string): Promise<void>;
}

export interface SampleSink {
	ingest(samples: StoredSample[]): void | Promise<void>;
}

/**
 * Write-ahead log for scraped samples.
 *
 * sql.js keeps the whole database in memory; persisting it means rewriting
 * the full file image, which is too expensive to do per scrape. Instead,
 * every ingested batch is appended here as one JSON line, making samples
 * durable immediately. On startup the log is replayed into the store
 * (idempotent: the store overwrites duplicate (series, ts) pairs), and the
 * log is truncated after each successful snapshot flush.
 */
export class SampleWal {
	private adapter: WalAdapter;
	private path: string;
	/** Serializes appends/truncations so lines never interleave. */
	private queue: Promise<void> = Promise.resolve();
	/** Bumped on every append; lets the flusher detect concurrent writes. */
	private appendEpoch = 0;

	constructor(adapter: WalAdapter, path: string) {
		this.adapter = adapter;
		this.path = path;
	}

	get epoch(): number {
		return this.appendEpoch;
	}

	/** Fire-and-forget append; failures are logged, never thrown. */
	append(samples: StoredSample[]): void {
		if (samples.length === 0) return;
		this.appendEpoch++;
		const line = JSON.stringify(samples) + "\n";
		this.queue = this.queue
			.then(() => this.adapter.append(this.path, line))
			.catch((error) => {
				console.error("tsdb: WAL append failed", error);
			});
	}

	/**
	 * Replay logged samples into the store. Unparseable lines (e.g. a line
	 * torn by a crash mid-append) are skipped. Returns the sample count.
	 */
	async replayInto(target: SampleSink): Promise<number> {
		if (!(await this.adapter.exists(this.path))) return 0;
		let text: string;
		try {
			text = await this.adapter.read(this.path);
		} catch (error) {
			console.warn("tsdb: could not read WAL", error);
			return 0;
		}
		let count = 0;
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const samples = JSON.parse(trimmed) as StoredSample[];
				if (Array.isArray(samples) && samples.length > 0) {
					await target.ingest(samples);
					count += samples.length;
				}
			} catch {
				// Torn or corrupt line — skip it, keep the rest.
			}
		}
		return count;
	}

	/** Wait for all pending appends to reach the file. */
	async barrier(): Promise<void> {
		await this.queue;
	}

	/**
	 * Clear the log. Callers must only truncate entries that are covered by
	 * a snapshot: check that `epoch` is unchanged between snapshotting and
	 * truncating, and skip otherwise (the next flush picks them up; replay
	 * being idempotent makes late truncation safe, early truncation is not).
	 */
	async truncate(): Promise<void> {
		this.queue = this.queue
			.then(() => this.adapter.write(this.path, ""))
			.catch((error) => {
				console.error("tsdb: WAL truncate failed", error);
			});
		await this.queue;
	}
}
