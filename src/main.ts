import { MarkdownView, Notice, Plugin } from "obsidian";
// esbuild "binary" loader: the SQLite WASM binary is embedded in main.js.
import waSqliteWasm from "wa-sqlite/dist/wa-sqlite-async.wasm";
import { installMetricsGlobal } from "./api/debug-global";
import { ApiHealthStatus, ApiServer } from "./api/server";
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
import type { ErrnoError } from "./types/runtime";
import { PromQLPanel } from "./panels/panel";
import {
	migrateLegacySnapshot,
	readChunkedDatabaseImage,
} from "./storage/chunk-vfs";
import {
	DEFAULT_CHUNK_DB_NAME,
	DEFAULT_NODE_DB_NAME,
	MetricsStore,
	StoreLocation,
	StoreStats,
	StoredSample,
} from "./storage/store";
import {
	migrateLegacySnapshotToNodeFile,
	nodeFileExists,
	nodeStorageDirectoryForAdapter,
	writeNodeFileDatabase,
} from "./storage/node-file-vfs";
import { SampleWal } from "./storage/wal";
import { TimeContext } from "./time/context";
import { TimeSelectorController } from "./time/selector";
import {
	METRICS_DASHBOARD_VIEW_TYPE,
	MetricsDashboardView,
	openMetricsDashboard,
} from "./ui/demo-dashboard";
import { MetricsModal } from "./ui/metrics-modal";
import { MetricsSettingTab } from "./ui/settings-tab";

declare module "obsidian" {
	interface App {
		/** Per-installation id; present at runtime but absent from the API types. */
		appId?: string;
	}
}

declare global {
	interface Window {
		__tsdbTeardownPromise?: Promise<void>;
	}
}

const LEGACY_DB_FILENAME = "metrics.db";
const TSDB_DIRNAME = "metrics-tsdb";
const WAL_FILENAME = "metrics.wal";
const RETENTION_SWEEP_MS = 60 * 60 * 1000; // hourly
const PROMQL_BLOCK_RE = /```[ \t]*promql[^\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)```/gi;
const STALE_PROMQL_PANEL_TEXT = "promql panel: metrics store is not running";

interface IngestHealth {
	lastIngestMs: number | null;
	lastIngestSampleCount: number;
	lastIngestError: string | null;
	lastIngestErrorMs: number | null;
}

export default class ObsidianMetricsPlugin extends Plugin {
	settings: ObsidianMetricsSettings = DEFAULT_SETTINGS;

	private sources: MetricSourceRegistry | null = null;
	private store: MetricsStore | null = null;
	private wal: SampleWal | null = null;
	private scraper: Scraper | null = null;
	private settingsTab: MetricsSettingTab | null = null;
	/** Query engine over the local TSDB (used by the API and note panels). */
	public engine: PromQLEngine | null = null;
	private apiServer: ApiServer | null = null;
	private statusBarEl: HTMLElement | null = null;
	private flushTimer: number | null = null;
	private retentionTimer: number | null = null;
	private markdownRefreshScheduled = false;
	private inFlightIngests = new Set<Promise<void>>();
	private storeHealth: IngestHealth = {
		lastIngestMs: null,
		lastIngestSampleCount: 0,
		lastIngestError: null,
		lastIngestErrorMs: null,
	};
	public isUnloading = false;

	public timeContext: TimeContext = new TimeContext();

	/**
	 * Public API for other plugins: api.getStore(name, { intervalSeconds })
	 * returns a metric-creation API recorded under job=<name>.
	 * Access via app.plugins.plugins['tsdb'].api
	 */
	public api: IObsidianMetricsRootAPI;

