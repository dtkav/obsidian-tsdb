import { PromQLError, parseDuration } from "../promql/ast";
import { PromQLEngine } from "../promql/engine";
import { parseSeriesSelector } from "../promql/parser";
import { MetricsStore } from "../storage/store";
import { Matcher } from "../labels";
import type {
	ErrnoError,
	HttpModule,
	IncomingMessage,
	Server,
	ServerResponse,
	Socket,
	UrlModule,
} from "../types/runtime";

// The Electron renderer that hosts plugins exposes CommonJS require; call it
// through an alias so the Node builtins load at runtime without importing them.
const nodeRequire = require;
const http = nodeRequire("http") as HttpModule;
const { URL, URLSearchParams } = nodeRequire("url") as UrlModule;

export interface ApiServerDeps {
	/** Text exposition of the live prom-client registry (the /metrics page). */
	getExposition: () => Promise<string>;
	engine: PromQLEngine;
	store: MetricsStore;
	getHealth: () => ApiHealthStatus;
	getMetricsPath: () => string;
	pluginVersion: string;
}

/** Parse a Prometheus API time param: unix seconds (float) or RFC 3339. */
export function parseTimeParam(raw: string): number {
	if (/^-?\d+(\.\d+)?$/.test(raw)) {
		return Math.round(parseFloat(raw) * 1000);
	}
	const ms = Date.parse(raw);
	if (Number.isNaN(ms)) {
		throw new PromQLError(`invalid time value: "${raw}"`);
	}
	return ms;
}

/** Parse a step param: seconds (float) or a duration string like "15s". */
export function parseStepParam(raw: string): number {
	if (/^-?\d+(\.\d+)?$/.test(raw)) {
		return Math.round(parseFloat(raw) * 1000);
	}
	return parseDuration(raw);
}

interface ApiRequest {
	params: URLSearchParams;
	pathname: string;
}

export interface ApiHealthStatus {
	ok: boolean;
	storeOpen: boolean;
	queryEngineReady: boolean;
	lastIngestMs: number | null;
	lastIngestSampleCount: number;
	lastIngestError: string | null;
	lastIngestErrorMs: number | null;
	inFlightIngests: number;
}

/**
 * HTTP server exposing:
 *  - the exposition endpoint (settings.metricsPath) and /health (unchanged)
 *  - a Prometheus-compatible query API under /api/v1/, so the plugin can be
 *    used directly as a "Prometheus" datasource in Grafana.
 */
export class ApiServer {
	private server: Server | null = null;
	private port: number | null = null;
	private sockets = new Set<Socket>();
	private deps: ApiServerDeps | null;

	constructor(deps: ApiServerDeps) {
		this.deps = deps;
	}

	get listening(): boolean {
		return this.server?.listening ?? false;
	}

	/** The actually-bound port while listening, else null. */
	get boundPort(): number | null {
		return this.listening ? this.port : null;
	}

