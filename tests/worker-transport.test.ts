import { describe, expect, it } from "vitest";
import {
	BrowserWorkerLike,
	BrowserWorkerStoreTransport,
} from "../src/storage/worker-transport";
import type {
	WorkerStoreRequest,
	WorkerStoreResponse,
} from "../src/storage/worker-protocol";

class FakeBrowserWorker implements BrowserWorkerLike {
	messages: Array<{
		message: WorkerStoreRequest;
		transfer?: Transferable[];
	}> = [];
	listeners = new Set<(event: { data: WorkerStoreResponse }) => void>();
	terminated = false;

	postMessage(message: WorkerStoreRequest, transfer?: Transferable[]): void {
		this.messages.push({ message, transfer });
	}

	addEventListener(
		type: "message",
		listener: (event: { data: WorkerStoreResponse }) => void
	): void {
		expect(type).toBe("message");
		this.listeners.add(listener);
	}

	removeEventListener(
		type: "message",
		listener: (event: { data: WorkerStoreResponse }) => void
	): void {
		expect(type).toBe("message");
		this.listeners.delete(listener);
	}

	terminate(): void {
		this.terminated = true;
	}

	emit(response: WorkerStoreResponse): void {
		for (const listener of this.listeners) listener({ data: response });
	}
}

describe("BrowserWorkerStoreTransport", () => {
	it("forwards requests and worker responses", () => {
		const worker = new FakeBrowserWorker();
		const transport = new BrowserWorkerStoreTransport(worker);
		const responses: WorkerStoreResponse[] = [];
		const unsubscribe = transport.onMessage((response) =>
			responses.push(response)
		);

		const transfer: Transferable[] = [new ArrayBuffer(1)];
		transport.post({ id: 1, op: "stats" }, transfer);
		expect(worker.messages).toEqual([
			{ message: { id: 1, op: "stats" }, transfer },
		]);

		worker.emit({
			id: 1,
			ok: true,
			value: {
				seriesCount: 0,
				sampleCount: 0,
				oldestSampleMs: null,
				newestSampleMs: null,
				sizeBytes: 0,
				samplesLastHour: 0,
			},
		});
		expect(responses).toHaveLength(1);

		unsubscribe();
		worker.emit({ id: 2, ok: false, error: "ignored" });
		expect(responses).toHaveLength(1);
	});

	it("terminates once and runs the close callback", () => {
		const worker = new FakeBrowserWorker();
		let closeCount = 0;
		const transport = new BrowserWorkerStoreTransport(worker, () => {
			closeCount++;
		});

		transport.close();
		transport.close();

		expect(worker.terminated).toBe(true);
		expect(closeCount).toBe(1);
		expect(() => transport.post({ id: 1, op: "stats" })).toThrow(/closed/);
	});
});
