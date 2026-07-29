import { ObsidianMetricsAPI } from "./metrics-api";
import { MetricInstance } from "../types";
import type { VacuumBatchResult } from "../storage/store";
import type { WorkerRequestTiming } from "../storage/worker-protocol";

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
	recordCompaction(
		durationSeconds: number,
		status: "ok" | "error",
		backlog: boolean,
		pointLimit: number,
		compactedPoints: number,
		backlogAgeSeconds: number,
		pauseSeconds: number
	): void;
	recordRetention(
		durationSeconds: number,
		status: "ok" | "error",
		backlog: boolean,
		sampleLimit: number,
		deletedSamples: number
	): void;
	recordRetentionFinalize(
		durationSeconds: number,
		phase: "metadata" | "series",
		status: "ok" | "error"
	): void;
	recordVacuum(
		durationSeconds: number,
		status: "ok" | "error",
		pageLimit: number,
		result: VacuumBatchResult | null
	): void;
	recordWorkerRequest(
		timing: WorkerRequestTiming,
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
	const compactionBatches = metricsAPI.createCounter({
		name: "tsdb_compaction_batches_total",
		help: "Total bounded TSDB compaction batches",
		labelNames: ["status"],
	});
	const compactionDuration = metricsAPI.createHistogram({
		name: "tsdb_compaction_duration_seconds",
		help: "Time spent compacting one bounded slice of closed samples",
		labelNames: ["status"],
		buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 5],
	});
	const compactionPoints = metricsAPI.createCounter({
		name: "tsdb_compaction_points_total",
		help: "Total hot points moved into compressed TSDB blocks",
		labelNames: ["status"],
	});
	const compactionBacklog = metricsAPI.createGauge({
		name: "tsdb_compaction_backlog",
		help: "Whether closed hot rows remain after the last compaction slice",
	});
	const compactionPointLimit = metricsAPI.createGauge({
		name: "tsdb_compaction_point_limit",
		help: "Maximum hot points assigned to the most recent compaction slice",
	});
	const compactionBacklogAge = metricsAPI.createGauge({
		name: "tsdb_compaction_backlog_age_seconds",
		help: "Age of the oldest closed hot point still awaiting compaction",
	});
	const compactionPause = metricsAPI.createGauge({
		name: "tsdb_compaction_pause_seconds",
		help: "Foreground scheduling pause selected after the latest compaction slice",
	});
	const retentionBatches = metricsAPI.createCounter({
		name: "tsdb_retention_batches_total",
		help: "Total bounded TSDB retention batches",
		labelNames: ["status"],
	});
	const retentionDuration = metricsAPI.createHistogram({
		name: "tsdb_retention_duration_seconds",
		help: "Time spent deleting one bounded slice of expired samples",
		labelNames: ["status"],
		buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 5],
	});
	const retentionSamples = metricsAPI.createCounter({
		name: "tsdb_retention_samples_total",
		help: "Total expired samples deleted from the TSDB",
		labelNames: ["status"],
	});
	const retentionBacklog = metricsAPI.createGauge({
		name: "tsdb_retention_backlog",
		help: "Whether expired samples remain after the last retention slice",
	});
	const retentionSampleLimit = metricsAPI.createGauge({
		name: "tsdb_retention_sample_limit",
		help: "Maximum samples assigned to the most recent retention slice",
	});
	const retentionFinalizeDuration = metricsAPI.createHistogram({
		name: "tsdb_retention_finalize_duration_seconds",
		help: "Time spent in one independently queued retention finalization phase",
		labelNames: ["phase", "status"],
		buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 5],
	});
	const vacuumBatches = metricsAPI.createCounter({
		name: "tsdb_vacuum_batches_total",
		help: "Total bounded incremental-vacuum batches",
		labelNames: ["status"],
	});
	const vacuumDuration = metricsAPI.createHistogram({
		name: "tsdb_vacuum_duration_seconds",
		help: "Time spent in one bounded incremental-vacuum request",
		labelNames: ["status"],
		buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 5],
	});
	const vacuumPages = metricsAPI.createCounter({
		name: "tsdb_vacuum_pages_total",
		help: "Total SQLite pages reclaimed by incremental vacuum",
		labelNames: ["status"],
	});
	const vacuumRemainingPages = metricsAPI.createGauge({
		name: "tsdb_vacuum_remaining_pages",
		help: "SQLite freelist pages remaining after the latest vacuum batch",
	});
	const vacuumPageCount = metricsAPI.createGauge({
		name: "tsdb_page_count",
		help: "SQLite database page count after the latest vacuum batch",
	});
	const vacuumPageSize = metricsAPI.createGauge({
		name: "tsdb_page_size_bytes",
		help: "SQLite database page size",
	});
	const vacuumPageLimit = metricsAPI.createGauge({
		name: "tsdb_vacuum_page_limit",
		help: "Maximum pages assigned to the latest vacuum batch",
	});
	const workerQueueWait = metricsAPI.createHistogram({
		name: "tsdb_worker_queue_wait_seconds",
		help: "Time a worker request waited before dispatch",
		labelNames: ["request_class", "op", "status"],
		buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 5],
	});
	const workerRequestDuration = metricsAPI.createHistogram({
		name: "tsdb_worker_request_duration_seconds",
		help: "Worker request execution duration after dispatch",
		labelNames: ["request_class", "op", "status"],
		buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 5],
	});
	const workerQueueDepth = metricsAPI.createGauge({
		name: "tsdb_worker_queue_depth",
		help: "Queued worker requests observed when the latest request began",
		labelNames: ["request_class"],
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
		recordCompaction(
			durationSeconds,
			status,
			backlog,
			pointLimit,
			compactedPointCount,
			backlogAgeSeconds,
			pauseSeconds
		) {
			const labels = { status };
			compactionBatches.inc(1, labels);
			compactionDuration.observe(durationSeconds, labels);
			compactionPoints.inc(compactedPointCount, labels);
			compactionBacklog.set(backlog ? 1 : 0);
			compactionPointLimit.set(pointLimit);
			compactionBacklogAge.set(backlogAgeSeconds);
			compactionPause.set(pauseSeconds);
		},
		recordRetention(
			durationSeconds,
			status,
			backlog,
			sampleLimit,
			deletedSampleCount
		) {
			const labels = { status };
			retentionBatches.inc(1, labels);
			retentionDuration.observe(durationSeconds, labels);
			retentionSamples.inc(deletedSampleCount, labels);
			retentionBacklog.set(backlog ? 1 : 0);
			retentionSampleLimit.set(sampleLimit);
		},
		recordRetentionFinalize(durationSeconds, phase, status) {
			retentionFinalizeDuration.observe(durationSeconds, {
				phase,
				status,
			});
		},
		recordVacuum(durationSeconds, status, pageLimit, result) {
			const labels = { status };
			vacuumBatches.inc(1, labels);
			vacuumDuration.observe(durationSeconds, labels);
			vacuumPages.inc(result?.reclaimedPages ?? 0, labels);
			vacuumPageLimit.set(pageLimit);
			if (result) {
				vacuumRemainingPages.set(result.remainingPages);
				vacuumPageCount.set(result.pageCount);
				vacuumPageSize.set(result.pageSize);
			}
		},
		recordWorkerRequest(timing, status) {
			const labels = {
				request_class: timing.requestClass,
				op: timing.op,
				status,
			};
			workerQueueWait.observe(timing.queueWaitMs / 1000, labels);
			workerRequestDuration.observe(timing.durationMs / 1000, labels);
			workerQueueDepth.set(timing.foregroundQueueDepth, {
				request_class: "foreground",
			});
			workerQueueDepth.set(timing.maintenanceQueueDepth, {
				request_class: "maintenance",
			});
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
