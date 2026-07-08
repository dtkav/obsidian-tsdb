import * as http from "http";
import { describe, expect, it } from "vitest";
import {
	ApiServer,
	parseStepParam,
	parseTimeParam,
} from "../src/api/server";

function makeServer(): ApiServer {
	// Port binding doesn't touch engine/store; stub the deps.
	return new ApiServer({
		getExposition: async () => "",
		engine: {} as any,
		store: {} as any,
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
