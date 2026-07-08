import { MetricsManager } from './metrics-manager';
import {
	CounterOptions,
	GaugeOptions,
	HistogramOptions,
	SummaryOptions,
	MetricInstance,
	IObsidianMetricsAPI
} from '../types';

export class ObsidianMetricsAPI implements IObsidianMetricsAPI {
	private metricsManager: MetricsManager;

	constructor(metricsManager: MetricsManager) {
		this.metricsManager = metricsManager;
	}
	/**
	 * Create a new counter metric
	 * Counters only go up and can track cumulative values
	 * @param options Counter configuration options
	 * @returns MetricInstance for the created counter
	 */
	createCounter(options: CounterOptions): MetricInstance {
		return this.metricsManager.createCounter(options);
	}

	/**
	 * Create a new gauge metric
	 * Gauges can go up and down and represent a point-in-time value
	 * @param options Gauge configuration options
	 * @returns MetricInstance for the created gauge
	 */
	createGauge(options: GaugeOptions): MetricInstance {
		return this.metricsManager.createGauge(options);
	}

	/**
	 * Create a new histogram metric
	 * Histograms track distributions of values in configurable buckets
	 * @param options Histogram configuration options
	 * @returns MetricInstance for the created histogram
	 */
	createHistogram(options: HistogramOptions): MetricInstance {
		return this.metricsManager.createHistogram(options);
	}

	/**
	 * Create a new summary metric
	 * Summaries track distributions with configurable percentiles
	 * @param options Summary configuration options
	 * @returns MetricInstance for the created summary
	 */
	createSummary(options: SummaryOptions): MetricInstance {
		return this.metricsManager.createSummary(options);
	}

	/**
	 * Get an existing metric by name
	 * @param name Metric name (with or without prefix)
	 * @returns MetricInstance if found, undefined otherwise
	 */
	getMetric(name: string): MetricInstance | undefined {
		return this.metricsManager.getMetric(name);
	}

	/**
	 * Get all metrics in Prometheus text format
	 * @returns Promise resolving to string containing all metrics
	 */
	async getAllMetrics(): Promise<string> {
		return await this.metricsManager.getAllMetrics();
	}

	/**
	 * Clear a specific metric by name
	 * @param name Metric name to clear
	 * @returns true if metric was found and cleared, false otherwise
	 */
	clearMetric(name: string): boolean {
		return this.metricsManager.clearMetric(name);
	}

	/**
	 * Clear all metrics (including default system metrics)
	 * This will also re-register default metrics
	 */
	clearAllMetrics(): void {
		this.metricsManager.clearAllMetrics();
	}

	/**
	 * Convenience method to create and immediately use a counter
	 * @param name Metric name
	 * @param help Metric description
	 * @param value Optional initial value to increment by
	 * @returns MetricInstance for the created counter
	 */
	counter(name: string, help: string, value?: number): MetricInstance {
		const counter = this.createCounter({ name, help });
		if (value !== undefined) {
			counter.inc(value);
		}
		return counter;
	}

	/**
	 * Convenience method to create and immediately use a gauge
	 * @param name Metric name
	 * @param help Metric description
	 * @param value Optional initial value to set
	 * @returns MetricInstance for the created gauge
	 */
	gauge(name: string, help: string, value?: number): MetricInstance {
		const gauge = this.createGauge({ name, help });
		if (value !== undefined) {
			gauge.set(value);
		}
		return gauge;
	}

	/**
	 * Convenience method to create and immediately use a histogram
	 * @param name Metric name
	 * @param help Metric description
	 * @param buckets Optional bucket configuration
	 * @returns MetricInstance for the created histogram
	 */
	histogram(name: string, help: string, buckets?: number[]): MetricInstance {
		return this.createHistogram({ name, help, buckets });
	}

	/**
	 * Convenience method to create and immediately use a summary
	 * @param name Metric name
	 * @param help Metric description
	 * @param percentiles Optional percentiles configuration
	 * @returns MetricInstance for the created summary
	 */
	summary(name: string, help: string, percentiles?: number[]): MetricInstance {
		return this.createSummary({ name, help, percentiles });
	}

	/**
	 * Create a timer function that measures duration
	 * @param metricName Name of histogram or summary metric to use
	 * @returns Timer function that when called returns the measured duration
	 */
	createTimer(metricName: string): () => number {
		const metric = this.getMetric(metricName);
		if (!metric) {
			throw new Error(`Metric ${metricName} not found`);
		}

		const start = Date.now();
		let timerEnd: (() => void) | undefined;

		try {
			timerEnd = metric.startTimer();
		} catch (e) {
			// Fallback for metrics that don't support timing
		}

		return () => {
			const duration = Date.now() - start;
			
			if (timerEnd) {
				timerEnd();
			} else {
				// Fallback: manually observe the duration
				try {
					metric.observe(duration / 1000); // Convert to seconds
				} catch (e) {
					// If observe doesn't work, this metric type doesn't support timing
					console.warn(`Metric ${metricName} does not support timing operations`);
				}
			}
			
			return duration;
		};
	}

	/**
	 * Measure the execution time of an async function
	 * @param metricName Name of histogram or summary metric to use
	 * @param fn Async function to measure
	 * @returns Promise resolving to the function result
	 */
	async measureAsync<T>(metricName: string, fn: () => Promise<T>): Promise<T> {
		const timer = this.createTimer(metricName);
		try {
			const result = await fn();
			timer();
			return result;
		} catch (error) {
			timer();
			throw error;
		}
	}

	/**
	 * Measure the execution time of a synchronous function
	 * @param metricName Name of histogram or summary metric to use
	 * @param fn Synchronous function to measure
	 * @returns Function result
	 */
	measureSync<T>(metricName: string, fn: () => T): T {
		const timer = this.createTimer(metricName);
		try {
			const result = fn();
			timer();
			return result;
		} catch (error) {
			timer();
			throw error;
		}
	}
}
