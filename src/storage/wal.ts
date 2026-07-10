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

export interface WalReplayOptions {
	/** Return false to stop replay after the current batch finishes. */
	shouldContinue?: () => boolean;
	/** Yield to the event loop every N valid batches. */
	yieldEveryBatches?: number;
}

export interface WalReplayResult {
	samples: number;
	batches: number;
	bytes: number;
	aborted: boolean;
}

/**
 * Write-ahead log for scraped samples.
 *
 * SQLite commits are already durable through the active VFS. This log is a
 * second recovery net for scrape batches: every committed batch is appended as
 * one JSON line, replayed idempotently on startup, and periodically truncated
 * after all pending appends have landed.
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
	async replayInto(
		target: SampleSink,
		options: WalReplayOptions = {}
	): Promise<number> {
		return (await this.replayIntoWithStats(target, options)).samples;
	}

	async replayIntoWithStats(
		target: SampleSink,
		options: WalReplayOptions = {}
	): Promise<WalReplayResult> {
		if (!(await this.adapter.exists(this.path))) {
			return { samples: 0, batches: 0, bytes: 0, aborted: false };
		}
		let text: string;
		try {
			text = await this.adapter.read(this.path);
		} catch (error) {
			console.warn("tsdb: could not read WAL", error);
			return { samples: 0, batches: 0, bytes: 0, aborted: false };
		}
		let samplesReplayed = 0;
		let batchesReplayed = 0;
		let offset = 0;
		const yieldEveryBatches = Math.max(1, options.yieldEveryBatches ?? 25);
		while (offset < text.length) {
			if (options.shouldContinue && !options.shouldContinue()) {
				return {
					samples: samplesReplayed,
					batches: batchesReplayed,
					bytes: text.length,
					aborted: true,
				};
			}
			const newline = text.indexOf("\n", offset);
			const end = newline === -1 ? text.length : newline;
			const trimmed = text.slice(offset, end).trim();
			offset = newline === -1 ? text.length : newline + 1;
			if (!trimmed) continue;
			try {
				const samples = JSON.parse(trimmed) as StoredSample[];
				if (Array.isArray(samples) && samples.length > 0) {
					await target.ingest(samples);
					samplesReplayed += samples.length;
					batchesReplayed++;
					if (batchesReplayed % yieldEveryBatches === 0) {
						await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
					}
				}
			} catch {
				// Torn or corrupt line — skip it, keep the rest.
			}
		}
		return {
			samples: samplesReplayed,
			batches: batchesReplayed,
			bytes: text.length,
			aborted: false,
		};
	}

	/** Wait for all pending appends to reach the file. */
	async barrier(): Promise<void> {
		await this.queue;
	}

	/**
	 * Clear the log. Callers must only truncate entries that are covered by
	 * committed SQLite transactions: check that `epoch` is unchanged between
	 * waiting for pending appends and
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
