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
		recorder.recordCompaction(0.12, "ok", true, 512, 384, 7200, 0.5);
		recorder.recordRetention(0.08, "ok", true, 2048, 2048);
		recorder.recordRetentionFinalize(0.03, "metadata", "ok");
		recorder.recordVacuum(0.04, "ok", 64, {
			complete: false,
			reclaimedPages: 64,
			remainingPages: 128,
			pageCount: 2048,
			pageSize: 4096,
		});
		recorder.recordWorkerRequest(
			{
				op: "rangeQuery",
				requestClass: "foreground",
				queueWaitMs: 25,
				durationMs: 75,
				foregroundQueueDepth: 1,
				maintenanceQueueDepth: 2,
			},
			"ok"
		);
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
					sample.name === "tsdb_compaction_batches_total" &&
					sample.labels.status === "ok"
			)?.value
		).toBe(1);
		expect(
			samples.find((sample) => sample.name === "tsdb_compaction_backlog")
				?.value
		).toBe(1);
		expect(
			samples.find((sample) => sample.name === "tsdb_compaction_point_limit")
				?.value
		).toBe(512);
		expect(
			samples.find(
				(sample) =>
					sample.name === "tsdb_compaction_backlog_age_seconds"
			)?.value
		).toBe(7200);
		expect(
			samples.find((sample) => sample.name === "tsdb_compaction_pause_seconds")
				?.value
		).toBe(0.5);
		expect(
			samples.find(
				(sample) =>
					sample.name === "tsdb_compaction_points_total" &&
					sample.labels.status === "ok"
			)?.value
		).toBe(384);
		expect(
			samples.find(
				(sample) =>
					sample.name === "tsdb_retention_samples_total" &&
					sample.labels.status === "ok"
			)?.value
		).toBe(2048);
		expect(
			samples.find((sample) => sample.name === "tsdb_retention_backlog")
				?.value
		).toBe(1);
		expect(
			samples.find((sample) => sample.name === "tsdb_retention_sample_limit")
				?.value
		).toBe(2048);
		expect(
			samples.find(
				(sample) =>
					sample.name ===
						"tsdb_retention_finalize_duration_seconds_count" &&
					sample.labels.phase === "metadata" &&
					sample.labels.status === "ok"
			)?.value
		).toBe(1);
		expect(
			samples.find(
				(sample) =>
					sample.name === "tsdb_vacuum_pages_total" &&
					sample.labels.status === "ok"
			)?.value
		).toBe(64);
		expect(
			samples.find(
				(sample) => sample.name === "tsdb_vacuum_remaining_pages"
			)?.value
		).toBe(128);
		expect(
			samples.find(
				(sample) =>
					sample.name === "tsdb_worker_queue_wait_seconds_count" &&
					sample.labels.request_class === "foreground" &&
					sample.labels.op === "rangeQuery" &&
					sample.labels.status === "ok"
			)?.value
		).toBe(1);
		expect(
			samples.find(
				(sample) =>
					sample.name === "tsdb_worker_queue_depth" &&
					sample.labels.request_class === "maintenance"
			)?.value
		).toBe(2);
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
