export interface MetricLabels {
	[key: string]: string;
}

export interface CounterOptions {
	name: string;
	help: string;
	labels?: string[];
	labelNames?: string[];
}

export interface GaugeOptions {
	name: string;
	help: string;
	labels?: string[];
	labelNames?: string[];
}

export interface HistogramOptions {
	name: string;
	help: string;
	labels?: string[];
	labelNames?: string[];
	buckets?: number[];
}

export interface SummaryOptions {
	name: string;
	help: string;
	labels?: string[];
	labelNames?: string[];
	percentiles?: number[];
	maxAgeSeconds?: number;
	ageBuckets?: number;
}

export interface LabeledMetricInstance {
	inc(value?: number): void;
	dec(value?: number): void;
	set(value: number): void;
	observe(value: number): void;
	startTimer(): () => void;
}

export interface MetricInstance {
	inc(value?: number, labels?: MetricLabels): void;
	dec(value?: number, labels?: MetricLabels): void;
	set(value: number, labels?: MetricLabels): void;
	observe(value: number, labels?: MetricLabels): void;
	startTimer(labels?: MetricLabels): () => void;
	labels(labels: MetricLabels): LabeledMetricInstance;
}

export interface MetricsRegistry {
	getMetric(name: string): MetricInstance | undefined;
	getAllMetrics(): Promise<string>;
	clearMetric(name: string): boolean;
	clearAllMetrics(): void;
}

/**
 * The full public API exposed via window.ObsidianMetrics
 * Other plugins can use this interface to type their access to the metrics API
 *
 * @example
 * declare global {
 *   interface Window {
 *     ObsidianMetrics?: IObsidianMetricsAPI;
 *   }
 * }
 *
 * const metrics = window.ObsidianMetrics;
 * if (metrics) {
 *   const gauge = metrics.createGauge({
 *     name: 'my_metric',
 *     help: 'My metric description',
 *     labelNames: ['document']
 *   });
 *   gauge.labels({ document: 'note.md' }).set(42);
 * }
 */
/**
 * The root API exposed as plugin.api and via the 'tsdb:ready'
 * event. Metrics are always created inside a named store: each store is
 * recorded into the local TSDB at its own frequency (job label = store name).
 */
export interface IObsidianMetricsRootAPI {
	/**
	 * Get or create a named metric store. Idempotent per name; the interval
	 * is a default that user settings can override.
	 */
	getStore(
		name: string,
		options?: {
			intervalSeconds?: number;
			displayName?: string;
			description?: string;
		}
	): IObsidianMetricsAPI;
}

export interface IObsidianMetricsAPI extends MetricsRegistry {
	// Metric creation methods
	createCounter(options: CounterOptions): MetricInstance;
	createGauge(options: GaugeOptions): MetricInstance;
	createHistogram(options: HistogramOptions): MetricInstance;
	createSummary(options: SummaryOptions): MetricInstance;

	// Convenience methods (create + optional initial value)
	counter(name: string, help: string, value?: number): MetricInstance;
	gauge(name: string, help: string, value?: number): MetricInstance;
	histogram(name: string, help: string, buckets?: number[]): MetricInstance;
	summary(name: string, help: string, percentiles?: number[]): MetricInstance;

	// Timing utilities
	createTimer(metricName: string): () => number;
	measureAsync<T>(metricName: string, fn: () => Promise<T>): Promise<T>;
	measureSync<T>(metricName: string, fn: () => T): T;
}
