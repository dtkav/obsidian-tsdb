import { describe, expect, it } from "vitest";
import type { Labels, Matcher } from "../src/labels";
import type {
	MetricsStoreLike,
	QuickStoreStats,
	SeriesData,
	StoredSample,
	StoreStats,
} from "../src/storage/store";
import {
	WorkerStoreOpenRequest,
	WorkerStoreServer,
	WorkerStoreServerTransport,
} from "../src/storage/worker-server";
import type {
	WorkerStoreRequest,
	WorkerStoreResponse,
} from "../src/storage/worker-protocol";

class FakeTransport implements WorkerStoreServerTransport {
	responses: WorkerStoreResponse[] = [];
	private listener: ((request: WorkerStoreRequest) => void) | null = null;

	post(response: WorkerStoreResponse): void {
		this.responses.push(response);
	}

	onMessage(listener: (request: WorkerStoreRequest) => void): () => void {
		this.listener = listener;
		return () => {
			if (this.listener === listener) this.listener = null;
		};
	}

	send(request: WorkerStoreRequest): void {
		if (!this.listener) throw new Error("no listener");
		this.listener(request);
	}
}

class FakeStore implements MetricsStoreLike {
	isOpen = true;
	recoveredFromCorruption = false;
	closed = false;
	ingested: StoredSample[] = [];
	selectResult: SeriesData[] = [];
	statsResult: StoreStats = {
		seriesCount: 0,
		sampleCount: 0,
		oldestSampleMs: null,
		newestSampleMs: null,
		sizeBytes: 0,
		samplesLastHour: 0,
	};

	async ingest(samples: StoredSample[]): Promise<void> {
		this.ingested.push(...samples);
	}

	async importSamples(samples: StoredSample[]): Promise<void> {
		this.ingested.push(...samples);
	}

	async select(
		_matchers: Matcher[],
		_startMs: number,
		_endMs: number
	): Promise<SeriesData[]> {
		return this.selectResult;
	}

	async seriesMatching(
		_matchers: Matcher[],
		_startMs?: number,
		_endMs?: number
	): Promise<Labels[]> {
		return this.selectResult.map((series) => series.labels);
	}

	async labelNames(_matchers?: Matcher[]): Promise<string[]> {
		return ["__name__"];
	}

	async labelValues(
		labelName: string,
		_matchers?: Matcher[]
	): Promise<string[]> {
		return labelName === "__name__" ? ["metric"] : [];
	}

	async deleteBefore(_cutoffMs: number): Promise<void> {}

	async quickStats(): Promise<QuickStoreStats> {
		return { ...this.statsResult, sampleCount: 0, samplesLastHour: 0 };
	}

	async stats(): Promise<StoreStats> {
		return this.statsResult;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.isOpen = false;
	}
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("WorkerStoreServer", () => {
	it("opens a store and delegates requests", async () => {
		const transport = new FakeTransport();
		const store = new FakeStore();
		store.recoveredFromCorruption = true;
		store.selectResult = [
			{ labels: { __name__: "metric" }, points: [{ t: 1000, v: 2 }] },
		];
		const opened: WorkerStoreOpenRequest[] = [];
		new WorkerStoreServer(transport, async (request) => {
			opened.push(request);
			return store;
		});

		transport.send({
			id: 1,
			op: "open",
			dbName: "metrics",
			wasmBinary: new Uint8Array([1]),
		});
		await flush();
		expect(opened).toHaveLength(1);
		expect(transport.responses[0]).toEqual({
			id: 1,
			ok: true,
			value: { recoveredFromCorruption: true },
		});

		const sample = { labels: { __name__: "metric" }, ts: 1000, value: 2 };
		transport.send({ id: 2, op: "ingest", samples: [sample] });
		await flush();
		expect(store.ingested).toEqual([sample]);
		expect(transport.responses[1]).toEqual({
			id: 2,
			ok: true,
			value: undefined,
		});

		transport.send({
			id: 3,
			op: "select",
			matchers: [{ name: "__name__", op: "=", value: "metric" }],
			startMs: 0,
			endMs: 10_000,
		});
		await flush();
		expect(transport.responses[2]).toEqual({
			id: 3,
			ok: true,
			value: store.selectResult,
		});
	});

	it("serializes requests through one queue", async () => {
		const transport = new FakeTransport();
		const releaseIngest: { current: (() => void) | null } = {
			current: null,
		};
		const store = new FakeStore();
		store.ingest = async () => {
			await new Promise<void>((resolve) => {
				releaseIngest.current = resolve;
			});
		};
		let statsCalled = false;
		store.stats = async () => {
			statsCalled = true;
			return store.statsResult;
		};
		new WorkerStoreServer(transport, async () => store);

		transport.send({
			id: 1,
			op: "open",
			dbName: "metrics",
			wasmBinary: new Uint8Array([1]),
		});
		await flush();
		transport.send({ id: 2, op: "ingest", samples: [] });
		transport.send({ id: 3, op: "stats" });
		await flush();

		expect(statsCalled).toBe(false);
		if (!releaseIngest.current) throw new Error("ingest did not start");
		releaseIngest.current();
		await flush();
		expect(statsCalled).toBe(true);
		expect(transport.responses.map((response) => response.id)).toEqual([
			1, 2, 3,
		]);
	});

	it("reports errors without breaking later requests", async () => {
		const transport = new FakeTransport();
		const store = new FakeStore();
		store.stats = async () => {
			throw new Error("boom");
		};
		new WorkerStoreServer(transport, async () => store);

		transport.send({
			id: 1,
			op: "open",
			dbName: "metrics",
			wasmBinary: new Uint8Array([1]),
		});
		await flush();
		transport.send({ id: 2, op: "stats" });
		await flush();
		transport.send({ id: 3, op: "labelNames" });
		await flush();

		expect(transport.responses[1]).toEqual({
			id: 2,
			ok: false,
			error: "boom",
		});
		expect(transport.responses[2]).toEqual({
			id: 3,
			ok: true,
			value: ["__name__"],
		});
	});

	it("rejects operations before open", async () => {
		const transport = new FakeTransport();
		new WorkerStoreServer(transport, async () => new FakeStore());

		transport.send({ id: 1, op: "stats" });
		await flush();

		expect(transport.responses).toEqual([
			{
				id: 1,
				ok: false,
				error: "tsdb: worker store is not open",
			},
		]);
	});

	it("closes the current store", async () => {
		const transport = new FakeTransport();
		const store = new FakeStore();
		const server = new WorkerStoreServer(transport, async () => store);

		transport.send({
			id: 1,
			op: "open",
			dbName: "metrics",
			wasmBinary: new Uint8Array([1]),
		});
		await flush();
		transport.send({ id: 2, op: "close" });
		await flush();

		expect(store.closed).toBe(true);
		expect(transport.responses[1]).toEqual({
			id: 2,
			ok: true,
			value: undefined,
		});

		server.close();
		expect(() => transport.send({ id: 3, op: "stats" })).toThrow(
			/no listener/
		);
		expect(transport.responses).toHaveLength(2);
	});
});
