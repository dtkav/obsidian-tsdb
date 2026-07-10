import { afterEach, describe, expect, it, vi } from "vitest";
import {
	WORKER_STORE_CLOSE_TIMEOUT_MS,
	WorkerMetricsStore,
	WorkerStoreTransport,
} from "../src/storage/worker-store";
import type {
	WorkerStoreRequest,
	WorkerStoreResponse,
	WorkerStoreResult,
} from "../src/storage/worker-protocol";

class FakeTransport implements WorkerStoreTransport {
	messages: Array<{
		message: WorkerStoreRequest;
		transfer?: Transferable[];
	}> = [];
	closed = false;
	private listener: ((response: WorkerStoreResponse) => void) | null = null;

	post(message: WorkerStoreRequest, transfer?: Transferable[]): void {
		if (this.closed) throw new Error("transport closed");
		this.messages.push({ message, transfer });
	}

	onMessage(listener: (response: WorkerStoreResponse) => void): () => void {
		this.listener = listener;
		return () => {
			if (this.listener === listener) this.listener = null;
		};
	}

	close(): void {
		this.closed = true;
	}

	last(): WorkerStoreRequest {
		return this.messages[this.messages.length - 1].message;
	}

	lastTransfer(): Transferable[] | undefined {
		return this.messages[this.messages.length - 1].transfer;
	}

	resolve(id: number, value: WorkerStoreResult = undefined): void {
		this.listener?.({ id, ok: true, value });
	}

	reject(id: number, error: string): void {
		this.listener?.({ id, ok: false, error });
	}
}

async function openStore(recoveredFromCorruption = false): Promise<{
	store: WorkerMetricsStore;
	transport: FakeTransport;
}> {
	const transport = new FakeTransport();
	const opening = WorkerMetricsStore.open(transport, {
		dbName: "metrics",
		wasmBinary: new Uint8Array([1, 2, 3]),
	});
	const openMessage = transport.last();
	expect(openMessage.op).toBe("open");
	transport.resolve(openMessage.id, { recoveredFromCorruption });
	return {
		store: await opening,
		transport,
	};
}

describe("WorkerMetricsStore", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("opens through the worker transport and transfers cloned byte buffers", async () => {
		const transport = new FakeTransport();
		const wasmBinary = new Uint8Array([1, 2, 3]);

		const opening = WorkerMetricsStore.open(transport, {
			dbName: "metrics",
			wasmBinary,
		});

		const message = transport.last();
		expect(message.op).toBe("open");
		if (message.op !== "open") throw new Error("unexpected op");
		expect(message.dbName).toBe("metrics");
		expect(message.wasmBinary).toEqual(wasmBinary);
		expect(message.wasmBinary).not.toBe(wasmBinary);
		expect(transport.lastTransfer()).toHaveLength(1);

		transport.resolve(message.id, { recoveredFromCorruption: true });
		const store = await opening;
		expect(store.recoveredFromCorruption).toBe(true);
		expect(store.isOpen).toBe(true);
	});

	it("forwards store operations and resolves matching response ids", async () => {
		const { store, transport } = await openStore();
		const sample = {
			labels: { __name__: "requests_total", method: "GET" },
			ts: 1000,
			value: 1,
		};

		const ingesting = store.ingest([sample]);
		let message = transport.last();
		expect(message).toMatchObject({ op: "ingest", samples: [sample] });
		transport.resolve(message.id);
		await ingesting;

		const importing = store.importSamples([sample]);
		message = transport.last();
		expect(message).toMatchObject({ op: "importSamples", samples: [sample] });
		transport.resolve(message.id);
		await importing;

		const selecting = store.select(
			[{ name: "__name__", op: "=", value: "requests_total" }],
			0,
			10_000
		);
		message = transport.last();
		expect(message).toMatchObject({
			op: "select",
			startMs: 0,
			endMs: 10_000,
		});
		transport.resolve(message.id, [
			{
				labels: sample.labels,
				points: [{ t: 1000, v: 1 }],
			},
		]);
		expect(await selecting).toEqual([
			{
				labels: sample.labels,
				points: [{ t: 1000, v: 1 }],
			},
		]);

		const stats = store.quickStats();
		message = transport.last();
		expect(message.op).toBe("quickStats");
		transport.resolve(message.id, {
			seriesCount: 1,
			sampleCount: 1,
			oldestSampleMs: 1000,
			newestSampleMs: 1000,
			sizeBytes: 4096,
			samplesLastHour: 1,
		});
		expect(await stats).toMatchObject({ seriesCount: 1, sampleCount: 1 });
	});

	it("rejects the matching request when the worker reports an error", async () => {
		const { store, transport } = await openStore();

		const stats = store.stats();
		const message = transport.last();
		expect(message.op).toBe("stats");
		transport.reject(message.id, "database disk image is malformed");

		await expect(stats).rejects.toThrow("database disk image is malformed");
		expect(store.isOpen).toBe(true);
	});

	it("closes the worker transport and rejects later operations", async () => {
		const { store, transport } = await openStore();

		const closing = store.close();
		const message = transport.last();
		expect(message.op).toBe("close");
		expect(store.isOpen).toBe(false);
		transport.resolve(message.id);
		await closing;

		expect(transport.closed).toBe(true);
		await expect(store.stats()).rejects.toThrow(/closing/);
	});

	it("terminates the worker when close does not answer", async () => {
		vi.useFakeTimers();
		const { store, transport } = await openStore();

		const closing = store.close();
		const message = transport.last();
		expect(message.op).toBe("close");

		await vi.advanceTimersByTimeAsync(WORKER_STORE_CLOSE_TIMEOUT_MS);
		await closing;

		expect(transport.closed).toBe(true);
		await expect(store.stats()).rejects.toThrow(/closing/);
	});

	it("closes the transport when opening fails", async () => {
		const transport = new FakeTransport();
		const opening = WorkerMetricsStore.open(transport, {
			dbName: "metrics",
			wasmBinary: new Uint8Array([1]),
		});
		const message = transport.last();
		transport.reject(message.id, "opfs unavailable");

		await expect(opening).rejects.toThrow("opfs unavailable");
		expect(transport.closed).toBe(true);
	});
});
