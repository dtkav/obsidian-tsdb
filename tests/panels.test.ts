import { describe, expect, it } from "vitest";
import {
	normalizePanelConfig,
	parsePanelConfig,
	resolveStepMs,
} from "../src/panels/config";
import {
	alignMatrix,
	axisSizeForLabels,
	buildPanelLegends,
	formatLegend,
	formatStatValue,
	formatUnitValue,
} from "../src/panels/data";
import {
	panelNoDataStatus,
	panelQueryErrorStatus,
	panelUnavailableStatus,
} from "../src/panels/status";
import { ApiResultData } from "../src/promql/engine";
import type { ApiHealthStatus } from "../src/health";

// Stand-in for Obsidian's parseYaml, good enough for the shapes we test.
const fakeYaml = (text: string): unknown => {
	if (!text.includes(":")) return text;
	const obj: Record<string, unknown> = {};
	for (const line of text.split("\n")) {
		const idx = line.indexOf(":");
		if (idx < 0) return text;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (!/^[a-z_]+$/.test(key)) return text;
		obj[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
	}
	return obj;
};

const HEALTHY: ApiHealthStatus = {
	ok: true,
	store: { open: true, backend: "node-file" },
	queryEngine: { ready: true },
	api: { running: false, port: null },
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

describe("panel config", () => {
	it("treats a bare expression as a timeseries query", () => {
		const config = parsePanelConfig("rate(obsidian_file_operations_total[5m])", fakeYaml);
		expect(config.queries).toEqual([
			{ expr: "rate(obsidian_file_operations_total[5m])", legend: undefined },
		]);
		expect(config.type).toBe("timeseries");
		expect(config.rangeMs).toBe(3600_000);
	});

	it("parses a structured config", () => {
		const config = parsePanelConfig(
			["query: up", "type: stat", "range: 6h", "refresh: 30s", "unit: ops"].join("\n"),
			fakeYaml
		);
		expect(config.type).toBe("stat");
		expect(config.rangeMs).toBe(6 * 3600_000);
		expect(config.refreshSeconds).toBe(30);
		expect(config.unit).toBe("ops");
	});

	it("supports multiple queries with legends", () => {
		const config = normalizePanelConfig({
			queries: [
				{ expr: "a", legend: "{{job}}" },
				"b",
			],
		});
		expect(config.queries).toEqual([
			{ expr: "a", legend: "{{job}}" },
			{ expr: "b", legend: undefined },
		]);
	});

	it("rejects unknown panel types and missing queries", () => {
		expect(() => normalizePanelConfig({ query: "up", type: "piechart" })).toThrow(
			/unknown panel type/
		);
		expect(() => normalizePanelConfig({ type: "stat" })).toThrow(/needs a query/);
	});

	it("auto-computes a sane step", () => {
		const config = normalizePanelConfig({ query: "up", range: "1h" });
		expect(resolveStepMs(config)).toBe(15_000); // 3600/250 → 14.4s → 15s
		const wide = normalizePanelConfig({ query: "up", range: "30d" });
		expect(resolveStepMs(wide)).toBeGreaterThan(10_000);
	});
});

describe("panel data shaping", () => {
	it("aligns matrix samples onto the step grid with null gaps", () => {
		const matrix: ApiResultData = {
			resultType: "matrix",
			result: [
				{
					metric: { __name__: "m", job: "a" },
					values: [
						[100, "1"],
						[130, "4"], // gap at 110/120
					],
				},
			],
		};
		const aligned = alignMatrix(matrix, 100, 130, 10);
		expect(aligned.xs).toEqual([100, 110, 120, 130]);
		expect(aligned.series[0].values).toEqual([1, null, null, 4]);
		expect(aligned.series[0].metric).toEqual({ __name__: "m", job: "a" });
	});

	it("elides labels common to every series in the panel legend", () => {
		const legends = buildPanelLegends([
			{ metric: { __name__: "ops", job: "obsidian", vault: "v1", op: "open" } },
			{ metric: { __name__: "ops", job: "obsidian", vault: "v1", op: "modify" } },
		]);
		// job/vault identical everywhere → elided; shared name → dropped too.
		expect(legends).toEqual(['op="open"', 'op="modify"']);

		// Single series: just the metric name.
		expect(buildPanelLegends([{ metric: { __name__: "up", job: "x" } }])).toEqual([
			"up",
		]);

		// Templates always win.
		expect(
			buildPanelLegends([
				{ metric: { __name__: "a", job: "x" }, template: "{{job}}!" },
				{ metric: { __name__: "a", job: "y" } },
			])
		).toEqual(["x!", "a"]);
	});

	it("formats unit-aware values", () => {
		expect(formatUnitValue(268435456, "bytes")).toBe("256.0 MiB");
		expect(formatUnitValue(1536, "B")).toBe("1.5 KiB");
		expect(formatUnitValue(0.042, "s")).toBe("42 ms");
		expect(formatUnitValue(90, "ops")).toBe("90 ops");
	});

	it("widens the y axis for long unit labels", () => {
		expect(axisSizeForLabels(null)).toBe(70);
		expect(axisSizeForLabels(["0", "100"])).toBe(70);
		expect(axisSizeForLabels(["0.100 req/s"])).toBeGreaterThan(80);
		expect(axisSizeForLabels(["1234567890123456789012345"])).toBe(140);
	});

	it("renders legend templates", () => {
		expect(
			formatLegend({ __name__: "m", job: "api", code: "500" }, "{{job}} → {{code}}")
		).toBe("api → 500");
		expect(formatLegend({ __name__: "up" })).toBe("up");
	});

	it("formats stat values readably", () => {
		expect(formatStatValue(0.12345)).toBe("0.123");
		expect(formatStatValue(42)).toBe("42");
		expect(formatStatValue(1234.5)).toBe("1234.50");
		expect(formatStatValue(2_500_000)).toBe("2.50M");
		expect(formatStatValue(Infinity)).toBe("∞");
	});
});

describe("panel status messages", () => {
	it("explains startup when health is unavailable", () => {
		expect(panelUnavailableStatus(null)).toMatchObject({
			tone: "empty",
			title: "Metrics database is starting",
		});
	});

	it("prioritizes ingest failures over generic no-data", () => {
		const status = panelNoDataStatus({
			...HEALTHY,
			ingest: {
				...HEALTHY.ingest,
				lastError: "Error: database disk image is malformed",
				lastErrorMs: 1,
			},
		});

		expect(status).toMatchObject({
			tone: "error",
			title: "Ingest is failing",
		});
		expect(status.detail).toContain("malformed");
	});

	it("surfaces down scrape targets before generic no-data", () => {
		const status = panelNoDataStatus({
			...HEALTHY,
			scraper: {
				...HEALTHY.scraper,
				targets: 1,
				down: 1,
				lastError: "connect ECONNREFUSED",
			},
		});

		expect(status).toEqual({
			tone: "warning",
			title: "Scrape target down",
			detail: "connect ECONNREFUSED",
		});
	});

	it("distinguishes waiting for first scrape from an empty query", () => {
		expect(
			panelNoDataStatus({
				...HEALTHY,
				scraper: {
					...HEALTHY.scraper,
					targets: 2,
					pending: 2,
				},
			})
		).toMatchObject({
			tone: "empty",
			title: "Waiting for first scrape",
		});
		expect(panelNoDataStatus(HEALTHY)).toMatchObject({
			tone: "empty",
			title: "No data",
		});
	});

	it("formats query errors", () => {
		expect(panelQueryErrorStatus(new Error("parse failed"))).toEqual({
			tone: "error",
			title: "Query error",
			detail: "parse failed",
		});
	});
});
