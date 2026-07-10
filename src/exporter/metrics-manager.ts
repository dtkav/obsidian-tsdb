import type { Metric } from 'prom-client';
import Registry from 'prom-client/lib/registry';
import Counter from 'prom-client/lib/counter';
import Gauge from 'prom-client/lib/gauge';
import Histogram from 'prom-client/lib/histogram';
import Summary from 'prom-client/lib/summary';
import type { Labels } from '../labels';
import {
	CounterOptions,
	GaugeOptions,
	HistogramOptions,
	SummaryOptions,
	MetricLabels,
	MetricInstance,
	LabeledMetricInstance,
	MetricsRegistry
} from '../types';

interface RegistryMetricValue {
	value: number;
	labels?: Record<string, string | number>;
	metricName?: string;
}

interface RegistryMetricJson {
	name: string;
	values?: RegistryMetricValue[];
}

export interface CollectedMetricSample {
	name: string;
	labels: Labels;
	value: number;
}

export class MetricsManager implements MetricsRegistry {
	private registry: Registry;
	private metrics: Map<string, Metric<string>>;
	private prefix: string;

	constructor(prefix: string = 'obsidian_') {
		this.registry = new Registry();
		this.metrics = new Map();
		this.prefix = prefix;
		
		// Don't collect Node.js default metrics - we only want Obsidian-specific metrics
	}

	createCounter(options: CounterOptions): MetricInstance {
		const name = this.prefix + options.name;

		// Idempotent: return existing metric if it exists
		if (this.metrics.has(name)) {
			return this.getMetric(name)!;
		}

		const counter = new Counter({
			name,
			help: options.help,
			labelNames: options.labelNames || options.labels || [],
			registers: [this.registry]
		});

		this.metrics.set(name, counter);

		return {
			inc: (value?: number, labels?: MetricLabels) => {
				if (labels) {
					counter.labels(labels).inc(value);
				} else {
					counter.inc(value);
				}
			},
			dec: () => { throw new Error('Counter cannot be decremented'); },
			set: () => { throw new Error('Counter cannot be set'); },
			observe: () => { throw new Error('Counter does not support observe'); },
			startTimer: () => { throw new Error('Counter does not support timing'); },
			labels: (labels: MetricLabels): LabeledMetricInstance => {
				const labeled = counter.labels(labels);
				return {
					inc: (value?: number) => labeled.inc(value),
					dec: () => { throw new Error('Counter cannot be decremented'); },
					set: () => { throw new Error('Counter cannot be set'); },
					observe: () => { throw new Error('Counter does not support observe'); },
					startTimer: () => { throw new Error('Counter does not support timing'); }
				};
			}
		};
	}

	createGauge(options: GaugeOptions): MetricInstance {
		const name = this.prefix + options.name;

		// Idempotent: return existing metric if it exists
		if (this.metrics.has(name)) {
			return this.getMetric(name)!;
		}

		const gauge = new Gauge({
			name,
			help: options.help,
			labelNames: options.labelNames || options.labels || [],
			registers: [this.registry]
		});

		this.metrics.set(name, gauge);

		return {
			inc: (value?: number, labels?: MetricLabels) => {
				if (labels) {
					gauge.labels(labels).inc(value);
				} else {
					gauge.inc(value);
				}
			},
			dec: (value?: number, labels?: MetricLabels) => {
				if (labels) {
					gauge.labels(labels).dec(value);
				} else {
					gauge.dec(value);
				}
			},
			set: (value: number, labels?: MetricLabels) => {
				if (labels) {
					gauge.labels(labels).set(value);
				} else {
					gauge.set(value);
				}
			},
			observe: () => { throw new Error('Gauge does not support observe'); },
			startTimer: () => { throw new Error('Gauge does not support timing'); },
			labels: (labels: MetricLabels): LabeledMetricInstance => {
				const labeled = gauge.labels(labels);
				return {
					inc: (value?: number) => labeled.inc(value),
					dec: (value?: number) => labeled.dec(value),
					set: (value: number) => labeled.set(value),
					observe: () => { throw new Error('Gauge does not support observe'); },
					startTimer: () => { throw new Error('Gauge does not support timing'); }
				};
			}
		};
	}

