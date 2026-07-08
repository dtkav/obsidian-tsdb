import { Notice, Plugin } from "obsidian";
// esbuild "binary" loader: the SQLite WASM binary is embedded in main.js.
import waSqliteWasm from "wa-sqlite/dist/wa-sqlite-async.wasm";
import { installMetricsGlobal } from "./api/debug-global";
import { ApiServer } from "./api/server";
import {
	setupPerformanceMetrics,
	setupVaultMetrics,
} from "./exporter/builtin-metrics";
import {
	MetricSourceRegistry,
	PERFORMANCE_SOURCE,
	VAULT_SOURCE,
} from "./exporter/sources";
import { PromQLEngine } from "./promql/engine";
import { Scraper, ScraperStatus } from "./scrape/scraper";
import {
	DEFAULT_SETTINGS,
	ObsidianMetricsSettings,
	mergeSettings,
} from "./settings";
import { IObsidianMetricsRootAPI } from "./types";
import { PromQLPanel } from "./panels/panel";
import { migrateLegacySnapshot } from "./storage/chunk-vfs";
import { MetricsStore, StoreStats, StoredSample } from "./storage/store";
import { SampleWal } from "./storage/wal";
import {
	METRICS_DASHBOARD_VIEW_TYPE,
	MetricsDashboardView,
	openMetricsDashboard,
} from "./ui/demo-dashboard";
import { MetricsModal } from "./ui/metrics-modal";
import { MetricsSettingTab } from "./ui/settings-tab";

const LEGACY_DB_FILENAME = "metrics.db";
const TSDB_DIRNAME = "metrics-tsdb";
const WAL_FILENAME = "metrics.wal";
const RETENTION_SWEEP_MS = 60 * 60 * 1000; // hourly

export default class ObsidianMetricsPlugin extends Plugin {
	settings: ObsidianMetricsSettings = DEFAULT_SETTINGS;

	private sources: MetricSourceRegistry | null = null;
	private store: MetricsStore | null = null;
	private wal: SampleWal | null = null;
	private scraper: Scraper | null = null;
	/** Query engine over the local TSDB (used by the API and note panels). */
	public engine: PromQLEngine | null = null;
	private apiServer: ApiServer | null = null;
	private statusBarEl: HTMLElement | null = null;
	private flushTimer: number | null = null;
	private retentionTimer: number | null = null;

	/**
	 * Public API for other plugins: api.getStore(name, { intervalSeconds })
	 * returns a metric-creation API recorded under job=<name>.
	 * Access via app.plugins.plugins['tsdb'].api
	 */
	public api: IObsidianMetricsRootAPI;

