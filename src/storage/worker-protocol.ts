import type { Labels, Matcher } from "../labels";
import type { ApiResultData } from "../promql/engine";
import type {
	CompactionBatchResult,
	QuickStoreStats,
	RetentionDeleteResult,
	RetentionFinalizePhase,
	SeriesData,
	StoredSample,
	StoreStats,
	VacuumBatchResult,
} from "./store";

type WithRequestId<T> = T & { id: number };

export type WorkerStoreRequest =
	| WithRequestId<{
			op: "open";
			dbName: string;
			wasmBinary: Uint8Array;
	  }>
	| WithRequestId<{ op: "ingest"; samples: StoredSample[] }>
	| WithRequestId<{ op: "importSamples"; samples: StoredSample[] }>
	| WithRequestId<{
			op: "select";
			matchers: Matcher[];
			startMs: number;
			endMs: number;
	  }>
	| WithRequestId<{
			op: "seriesMatching";
			matchers: Matcher[];
			startMs?: number;
			endMs?: number;
	  }>
	| WithRequestId<{ op: "labelNames"; matchers?: Matcher[] }>
	| WithRequestId<{
			op: "labelValues";
			labelName: string;
			matchers?: Matcher[];
	  }>
	| WithRequestId<{ op: "deleteBefore"; cutoffMs: number }>
	| WithRequestId<{
			op: "deleteBeforeBatch";
			cutoffMs: number;
			maxSamples: number;
	  }>
	| WithRequestId<{
			op: "compactBeforeBatch";
			cutoffMs: number;
			maxPoints: number;
	  }>
	| WithRequestId<{
			op: "finalizeRetention";
			cutoffMs: number;
			phase: RetentionFinalizePhase;
	  }>
	| WithRequestId<{
			op: "vacuumBatch";
			maxPages: number;
	  }>
	| WithRequestId<{ op: "quickStats" }>
	| WithRequestId<{ op: "stats" }>
	| WithRequestId<{ op: "instantQuery"; query: string; timeMs: number }>
	| WithRequestId<{
			op: "rangeQuery";
			query: string;
			startMs: number;
			endMs: number;
			stepMs: number;
	  }>
	| WithRequestId<{ op: "close" }>;

export type WorkerStoreRequestBody = WorkerStoreRequest extends infer Request
	? Request extends { id: number }
		? Omit<Request, "id">
		: never
	: never;

export interface WorkerStoreOpenResult {
	recoveredFromCorruption: boolean;
}

export type WorkerRequestClass = "foreground" | "maintenance";

export interface WorkerRequestTiming {
	op: WorkerStoreRequest["op"];
	requestClass: WorkerRequestClass;
	queueWaitMs: number;
	durationMs: number;
	foregroundQueueDepth: number;
	maintenanceQueueDepth: number;
}

export type WorkerStoreResult =
	| WorkerStoreOpenResult
	| void
	| SeriesData[]
	| Labels[]
	| string[]
	| QuickStoreStats
	| CompactionBatchResult
	| RetentionDeleteResult
	| VacuumBatchResult
	| StoreStats
	| ApiResultData;

export type WorkerStoreResponse =
	| {
			id: number;
			ok: true;
			value: WorkerStoreResult;
			timing?: WorkerRequestTiming;
	  }
	| {
			id: number;
			ok: false;
			error: string;
			errorType?: string;
			timing?: WorkerRequestTiming;
	  };