	createHistogram(options: HistogramOptions): MetricInstance {
		const name = this.prefix + options.name;

		// Idempotent: return existing metric if it exists
		if (this.metrics.has(name)) {
			return this.getMetric(name)!;
		}

		const histogram = new Histogram({
			name,
			help: options.help,
			labelNames: options.labelNames || options.labels || [],
			buckets: options.buckets,
			registers: [this.registry]
		});

		this.metrics.set(name, histogram);

		return {
			inc: () => { throw new Error('Histogram does not support inc'); },
			dec: () => { throw new Error('Histogram does not support dec'); },
			set: () => { throw new Error('Histogram does not support set'); },
			observe: (value: number, labels?: MetricLabels) => {
				if (labels) {
					histogram.labels(labels).observe(value);
				} else {
					histogram.observe(value);
				}
			},
			startTimer: (labels?: MetricLabels) => {
				if (labels) {
					return histogram.labels(labels).startTimer();
				} else {
					return histogram.startTimer();
				}
			},
			labels: (labels: MetricLabels): LabeledMetricInstance => {
				const labeled = histogram.labels(labels);
				return {
					inc: () => { throw new Error('Histogram does not support inc'); },
					dec: () => { throw new Error('Histogram does not support dec'); },
					set: () => { throw new Error('Histogram does not support set'); },
					observe: (value: number) => labeled.observe(value),
					startTimer: () => labeled.startTimer()
				};
			}
		};
	}

	createSummary(options: SummaryOptions): MetricInstance {
		const name = this.prefix + options.name;

		// Idempotent: return existing metric if it exists
		if (this.metrics.has(name)) {
			return this.getMetric(name)!;
		}

		const summary = new Summary({
			name,
			help: options.help,
			labelNames: options.labelNames || options.labels || [],
			percentiles: options.percentiles,
			maxAgeSeconds: options.maxAgeSeconds,
			ageBuckets: options.ageBuckets,
			registers: [this.registry]
		});

		this.metrics.set(name, summary);

		return {
			inc: () => { throw new Error('Summary does not support inc'); },
			dec: () => { throw new Error('Summary does not support dec'); },
			set: () => { throw new Error('Summary does not support set'); },
			observe: (value: number, labels?: MetricLabels) => {
				if (labels) {
					summary.labels(labels).observe(value);
				} else {
					summary.observe(value);
				}
			},
			startTimer: (labels?: MetricLabels) => {
				if (labels) {
					return summary.labels(labels).startTimer();
				} else {
					return summary.startTimer();
				}
			},
			labels: (labels: MetricLabels): LabeledMetricInstance => {
				const labeled = summary.labels(labels);
				return {
					inc: () => { throw new Error('Summary does not support inc'); },
					dec: () => { throw new Error('Summary does not support dec'); },
					set: () => { throw new Error('Summary does not support set'); },
					observe: (value: number) => labeled.observe(value),
					startTimer: () => labeled.startTimer()
				};
			}
		};
	}

