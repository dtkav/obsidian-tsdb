import { describe, expect, it } from "vitest";
import { summarizeScraperHealth } from "../src/health";
import type { ScraperStatus } from "../src/scrape/scraper";

describe("summarizeScraperHealth", () => {
	it("counts pending, failed, and stale scrape targets", () => {
		const now = 120_000;
		const statuses: ScraperStatus[] = [
			{
				job: "vault",
				target: "self",
				kind: "self",
				intervalSeconds: 30,
				lastScrapeMs: null,
				lastError: null,
				up: null,
			},
			{
				job: "relay",
				target: "http://127.0.0.1:9100/metrics",
				kind: "target",
				intervalSeconds: 10,
				lastScrapeMs: 118_000,
				lastError: "Error: database disk image is malformed",
				up: false,
			},
			{
				job: "perf",
				target: "self",
				kind: "self",
				intervalSeconds: 10,
				lastScrapeMs: 10_000,
				lastError: null,
				up: true,
			},
		];

		expect(summarizeScraperHealth(statuses, true, now)).toEqual({
			running: true,
			targets: 3,
			up: 1,
			down: 1,
			pending: 1,
			stale: 1,
			lastScrapeMs: 118_000,
			lastError: "Error: database disk image is malformed",
			lastErrorMs: 118_000,
		});
	});
});
