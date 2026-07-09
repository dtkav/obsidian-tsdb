import * as client from 'prom-client';
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

export class MetricsManager implements MetricsRegistry {
	private registry: client.Registry;
	private metrics: Map<string, client.Metric<string>>;
	private prefix: string;

	constructor(prefix: string = 'obsidian_') {
		this.registry = new client.Registry();
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

		const counter = new client.Counter({
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

		const gauge = new client.Gauge({
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

		const histogram = new client.Histogram({
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

		const summary = new client.Summary({
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
		if (metric instanceof client.Counter) {
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

		if (metric instanceof client.Gauge) {
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

		if (metric instanceof client.Histogram) {
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

		if (metric instanceof client.Summary) {
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

	getRegistry(): client.Registry {
		return this.registry;
	}

	setDefaultLabels(labels: Record<string, string>): void {
		this.registry.setDefaultLabels(labels);
	}
}