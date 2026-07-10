import { describe, expect, it } from "vitest";
import { StoredSample } from "../src/storage/store";
import { SampleWal, WalAdapter } from "../src/storage/wal";

function makeAdapter(): WalAdapter & { files: Map<string, string> } {
	const files = new Map<string, string>();
	return {
		files,
		exists: async (path) => files.has(path),
		read: async (path) => {
			const content = files.get(path);
			if (content === undefined) throw new Error("ENOENT");
			return content;
		},
		append: async (path, data) => {
			files.set(path, (files.get(path) ?? "") + data);
		},
		write: async (path, data) => {
			files.set(path, data);
		},
	};
}

function collector(): { ingested: StoredSample[]; ingest: (s: StoredSample[]) => void } {
	const ingested: StoredSample[] = [];
	return { ingested, ingest: (s) => ingested.push(...s) };
}

const sample = (name: string, ts: number, value: number): StoredSample => ({
	labels: { __name__: name, job: "t" },
	ts,
	value,
});

describe("SampleWal", () => {
	it("round-trips batches through append/replay", async () => {
		const adapter = makeAdapter();
		const wal = new SampleWal(adapter, "metrics.wal");
		wal.append([sample("a", 1000, 1), sample("b", 1000, 2)]);
		wal.append([sample("a", 2000, 3)]);
		await wal.barrier();

		const sink = collector();
		const count = await new SampleWal(adapter, "metrics.wal").replayInto(sink);
		expect(count).toBe(3);
		expect(sink.ingested.map((s) => [s.labels.__name__, s.ts, s.value])).toEqual([
			["a", 1000, 1],
			["b", 1000, 2],
			["a", 2000, 3],
		]);
	});

	it("replays nothing when the log is missing", async () => {
		const wal = new SampleWal(makeAdapter(), "metrics.wal");
		const sink = collector();
		expect(await wal.replayInto(sink)).toBe(0);
	});

	it("skips a torn final line from a crash mid-append", async () => {
		const adapter = makeAdapter();
		const wal = new SampleWal(adapter, "metrics.wal");
		wal.append([sample("a", 1000, 1)]);
		await wal.barrier();
		// Simulate a crash truncating the second batch mid-write.
		adapter.files.set(
			"metrics.wal",
			adapter.files.get("metrics.wal") + '[{"labels":{"__name__":"b"'
		);

		const sink = collector();
		const count = await wal.replayInto(sink);
		expect(count).toBe(1);
		expect(sink.ingested[0].labels.__name__).toBe("a");
	});

	it("truncates after pending appends have landed", async () => {
		const adapter = makeAdapter();
		const wal = new SampleWal(adapter, "metrics.wal");
		wal.append([sample("a", 1000, 1)]);
		await wal.truncate();
		expect(adapter.files.get("metrics.wal")).toBe("");
		expect(await wal.replayInto(collector())).toBe(0);
	});

	it("bumps the epoch on append so flushers can detect races", async () => {
		const wal = new SampleWal(makeAdapter(), "metrics.wal");
		const before = wal.epoch;
		wal.append([sample("a", 1000, 1)]);
		expect(wal.epoch).toBe(before + 1);
		wal.append([]); // empty batches don't count
		expect(wal.epoch).toBe(before + 1);
	});

	it("keeps appending after a failed write", async () => {
		const adapter = makeAdapter();
		let fail = true;
		const flaky: WalAdapter = {
			...adapter,
			append: async (path, data) => {
				if (fail) throw new Error("disk full");
				return adapter.append(path, data);
			},
		};
		const wal = new SampleWal(flaky, "metrics.wal");
		wal.append([sample("a", 1000, 1)]); // fails, logged
		await wal.barrier();
		fail = false;
		wal.append([sample("b", 2000, 2)]);
		await wal.barrier();
		expect(await wal.replayInto(collector())).toBe(1);
	});

	it("reports replay stats", async () => {
		const adapter = makeAdapter();
		const wal = new SampleWal(adapter, "metrics.wal");
		wal.append([sample("a", 1000, 1), sample("b", 1000, 2)]);
		wal.append([sample("a", 2000, 3)]);
		await wal.barrier();

		const result = await wal.replayIntoWithStats(collector());
		expect(result).toEqual({
			samples: 3,
			batches: 2,
			bytes: adapter.files.get("metrics.wal")!.length,
			aborted: false,
		});
	});

	it("can abort replay between batches", async () => {
		const adapter = makeAdapter();
		const wal = new SampleWal(adapter, "metrics.wal");
		wal.append([sample("a", 1000, 1)]);
		wal.append([sample("b", 2000, 2)]);
		await wal.barrier();

		let batches = 0;
		const sink = {
			ingested: [] as StoredSample[],
			ingest: (samples: StoredSample[]) => {
				batches++;
				sink.ingested.push(...samples);
			},
		};
		const result = await wal.replayIntoWithStats(sink, {
			shouldContinue: () => batches === 0,
		});

		expect(result.aborted).toBe(true);
		expect(result.samples).toBe(1);
		expect(result.batches).toBe(1);
		expect(sink.ingested.map((s) => s.labels.__name__)).toEqual(["a"]);
	});
});
