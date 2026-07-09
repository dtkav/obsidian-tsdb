import * as http from "http";
import * as https from "https";
import { URL } from "url";
import { Labels, NAME_LABEL } from "../labels";
import { StoredSample } from "../storage/store";
import { SampleSink } from "../storage/wal";
import { parseExposition } from "./parser";

export interface ScrapeJobConfig {
	jobName: string;
	/** Full URLs, e.g. http://localhost:9100/metrics */
	targets: string[];
	intervalSeconds: number;
	timeoutSeconds: number;
	enabled: boolean;
}

/** One metric store recorded from the in-process registry. */
export interface SelfSourceConfig {
	jobName: string;
	intervalSeconds: number;
	read: () => Promise<string>;
}

export const DEFAULT_SCRAPE_INTERVAL_SECONDS = 30;
export const DEFAULT_SCRAPE_TIMEOUT_SECONDS = 10;

/** Labels every scrape attaches; colliding target labels get exported_ prefix. */
const RESERVED_TARGET_LABELS = ["job", "instance"];

export function fetchText(
	url: string,
	timeoutMs: number,
	maxRedirects = 3
): Promise<string> {
	return new Promise((resolve, reject) => {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			reject(new Error(`invalid target URL: ${url}`));
			return;
		}
		const lib = parsed.protocol === "https:" ? https : http;
		const req = lib.get(parsed, { timeout: timeoutMs }, (res) => {
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				if (maxRedirects <= 0) {
					reject(new Error(`too many redirects for ${url}`));
					return;
				}
				const next = new URL(res.headers.location, parsed).toString();
				fetchText(next, timeoutMs, maxRedirects - 1).then(resolve, reject);
				return;
			}
			if (status !== 200) {
				res.resume();
				reject(new Error(`unexpected status ${status} from ${url}`));
				return;
			}
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			res.on("error", reject);
		});
		req.on("timeout", () => req.destroy(new Error(`scrape timeout for ${url}`)));
		req.on("error", reject);
	});
}

export function instanceFromTarget(target: string): string {
	try {
		const parsed = new URL(target);
		return parsed.host;
	} catch {
		return target;
	}
}

/**
 * Convert parsed exposition samples into stored samples, attaching
 * job/instance the way Prometheus does (honor_labels=false semantics:
 * colliding labels are preserved as exported_<label>).
 */
export function buildStoredSamples(
	text: string,
	jobName: string,
	instance: string,
	scrapeTimeMs: number
): StoredSample[] {
	const parsed = parseExposition(text);
	const stored: StoredSample[] = [];
	for (const sample of parsed) {
		if (Number.isNaN(sample.value)) continue; // SQLite has no NaN; drop
		const labels: Labels = { [NAME_LABEL]: sample.name };
		for (const key of Object.keys(sample.labels)) {
			if (RESERVED_TARGET_LABELS.includes(key)) {
				labels["exported_" + key] = sample.labels[key];
			} else {
				labels[key] = sample.labels[key];
			}
		}
		labels.job = jobName;
		labels.instance = instance;
		stored.push({
			labels,
			ts: sample.timestampMs ?? scrapeTimeMs,
			value: sample.value,
		});
	}
	return stored;
}

function syntheticSamples(
	jobName: string,
	instance: string,
	scrapeTimeMs: number,
	up: boolean,
	durationSeconds: number,
	samplesScraped: number
): StoredSample[] {
	const base: Labels = { job: jobName, instance };
	return [
		{
			labels: { [NAME_LABEL]: "up", ...base },
			ts: scrapeTimeMs,
			value: up ? 1 : 0,
		},
		{
			labels: { [NAME_LABEL]: "scrape_duration_seconds", ...base },
			ts: scrapeTimeMs,
			value: durationSeconds,
		},
		{
			labels: { [NAME_LABEL]: "scrape_samples_scraped", ...base },
			ts: scrapeTimeMs,
			value: samplesScraped,
		},
	];
}

export interface ScraperStatus {
	job: string;
	target: string;
	lastScrapeMs: number | null;
	lastError: string | null;
	up: boolean;
}

/**
 * Schedules scrapes of the plugin's own registry and of external HTTP
 * targets, writing samples into the MetricsStore.
 */
