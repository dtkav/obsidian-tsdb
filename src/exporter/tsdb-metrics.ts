import { ObsidianMetricsAPI } from "./metrics-api";
import { MetricInstance } from "../types";

export interface TsdbScrapeObservation {
	source: string;
	kind: "self" | "target";
	status: "ok" | "error";
	durationSeconds: number;
	samplesScraped: number;
}

export interface TsdbHealthMetrics {
	storeOpen: boolean;
	queryEngineReady: boolean;
	apiServerRunning: boolean;
	inFlightIngests: number;
}

export interface TsdbMetricsRecorder {
	recordScrape(observation: TsdbScrapeObservation): void;
	recordIngest(
		samples: number,
		durationSeconds: number,
		status: "ok" | "error"
	): void;
	recordWalCheckpoint(
		durationSeconds: number,
		status: "ok" | "error" | "skipped"
	): void;
	recordWalReplay(
		samples: number,
		batches: number,
		bytes: number,
		durationSeconds: number,
		status: "ok" | "error" | "aborted"
	): void;
	setHealth(metrics: TsdbHealthMetrics): void;
}

export function setupTsdbMetrics(
	metricsAPI: ObsidianMetricsAPI
): TsdbMetricsRecorder {
	const scrapeDuration = metricsAPI.createHistogram({
		name: "tsdb_scrape_collection_duration_seconds",
		help: "Time spent collecting and preparing scrape samples before ingest",
		labelNames: ["source", "kind", "status"],
		buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
	});
	const scrapeSamples = metricsAPI.createHistogram({
		name: "tsdb_scrape_samples_collected",
		help: "Samples collected per scrape before synthetic scrape metrics are added",
		labelNames: ["source", "kind", "status"],
		buckets: [0, 1, 10, 50, 100, 500, 1000, 5000, 10000],
	});
	const ingestBatches = metricsAPI.createCounter({
		name: "tsdb_ingest_batches_total",
		help: "Total TSDB ingest batches",
		labelNames: ["status"],
	});
	const ingestSamples = metricsAPI.createCounter({
		name: "tsdb_ingest_samples_total",
		help: "Total TSDB samples offered to ingest",
		labelNames: ["status"],
	});
	const ingestDuration = metricsAPI.createHistogram({
		name: "tsdb_ingest_duration_seconds",
		help: "Time spent committing an ingest batch to SQLite",
		labelNames: ["status"],
		buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
	});
	const ingestBatchSamples = metricsAPI.createHistogram({
		name: "tsdb_ingest_batch_samples",
		help: "Samples per TSDB ingest batch",
		labelNames: ["status"],
		buckets: [1, 10, 50, 100, 500, 1000, 5000, 10000],
	});
	const lastIngestSamples = metricsAPI.createGauge({
		name: "tsdb_last_ingest_samples",
		help: "Samples in the most recent TSDB ingest attempt",
		labelNames: ["status"],
	});
	const lastIngestDuration = metricsAPI.createGauge({
		name: "tsdb_last_ingest_duration_seconds",
		help: "Duration of the most recent TSDB ingest attempt",
		labelNames: ["status"],
	});
	const walCheckpoints = metricsAPI.createCounter({
		name: "tsdb_wal_checkpoints_total",
		help: "Total TSDB WAL checkpoint attempts",
		labelNames: ["status"],
	});
	const walCheckpointDuration = metricsAPI.createHistogram({
		name: "tsdb_wal_checkpoint_duration_seconds",
		help: "Time spent waiting for and truncating the TSDB recovery WAL",
		labelNames: ["status"],
		buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
	});
	const walReplays = metricsAPI.createCounter({
		name: "tsdb_wal_replays_total",
		help: "Total TSDB WAL replay attempts",
		labelNames: ["status"],
	});
	const walReplaySamples = metricsAPI.createCounter({
		name: "tsdb_wal_replay_samples_total",
		help: "Total samples replayed from the TSDB recovery WAL",
		labelNames: ["status"],
	});
	const walReplayBatches = metricsAPI.createCounter({
		name: "tsdb_wal_replay_batches_total",
		help: "Total batches replayed from the TSDB recovery WAL",
		labelNames: ["status"],
	});
	const walReplayDuration = metricsAPI.createHistogram({
		name: "tsdb_wal_replay_duration_seconds",
		help: "Time spent replaying the TSDB recovery WAL",
		labelNames: ["status"],
		buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120],
	});
	const walReplayBytes = metricsAPI.createGauge({
		name: "tsdb_wal_replay_bytes",
		help: "Bytes read by the most recent TSDB WAL replay attempt",
		labelNames: ["status"],
	});
	const storeOpen = metricsAPI.createGauge({
		name: "tsdb_store_open",
		help: "Whether the TSDB SQLite store is open",
	});
	const queryEngineReady = metricsAPI.createGauge({
		name: "tsdb_query_engine_ready",
		help: "Whether the TSDB query engine is ready",
	});
	const apiServerRunning = metricsAPI.createGauge({
		name: "tsdb_api_server_running",
		help: "Whether the optional TSDB HTTP API server is running",
	});
	const inFlightIngests = metricsAPI.createGauge({
		name: "tsdb_ingests_in_flight",
		help: "Number of TSDB ingest promises currently in flight",
	});

	const setBoolean = (gauge: MetricInstance, value: boolean) => {
		gauge.set(value ? 1 : 0);
	};

	return {
		recordScrape(observation) {
			const labels = {
				source: observation.source,
				kind: observation.kind,
				status: observation.status,
			};
			scrapeDuration.observe(observation.durationSeconds, labels);
			scrapeSamples.observe(observation.samplesScraped, labels);
		},
		recordIngest(samples, durationSeconds, status) {
			const labels = { status };
			ingestBatches.inc(1, labels);
			ingestSamples.inc(samples, labels);
			ingestDuration.observe(durationSeconds, labels);
			ingestBatchSamples.observe(samples, labels);
			lastIngestSamples.set(samples, labels);
			lastIngestDuration.set(durationSeconds, labels);
		},
		recordWalCheckpoint(durationSeconds, status) {
			const labels = { status };
			walCheckpoints.inc(1, labels);
			walCheckpointDuration.observe(durationSeconds, labels);
		},
		recordWalReplay(samples, batches, bytes, durationSeconds, status) {
			const labels = { status };
			walReplays.inc(1, labels);
			walReplaySamples.inc(samples, labels);
			walReplayBatches.inc(batches, labels);
			walReplayDuration.observe(durationSeconds, labels);
			walReplayBytes.set(bytes, labels);
		},
		setHealth(metrics) {
			setBoolean(storeOpen, metrics.storeOpen);
			setBoolean(queryEngineReady, metrics.queryEngineReady);
			setBoolean(apiServerRunning, metrics.apiServerRunning);
			inFlightIngests.set(metrics.inFlightIngests);
		},
	};
}