	async onload() {
		this.isUnloading = false;
		await this.waitForPreviousTeardown();
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
			vault_id: this.app.appId ?? "",
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

		// TSDB side: SQLite (wa-sqlite over a desktop .sqlite file when
		// available, else the vault-adapter chunk VFS), WAL, scraper and query
		// API. Every committed ingest is durable.
		const adapter = this.app.vault.adapter;
		const pluginDir = this.pluginDirectory();
		const tsdbDir = `${pluginDir}/${TSDB_DIRNAME}`;
		let storeLocation: StoreLocation = {
			kind: "chunks",
			adapter,
			directory: tsdbDir,
		};
		let storeDbName = DEFAULT_CHUNK_DB_NAME;
		const nodeDirectory = this.getNodeStorageDirectory();
		if (nodeDirectory) {
			try {
				await this.prepareNodeFileDatabase(nodeDirectory, tsdbDir);
				storeLocation = {
					kind: "node-file",
					directory: nodeDirectory,
				};
				storeDbName = DEFAULT_NODE_DB_NAME;
			} catch (error) {
				console.warn(
					"tsdb: desktop sqlite backend unavailable, falling back to chunks",
					error
				);
			}
		}
		if (storeLocation.kind === "chunks") {
			try {
				// One-time migration from the old sql.js whole-file snapshot.
				const migrated = await migrateLegacySnapshot(
					adapter,
					`${pluginDir}/${LEGACY_DB_FILENAME}`,
					tsdbDir,
					DEFAULT_CHUNK_DB_NAME
				);
				if (migrated) {
					console.log("tsdb: migrated legacy metrics.db snapshot");
				}
			} catch (error) {
				console.warn("tsdb: legacy snapshot migration failed", error);
			}
		}
		this.store = await MetricsStore.open({
			location: storeLocation,
			dbName: storeDbName,
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
		}, () => this.settingsTab?.onScrapeStatusChanged());

		this.engine = new PromQLEngine(this.store);
		this.apiServer = new ApiServer({
			getExposition: () => this.getExposition(),
			engine: this.engine,
			store: this.store,
			getHealth: () => this.getHealthStatus(),
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
		this.settingsTab = new MetricsSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);
		this.register(() => {
			this.settingsTab = null;
		});
		new TimeSelectorController(this, this.timeContext);

		this.registerView(
			METRICS_DASHBOARD_VIEW_TYPE,
			(leaf) => new MetricsDashboardView(leaf, this)
		);

		// ```promql code blocks render as live panels in notes and plugin views.
		this.registerMarkdownCodeBlockProcessor("promql", (source, el, ctx) => {
			ctx.addChild(
				new PromQLPanel(el, this, source, ctx.sourcePath, ctx.frontmatter)
			);
		});
		this.refreshMarkdownPreviews();
		this.app.workspace.onLayoutReady(() => this.scheduleMarkdownPanelRefresh());
		this.scheduleMarkdownPanelRefresh();
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				void this.repairStalePromqlPanels();
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				void this.repairStalePromqlPanels();
			})
		);

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

	onunload() {
		this.isUnloading = true;
		// onunload must return void (Obsidian does not await it); run the
		// async teardown as a detached task.
		const teardown = this.teardown();
		window.__tsdbTeardownPromise = teardown;
		const clearTeardown = () => {
			if (window.__tsdbTeardownPromise === teardown) {
				delete window.__tsdbTeardownPromise;
			}
		};
		void teardown.then(clearTeardown, clearTeardown);
	}

	private async waitForPreviousTeardown(): Promise<void> {
		const previous = window.__tsdbTeardownPromise;
		if (!previous) return;
		try {
			await previous;
		} catch (error) {
			console.warn("tsdb: previous plugin teardown failed", error);
		} finally {
			if (window.__tsdbTeardownPromise === previous) {
				delete window.__tsdbTeardownPromise;
			}
		}
	}

	private refreshMarkdownPreviews(): void {
		if (this.isUnloading) return;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			try {
				view.previewMode.rerender(true);
			} catch (error) {
				console.warn("tsdb: could not refresh markdown preview", error);
			}
		}
		void this.repairStalePromqlPanels();
	}

	private scheduleMarkdownPanelRefresh(): void {
		if (this.markdownRefreshScheduled) return;
		this.markdownRefreshScheduled = true;
		for (const delayMs of [100, 500, 1500, 3000]) {
			const timeout = window.setTimeout(() => {
				this.refreshMarkdownPreviews();
			}, delayMs);
			this.register(() => window.clearTimeout(timeout));
		}
		const repairInterval = window.setInterval(() => {
			void this.repairStalePromqlPanels();
		}, 500);
		const stopRepair = window.setTimeout(() => {
			window.clearInterval(repairInterval);
			this.markdownRefreshScheduled = false;
		}, 12_000);
		this.register(() => {
			window.clearInterval(repairInterval);
			window.clearTimeout(stopRepair);
			this.markdownRefreshScheduled = false;
		});
	}

	private async repairStalePromqlPanels(): Promise<void> {
		if (this.isUnloading || !this.engine) return;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file) continue;

			const panels = Array.from(
				view.containerEl.querySelectorAll<HTMLElement>(
					".markdown-reading-view .el-pre > .block-language-promql.omx-panel"
				)
			);
			if (
				!panels.some((panel) =>
					panel.textContent?.includes(STALE_PROMQL_PANEL_TEXT)
				)
			) {
				continue;
			}

			let blocks: string[];
			try {
				const markdown = await this.app.vault.cachedRead(view.file);
				blocks = extractPromqlBlocks(markdown);
			} catch (error) {
				console.warn("tsdb: could not read markdown for panel repair", error);
				continue;
			}

			const frontmatter =
				this.app.metadataCache.getFileCache(view.file)?.frontmatter;
			for (let index = 0; index < panels.length; index++) {
				const panel = panels[index];
				if (!panel.textContent?.includes(STALE_PROMQL_PANEL_TEXT)) continue;
				const source = blocks[index];
				const parent = panel.parentElement;
				if (!source || !parent) continue;

				parent.empty();
				const container = parent.createDiv({ cls: "block-language-promql" });
				this.addChild(
					new PromQLPanel(container, this, source, view.file.path, frontmatter)
				);
			}
		}
	}

	private async teardown(): Promise<void> {
		this.closePluginViews();
		this.scraper?.dispose();
		this.clearMaintenanceTimers();
		this.removeStatusBarItem();
		await this.stopMetricsServer(true);
		this.apiServer?.dispose();
		await this.waitForInFlightIngests();
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
		} catch (error: unknown) {
			console.warn("Metrics server failed to start:", error);
			const range = end > start ? `ports ${start}-${end}` : `port ${start}`;
			let message = `TSDB API could not start - ${range} not available`;
			const code = (error as ErrnoError | undefined)?.code;
			if (code === "EADDRINUSE") {
				message += ". Other services are using these ports.";
			} else if (code === "EACCES") {
				message += ". Permission denied (try ports > 1024).";
			}
			new Notice(message + " Change port in plugin settings.", 8000);
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
				collect: () => source.manager.collectSamples(),
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

	// -- storage backend -----------------------------------------------------

	private getNodeStorageDirectory(): string | null {
		return nodeStorageDirectoryForAdapter(
			this.app.vault.adapter as { getBasePath?: () => string },
			this.pluginDirectory()
		);
	}

	private pluginDirectory(): string {
		return this.manifest.dir ?? this.manifest.id;
	}

	private async prepareNodeFileDatabase(
		nodeDirectory: string,
		chunkDirectory: string
	): Promise<void> {
		if (await nodeFileExists(nodeDirectory, DEFAULT_NODE_DB_NAME)) return;

		const legacyPath = `${this.pluginDirectory()}/${LEGACY_DB_FILENAME}`;
		const migratedLegacy = await migrateLegacySnapshotToNodeFile(
			this.app.vault.adapter,
			legacyPath,
			nodeDirectory,
			DEFAULT_NODE_DB_NAME
		);
		if (migratedLegacy) {
			console.log("tsdb: migrated legacy metrics.db snapshot to metrics.sqlite");
			return;
		}

		const existingChunkImage = await readChunkedDatabaseImage(
			this.app.vault.adapter,
			chunkDirectory,
			DEFAULT_CHUNK_DB_NAME
		);
		if (!existingChunkImage || existingChunkImage.byteLength === 0) return;

		const chunkStore = await MetricsStore.open({
			location: {
				kind: "chunks",
				adapter: this.app.vault.adapter,
				directory: chunkDirectory,
			},
			dbName: DEFAULT_CHUNK_DB_NAME,
			wasmBinary: waSqliteWasm,
		});
		await chunkStore.close();

		const chunkImage = await readChunkedDatabaseImage(
			this.app.vault.adapter,
			chunkDirectory,
			DEFAULT_CHUNK_DB_NAME
		);
		if (chunkImage && chunkImage.byteLength > 0) {
			await writeNodeFileDatabase(
				nodeDirectory,
				DEFAULT_NODE_DB_NAME,
				chunkImage
			);
			console.log("tsdb: seeded metrics.sqlite from chunked database");
		}
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
		const task = this.ingestDurablyTracked(samples);
		this.inFlightIngests.add(task);
		task.then(
			() => this.inFlightIngests.delete(task),
			() => this.inFlightIngests.delete(task)
		);
		return task;
	}

	private async ingestDurablyTracked(samples: StoredSample[]): Promise<void> {
		if (!this.store) return;
		try {
			await this.store.ingest(samples);
			this.storeHealth.lastIngestMs = Date.now();
			this.storeHealth.lastIngestSampleCount = samples.length;
			this.storeHealth.lastIngestError = null;
			this.storeHealth.lastIngestErrorMs = null;
			this.wal?.append(samples);
		} catch (error) {
			this.storeHealth.lastIngestError = String(error);
			this.storeHealth.lastIngestErrorMs = Date.now();
			throw error;
		}
	}

	private async waitForInFlightIngests(): Promise<void> {
		while (this.inFlightIngests.size > 0) {
			await Promise.allSettled(Array.from(this.inFlightIngests));
		}
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

	getHealthStatus(): ApiHealthStatus {
		const storeOpen = this.store?.isOpen ?? false;
		const queryEngineReady = this.engine !== null;
		const ok =
			!this.isUnloading &&
			storeOpen &&
			queryEngineReady &&
			this.storeHealth.lastIngestError === null;
		return {
			ok,
			storeOpen,
			queryEngineReady,
			lastIngestMs: this.storeHealth.lastIngestMs,
			lastIngestSampleCount: this.storeHealth.lastIngestSampleCount,
			lastIngestError: this.storeHealth.lastIngestError,
			lastIngestErrorMs: this.storeHealth.lastIngestErrorMs,
			inFlightIngests: this.inFlightIngests.size,
		};
	}

	// -- misc ----------------------------------------------------------------

	private removeStaleStatusBarItems(): void {
		activeDocument
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
		this.statusBarEl.style.display = port !== null ? "" : "none";
		this.statusBarEl.textContent = port !== null ? `TSDB API: ${port}` : "";
	}

	async loadSettings() {
		this.settings = mergeSettings(await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

function extractPromqlBlocks(markdown: string): string[] {
	const blocks: string[] = [];
	PROMQL_BLOCK_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = PROMQL_BLOCK_RE.exec(markdown)) !== null) {
		blocks.push(match[1]);
	}
	return blocks;
}
