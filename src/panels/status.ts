import type { ApiHealthStatus } from "../health";

export type PanelStatusTone = "empty" | "warning" | "error";

export interface PanelStatusMessage {
	tone: PanelStatusTone;
	title: string;
	detail?: string;
}

export function panelUnavailableStatus(
	health: ApiHealthStatus | null | undefined
): PanelStatusMessage {
	if (!health) {
		return {
			tone: "empty",
			title: "Metrics database is starting",
			detail: "This panel will refresh when the local TSDB is ready.",
		};
	}
	if (!health.store.open) {
		return {
			tone: "warning",
			title: "Database is not open",
			detail: "The local TSDB has not opened its SQLite store yet.",
		};
	}
	if (!health.queryEngine.ready) {
		return {
			tone: "empty",
			title: "Query engine is starting",
			detail: "This panel will refresh when PromQL queries are ready.",
		};
	}
	return panelNoDataStatus(health);
}

export function panelNoDataStatus(
	health: ApiHealthStatus | null | undefined
): PanelStatusMessage {
	if (health?.ingest.lastError) {
		return {
			tone: "error",
			title: "Ingest is failing",
			detail: `Last ingest failed: ${health.ingest.lastError}`,
		};
	}
	if (health && health.scraper.down > 0) {
		return {
			tone: "warning",
			title: "Scrape target down",
			detail:
				health.scraper.lastError ??
				`${health.scraper.down} scrape target${health.scraper.down === 1 ? "" : "s"} reported down.`,
		};
	}
	if (health && health.scraper.stale > 0) {
		return {
			tone: "warning",
			title: "Scrape data is stale",
			detail: `${health.scraper.stale} scrape target${health.scraper.stale === 1 ? "" : "s"} has not reported recently.`,
		};
	}
	if (
		health &&
		health.scraper.targets > 0 &&
		health.scraper.pending === health.scraper.targets
	) {
		return {
			tone: "empty",
			title: "Waiting for first scrape",
			detail: "The query will populate after the first source records samples.",
		};
	}
	return {
		tone: "empty",
		title: "No data",
		detail: "No samples matched this query in the selected time range.",
	};
}

export function panelQueryErrorStatus(error: unknown): PanelStatusMessage {
	return {
		tone: "error",
		title: "Query error",
		detail: error instanceof Error ? error.message : String(error),
	};
}
