import { describe, expect, it } from "vitest";
import {
	OPFS_WORKER_PROBE_SOURCE,
	OPFS_WORKER_PROBE_TIMEOUT_MS,
	OpfsProbeWorkerLike,
	OpfsWorkerProbeMessage,
	probeOpfsWorker,
} from "../src/storage/opfs-probe";

class FakeProbeWorker implements OpfsProbeWorkerLike {
	posted: Array<{ id: number }> = [];
	terminated = false;
	private listeners = new Set<
		(event: { data: OpfsWorkerProbeMessage }) => void
	>();

	constructor(private response?: OpfsWorkerProbeMessage) {}

	postMessage(message: { id: number }): void {
		this.posted.push(message);
		if (!this.response) return;
		setTimeout(() => this.emit(this.response!), 0);
	}

	addEventListener(
		type: "message",
		listener: (event: { data: OpfsWorkerProbeMessage }) => void
	): void {
		expect(type).toBe("message");
		this.listeners.add(listener);
	}

	removeEventListener(
		type: "message",
		listener: (event: { data: OpfsWorkerProbeMessage }) => void
	): void {
		expect(type).toBe("message");
		this.listeners.delete(listener);
	}

	terminate(): void {
		this.terminated = true;
	}

	private emit(response: OpfsWorkerProbeMessage): void {
		for (const listener of this.listeners) listener({ data: response });
	}
}

describe("probeOpfsWorker", () => {
	it("allows a busy Obsidian runtime time to answer by default", () => {
		expect(OPFS_WORKER_PROBE_TIMEOUT_MS).toBe(5000);
	});

	it("probes OPFS sync access handles in an inline worker", async () => {
		let source = "";
		const worker = new FakeProbeWorker({ id: 1, ok: true });
		const result = await probeOpfsWorker({
			createWorker: (workerSource) => {
				source = workerSource;
				return worker;
			},
		});

		expect(result).toEqual({ ok: true });
		expect(source).toContain("createSyncAccessHandle");
		expect(worker.posted).toEqual([{ id: 1 }]);
		expect(worker.terminated).toBe(true);
	});

	it("returns worker probe errors", async () => {
		const worker = new FakeProbeWorker({
			id: 1,
			ok: false,
			error: "FileSystemSyncAccessHandle is unavailable",
		});

		await expect(
			probeOpfsWorker({ createWorker: () => worker })
		).resolves.toEqual({
			ok: false,
			error: "FileSystemSyncAccessHandle is unavailable",
		});
		expect(worker.terminated).toBe(true);
	});

	it("returns worker creation errors", async () => {
		await expect(
			probeOpfsWorker({
				createWorker: () => {
					throw new Error("Worker is unavailable");
				},
			})
		).resolves.toEqual({
			ok: false,
			error: "Worker is unavailable",
		});
	});

	it("times out and terminates the worker", async () => {
		const worker = new FakeProbeWorker();

		await expect(
			probeOpfsWorker({ createWorker: () => worker, timeoutMs: 1 })
		).resolves.toEqual({
			ok: false,
			error: "OPFS worker probe timed out",
		});
		expect(worker.terminated).toBe(true);
	});
});

describe("OPFS_WORKER_PROBE_SOURCE", () => {
	it("keeps the probe self-contained", () => {
		expect(OPFS_WORKER_PROBE_SOURCE).toContain(
			"navigator.storage.getDirectory"
		);
		expect(OPFS_WORKER_PROBE_SOURCE).toContain("createSyncAccessHandle");
	});
});
