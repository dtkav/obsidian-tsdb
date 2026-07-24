import { afterEach, describe, expect, it, vi } from "vitest";
import {
	WORKER_STORE_CLOSE_TIMEOUT_MS,
	WORKER_STORE_DRAIN_TIMEOUT_MS,
	WORKER_STORE_OPEN_TIMEOUT_MS,
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

	reject(id: number, error: string, errorType?: string): void {
		this.listener?.(
			errorType
				? { id, ok: false, error, errorType }
				: { id, ok: false, error }
		);
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

	it("terminates the worker when opening does not answer", async () => {
		vi.useFakeTimers();
		const transport = new FakeTransport();
		const opening = WorkerMetricsStore.open(transport, {
			dbName: "metrics",
			wasmBinary: new Uint8Array([1]),
		});
		const rejectedOpening = expect(opening).rejects.toThrow(/open timed out/);

		await vi.advanceTimersByTimeAsync(WORKER_STORE_OPEN_TIMEOUT_MS);
		await rejectedOpening;

		expect(transport.closed).toBe(true);
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

	it("forwards PromQL queries and receives only evaluated results", async () => {
		const { store, transport } = await openStore();
		const instantResult = {
			resultType: "vector" as const,
			result: [
				{
					metric: { __name__: "requests_total" },
					value: [1, "2"] as [number, string],
				},
			],
		};

		const instant = store.instantQuery("requests_total", 1000);
		let message = transport.last();
		expect(message).toMatchObject({
			op: "instantQuery",
			query: "requests_total",
			timeMs: 1000,
		});
		transport.resolve(message.id, instantResult);
		expect(await instant).toEqual(instantResult);

		const rangeResult = {
			resultType: "matrix" as const,
			result: [
				{
					metric: { __name__: "requests_total" },
					values: [
						[1, "2"],
						[2, "3"],
					] as Array<[number, string]>,
				},
			],
		};
		const range = store.rangeQuery("rate(requests_total[1m])", 1000, 2000, 1000);
		message = transport.last();
		expect(message).toMatchObject({
			op: "rangeQuery",
			query: "rate(requests_total[1m])",
			startMs: 1000,
			endMs: 2000,
			stepMs: 1000,
		});
		transport.resolve(message.id, rangeResult);
		expect(await range).toEqual(rangeResult);
	});

	it("forwards bounded retention requests", async () => {
		const { store, transport } = await openStore();
		const deleting = store.deleteBeforeBatch(10_000, 100_000);
		const message = transport.last();
		expect(message).toMatchObject({
			op: "deleteBeforeBatch",
			cutoffMs: 10_000,
			maxSamples: 100_000,
		});
		transport.resolve(message.id, {
			complete: false,
			cutoffMs: 5000,
			deletedSamples: 100_000,
		});

		expect(await deleting).toEqual({
			complete: false,
			cutoffMs: 5000,
			deletedSamples: 100_000,
		});
	});

	it("preserves PromQL error types across the worker boundary", async () => {
		const { store, transport } = await openStore();
		const query = store.instantQuery("sum(", 1000);
		const message = transport.last();
		transport.reject(message.id, "unexpected end of expression", "bad_data");

		await expect(query).rejects.toMatchObject({
			name: "PromQLError",
			errorType: "bad_data",
		});
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

	it("waits for pending operations before starting the close request", async () => {
		vi.useFakeTimers();
		const { store, transport } = await openStore();
		const sample = {
			labels: { __name__: "requests_total" },
			ts: 1000,
			value: 1,
		};

		const ingesting = store.ingest([sample]);
		const ingestMessage = transport.last();
		const closing = store.close();

		await vi.advanceTimersByTimeAsync(WORKER_STORE_CLOSE_TIMEOUT_MS);
		expect(transport.last()).toBe(ingestMessage);
		expect(transport.closed).toBe(false);

		transport.resolve(ingestMessage.id);
		await ingesting;
		const closeMessage = transport.last();
		expect(closeMessage.op).toBe("close");
		transport.resolve(closeMessage.id);
		await closing;

		expect(transport.closed).toBe(true);
	});

	it("terminates the worker when pending operations do not drain", async () => {
		vi.useFakeTimers();
		const { store, transport } = await openStore();

		const stats = store.stats();
		const rejectedStats = expect(stats).rejects.toThrow(/drain timed out/);
		const closing = store.close();

		await vi.advanceTimersByTimeAsync(WORKER_STORE_DRAIN_TIMEOUT_MS);
		await closing;
		await rejectedStats;

		expect(transport.closed).toBe(true);
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