	/** Start listening; rejects on bind errors (EADDRINUSE etc.). */
	listen(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				void this.handle(req, res);
			});
			server.on("connection", (socket) => {
				this.sockets.add(socket);
				socket.on("close", () => this.sockets.delete(socket));
			});
			server.once("error", (error) => {
				this.server = null;
				this.port = null;
				reject(error);
			});
			server.listen(port, "127.0.0.1", () => {
				this.server = server;
				this.port = port;
				resolve();
			});
		});
	}

	/**
	 * Try each port in [startPort, endPort] until one binds (so several
	 * vaults can run the plugin side by side). Returns the bound port;
	 * rejects with the last error if every port is taken.
	 */
	async listenRange(startPort: number, endPort: number): Promise<number> {
		let lastError: unknown = new Error("no ports to try");
		for (let port = startPort; port <= endPort; port++) {
			try {
				await this.listen(port);
				return port;
			} catch (error: unknown) {
				lastError = error;
				// Only walk the range for "port taken" style errors.
				const code = (error as ErrnoError | undefined)?.code;
				if (code !== "EADDRINUSE" && code !== "EACCES") {
					throw error;
				}
			}
		}
		throw lastError;
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			const server = this.server;
			if (!server) {
				resolve();
				return;
			}
			for (const socket of this.sockets) {
				socket.destroy();
			}
			server.close(() => {
				server.removeAllListeners();
				this.server = null;
				this.port = null;
				this.sockets.clear();
				resolve();
			});
		});
	}

	dispose(): void {
		const server = this.server;
		if (server) {
			server.removeAllListeners();
		}
		for (const socket of this.sockets) {
			socket.destroy();
		}
		this.sockets.clear();
		this.server = null;
		this.port = null;
		this.deps = null;
	}

	private async readParams(
		req: IncomingMessage,
		url: URL
	): Promise<URLSearchParams> {
		const params = new URLSearchParams(url.search);
		if (req.method === "POST") {
			const contentType = req.headers["content-type"] ?? "";
			if (contentType.includes("application/x-www-form-urlencoded")) {
				const body = await new Promise<string>((resolve, reject) => {
					let raw = "";
					req.setEncoding("utf8");
					req.on("data", (chunk) => (raw += chunk));
					req.on("end", () => resolve(raw));
					req.on("error", reject);
				});
				new URLSearchParams(body).forEach((value, key) =>
					params.append(key, value)
				);
			}
		}
		return params;
	}

	private async handle(
		req: IncomingMessage,
		res: ServerResponse
	): Promise<void> {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		const url = new URL(req.url ?? "/", "http://localhost");
		const pathname = url.pathname;

		try {
			const deps = this.deps;
			if (!deps) {
				this.json(res, 503, {
					status: "error",
					errorType: "unavailable",
					error: "server is shutting down",
				});
				return;
			}
			if (pathname === deps.getMetricsPath()) {
				const text = await deps.getExposition();
				res.writeHead(200, {
					"Content-Type": "text/plain; version=0.0.4; charset=utf-8",
				});
				res.end(text);
				return;
			}
			if (pathname === "/health" || pathname === "/-/healthy") {
				const health = deps.getHealth();
				this.json(res, health.ok ? 200 : 503, {
					status: health.ok ? "ok" : "error",
					timestamp: new Date().toISOString(),
					metrics_endpoint: deps.getMetricsPath(),
					...health,
				});
				return;
			}
			if (pathname.startsWith("/api/v1/")) {
				const params = await this.readParams(req, url);
				await this.handleApiV1(res, { pathname, params }, deps);
				return;
			}
			this.json(res, 404, {
				status: "error",
				errorType: "not_found",
				error: "not found",
				available_endpoints: [
					deps.getMetricsPath(),
					"/health",
					"/api/v1/*",
				],
			});
		} catch (error) {
			this.sendError(res, error);
		}
	}

	private async handleApiV1(
		res: ServerResponse,
		request: ApiRequest,
		deps: ApiServerDeps
	): Promise<void> {
		const { pathname, params } = request;
		const { engine, store } = deps;

		switch (pathname) {
			case "/api/v1/query": {
				const query = this.required(params, "query");
				const timeMs = params.has("time")
					? parseTimeParam(params.get("time") as string)
					: Date.now();
				this.success(res, await engine.instantQuery(query, timeMs));
				return;
			}
			case "/api/v1/query_range": {
				const query = this.required(params, "query");
				const startMs = parseTimeParam(this.required(params, "start"));
				const endMs = parseTimeParam(this.required(params, "end"));
				const stepMs = parseStepParam(this.required(params, "step"));
				this.success(res, await engine.rangeQuery(query, startMs, endMs, stepMs));
				return;
			}
			case "/api/v1/series": {
				const selectors = params.getAll("match[]");
				if (selectors.length === 0) {
					throw new PromQLError('no match[] parameter provided');
				}
				const startMs = params.has("start")
					? parseTimeParam(params.get("start") as string)
					: undefined;
				const endMs = params.has("end")
					? parseTimeParam(params.get("end") as string)
					: undefined;
				const seen = new Set<string>();
				const result: Record<string, string>[] = [];
				for (const selector of selectors) {
					const matchers = parseSeriesSelector(selector);
					for (const labels of await store.seriesMatching(matchers, startMs, endMs)) {
						const key = JSON.stringify(labels);
						if (!seen.has(key)) {
							seen.add(key);
							result.push(labels);
						}
					}
				}
				this.success(res, result);
				return;
			}
			case "/api/v1/labels": {
				const matchers = this.optionalMatchers(params);
				this.success(res, await store.labelNames(matchers));
				return;
			}
			case "/api/v1/status/buildinfo": {
				// Grafana feature-detects on this; report a Prometheus-2.x-
				// compatible version.
				this.success(res, {
					version: "2.24.0",
					application: "tsdb",
					pluginVersion: deps.pluginVersion,
					revision: "",
					branch: "",
					buildUser: "",
					buildDate: "",
					goVersion: "",
				});
				return;
			}
			case "/api/v1/status/tsdb": {
				const stats = await store.stats();
				this.success(res, {
					headStats: {
						numSeries: stats.seriesCount,
						numSamples: stats.sampleCount,
						minTime: stats.oldestSampleMs,
						maxTime: stats.newestSampleMs,
					},
					seriesCountByMetricName: [],
				});
				return;
			}
			case "/api/v1/export": {
				// JSON-lines export.
				const selectors = params.getAll("match[]");
				if (selectors.length === 0) {
					throw new PromQLError('no match[] parameter provided');
				}
				const startMs = params.has("start")
					? parseTimeParam(params.get("start") as string)
					: 0;
				const endMs = params.has("end")
					? parseTimeParam(params.get("end") as string)
					: Date.now();
				res.writeHead(200, { "Content-Type": "application/stream+json" });
				for (const selector of selectors) {
					const matchers = parseSeriesSelector(selector);
					for (const series of await store.select(matchers, startMs, endMs)) {
						res.write(
							JSON.stringify({
								metric: series.labels,
								values: series.points.map((p) => p.v),
								timestamps: series.points.map((p) => p.t),
							}) + "\n"
						);
					}
				}
				res.end();
				return;
			}
			// Endpoints Grafana probes that we answer with empty success:
			case "/api/v1/metadata":
				this.success(res, {});
				return;
			case "/api/v1/rules":
				this.success(res, { groups: [] });
				return;
			case "/api/v1/alerts":
				this.success(res, { alerts: [] });
				return;
			case "/api/v1/query_exemplars":
				this.success(res, []);
				return;
		}

		const labelValues = /^\/api\/v1\/label\/([^/]+)\/values$/.exec(pathname);
		if (labelValues) {
			const labelName = decodeURIComponent(labelValues[1]);
			const matchers = this.optionalMatchers(params);
			this.success(res, await deps.store.labelValues(labelName, matchers));
			return;
		}

		this.json(res, 404, {
			status: "error",
			errorType: "not_found",
			error: `unknown endpoint ${pathname}`,
		});
	}

	private optionalMatchers(params: URLSearchParams): Matcher[] {
		const selectors = params.getAll("match[]");
		if (selectors.length === 0) return [];
		// Multiple selectors are OR'd in Prometheus; approximate with the
		// first (single-selector requests are what Grafana sends).
		return parseSeriesSelector(selectors[0]);
	}

	private required(params: URLSearchParams, name: string): string {
		const value = params.get(name);
		if (value === null || value === "") {
			throw new PromQLError(`missing required parameter "${name}"`);
		}
		return value;
	}

	private success(res: ServerResponse, data: unknown): void {
		this.json(res, 200, { status: "success", data });
	}

	private sendError(res: ServerResponse, error: unknown): void {
		if (error instanceof PromQLError) {
			this.json(res, 400, {
				status: "error",
				errorType: error.errorType,
				error: error.message,
			});
			return;
		}
		console.error("tsdb: API error", error);
		this.json(res, 500, {
			status: "error",
			errorType: "internal",
			error: String(error),
		});
	}

	private json(res: ServerResponse, code: number, body: unknown): void {
		res.writeHead(code, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	}
}
