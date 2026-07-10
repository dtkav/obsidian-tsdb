import type { ApiResultData } from "../promql/engine";
import type { ApiHealthStatus } from "./server";
import type { ScraperStatus } from "../scrape/scraper";
import type { StoreStats } from "../storage/store";
import type ObsidianMetricsPlugin from "../main";

/**
 * CDP-accessible discovery surface, exposed as `window.__tsdb`
 * (same convention as Relay's `window.__relayDebug`). External tooling that
 * attaches to Obsidian over the Chrome DevTools Protocol can enumerate
 * renderer targets and evaluate `window.__tsdb?.getInfo()` in
 * each to map vault → metrics port — which matters now that the server
 * walks a port range and the bound port is not statically known.
 */
export const METRICS_DEBUG_GLOBAL = "__tsdb";

export interface MetricsDebugInfo {
	vault: string;
	vaultId: string | null;
	pluginVersion: string;
	serverRunning: boolean;
	/** Actually-bound port (may differ from the configured start of range). */
	port: number | null;
	metricsPath: string;
	/** e.g. "http://localhost:9091" — Grafana datasource URL. */
	baseUrl: string | null;
}

export interface MetricsDebugGlobal {
	__owner: unknown;
	getInfo(): MetricsDebugInfo;
	getHealth(): ApiHealthStatus;
	getStats(): Promise<StoreStats | null>;
	getScrapeStatuses(): ScraperStatus[];
	/** Run an instant PromQL query against the local TSDB. */
	query(expr: string, timeMs?: number): Promise<ApiResultData>;
	/** Run a range PromQL query against the local TSDB. */
	queryRange(
		expr: string,
		startMs: number,
		endMs: number,
		stepMs: number
	): Promise<ApiResultData>;
}

declare global {
	interface Window {
		[METRICS_DEBUG_GLOBAL]?: MetricsDebugGlobal;
	}
}

/** Install the global; returns an uninstaller safe to call on unload. */
export function installMetricsGlobal(
	plugin: ObsidianMetricsPlugin
): () => void {
	const requireEngine = () => {
		if (!plugin.engine) {
			throw new Error("tsdb: query engine is not running");
		}
		return plugin.engine;
	};

	const api: MetricsDebugGlobal = {
		__owner: plugin,
		getInfo: () => {
			const port = plugin.boundPort;
			return {
				vault: plugin.app.vault.getName(),
				vaultId: plugin.app.appId ?? null,
				pluginVersion: plugin.manifest.version,
				serverRunning: plugin.serverRunning,
				port,
				metricsPath: plugin.settings.serverConfig.path,
				baseUrl: port !== null ? `http://localhost:${port}` : null,
			};
		},
		getHealth: () => plugin.getHealthStatus(),
		getStats: () => plugin.getTsdbStats(),
		getScrapeStatuses: () => plugin.getScrapeStatuses(),
		query: (expr, timeMs) =>
			requireEngine().instantQuery(expr, timeMs ?? Date.now()),
		queryRange: (expr, startMs, endMs, stepMs) =>
			requireEngine().rangeQuery(expr, startMs, endMs, stepMs),
	};

	window[METRICS_DEBUG_GLOBAL] = api;
	return () => {
		if (window[METRICS_DEBUG_GLOBAL]?.__owner === plugin) {
			delete window[METRICS_DEBUG_GLOBAL];
		}
	};
}
