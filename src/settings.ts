export interface MetricsServerConfig {
	port: number;
	/**
	 * Upper bound of the port range to try when `port` is busy (lets several
	 * vaults run the plugin concurrently). 0 or < port means single port.
	 */
	portRangeEnd: number;
	path: string;
	enabled: boolean;
}

export interface ScrapeJobSettings {
	jobName: string;
	/** Full target URLs, e.g. http://localhost:9100/metrics */
	targets: string[];
	intervalSeconds: number;
	timeoutSeconds: number;
	enabled: boolean;
}

export interface StoreSettings {
	/** Recording on/off for this store (default on). */
	enabled?: boolean;
	/** Recording interval override; unset = registration default. */
	intervalSeconds?: number;
}

export interface ScrapeSettings {
	/** Per-store overrides, keyed by store name. */
	stores: Record<string, StoreSettings>;
	jobs: ScrapeJobSettings[];
}

export interface StorageSettings {
	retentionDays: number;
	/** How often the in-memory SQLite image is flushed to disk. */
	flushIntervalSeconds: number;
	/**
	 * Prefer the worker-backed OPFS store when the runtime supports it.
	 * Advanced data.json override; not shown in the settings UI.
	 */
	workerBackend: boolean;
	/**
	 * Permit desktop SQLite or vault chunk storage when worker OPFS cannot start.
	 * Off by default so OPFS failures are visible instead of silently switching
	 * engines.
	 */
	allowLegacyBackends: boolean;
}

export interface ObsidianMetricsSettings {
	serverConfig: MetricsServerConfig;
	customMetricsPrefix: string;
	scrape: ScrapeSettings;
	storage: StorageSettings;
	/** Demo dashboard note has been offered/created once. */
	onboarded: boolean;
}

export const DEFAULT_SETTINGS: ObsidianMetricsSettings = {
	serverConfig: {
		port: 9090,
		portRangeEnd: 9099,
		path: "/metrics",
		// The trailhead is local recording + note panels; the HTTP API is a
		// power feature users turn on when they bring Grafana or curl.
		enabled: false,
	},
	customMetricsPrefix: "obsidian_",
	scrape: {
		stores: {},
		jobs: [],
	},
	storage: {
		retentionDays: 30,
		flushIntervalSeconds: 300,
		workerBackend: true,
		allowLegacyBackends: false,
	},
	onboarded: false,
};

/**
 * Persisted settings as they may appear on disk: any field can be missing or
 * predate a newer schema, so every level is optional. Stored scrape overrides
 * keep their full value shape; job entries may be partially populated.
 */
interface LoadedSettings {
	serverConfig?: Partial<MetricsServerConfig>;
	customMetricsPrefix?: string;
	scrape?: {
		stores?: Record<string, StoreSettings>;
		jobs?: Partial<ScrapeJobSettings>[];
	};
	storage?: Partial<StorageSettings>;
	onboarded?: boolean;
}

/** Deep-merge loaded data over defaults (loadData may predate new fields). */
export function mergeSettings(loaded: unknown): ObsidianMetricsSettings {
	const data = (loaded ?? {}) as LoadedSettings;
	return {
		serverConfig: {
			...DEFAULT_SETTINGS.serverConfig,
			...(data.serverConfig ?? {}),
		},
		customMetricsPrefix:
			data.customMetricsPrefix ?? DEFAULT_SETTINGS.customMetricsPrefix,
		scrape: {
			stores: { ...data.scrape?.stores },
			jobs: (data.scrape?.jobs ?? []).map((job) => ({
				jobName: job.jobName ?? "job",
				targets: Array.isArray(job.targets) ? job.targets : [],
				intervalSeconds: job.intervalSeconds ?? 30,
				timeoutSeconds: job.timeoutSeconds ?? 10,
				enabled: job.enabled ?? true,
			})),
		},
		storage: {
			...DEFAULT_SETTINGS.storage,
			...(data.storage ?? {}),
		},
		onboarded: data.onboarded ?? false,
	};
}