	getMetric(name: string): MetricInstance | undefined {
		const fullName = name.startsWith(this.prefix) ? name : this.prefix + name;
		const metric = this.metrics.get(fullName);

		if (!metric) {
			return undefined;
		}

		// Return a wrapper that provides the MetricInstance interface
		if (metric instanceof Counter) {
			const counter = metric;
			return {
				inc: (value?: number, labels?: MetricLabels) => {
					if (labels) {
						counter.labels(labels).inc(value);
					} else {
						counter.inc(value);
					}
				},
				dec: () => { throw new Error('Counter cannot be decremented'); },
				set: () => { throw new Error('Counter cannot be set'); },
				observe: () => { throw new Error('Counter does not support observe'); },
				startTimer: () => { throw new Error('Counter does not support timing'); },
				labels: (labels: MetricLabels): LabeledMetricInstance => {
					const labeled = counter.labels(labels);
					return {
						inc: (value?: number) => labeled.inc(value),
						dec: () => { throw new Error('Counter cannot be decremented'); },
						set: () => { throw new Error('Counter cannot be set'); },
						observe: () => { throw new Error('Counter does not support observe'); },
						startTimer: () => { throw new Error('Counter does not support timing'); }
					};
				}
			};
		}

		if (metric instanceof Gauge) {
			const gauge = metric;
			return {
				inc: (value?: number, labels?: MetricLabels) => {
					if (labels) {
						gauge.labels(labels).inc(value);
					} else {
						gauge.inc(value);
					}
				},
				dec: (value?: number, labels?: MetricLabels) => {
					if (labels) {
						gauge.labels(labels).dec(value);
					} else {
						gauge.dec(value);
					}
				},
				set: (value: number, labels?: MetricLabels) => {
					if (labels) {
						gauge.labels(labels).set(value);
					} else {
						gauge.set(value);
					}
				},
				observe: () => { throw new Error('Gauge does not support observe'); },
				startTimer: () => { throw new Error('Gauge does not support timing'); },
				labels: (labels: MetricLabels): LabeledMetricInstance => {
					const labeled = gauge.labels(labels);
					return {
						inc: (value?: number) => labeled.inc(value),
						dec: (value?: number) => labeled.dec(value),
						set: (value: number) => labeled.set(value),
						observe: () => { throw new Error('Gauge does not support observe'); },
						startTimer: () => { throw new Error('Gauge does not support timing'); }
					};
				}
			};
		}

		if (metric instanceof Histogram) {
			const histogram = metric;
			return {
				inc: () => { throw new Error('Histogram does not support inc'); },
				dec: () => { throw new Error('Histogram does not support dec'); },
				set: () => { throw new Error('Histogram does not support set'); },
				observe: (value: number, labels?: MetricLabels) => {
					if (labels) {
						histogram.labels(labels).observe(value);
					} else {
						histogram.observe(value);
					}
				},
				startTimer: (labels?: MetricLabels) => {
					if (labels) {
						return histogram.labels(labels).startTimer();
					} else {
						return histogram.startTimer();
					}
				},
				labels: (labels: MetricLabels): LabeledMetricInstance => {
					const labeled = histogram.labels(labels);
					return {
						inc: () => { throw new Error('Histogram does not support inc'); },
						dec: () => { throw new Error('Histogram does not support dec'); },
						set: () => { throw new Error('Histogram does not support set'); },
						observe: (value: number) => labeled.observe(value),
						startTimer: () => labeled.startTimer()
					};
				}
			};
		}

		if (metric instanceof Summary) {
			const summary = metric;
			return {
				inc: () => { throw new Error('Summary does not support inc'); },
				dec: () => { throw new Error('Summary does not support dec'); },
				set: () => { throw new Error('Summary does not support set'); },
				observe: (value: number, labels?: MetricLabels) => {
					if (labels) {
						summary.labels(labels).observe(value);
					} else {
						summary.observe(value);
					}
				},
				startTimer: (labels?: MetricLabels) => {
					if (labels) {
						return summary.labels(labels).startTimer();
					} else {
						return summary.startTimer();
					}
				},
				labels: (labels: MetricLabels): LabeledMetricInstance => {
					const labeled = summary.labels(labels);
					return {
						inc: () => { throw new Error('Summary does not support inc'); },
						dec: () => { throw new Error('Summary does not support dec'); },
						set: () => { throw new Error('Summary does not support set'); },
						observe: (value: number) => labeled.observe(value),
						startTimer: () => labeled.startTimer()
					};
				}
			};
		}

		return undefined;
	}

	async getAllMetrics(): Promise<string> {
		return await this.registry.metrics();
	}

	/**
	 * Structured collection for in-process TSDB recording. This avoids turning
	 * our own metrics into Prometheus text only to parse that text immediately.
	 */
	async collectSamples(): Promise<CollectedMetricSample[]> {
		const metrics =
			(await this.registry.getMetricsAsJSON()) as RegistryMetricJson[];
		const samples: CollectedMetricSample[] = [];
		for (const metric of metrics) {
			for (const value of metric.values ?? []) {
				const labels: Labels = {};
				for (const [key, labelValue] of Object.entries(value.labels ?? {})) {
					labels[key] = String(labelValue);
				}
				samples.push({
					name: value.metricName ?? metric.name,
					labels,
					value: value.value,
				});
			}
		}
		return samples;
	}

	clearMetric(name: string): boolean {
		const fullName = name.startsWith(this.prefix) ? name : this.prefix + name;
		const metric = this.metrics.get(fullName);
		
		if (metric) {
			this.registry.removeSingleMetric(fullName);
			this.metrics.delete(fullName);
			return true;
		}
		
		return false;
	}

	clearAllMetrics(): void {
		this.registry.clear();
		this.metrics.clear();
		
		// Don't re-register Node.js default metrics - keep only Obsidian metrics
	}

	getRegistry(): Registry {
		return this.registry;
	}

	setDefaultLabels(labels: Record<string, string>): void {
		this.registry.setDefaultLabels(labels);
	}
}
