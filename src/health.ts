import type { ScraperStatus } from "./scrape/scraper";

export interface IngestHealthStatus {
	lastSuccessMs: number | null;
	lastSampleCount: number;
	lastError: string | null;
	lastErrorMs: number | null;
	inFlight: number;
}

export interface WalHealthStatus {
	startup: "idle" | "running";
	lastCheckpointError: string | null;
	lastCheckpointErrorMs: number | null;
	lastReplayError: string | null;
	lastReplayErrorMs: number | null;
}

export interface ScraperHealthStatus {
	running: boolean;
	targets: number;
	up: number;
	down: number;
	pending: number;
	stale: number;
	lastScrapeMs: number | null;
	lastError: string | null;
	lastErrorMs: number | null;
}

export interface ApiHealthStatus {
	ok: boolean;
	store: {
		open: boolean;
	};
	queryEngine: {
		ready: boolean;
	};
	api: {
		running: boolean;
		port: number | null;
	};
	ingest: IngestHealthStatus;
	scraper: ScraperHealthStatus;
	wal: WalHealthStatus;
	/** Compatibility fields retained for existing consumers. */
	storeOpen: boolean;
	queryEngineReady: boolean;
	lastIngestMs: number | null;
	lastIngestSampleCount: number;
	lastIngestError: string | null;
	lastIngestErrorMs: number | null;
	inFlightIngests: number;
}

export function summarizeScraperHealth(
	statuses: ScraperStatus[],
	running: boolean,
	nowMs = Date.now()
): ScraperHealthStatus {
	let lastScrapeMs: number | null = null;
	let lastError: string | null = null;
	let lastErrorMs: number | null = null;
	let up = 0;
	let down = 0;
	let pending = 0;
	let stale = 0;

	for (const status of statuses) {
		if (status.lastScrapeMs === null) {
			pending++;
		} else {
			lastScrapeMs =
				lastScrapeMs === null
					? status.lastScrapeMs
					: Math.max(lastScrapeMs, status.lastScrapeMs);
			const staleAfterMs = Math.max(status.intervalSeconds * 3000, 30_000);
			if (nowMs - status.lastScrapeMs > staleAfterMs) stale++;
		}

		if (status.up === true) up++;
		if (status.up === false) {
			down++;
			if (
				status.lastError &&
				(lastErrorMs === null ||
					(status.lastScrapeMs ?? 0) >= lastErrorMs)
			) {
				lastError = status.lastError;
				lastErrorMs = status.lastScrapeMs;
			}
		}
	}

	return {
		running,
		targets: statuses.length,
		up,
		down,
		pending,
		stale,
		lastScrapeMs,
		lastError,
		lastErrorMs,
	};
}
