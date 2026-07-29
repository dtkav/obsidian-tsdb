import { describe, expect, it } from "vitest";
import type { Labels, Matcher } from "../src/labels";
import type {
	MetricsStoreLike,
	QuickStoreStats,
	RetentionDeleteResult,
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
	finalized: Array<{ cutoffMs: number; phase: "metadata" | "series" }> = [];
	vacuumLimits: number[] = [];
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
	async deleteBeforeBatch(
		cutoffMs: number,
		_maxSamples: number
	): Promise<RetentionDeleteResult> {
		return { complete: true, cutoffMs, deletedSamples: 0 };
	}
	async compactBeforeBatch(
		cutoffMs: number,
		_maxPoints: number
	) {
		return {
			complete: true,
			cutoffMs,
			compactedPoints: 0,
			oldestUncompactedMs: null,
		};
	}
	async finalizeRetention(
		cutoffMs: number,
		phase: "metadata" | "series"
	): Promise<void> {
		this.finalized.push({ cutoffMs, phase });
	}
	async vacuumBatch(maxPages: number) {
		this.vacuumLimits.push(maxPages);
		return {
			complete: true,
			reclaimedPages: 0,
			remainingPages: 0,
			pageCount: 1,
			pageSize: 4096,
		};
	}

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
		expect(transport.responses[0]).toMatchObject({
			id: 1,
			ok: true,
			value: { recoveredFromCorruption: true },
			timing: {
				op: "open",
				requestClass: "foreground",
				queueWaitMs: expect.any(Number),
				durationMs: expect.any(Number),
				foregroundQueueDepth: 0,
				maintenanceQueueDepth: 0,
			},
		});

		const sample = { labels: { __name__: "metric" }, ts: 1000, value: 2 };
		transport.send({ id: 2, op: "ingest", samples: [sample] });
		await flush();
		expect(store.ingested).toEqual([sample]);
		expect(transport.responses[1]).toMatchObject({
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
		expect(transport.responses[2]).toMatchObject({
			id: 3,
			ok: true,
			value: store.selectResult,
		});

		transport.send({
			id: 4,
			op: "instantQuery",
			query: "metric",
			timeMs: 1000,
		});
		await flush();
		expect(transport.responses[3]).toMatchObject({
			id: 4,
			ok: true,
			value: {
				resultType: "vector",
				result: [
					{
						metric: { __name__: "metric" },
						value: [1, "2"],
					},
				],
			},
		});

		transport.send({
			id: 5,
			op: "rangeQuery",
			query: "metric",
			startMs: 1000,
			endMs: 2000,
			stepMs: 1000,
		});
		await flush();
		expect(transport.responses[4]).toMatchObject({
			id: 5,
			ok: true,
			value: {
				resultType: "matrix",
				result: [
					{
						metric: { __name__: "metric" },
						values: [
							[1, "2"],
							[2, "2"],
						],
					},
				],
			},
		});

		transport.send({
			id: 6,
			op: "compactBeforeBatch",
			cutoffMs: 21_600_000,
			maxPoints: 50_000,
		});
		await flush();
		expect(transport.responses[5]).toMatchObject({
			id: 6,
			ok: true,
			value: {
				complete: true,
				cutoffMs: 21_600_000,
				compactedPoints: 0,
				oldestUncompactedMs: null,
			},
		});

		transport.send({
			id: 7,
			op: "finalizeRetention",
			cutoffMs: 21_600_000,
			phase: "metadata",
		});
		await flush();
		expect(store.finalized).toEqual([
			{ cutoffMs: 21_600_000, phase: "metadata" },
		]);
		expect(transport.responses[6]).toMatchObject({
			id: 7,
			ok: true,
			timing: expect.objectContaining({
				op: "finalizeRetention",
				requestClass: "maintenance",
			}),
		});

		transport.send({ id: 8, op: "vacuumBatch", maxPages: 64 });
		await flush();
		expect(store.vacuumLimits).toEqual([64]);
		expect(transport.responses[7]).toMatchObject({
			id: 8,
			ok: true,
			value: expect.objectContaining({
				complete: true,
				reclaimedPages: 0,
			}),
			timing: expect.objectContaining({
				op: "vacuumBatch",
				requestClass: "maintenance",
			}),
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

	it("runs foreground work before queued maintenance", async () => {
		const transport = new FakeTransport();
		const releaseIngest: { current: (() => void) | null } = {
			current: null,
		};
		const calls: string[] = [];
		const store = new FakeStore();
		store.ingest = async () => {
			calls.push("ingest");
			await new Promise<void>((resolve) => {
				releaseIngest.current = resolve;
			});
		};
		store.compactBeforeBatch = async (cutoffMs) => {
			calls.push("compact");
			return {
				complete: true,
				cutoffMs,
				compactedPoints: 0,
				oldestUncompactedMs: null,
			};
		};
		store.stats = async () => {
			calls.push("stats");
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
		transport.send({
			id: 3,
			op: "compactBeforeBatch",
			cutoffMs: 21_600_000,
			maxPoints: 512,
		});
		transport.send({ id: 4, op: "stats" });
		await flush();

		expect(calls).toEqual(["ingest"]);
		if (!releaseIngest.current) throw new Error("ingest did not start");
		releaseIngest.current();
		await flush();
		await flush();

		expect(calls).toEqual(["ingest", "stats", "compact"]);
		expect(transport.responses.map((response) => response.id)).toEqual([
			1, 2, 4, 3,
		]);
		expect(transport.responses[2]).toMatchObject({
			timing: expect.objectContaining({
				op: "stats",
				requestClass: "foreground",
				maintenanceQueueDepth: 1,
			}),
		});
		expect(transport.responses[3]).toMatchObject({
			timing: expect.objectContaining({
				op: "compactBeforeBatch",
				requestClass: "maintenance",
				queueWaitMs: expect.any(Number),
			}),
		});
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

		expect(transport.responses[1]).toMatchObject({
			id: 2,
			ok: false,
			error: "boom",
			timing: expect.objectContaining({
				op: "stats",
				requestClass: "foreground",
			}),
		});
		expect(transport.responses[2]).toMatchObject({
			id: 3,
			ok: true,
			value: ["__name__"],
		});
	});

	it("preserves PromQL error types in worker responses", async () => {
		const transport = new FakeTransport();
		new WorkerStoreServer(transport, async () => new FakeStore());

		transport.send({
			id: 1,
			op: "open",
			dbName: "metrics",
			wasmBinary: new Uint8Array([1]),
		});
		await flush();
		transport.send({ id: 2, op: "instantQuery", query: "sum(", timeMs: 1000 });
		await flush();

		expect(transport.responses[1]).toMatchObject({
			id: 2,
			ok: false,
			errorType: "bad_data",
		});
	});

	it("rejects operations before open", async () => {
		const transport = new FakeTransport();
		new WorkerStoreServer(transport, async () => new FakeStore());

		transport.send({ id: 1, op: "stats" });
		await flush();

		expect(transport.responses).toHaveLength(1);
		expect(transport.responses[0]).toMatchObject({
			id: 1,
			ok: false,
			error: "tsdb: worker store is not open",
			timing: expect.objectContaining({
				op: "stats",
				requestClass: "foreground",
			}),
		});
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
		expect(transport.responses[1]).toMatchObject({
			id: 2,
			ok: true,
			value: undefined,
			timing: expect.objectContaining({
				op: "close",
				requestClass: "foreground",
			}),
		});

		server.close();
		expect(() => transport.send({ id: 3, op: "stats" })).toThrow(
			/no listener/
		);
		expect(transport.responses).toHaveLength(2);
	});
});
