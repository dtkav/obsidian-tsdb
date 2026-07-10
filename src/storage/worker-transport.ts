import type { WorkerStoreTransport } from "./worker-store";
import type { WorkerStoreRequest, WorkerStoreResponse } from "./worker-protocol";

export interface BrowserWorkerLike {
	postMessage(message: WorkerStoreRequest, transfer?: Transferable[]): void;
	addEventListener(
		type: "message",
		listener: (event: { data: WorkerStoreResponse }) => void
	): void;
	removeEventListener(
		type: "message",
		listener: (event: { data: WorkerStoreResponse }) => void
	): void;
	terminate(): void;
}

export class BrowserWorkerStoreTransport implements WorkerStoreTransport {
	private closed = false;

	constructor(
		private worker: BrowserWorkerLike,
		private onClose?: () => void
	) {}

	post(message: WorkerStoreRequest, transfer?: Transferable[]): void {
		if (this.closed) throw new Error("tsdb: worker transport is closed");
		this.worker.postMessage(message, transfer);
	}

	onMessage(listener: (response: WorkerStoreResponse) => void): () => void {
		const handler = (event: { data: WorkerStoreResponse }) => {
			listener(event.data);
		};
		this.worker.addEventListener("message", handler);
		return () => this.worker.removeEventListener("message", handler);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.worker.terminate();
		this.onClose?.();
	}
}

export function createInlineWorkerStoreTransport(
	source: string
): WorkerStoreTransport {
	const url = URL.createObjectURL(
		new Blob([source], { type: "text/javascript" })
	);
	const worker = new Worker(url);
	return new BrowserWorkerStoreTransport(worker, () =>
		URL.revokeObjectURL(url)
	);
}