export class Scraper {
	private sink: SampleSink;
	private timers: number[] = [];
	private inFlight = new Set<string>();
	private statuses = new Map<string, ScraperStatus>();
	private generation = 0;

	constructor(sink: SampleSink) {
		this.sink = sink;
	}

	start(
		jobs: ScrapeJobConfig[],
		selfSources: SelfSourceConfig[],
		instance: string
	): void {
		this.stop();
		const generation = ++this.generation;

		for (const source of selfSources) {
			const run = () => void this.scrapeSelf(source, instance, generation);
			run();
			this.timers.push(
				window.setInterval(run, Math.max(1, source.intervalSeconds) * 1000)
			);
		}

		for (const job of jobs) {
			if (!job.enabled || job.targets.length === 0) continue;
			const run = () => {
				for (const target of job.targets) {
					void this.scrapeTarget(job, target, generation);
				}
			};
			run();
			this.timers.push(
				window.setInterval(run, Math.max(5, job.intervalSeconds) * 1000)
			);
		}
	}

	stop(): void {
		for (const timer of this.timers) window.clearInterval(timer);
		this.timers = [];
		this.generation++;
	}

	dispose(): void {
		this.stop();
		this.inFlight.clear();
		this.statuses.clear();
		this.sink = { ingest: () => undefined };
	}

	getStatuses(): ScraperStatus[] {
		return Array.from(this.statuses.values());
	}

	private async scrapeSelf(
		source: SelfSourceConfig,
		instance: string,
		generation: number
	): Promise<void> {
		const key = `${source.jobName}//self`;
		if (this.inFlight.has(key)) return;
		this.inFlight.add(key);
		const started = Date.now();
		try {
			const text = await source.read();
			if (generation !== this.generation) return;
			const samples = buildStoredSamples(
				text,
				source.jobName,
				instance,
				started
			);
			const duration = (Date.now() - started) / 1000;
			samples.push(
				...syntheticSamples(
					source.jobName,
					instance,
					started,
					true,
					duration,
					samples.length
				)
			);
			if (generation !== this.generation) return;
			await this.sink.ingest(samples);
			if (generation !== this.generation) return;
			this.setStatus(key, source.jobName, "self", started, null);
		} catch (error) {
			if (generation !== this.generation) return;
			await this.recordFailure(source.jobName, instance, started);
			if (generation !== this.generation) return;
			this.setStatus(key, source.jobName, "self", started, String(error));
		} finally {
			this.inFlight.delete(key);
		}
	}

	private async scrapeTarget(
		job: ScrapeJobConfig,
		target: string,
		generation: number
	): Promise<void> {
		const key = `${job.jobName}//${target}`;
		if (this.inFlight.has(key)) return;
		this.inFlight.add(key);
		const instance = instanceFromTarget(target);
		const started = Date.now();
		try {
			const text = await fetchText(
				target,
				Math.max(1, job.timeoutSeconds) * 1000
			);
			if (generation !== this.generation) return;
			const samples = buildStoredSamples(text, job.jobName, instance, started);
			const duration = (Date.now() - started) / 1000;
			samples.push(
				...syntheticSamples(
					job.jobName,
					instance,
					started,
					true,
					duration,
					samples.length
				)
			);
			if (generation !== this.generation) return;
			await this.sink.ingest(samples);
			if (generation !== this.generation) return;
			this.setStatus(key, job.jobName, target, started, null);
		} catch (error) {
			if (generation !== this.generation) return;
			await this.recordFailure(job.jobName, instance, started);
			if (generation !== this.generation) return;
			this.setStatus(key, job.jobName, target, started, String(error));
		} finally {
			this.inFlight.delete(key);
		}
	}

	private async recordFailure(
		jobName: string,
		instance: string,
		scrapeTimeMs: number
	): Promise<void> {
		try {
			await this.sink.ingest(
				syntheticSamples(
					jobName,
					instance,
					scrapeTimeMs,
					false,
					(Date.now() - scrapeTimeMs) / 1000,
					0
				)
			);
		} catch (error) {
			console.error("tsdb: failed to record scrape failure", error);
		}
	}

	private setStatus(
		key: string,
		job: string,
		target: string,
		lastScrapeMs: number,
		lastError: string | null
	): void {
		this.statuses.set(key, {
			job,
			target,
			lastScrapeMs,
			lastError,
			up: lastError === null,
		});
	}
}
