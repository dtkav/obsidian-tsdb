import type { Labels, Matcher } from "../labels";
import { PromQLError } from "../promql/ast";
import type { ApiResultData, PromQLQueryEngine } from "../promql/engine";
import type {
	MetricsStoreLike,
	QuickStoreStats,
	RetentionDeleteResult,
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

export const WORKER_STORE_CLOSE_TIMEOUT_MS = 10000;
export const WORKER_STORE_DRAIN_TIMEOUT_MS = 60000;
export const WORKER_STORE_OPEN_TIMEOUT_MS = 60000;

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

export class WorkerMetricsStore implements MetricsStoreLike, PromQLQueryEngine {
	private nextRequestId = 1;
	private pending = new Map<number, PendingRequest>();
	private idleWaiters = new Set<() => void>();
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
		let timeoutId: number | null = null;
		try {
			const request = store.request<WorkerStoreOpenResult>(
				{
					op: "open",
					dbName: options.dbName,
					wasmBinary,
				},
				transfer
			);
			const timeout = new Promise<never>((_resolve, reject) => {
				timeoutId = window.setTimeout(() => {
					reject(new Error("tsdb: worker store open timed out"));
				}, WORKER_STORE_OPEN_TIMEOUT_MS);
			});
			const result = await Promise.race([request, timeout]);
			store.recovered = result.recoveredFromCorruption;
			return store;
		} catch (error) {
			store.forceClose(error);
			throw error;
		} finally {
			if (timeoutId !== null) window.clearTimeout(timeoutId);
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

	deleteBeforeBatch(
		cutoffMs: number,
		maxSamples: number
	): Promise<RetentionDeleteResult> {
		return this.request<RetentionDeleteResult>({
			op: "deleteBeforeBatch",
			cutoffMs,
			maxSamples,
		});
	}

	quickStats(): Promise<QuickStoreStats> {
		return this.request<QuickStoreStats>({ op: "quickStats" });
	}

	stats(): Promise<StoreStats> {
		return this.request<StoreStats>({ op: "stats" });
	}

	instantQuery(query: string, timeMs: number): Promise<ApiResultData> {
		return this.request<ApiResultData>({ op: "instantQuery", query, timeMs });
	}

	rangeQuery(
		query: string,
		startMs: number,
		endMs: number,
		stepMs: number
	): Promise<ApiResultData> {
		return this.request<ApiResultData>({
			op: "rangeQuery",
			query,
			startMs,
			endMs,
			stepMs,
		});
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		if (this.closed) return Promise.resolve();
		this.closing = true;
		this.closePromise = this.closeAfterPendingRequests();
		return this.closePromise;
	}

	private async closeAfterPendingRequests(): Promise<void> {
		if (this.pending.size > 0) {
			const drained = await this.waitForIdle(WORKER_STORE_DRAIN_TIMEOUT_MS);
			if (!drained) {
				console.warn(
					"tsdb: worker store drain timed out; terminating worker"
				);
				this.forceClose(new Error("tsdb: worker store drain timed out"));
				return;
			}
		}

		const closeRequest = this.request<void>({ op: "close" }, undefined, true).catch(
			(error) => {
				if (!this.closed) {
					console.warn("tsdb: worker store close failed", error);
				}
			}
		);
		let timeoutId: number | null = null;
		const timeout = new Promise<void>((resolve) => {
			timeoutId = window.setTimeout(() => {
				console.warn("tsdb: worker store close timed out; terminating worker");
				resolve();
			}, WORKER_STORE_CLOSE_TIMEOUT_MS);
		});
		await Promise.race([closeRequest, timeout]);
		if (timeoutId !== null) window.clearTimeout(timeoutId);
		this.forceClose(new Error("tsdb: worker store closed"));
	}

	private waitForIdle(timeoutMs: number): Promise<boolean> {
		if (this.pending.size === 0) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (idle: boolean) => {
				if (settled) return;
				settled = true;
				this.idleWaiters.delete(onIdle);
				window.clearTimeout(timeoutId);
				resolve(idle);
			};
			const onIdle = () => finish(true);
			const timeoutId = window.setTimeout(() => finish(false), timeoutMs);
			this.idleWaiters.add(onIdle);
		});
	}

	private notifyIdle(): void {
		if (this.pending.size > 0) return;
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
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
		const message: WorkerStoreRequest = { id, ...body };
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
		this.notifyIdle();
		if (response.ok) {
			pending.resolve(response.value);
		} else {
			pending.reject(
				response.errorType
					? new PromQLError(response.error, response.errorType)
					: new Error(response.error)
			);
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
		this.notifyIdle();
		this.transport.close();
	}
}

function copyBytes(bytes: Uint8Array | ArrayBuffer): Uint8Array {
	return bytes instanceof Uint8Array
		? new Uint8Array(bytes)
		: new Uint8Array(bytes.slice(0));
}
