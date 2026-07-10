import { describe, expect, it } from "vitest";
import { NAME_LABEL } from "../src/labels";
import { MetricsManager } from "../src/exporter/metrics-manager";
import { buildStoredSamplesFromScraped } from "../src/scrape/scraper";

describe("MetricsManager structured collection", () => {
	it("collects samples without Prometheus text parsing", async () => {
		const manager = new MetricsManager("");
		manager.setDefaultLabels({ vault: "My vault" });
		const gauge = manager.createGauge({
			name: "active_notes",
			help: "Active notes",
			labelNames: ["instance", "state"],
		});

		gauge.set(3, { instance: "plugin-instance", state: "open" });

		const collected = await manager.collectSamples();
		expect(collected).toEqual([
			{
				name: "active_notes",
				labels: {
					instance: "plugin-instance",
					state: "open",
					vault: "My vault",
				},
				value: 3,
			},
		]);

		expect(
			buildStoredSamplesFromScraped(collected, "vault", "Local vault", 1234)
		).toEqual([
			{
				labels: {
					[NAME_LABEL]: "active_notes",
					exported_instance: "plugin-instance",
					state: "open",
					vault: "My vault",
					job: "vault",
					instance: "Local vault",
				},
				ts: 1234,
				value: 3,
			},
		]);
	});

	it("keeps histogram metric names and string label values", async () => {
		const manager = new MetricsManager("");
		const histogram = manager.createHistogram({
			name: "render_seconds",
			help: "Render duration",
			labelNames: ["view"],
			buckets: [0.5, 1],
		});

		histogram.observe(0.75, { view: "preview" });

		const collected = await manager.collectSamples();
		expect(
			collected.find(
				(sample) =>
					sample.name === "render_seconds_bucket" &&
					sample.labels.le === "0.5"
			)?.value
		).toBe(0);
		expect(
			collected.find(
				(sample) =>
					sample.name === "render_seconds_bucket" &&
					sample.labels.le === "1"
			)?.value
		).toBe(1);
		expect(
			collected.find(
				(sample) =>
					sample.name === "render_seconds_bucket" &&
					sample.labels.le === "+Inf"
			)?.value
		).toBe(1);
		expect(
			collected.find((sample) => sample.name === "render_seconds_sum")
		).toMatchObject({ labels: { view: "preview" }, value: 0.75 });
		expect(
			collected.find((sample) => sample.name === "render_seconds_count")
		).toMatchObject({ labels: { view: "preview" }, value: 1 });
	});
});
