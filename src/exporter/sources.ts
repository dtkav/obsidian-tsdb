import { MetricsManager } from "./metrics-manager";
import { ObsidianMetricsAPI } from "./metrics-api";

/**
 * A metric "store": a named prom-client registry recorded into the TSDB at
 * its own frequency (job label = store name). Built-ins live in separate
 * vault/performance stores; every other consumer claims a named store via
 * api.getStore(name, { intervalSeconds }).
 */
export interface MetricSource {
	name: string;
	/** Human-facing section title in settings. */
	displayName?: string;
	manager: MetricsManager;
	api: ObsidianMetricsAPI;
	/** Requested default; user settings can override per store name. */
	defaultIntervalSeconds: number;
	/** Shown in settings: what this store records, provided at registration. */
	description?: string;
}

export interface StoreOptions {
	intervalSeconds?: number;
	displayName?: string;
	description?: string;
}

export const VAULT_SOURCE = "vault";
export const PERFORMANCE_SOURCE = "performance";
export const TSDB_SOURCE = "tsdb";

/** Stores registered without an interval record at 1s. */
export const DEFAULT_STORE_INTERVAL_SECONDS = 1;

export const DEFAULT_SOURCE_INTERVALS: Record<string, number> = {
	[VAULT_SOURCE]: 30,
	[PERFORMANCE_SOURCE]: 30,
	[TSDB_SOURCE]: 30,
};

export class MetricSourceRegistry {
	private prefix: string;
	private defaultLabels: Record<string, string> = {};
	private sources = new Map<string, MetricSource>();
	private onAdded: (source: MetricSource) => void;

	constructor(
		prefix: string,
		onAdded: (source: MetricSource) => void = () => undefined
	) {
		this.prefix = prefix;
		this.onAdded = onAdded;
	}

	setDefaultLabels(labels: Record<string, string>): void {
		this.defaultLabels = labels;
		for (const source of this.sources.values()) {
			source.manager.setDefaultLabels(labels);
		}
	}

	getSource(name: string, options: StoreOptions = {}): MetricSource {
		const existing = this.sources.get(name);
		if (existing) {
			if (options.displayName && !existing.displayName) {
				existing.displayName = options.displayName;
			}
			if (options.description && !existing.description) {
				existing.description = options.description;
			}
			return existing;
		}

		const manager = new MetricsManager(this.prefix);
		manager.setDefaultLabels(this.defaultLabels);
		const source: MetricSource = {
			name,
			displayName: options.displayName,
			manager,
			api: new ObsidianMetricsAPI(manager),
			defaultIntervalSeconds:
				options.intervalSeconds ??
				DEFAULT_SOURCE_INTERVALS[name] ??
				DEFAULT_STORE_INTERVAL_SECONDS,
			description: options.description,
		};
		this.sources.set(name, source);
		this.onAdded(source);
		return source;
	}

	list(): MetricSource[] {
		return Array.from(this.sources.values());
	}

	dispose(): void {
		this.onAdded = () => undefined;
		this.sources.clear();
		this.defaultLabels = {};
	}

	/**
	 * Combined exposition of every store, for the /metrics endpoint.
	 * Concatenated per-registry (NOT prom-client's Registry.merge, which
	 * would drop each registry's default labels).
	 */
	async exposition(): Promise<string> {
		const parts = await Promise.all(
			this.list().map((source) => source.manager.getAllMetrics())
		);
		return parts.filter((text) => text.trim().length > 0).join("\n");
	}
}
