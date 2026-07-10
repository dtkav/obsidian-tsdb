import { describe, expect, it } from "vitest";
import { MetricsManager } from "../src/exporter/metrics-manager";
import { ObsidianMetricsAPI } from "../src/exporter/metrics-api";
import { setupTsdbMetrics } from "../src/exporter/tsdb-metrics";

describe("setupTsdbMetrics", () => {
	it("records TSDB scrape, ingest, WAL, and health metrics", async () => {
		const manager = new MetricsManager("");
		const recorder = setupTsdbMetrics(new ObsidianMetricsAPI(manager));

		recorder.recordScrape({
			source: "relay",
			kind: "self",
			status: "ok",
			durationSeconds: 0.012,
			samplesScraped: 42,
		});
		recorder.recordIngest(45, 0.034, "ok");
		recorder.recordWalCheckpoint(0.005, "ok");
		recorder.recordWalReplay(123, 4, 2048, 0.12, "ok");
		recorder.setHealth({
			storeOpen: true,
			queryEngineReady: true,
			apiServerRunning: false,
			inFlightIngests: 2,
		});

		const samples = await manager.collectSamples();
		expect(
			samples.find(
				(sample) =>
					sample.name === "tsdb_scrape_collection_duration_seconds_count" &&
					sample.labels.source === "relay" &&
					sample.labels.kind === "self" &&
					sample.labels.status === "ok"
			)?.value
		).toBe(1);
		expect(
			samples.find(
				(sample) =>
					sample.name === "tsdb_ingest_samples_total" &&
					sample.labels.status === "ok"
			)?.value
		).toBe(45);
		expect(
			samples.find(
				(sample) =>
					sample.name === "tsdb_wal_checkpoints_total" &&
					sample.labels.status === "ok"
			)?.value
		).toBe(1);
		expect(
			samples.find(
				(sample) =>
					sample.name === "tsdb_wal_replay_samples_total" &&
					sample.labels.status === "ok"
			)?.value
		).toBe(123);
		expect(
			samples.find(
				(sample) =>
					sample.name === "tsdb_wal_replay_bytes" &&
					sample.labels.status === "ok"
			)?.value
		).toBe(2048);
		expect(
			samples.find((sample) => sample.name === "tsdb_store_open")?.value
		).toBe(1);
		expect(
			samples.find((sample) => sample.name === "tsdb_api_server_running")
				?.value
		).toBe(0);
		expect(
			samples.find((sample) => sample.name === "tsdb_ingests_in_flight")
				?.value
		).toBe(2);
	});
});
