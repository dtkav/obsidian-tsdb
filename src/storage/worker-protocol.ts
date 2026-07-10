import type { Labels, Matcher } from "../labels";
import type {
	QuickStoreStats,
	SeriesData,
	StoredSample,
	StoreStats,
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
	| WithRequestId<{ op: "quickStats" }>
	| WithRequestId<{ op: "stats" }>
	| WithRequestId<{ op: "close" }>;

export type WorkerStoreRequestBody = WorkerStoreRequest extends infer Request
	? Request extends { id: number }
		? Omit<Request, "id">
		: never
	: never;

export interface WorkerStoreOpenResult {
	recoveredFromCorruption: boolean;
}

export type WorkerStoreResult =
	| WorkerStoreOpenResult
	| void
	| SeriesData[]
	| Labels[]
	| string[]
	| QuickStoreStats
	| StoreStats;

export type WorkerStoreResponse =
	| { id: number; ok: true; value: WorkerStoreResult }
	| { id: number; ok: false; error: string };