	async onload() {
		await this.loadSettings();

		// Exporter side: metric stores (named registries, each recorded at
		// its own frequency). There is no default store — consumers claim a
		// named one via api.getStore(name, { intervalSeconds }).
		const sources = new MetricSourceRegistry(
			this.settings.customMetricsPrefix,
			() => this.restartScraper()
		);
		this.sources = sources;
		sources.setDefaultLabels({
			vault_name: this.app.vault.getName(),
			vault_id: (this.app as any).appId,
		});
		const apiState: { sources: MetricSourceRegistry | null } = {
			sources,
		};
		this.register(() => {
			apiState.sources = null;
		});
		this.api = {
			getStore: (name, options) => {
				if (!apiState.sources) {
					throw new Error("tsdb: plugin is not loaded");
				}
				return apiState.sources.getSource(name, options).api;
			},
		};
		// Register the built-in store up front so it appears in settings with
		// its docstring even before its collectors produce data.
		sources.getSource(VAULT_SOURCE, {
			displayName: "Vault metrics",
			description:
				"File activity, note view time, vault size, note counts, open notes, and enabled plugins.",
		});
		sources.getSource(PERFORMANCE_SOURCE, {
			displayName: "Performance metrics",
			description:
				"Browser memory usage and measured Obsidian API timings.",
		});

		// TSDB side: SQLite (wa-sqlite over the chunked vault-adapter VFS),
		// WAL, scraper and query API. Every committed ingest is durable —
		// there are no whole-image snapshots anymore.
		const adapter = this.app.vault.adapter;
		const tsdbDir = `${this.manifest.dir}/${TSDB_DIRNAME}`;
		try {
			// One-time migration from the old sql.js whole-file snapshot.
			const migrated = await migrateLegacySnapshot(
				adapter,
				`${this.manifest.dir}/${LEGACY_DB_FILENAME}`,
				tsdbDir,
				"metrics"
			);
			if (migrated) {
				console.log("tsdb: migrated legacy metrics.db snapshot");
			}
		} catch (error) {
			console.warn("tsdb: legacy snapshot migration failed", error);
		}
		this.store = await MetricsStore.open({
			adapter,
			directory: tsdbDir,
			wasmBinary: waSqliteWasm,
		});

		// The WAL remains as a recovery net: entries are only written after
		// their transaction commits, replayed (idempotently) on startup, and
		// truncated periodically.
		this.wal = new SampleWal(
			this.app.vault.adapter,
			`${this.manifest.dir}/${WAL_FILENAME}`
		);
		const replayed = await this.wal.replayInto(this.store);
		if (replayed > 0) {
			console.log(
				`tsdb: replayed ${replayed} samples from write-ahead log`
			);
		}

		this.scraper = new Scraper({
			ingest: (samples: StoredSample[]) => this.ingestDurably(samples),
		});

		this.engine = new PromQLEngine(this.store);
		this.apiServer = new ApiServer({
			getExposition: () => this.getExposition(),
			engine: this.engine,
			store: this.store,
			getMetricsPath: () => this.settings.serverConfig.path,
			pluginVersion: this.manifest.version,
		});

		if (this.settings.serverConfig.enabled) {
			await this.startMetricsServer();
		}

		setupVaultMetrics(this, sources.getSource(VAULT_SOURCE).api);
		setupPerformanceMetrics(
			this,
			sources.getSource(PERFORMANCE_SOURCE).api
		);

		this.restartScraper();
		this.restartMaintenanceTimers();
		this.pruneOldSamples();

		// UI: ribbon, status bar, commands, settings.
		this.removeStaleStatusBarItems();
		this.addRibbonIcon("bar-chart-2", "TSDB", () => {
			new MetricsModal(this.app, this).open();
		}).addClass("tsdb-ribbon");

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("tsdb-status");
		this.updateStatusBar();

		this.addCommand({
			id: "toggle-metrics-server",
			name: "Toggle metrics server",
			callback: async () => {
				if (this.serverRunning) {
					await this.stopMetricsServer();
				} else {
					await this.startMetricsServer();
				}
			},
		});
		this.addCommand({
			id: "show-metrics",
			name: "Show current metrics",
			callback: () => new MetricsModal(this.app, this).open(),
		});
		this.addCommand({
			id: "clear-all-metrics",
			name: "Clear all custom metrics",
			callback: () => {
				this.clearAllMetrics();
				new Notice("All custom metrics cleared");
			},
		});
		this.addCommand({
			id: "flush-metrics-db",
			name: "Clear committed recovery log",
			callback: async () => {
				await this.flushStore();
				new Notice("Committed recovery log cleared");
			},
		});

		this.addSettingTab(new MetricsSettingTab(this.app, this));

		this.registerView(
			METRICS_DASHBOARD_VIEW_TYPE,
			(leaf) => new MetricsDashboardView(leaf, this)
		);

		// ```promql code blocks render as live panels in notes and plugin views.
		this.registerMarkdownCodeBlockProcessor("promql", (source, el, ctx) => {
			ctx.addChild(new PromQLPanel(el, this, source));
		});

		// CDP-discoverable surface (window.__tsdb): lets external
		// tooling attached over the DevTools protocol find the bound port.
		this.register(installMetricsGlobal(this));

		this.addCommand({
			id: "open-dashboard",
			name: "Open metrics dashboard",
			callback: () => void openMetricsDashboard(this),
		});

		// Emit ready event so other plugins can initialize their metrics.
		this.app.workspace.trigger("tsdb:ready", this.api);
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.trigger("tsdb:ready", this.api);
		});
	}

	async onunload() {
		this.closePluginViews();
		this.scraper?.dispose();
		this.clearMaintenanceTimers();
		this.removeStatusBarItem();
		await this.stopMetricsServer(true);
		this.apiServer?.dispose();
		await this.flushStore();
		await this.store?.close().catch((error) => {
			console.error("tsdb: error closing store", error);
		});
		this.sources?.dispose();
		this.sources = null;
		this.scraper = null;
		this.apiServer = null;
		this.wal = null;
		this.store = null;
		this.engine = null;
		this.api = {
			getStore: () => {
				throw new Error("tsdb: plugin is not loaded");
			},
		};
	}

	// -- server ------------------------------------------------------------

	get serverRunning(): boolean {
		return this.apiServer?.listening ?? false;
	}

	/** The actually-bound port (range binding means it can differ from settings). */
	get boundPort(): number | null {
		return this.apiServer?.boundPort ?? null;
	}

	async startMetricsServer(): Promise<void> {
		if (!this.apiServer || this.apiServer.listening) return;
		const start = this.settings.serverConfig.port;
		const end = Math.max(start, this.settings.serverConfig.portRangeEnd || start);
		try {
			const port = await this.apiServer.listenRange(start, end);
			new Notice(`Metrics server started on port ${port}`);
		} catch (error: any) {
			console.warn("Metrics server failed to start:", error);
			const range = end > start ? `ports ${start}-${end}` : `port ${start}`;
			let message = `Metrics server disabled - ${range} not available`;
			if (error?.code === "EADDRINUSE") {
				message += ". Other services are using these ports.";
			} else if (error?.code === "EACCES") {
				message += ". Permission denied (try ports > 1024).";
			}
			new Notice(message + " Change port in plugin settings.", 8000);
			this.settings.serverConfig.enabled = false;
			await this.saveSettings();
		}
		this.updateStatusBar();
	}

	async stopMetricsServer(silent = false): Promise<void> {
		if (!this.apiServer?.listening) return;
		await this.apiServer.close();
		if (!silent) new Notice("Metrics server stopped");
		this.updateStatusBar();
	}

	// -- scraper & maintenance ----------------------------------------------

	restartScraper(): void {
		if (!this.scraper || !this.sources) return;
		const selfSources = this.sources
			.list()
			.filter((source) => this.storeConfig(source.name).enabled)
			.map((source) => ({
				jobName: source.name,
				intervalSeconds: this.storeConfig(source.name).intervalSeconds,
				read: () => source.manager.getAllMetrics(),
			}));
		this.scraper.start(
			this.settings.scrape.jobs.map((job) => ({ ...job })),
			selfSources,
			this.app.vault.getName()
		);
	}

	/** Effective per-store recording config (settings overrides win). */
	storeConfig(name: string): { enabled: boolean; intervalSeconds: number } {
		const override = this.settings.scrape.stores[name] ?? {};
		const source = this.sources?.list().find((s) => s.name === name);
		return {
			enabled: override.enabled ?? true,
			intervalSeconds:
				override.intervalSeconds ?? source?.defaultIntervalSeconds ?? 30,
		};
	}

	listMetricSources(): Array<{
		name: string;
		displayName?: string;
		description?: string;
		enabled: boolean;
		intervalSeconds: number;
	}> {
		if (!this.sources) return [];
		return this.sources
			.list()
			.map((source) => ({
				name: source.name,
				displayName: source.displayName,
				description: source.description,
				...this.storeConfig(source.name),
			}))
			.sort((a, b) => {
				const order = new Map([
					[VAULT_SOURCE, 0],
					[PERFORMANCE_SOURCE, 1],
				]);
				return (
					(order.get(a.name) ?? 100) - (order.get(b.name) ?? 100) ||
					(a.displayName ?? a.name).localeCompare(b.displayName ?? b.name)
				);
			});
	}

	/** Merged exposition of all metric stores (the /metrics page). */
	getExposition(): Promise<string> {
		return this.sources?.exposition() ?? Promise.resolve("");
	}

	/** Clear the in-process registries of every metric store. */
	clearAllMetrics(): void {
		for (const source of this.sources?.list() ?? []) {
			source.manager.clearAllMetrics();
		}
	}

	getScrapeStatuses(): ScraperStatus[] {
		return this.scraper?.getStatuses() ?? [];
	}

	restartMaintenanceTimers(): void {
		this.clearMaintenanceTimers();
		this.flushTimer = window.setInterval(
			() => void this.flushStore(),
			Math.max(10, this.settings.storage.flushIntervalSeconds) * 1000
		);
		this.retentionTimer = window.setInterval(
			() => this.pruneOldSamples(),
			RETENTION_SWEEP_MS
		);
	}

	private clearMaintenanceTimers(): void {
		if (this.flushTimer !== null) window.clearInterval(this.flushTimer);
		if (this.retentionTimer !== null) window.clearInterval(this.retentionTimer);
		this.flushTimer = null;
		this.retentionTimer = null;
	}

	private pruneOldSamples(): void {
		if (!this.store) return;
		const cutoff =
			Date.now() - this.settings.storage.retentionDays * 24 * 3600 * 1000;
		this.store.deleteBefore(cutoff).catch((error) => {
			console.error("tsdb: retention pruning failed", error);
		});
	}

	// -- persistence ---------------------------------------------------------

	/**
	 * Commit the batch (durable via SQLite's journal through the VFS), then
	 * log it to the WAL as a recovery net. Order matters: the WAL only ever
	 * contains samples that are already committed, so truncation is safe.
	 */
	private async ingestDurably(samples: StoredSample[]): Promise<void> {
		if (!this.store) return;
		await this.store.ingest(samples);
		this.wal?.append(samples);
	}

	/**
	 * Checkpoint the WAL: every entry predates a committed transaction, so
	 * it can be truncated whenever no appends are in flight.
	 */
	async flushStore(): Promise<void> {
		if (!this.wal) return;
		try {
			const epoch = this.wal.epoch;
			await this.wal.barrier();
			if (this.wal.epoch === epoch) {
				await this.wal.truncate();
			}
		} catch (error) {
			console.error("tsdb: WAL checkpoint failed", error);
		}
	}

	async getTsdbStats(): Promise<StoreStats | null> {
		try {
			return (await this.store?.stats()) ?? null;
		} catch {
			return null;
		}
	}

	// -- misc ----------------------------------------------------------------

	private removeStaleStatusBarItems(): void {
		document
			.querySelectorAll(".status-bar-item.tsdb-status")
			.forEach((el) => el.remove());
		this.statusBarEl = null;
	}

	private removeStatusBarItem(): void {
		this.statusBarEl?.remove();
		this.statusBarEl = null;
	}

	private closePluginViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(
			METRICS_DASHBOARD_VIEW_TYPE
		)) {
			leaf.detach();
		}
	}

	private updateStatusBar(): void {
		if (!this.statusBarEl) return;
		const port = this.boundPort;
		this.statusBarEl.textContent = `Metrics: ${
			port !== null ? `Running:${port}` : "Stopped"
		}`;
	}

	async loadSettings() {
		this.settings = mergeSettings(await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
