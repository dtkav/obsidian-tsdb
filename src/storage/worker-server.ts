import type { MetricsStoreLike } from "./store";
import type {
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

export class WorkerStoreServer {
	private store: MetricsStoreLike | null = null;
	private queue: Promise<unknown> = Promise.resolve();
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
		const run = this.queue.then(
			() => this.dispatch(request),
			() => this.dispatch(request)
		);
		this.queue = run.then(
			() => undefined,
			() => undefined
		);
		void run.then(
			(value) => this.transport.post({ id: request.id, ok: true, value }),
			(error) =>
				this.transport.post({
					id: request.id,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				})
		);
	}

	private async dispatch(request: WorkerStoreRequest) {
		switch (request.op) {
			case "open": {
				if (this.store) await this.store.close();
				this.store = await this.openStore(request);
				return {
					recoveredFromCorruption: this.store.recoveredFromCorruption,
				};
			}
			case "close": {
				const store = this.store;
				this.store = null;
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
			case "quickStats":
				return this.requireStore().quickStats();
			case "stats":
				return this.requireStore().stats();
		}
	}

	private requireStore(): MetricsStoreLike {
		if (!this.store) {
			throw new Error("tsdb: worker store is not open");
		}
		return this.store;
	}
}
