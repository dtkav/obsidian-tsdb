import type { Labels, Matcher } from "../labels";
import type {
	MetricsStoreLike,
	QuickStoreStats,
	SeriesData,
	StoredSample,
	StoreStats,
} from "./store";
import type {
	WorkerStoreOpenResult,
	WorkerStoreRequest,
	WorkerStoreRequestBody,
	WorkerStoreResponse,
} from "./worker-protocol";

export const WORKER_STORE_CLOSE_TIMEOUT_MS = 2000;

export interface WorkerStoreTransport {
	post(message: WorkerStoreRequest, transfer?: Transferable[]): void;
	onMessage(listener: (response: WorkerStoreResponse) => void): () => void;
	close(): void;
}

export interface WorkerMetricsStoreOpenOptions {
	dbName: string;
	wasmBinary: Uint8Array | ArrayBuffer;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export class WorkerMetricsStore implements MetricsStoreLike {
	private nextRequestId = 1;
	private pending = new Map<number, PendingRequest>();
	private unsubscribe: (() => void) | null;
	private closing = false;
	private closed = false;
	private closePromise: Promise<void> | null = null;
	private recovered = false;

	private constructor(private transport: WorkerStoreTransport) {
		this.unsubscribe = transport.onMessage((response) =>
			this.handleResponse(response)
		);
	}

	static async open(
		transport: WorkerStoreTransport,
		options: WorkerMetricsStoreOpenOptions
	): Promise<WorkerMetricsStore> {
		const store = new WorkerMetricsStore(transport);
		const wasmBinary = copyBytes(options.wasmBinary);
		const transfer: Transferable[] = [wasmBinary.buffer as ArrayBuffer];
		try {
			const result = await store.request<WorkerStoreOpenResult>(
				{
					op: "open",
					dbName: options.dbName,
					wasmBinary,
				},
				transfer
			);
			store.recovered = result.recoveredFromCorruption;
			return store;
		} catch (error) {
			store.forceClose(error);
			throw error;
		}
	}

	get isOpen(): boolean {
		return !this.closing && !this.closed;
	}

	get recoveredFromCorruption(): boolean {
		return this.recovered;
	}

	ingest(samples: StoredSample[]): Promise<void> {
		if (samples.length === 0) return Promise.resolve();
		return this.request<void>({ op: "ingest", samples });
	}

	importSamples(samples: StoredSample[]): Promise<void> {
		if (samples.length === 0) return Promise.resolve();
		return this.request<void>({ op: "importSamples", samples });
	}

	select(
		matchers: Matcher[],
		startMs: number,
		endMs: number
	): Promise<SeriesData[]> {
		return this.request<SeriesData[]>({
			op: "select",
			matchers,
			startMs,
			endMs,
		});
	}

	seriesMatching(
		matchers: Matcher[],
		startMs?: number,
		endMs?: number
	): Promise<Labels[]> {
		return this.request<Labels[]>({
			op: "seriesMatching",
			matchers,
			startMs,
			endMs,
		});
	}

	labelNames(matchers?: Matcher[]): Promise<string[]> {
		return this.request<string[]>({ op: "labelNames", matchers });
	}

	labelValues(labelName: string, matchers?: Matcher[]): Promise<string[]> {
		return this.request<string[]>({ op: "labelValues", labelName, matchers });
	}

	deleteBefore(cutoffMs: number): Promise<void> {
		return this.request<void>({ op: "deleteBefore", cutoffMs });
	}

	quickStats(): Promise<QuickStoreStats> {
		return this.request<QuickStoreStats>({ op: "quickStats" });
	}

	stats(): Promise<StoreStats> {
		return this.request<StoreStats>({ op: "stats" });
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		if (this.closed) return Promise.resolve();
		this.closing = true;
		const closeRequest = this.request<void>({ op: "close" }, undefined, true).catch(
			(error) => {
				console.warn("tsdb: worker store close failed", error);
			}
		);
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		const timeout = new Promise<void>((resolve) => {
			timeoutId = setTimeout(() => {
				console.warn("tsdb: worker store close timed out; terminating worker");
				resolve();
			}, WORKER_STORE_CLOSE_TIMEOUT_MS);
		});
		this.closePromise = Promise.race([closeRequest, timeout]).then(() => {
			if (timeoutId !== null) clearTimeout(timeoutId);
			this.forceClose(new Error("tsdb: worker store closed"));
		});
		return this.closePromise;
	}

	private request<T>(
		body: WorkerStoreRequestBody,
		transfer?: Transferable[],
		allowWhileClosing = false
	): Promise<T> {
		if (this.closed || (this.closing && !allowWhileClosing)) {
			return Promise.reject(new Error("tsdb: worker store is closing"));
		}
		const id = this.nextRequestId++;
		const message = { id, ...body } as WorkerStoreRequest;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
			});
			try {
				this.transport.post(message, transfer);
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private handleResponse(response: WorkerStoreResponse): void {
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.pending.delete(response.id);
		if (response.ok) {
			pending.resolve(response.value);
		} else {
			pending.reject(new Error(response.error));
		}
	}

	private forceClose(reason: unknown): void {
		if (this.closed) return;
		this.closed = true;
		this.closing = false;
		this.unsubscribe?.();
		this.unsubscribe = null;
		const error = reason instanceof Error ? reason : new Error(String(reason));
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
		this.transport.close();
	}
}

function copyBytes(bytes: Uint8Array | ArrayBuffer): Uint8Array {
	return bytes instanceof Uint8Array
		? new Uint8Array(bytes)
		: new Uint8Array(bytes.slice(0));
}
