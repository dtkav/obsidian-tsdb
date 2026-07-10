import * as http from "http";
import { describe, expect, it } from "vitest";
import {
	ApiHealthStatus,
	ApiServer,
	parseStepParam,
	parseTimeParam,
} from "../src/api/server";

const HEALTHY: ApiHealthStatus = {
	ok: true,
	store: {
		open: true,
		backend: "node-file",
	},
	queryEngine: {
		ready: true,
	},
	api: {
		running: true,
		port: 19841,
	},
	ingest: {
		lastSuccessMs: null,
		lastSampleCount: 0,
		lastError: null,
		lastErrorMs: null,
		inFlight: 0,
	},
	scraper: {
		running: true,
		targets: 0,
		up: 0,
		down: 0,
		pending: 0,
		stale: 0,
		lastScrapeMs: null,
		lastError: null,
		lastErrorMs: null,
	},
	wal: {
		startup: "idle",
		lastCheckpointError: null,
		lastCheckpointErrorMs: null,
		lastReplayError: null,
		lastReplayErrorMs: null,
	},
	storeOpen: true,
	queryEngineReady: true,
	lastIngestMs: null,
	lastIngestSampleCount: 0,
	lastIngestError: null,
	lastIngestErrorMs: null,
	inFlightIngests: 0,
};

function makeServer(health: ApiHealthStatus = HEALTHY): ApiServer {
	// Port binding doesn't touch engine/store; stub the deps.
	return new ApiServer({
		getExposition: async () => "",
		engine: {} as any,
		store: {} as any,
		getHealth: () => health,
		getMetricsPath: () => "/metrics",
		pluginVersion: "test",
	});
}

function occupy(port: number): Promise<http.Server> {
	return new Promise((resolve, reject) => {
		const server = http.createServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve(server));
	});
}

function getJson(
	port: number,
	path: string
): Promise<{ statusCode: number; body: any }> {
	return new Promise((resolve, reject) => {
		http
			.get(`http://127.0.0.1:${port}${path}`, (res) => {
				let raw = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => (raw += chunk));
				res.on("end", () => {
					try {
						resolve({
							statusCode: res.statusCode ?? 0,
							body: raw ? JSON.parse(raw) : null,
						});
					} catch (error) {
						reject(error);
					}
				});
			})
			.on("error", reject);
	});
}

describe("ApiServer.listenRange", () => {
	it("binds the first port when free", async () => {
		const api = makeServer();
		const port = await api.listenRange(19811, 19813);
		expect(port).toBe(19811);
		expect(api.boundPort).toBe(19811);
		await api.close();
		expect(api.boundPort).toBe(null);
	});

	it("walks past occupied ports", async () => {
		const blocker = await occupy(19821);
		const api = makeServer();
		try {
			const port = await api.listenRange(19821, 19823);
			expect(port).toBe(19822);
			expect(api.boundPort).toBe(19822);
			await api.close();
		} finally {
			blocker.close();
		}
	});

	it("rejects when the whole range is taken", async () => {
		const blockers = await Promise.all([occupy(19831), occupy(19832)]);
		const api = makeServer();
		try {
			await expect(api.listenRange(19831, 19832)).rejects.toMatchObject({
				code: "EADDRINUSE",
			});
			expect(api.boundPort).toBe(null);
		} finally {
			for (const blocker of blockers) blocker.close();
		}
	});
});

describe("ApiServer health", () => {
	it("returns ok while the store is writable", async () => {
		const api = makeServer();
		const port = await api.listenRange(19841, 19843);
		try {
			const response = await getJson(port, "/health");
			expect(response.statusCode).toBe(200);
			expect(response.body.status).toBe("ok");
			expect(response.body.storeOpen).toBe(true);
			expect(response.body.store.open).toBe(true);
			expect(response.body.lastIngestError).toBe(null);
			expect(response.body.ingest.lastError).toBe(null);
			expect(response.body.scraper.down).toBe(0);
			expect(response.body.wal.startup).toBe("idle");
		} finally {
			await api.close();
		}
	});

	it("returns unavailable when ingests are failing", async () => {
		const api = makeServer({
			...HEALTHY,
			ok: false,
			ingest: {
				...HEALTHY.ingest,
				lastError: "Error: database disk image is malformed",
				lastErrorMs: 1783657633000,
			},
			lastIngestError: "Error: database disk image is malformed",
			lastIngestErrorMs: 1783657633000,
		});
		const port = await api.listenRange(19851, 19853);
		try {
			const response = await getJson(port, "/health");
			expect(response.statusCode).toBe(503);
			expect(response.body.status).toBe("error");
			expect(response.body.lastIngestError).toContain("malformed");
			expect(response.body.ingest.lastError).toContain("malformed");
		} finally {
			await api.close();
		}
	});
});

describe("time/step param parsing", () => {
	it("accepts unix seconds and RFC 3339", () => {
		expect(parseTimeParam("1700000000.5")).toBe(1700000000500);
		expect(parseTimeParam("2026-01-02T03:04:05Z")).toBe(
			Date.parse("2026-01-02T03:04:05Z")
		);
		expect(() => parseTimeParam("yesterday-ish")).toThrow();
	});

	it("accepts seconds and duration strings for step", () => {
		expect(parseStepParam("15")).toBe(15_000);
		expect(parseStepParam("1m30s")).toBe(90_000);
	});
});
