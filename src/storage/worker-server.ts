import type { MetricsStoreLike } from "./store";
import { PromQLError } from "../promql/ast";
import { PromQLEngine } from "../promql/engine";
import type {
	WorkerRequestClass,
	WorkerStoreRequest,
	WorkerStoreResponse,
} from "./worker-protocol";

export interface WorkerStoreServerTransport {
	post(response: WorkerStoreResponse): void;
	onMessage(listener: (request: WorkerStoreRequest) => void): () => void;
}

export type WorkerStoreOpenRequest = Extract<
	WorkerStoreRequest,
	{ op: "open" }
>;

export type WorkerStoreOpenHandler = (
	request: WorkerStoreOpenRequest
) => Promise<MetricsStoreLike>;

interface QueuedRequest {
	request: WorkerStoreRequest;
	queuedAt: number;
	requestClass: WorkerRequestClass;
}

export class WorkerStoreServer {
	private store: MetricsStoreLike | null = null;
	private queryEngine: PromQLEngine | null = null;
	private foregroundQueue: QueuedRequest[] = [];
	private maintenanceQueue: QueuedRequest[] = [];
	private dispatching = false;
	private unsubscribe: (() => void) | null;
	private closed = false;

	constructor(
		private transport: WorkerStoreServerTransport,
		private openStore: WorkerStoreOpenHandler
	) {
		this.unsubscribe = transport.onMessage((request) =>
			this.handleRequest(request)
		);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		const store = this.store;
		this.store = null;
		this.queryEngine = null;
		void store?.close().catch((error) => {
			console.warn("tsdb: worker store server close failed", error);
		});
	}

	private handleRequest(request: WorkerStoreRequest): void {
		if (this.closed) {
			this.transport.post({
				id: request.id,
				ok: false,
				error: "tsdb: worker store server is closed",
			});
			return;
		}
		const requestClass = isMaintenanceRequest(request)
			? "maintenance"
			: "foreground";
		const queue =
			requestClass === "maintenance"
				? this.maintenanceQueue
				: this.foregroundQueue;
		queue.push({
			request,
			queuedAt: performance.now(),
			requestClass,
		});
		this.drainQueue();
	}

	private drainQueue(): void {
		if (this.dispatching) return;
		const queued =
			this.foregroundQueue.shift() ?? this.maintenanceQueue.shift();
		if (!queued) return;
		const { request } = queued;
		const started = performance.now();
		const timingBase = {
			op: request.op,
			requestClass: queued.requestClass,
			queueWaitMs: started - queued.queuedAt,
			foregroundQueueDepth: this.foregroundQueue.length,
			maintenanceQueueDepth: this.maintenanceQueue.length,
		};
		this.dispatching = true;
		const run = this.dispatch(request);
		void run.then(
			(value) =>
				this.transport.post({
					id: request.id,
					ok: true,
					value,
					timing: {
						...timingBase,
						durationMs: performance.now() - started,
					},
				}),
			(error) => {
				const message = error instanceof Error ? error.message : String(error);
				this.transport.post(
					error instanceof PromQLError
						? {
								id: request.id,
								ok: false,
								error: message,
								errorType: error.errorType,
								timing: {
									...timingBase,
									durationMs: performance.now() - started,
								},
						  }
						: {
								id: request.id,
								ok: false,
								error: message,
								timing: {
									...timingBase,
									durationMs: performance.now() - started,
								},
						  }
				);
			}
		).finally(() => {
			this.dispatching = false;
			this.drainQueue();
		});
	}

	private async dispatch(request: WorkerStoreRequest) {
		switch (request.op) {
			case "open": {
				if (this.store) await this.store.close();
				this.store = await this.openStore(request);
				this.queryEngine = new PromQLEngine(this.store);
				return {
					recoveredFromCorruption: this.store.recoveredFromCorruption,
				};
			}
			case "close": {
				const store = this.store;
				this.store = null;
				this.queryEngine = null;
				await store?.close();
				return undefined;
			}
			case "ingest":
				return this.requireStore().ingest(request.samples);
			case "importSamples":
				return this.requireStore().importSamples(request.samples);
			case "select":
				return this.requireStore().select(
					request.matchers,
					request.startMs,
					request.endMs
				);
			case "seriesMatching":
				return this.requireStore().seriesMatching(
					request.matchers,
					request.startMs,
					request.endMs
				);
			case "labelNames":
				return this.requireStore().labelNames(request.matchers);
			case "labelValues":
				return this.requireStore().labelValues(
					request.labelName,
					request.matchers
				);
			case "deleteBefore":
				return this.requireStore().deleteBefore(request.cutoffMs);
			case "deleteBeforeBatch":
				return this.requireStore().deleteBeforeBatch(
					request.cutoffMs,
					request.maxSamples
				);
			case "compactBeforeBatch":
				return this.requireStore().compactBeforeBatch(
					request.cutoffMs,
					request.maxPoints
				);
			case "finalizeRetention":
				return this.requireStore().finalizeRetention(
					request.cutoffMs,
					request.phase
				);
			case "vacuumBatch":
				return this.requireStore().vacuumBatch(request.maxPages);
			case "quickStats":
				return this.requireStore().quickStats();
			case "stats":
				return this.requireStore().stats();
			case "instantQuery":
				return this.requireQueryEngine().instantQuery(
					request.query,
					request.timeMs
				);
			case "rangeQuery":
				return this.requireQueryEngine().rangeQuery(
					request.query,
					request.startMs,
					request.endMs,
					request.stepMs
				);
		}
	}

	private requireStore(): MetricsStoreLike {
		if (!this.store) {
			throw new Error("tsdb: worker store is not open");
		}
		return this.store;
	}

	private requireQueryEngine(): PromQLEngine {
		if (!this.queryEngine) {
			throw new Error("tsdb: worker query engine is not open");
		}
		return this.queryEngine;
	}
}

function isMaintenanceRequest(request: WorkerStoreRequest): boolean {
	return (
		request.op === "compactBeforeBatch" ||
		request.op === "deleteBeforeBatch" ||
		request.op === "finalizeRetention" ||
		request.op === "vacuumBatch"
	);
}
