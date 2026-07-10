import { Labels, NAME_LABEL } from "../labels";
import { StoredSample } from "../storage/store";
import { SampleSink } from "../storage/wal";
import { parseExposition } from "./parser";
import type { ClientRequest, HttpModule, UrlModule } from "../types/runtime";

// The Electron renderer that hosts plugins exposes CommonJS require; call it
// through an alias so the Node builtins load at runtime without importing them.
const nodeRequire = require;
const http = nodeRequire("http") as HttpModule;
const https = nodeRequire("https") as HttpModule;
const { URL } = nodeRequire("url") as UrlModule;

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
	read?: () => Promise<string>;
	collect?: () => Promise<ScrapedSample[]>;
}

export const DEFAULT_SCRAPE_INTERVAL_SECONDS = 30;
export const DEFAULT_SCRAPE_TIMEOUT_SECONDS = 10;

/** Labels every scrape attaches; colliding target labels get exported_ prefix. */
const RESERVED_TARGET_LABELS = ["job", "instance"];

export interface ScrapedSample {
	name: string;
	labels: Labels;
	value: number;
	timestampMs?: number;
}

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
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			reject(new Error(`unsupported target URL protocol: ${parsed.protocol}`));
			return;
		}
		const lib = parsed.protocol === "https:" ? https : http;
		let req: ClientRequest | null = null;
		let settled = false;
		const timeoutId = window.setTimeout(() => {
			const error = new Error(`scrape timeout for ${url}`);
			req?.destroy(error);
			fail(error);
		}, Math.max(1, timeoutMs));
		const succeed = (text: string) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeoutId);
			resolve(text);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeoutId);
			reject(error);
		};
		try {
			req = lib.get(parsed, { timeout: timeoutMs }, (res) => {
				const status = res.statusCode ?? 0;
				if (status >= 300 && status < 400 && res.headers.location) {
					res.resume();
					if (maxRedirects <= 0) {
						fail(new Error(`too many redirects for ${url}`));
						return;
					}
					const next = new URL(res.headers.location, parsed).toString();
					fetchText(next, timeoutMs, maxRedirects - 1).then(succeed, (error) =>
						fail(error instanceof Error ? error : new Error(String(error)))
					);
					return;
				}
				if (status !== 200) {
					res.resume();
					fail(new Error(`unexpected status ${status} from ${url}`));
					return;
				}
				res.setEncoding("utf8");
				let body = "";
				res.on("data", (chunk) => (body += chunk));
				res.on("end", () => succeed(body));
				res.on("error", fail);
			});
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		req.on("timeout", () =>
			req?.destroy(new Error(`scrape timeout for ${url}`))
		);
		req.on("error", fail);
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
	return buildStoredSamplesFromScraped(
		parseExposition(text),
		jobName,
		instance,
		scrapeTimeMs
	);
}

export function buildStoredSamplesFromScraped(
	parsed: ScrapedSample[],
	jobName: string,
	instance: string,
	scrapeTimeMs: number
): StoredSample[] {
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

export type ScrapeStatusChangeListener = () => void;

export interface ScrapeObservation {
	source: string;
	target: string;
	kind: "self" | "target";
	status: "ok" | "error";
	durationSeconds: number;
	samplesScraped: number;
}

export type ScrapeObserver = (observation: ScrapeObservation) => void;

/**
 * Schedules scrapes of the plugin's own registry and of external HTTP
 * targets, writing samples into the MetricsStore.
 */
export class Scraper {
	private sink: SampleSink;
	private onTargetStatusChange: ScrapeStatusChangeListener | null;
	private observer: ScrapeObserver | null;
	private timers: number[] = [];
	private inFlight = new Map<string, number>();
	private statuses = new Map<string, ScraperStatus>();
	private generation = 0;

	constructor(
		sink: SampleSink,
		onTargetStatusChange: ScrapeStatusChangeListener | null = null,
		observer: ScrapeObserver | null = null
	) {
		this.sink = sink;
		this.onTargetStatusChange = onTargetStatusChange;
		this.observer = observer;
	}

	start(
		jobs: ScrapeJobConfig[],
		selfSources: SelfSourceConfig[],
		instance: string
	): void {
		this.stop();
		const generation = ++this.generation;
		this.statuses.clear();
		this.onTargetStatusChange?.();

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
		this.inFlight.clear();
		this.generation++;
	}

	dispose(): void {
		this.stop();
		this.inFlight.clear();
		this.statuses.clear();
		this.sink = { ingest: () => undefined };
		this.observer = null;
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
		if (this.inFlight.get(key) === generation) return;
		this.inFlight.set(key, generation);
		const started = Date.now();
		try {
			const samples =
				source.collect !== undefined
					? buildStoredSamplesFromScraped(
							await source.collect(),
							source.jobName,
							instance,
							started
						)
					: buildStoredSamples(
							await source.read!(),
							source.jobName,
							instance,
							started
						);
			if (generation !== this.generation) return;
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
			this.observeScrape({
				source: source.jobName,
				target: "self",
				kind: "self",
				status: "ok",
				durationSeconds: duration,
				samplesScraped: samples.length - 3,
			});
			this.setStatus(key, source.jobName, "self", started, null);
		} catch (error) {
			if (generation !== this.generation) return;
			await this.recordFailure(source.jobName, instance, started);
			if (generation !== this.generation) return;
			this.observeScrape({
				source: source.jobName,
				target: "self",
				kind: "self",
				status: "error",
				durationSeconds: (Date.now() - started) / 1000,
				samplesScraped: 0,
			});
			this.setStatus(key, source.jobName, "self", started, String(error));
		} finally {
			if (this.inFlight.get(key) === generation) this.inFlight.delete(key);
		}
	}

	private async scrapeTarget(
		job: ScrapeJobConfig,
		target: string,
		generation: number
	): Promise<void> {
		const key = `${job.jobName}//${target}`;
		if (this.inFlight.get(key) === generation) return;
		this.inFlight.set(key, generation);
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
			this.setStatus(key, job.jobName, target, started, null, true);
			await this.sink.ingest(samples);
			if (generation !== this.generation) return;
			this.observeScrape({
				source: job.jobName,
				target,
				kind: "target",
				status: "ok",
				durationSeconds: duration,
				samplesScraped: samples.length - 3,
			});
		} catch (error) {
			if (generation !== this.generation) return;
			this.setStatus(key, job.jobName, target, started, String(error), true);
			await this.recordFailure(job.jobName, instance, started);
			this.observeScrape({
				source: job.jobName,
				target,
				kind: "target",
				status: "error",
				durationSeconds: (Date.now() - started) / 1000,
				samplesScraped: 0,
			});
		} finally {
			if (this.inFlight.get(key) === generation) this.inFlight.delete(key);
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
		lastError: string | null,
		notify = false
	): void {
		this.statuses.set(key, {
			job,
			target,
			lastScrapeMs,
			lastError,
			up: lastError === null,
		});
		if (notify) this.onTargetStatusChange?.();
	}

	private observeScrape(observation: ScrapeObservation): void {
		try {
			this.observer?.(observation);
		} catch (error) {
			console.error("tsdb: scrape observer failed", error);
		}
	}
}
