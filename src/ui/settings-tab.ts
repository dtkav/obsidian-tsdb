import {
	App,
	Modal,
	PluginSettingTab,
	Setting,
	SettingGroup,
	setIcon,
	ToggleComponent,
} from "obsidian";
import uPlot from "uplot";
import type ObsidianMetricsPlugin from "../main";
import { alignMatrix, formatUnitValue } from "../panels/data";
import { ScrapeJobSettings } from "../settings";
import { openMetricsDashboard } from "./demo-dashboard";

export class MetricsSettingTab extends PluginSettingTab {
	plugin: ObsidianMetricsPlugin;
	private sparklines: uPlot[] = [];
	private sparklineRenderId = 0;
	private visible = false;
	private scrapeRefreshScheduled = false;

	constructor(app: App, plugin: ObsidianMetricsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.visible = true;
		const { containerEl } = this;
		containerEl.empty();
		const sparklineRenderId = ++this.sparklineRenderId;
		this.destroySparkline();

		this.displayStatusHeader(containerEl, sparklineRenderId);
		this.displaySourcesGroup(containerEl);
		this.displayDatabaseGroup(containerEl);
		this.displayServerGroup(containerEl);
		this.displayAdvancedGroup(containerEl);
	}

	hide(): void {
		this.visible = false;
		this.sparklineRenderId++;
		this.destroySparkline();
	}

	onScrapeStatusChanged(): void {
		if (!this.visible || this.scrapeRefreshScheduled) return;
		if (this.hasFocusedField()) return;
		this.scrapeRefreshScheduled = true;
		window.setTimeout(() => {
			this.scrapeRefreshScheduled = false;
			if (!this.visible || !this.containerEl.isConnected) return;
			if (this.hasFocusedField()) return;
			this.display();
		}, 250);
	}

	private hasFocusedField(): boolean {
		const active = activeDocument.activeElement;
		return (
			active instanceof HTMLElement &&
			this.containerEl.contains(active) &&
			active.matches("input, textarea, select")
		);
	}

	private destroySparkline(): void {
		for (const sparkline of this.sparklines) sparkline.destroy();
		this.sparklines = [];
	}

	// -- shared bits -----------------------------------------------------------

	private healthDot(parent: HTMLElement | DocumentFragment, up: boolean | null): void {
		parent.createSpan({
			cls: `omx-dot ${up === null ? "omx-dot-idle" : up ? "omx-dot-up" : "omx-dot-down"}`,
		});
	}

	private statusFor(job: string): boolean | null {
		const status = this.plugin.getScrapeStatuses().find((s) => s.job === job);
		return status ? status.up : null;
	}

	private statusesFor(job: string) {
		return this.plugin.getScrapeStatuses().filter((status) => status.job === job);
	}

	private headingWithDot(text: string, up: boolean | null): DocumentFragment {
		return createFragment((frag) => {
			frag.createSpan({ text });
			this.healthDot(frag, up);
		});
	}

	private hint(group: SettingGroup, text: string): void {
		group.listEl.createDiv({ cls: "omx-section-hint", text });
	}

	private sourceTitle(source: { name: string; displayName?: string }): string {
		if (source.displayName) return source.displayName;
		const words = source.name
			.replace(/[-_]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return `${words.charAt(0).toUpperCase()}${words.slice(1)} metrics`;
	}

	// -- status header ----------------------------------------------------------

	private displayStatusHeader(
		containerEl: HTMLElement,
		sparklineRenderId: number
	): void {
		const card = containerEl.createDiv({ cls: "omx-settings-status" });

		const main = card.createDiv({ cls: "omx-settings-status-main" });
		const port = this.plugin.boundPort;
		const health = this.plugin.getHealthStatus();

		const headline = main.createDiv({ cls: "omx-settings-status-headline" });
		this.healthDot(headline, health.ok);
		headline.createSpan({ text: "Time-series database" });

		if (port !== null) {
			main.createDiv({
				cls: "omx-settings-status-api",
				text: `TSDB API: ${port}`,
			});
			const links = main.createDiv({ cls: "omx-settings-status-links" });
			const base = `http://localhost:${port}`;
			links.createEl("a", {
				text: "metrics",
				href: `${base}${this.plugin.settings.serverConfig.path}`,
			});
			links.createEl("a", { text: "query API", href: `${base}/api/v1/query` });
			links.createEl("a", { text: "Grafana URL", href: base });
		}

		const dbLine = main.createDiv({ cls: "omx-settings-status-db" });
		dbLine.setText("Database: …");
		void this.plugin.getTsdbStats().then((stats) => {
			if (
				sparklineRenderId !== this.sparklineRenderId ||
				!dbLine.isConnected
			) {
				return;
			}
			if (!stats) {
				dbLine.setText("Database not running");
				return;
			}
			const parts = [
				`${formatUnitValue(stats.sizeBytes, "bytes")}`,
				`${stats.seriesCount.toLocaleString()} series`,
				stats.sampleCount === null
					? "sample count pending"
					: `${stats.sampleCount.toLocaleString()} samples`,
			];
			if (
				stats.samplesLastHour !== null &&
				stats.sampleCount !== null &&
				stats.samplesLastHour > 0 &&
				stats.sampleCount > 0
			) {
				const bytesPerDay =
					(stats.sizeBytes / stats.sampleCount) * stats.samplesLastHour * 24;
				parts.push(`growing ≈${formatUnitValue(bytesPerDay, "bytes")}/day`);
			}
			dbLine.setText(`SQLite database — ${parts.join(" · ")}`);
		});

		this.displayHealthSummary(main, health);

		const actions = main.createDiv({ cls: "omx-settings-status-actions" });
		const openBtn = actions.createEl("button", { text: "Open dashboard" });
		openBtn.onclick = () => void openMetricsDashboard(this.plugin);

		// The card's live element: recording activity from our own engine.
		const sparkWrap = card.createDiv({ cls: "omx-settings-sparkline" });
		sparkWrap.createDiv({
			cls: "omx-settings-sparkline-label",
			text: "samples per scrape · last 30 min",
		});
		const sparkEl = sparkWrap.createDiv();
		void this.renderSparkline(sparkEl, sparklineRenderId);
	}

	private displayHealthSummary(
		parent: HTMLElement,
		health: ReturnType<ObsidianMetricsPlugin["getHealthStatus"]>
	): void {
		const rows = parent.createDiv({ cls: "omx-settings-health" });
		if (health.ok) {
			rows.createDiv({
				cls: "omx-settings-health-row is-ok",
				text: "Recording, storage, and queries are healthy.",
			});
			return;
		}

		const addIssue = (text: string) => {
			rows.createDiv({ cls: "omx-settings-health-row is-warning", text });
		};

		if (!health.store.open) {
			addIssue("Database is not open.");
		}
		if (!health.queryEngine.ready) {
			addIssue("Query engine is not ready.");
		}
		if (health.ingest.lastError) {
			addIssue(`Last ingest failed: ${health.ingest.lastError}`);
		}
		if (health.scraper.down > 0 || health.scraper.stale > 0) {
			const parts = [];
			if (health.scraper.down > 0) {
				const plural = health.scraper.down === 1 ? "" : "s";
				parts.push(`${health.scraper.down} endpoint${plural} down`);
			}
			if (health.scraper.stale > 0) {
				parts.push(`${health.scraper.stale} stale`);
			}
			const suffix = health.scraper.lastError
				? `: ${health.scraper.lastError}`
				: ".";
			addIssue(`Scrapes need attention — ${parts.join(", ")}${suffix}`);
		}
		if (health.wal.lastCheckpointError) {
			addIssue(`WAL checkpoint failed: ${health.wal.lastCheckpointError}`);
		}
		if (health.wal.lastReplayError) {
			addIssue(`WAL replay failed: ${health.wal.lastReplayError}`);
		}
		if (health.wal.startup === "running") {
			rows.createDiv({
				cls: "omx-settings-health-row is-pending",
				text: "WAL startup maintenance is running.",
			});
		}
		if (
			health.scraper.pending > 0 &&
			health.scraper.targets > health.scraper.pending
		) {
			const plural = health.scraper.pending === 1 ? "" : "s";
			rows.createDiv({
				cls: "omx-settings-health-row is-pending",
				text: `${health.scraper.pending} scrape target${plural} waiting for a first sample.`,
			});
		}
		if (rows.childElementCount === 0) {
			rows.createDiv({
				cls: "omx-settings-health-row is-pending",
				text: "Startup checks are still settling.",
			});
		}
	}

	private async renderSparkline(
		el: HTMLElement,
		renderId: number
	): Promise<void> {
		const engine = this.plugin.engine;
		if (!engine) return;
		const endMs = Date.now();
		const startMs = endMs - 30 * 60 * 1000;
		const stepMs = 30_000;
		try {
			const result = await engine.rangeQuery(
				"sum(scrape_samples_scraped)",
				startMs,
				endMs,
				stepMs
			);
			if (result.resultType !== "matrix" || result.result.length === 0) return;
			const data = alignMatrix(
				result,
				startMs / 1000,
				endMs / 1000,
				stepMs / 1000
			);
			if (renderId !== this.sparklineRenderId || !el.isConnected) return;
			const accent =
				getComputedStyle(activeDocument.body)
					.getPropertyValue("--interactive-accent")
					.trim() || "#7c6ae6";
			const sparkline = new uPlot(
				{
					width: Math.max(180, el.clientWidth || 220),
					height: 44,
					series: [{}, { stroke: accent, width: 1.5, spanGaps: true }],
					axes: [{ show: false }, { show: false }],
					legend: { show: false },
					cursor: { show: false },
				},
				[data.xs, data.series[0].values] as uPlot.AlignedData,
				el
			);
			if (renderId !== this.sparklineRenderId || !el.isConnected) {
				sparkline.destroy();
				return;
			}
			this.sparklines.push(sparkline);
		} catch {
			// No activity yet — the card simply shows no sparkline.
		}
	}

	// -- sources -----------------------------------------------------------------

	private displaySourcesGroup(containerEl: HTMLElement): void {
		const sources = this.plugin.listMetricSources();

		const groupEl = containerEl.createDiv({
			cls: "omx-settings-group omx-settings-sources-group",
		});
		const heading = groupEl.createDiv({
			cls: "setting-item setting-item-heading omx-settings-group-heading",
		});
		heading
			.createDiv({ cls: "setting-item-info" })
			.createDiv({ cls: "setting-item-name", text: "Sources" });
		const headingControls = heading.createDiv({ cls: "setting-item-control" });
		const addButton = headingControls.createEl("button", {
			cls: "omx-heading-button",
			text: "Add",
		});
		addButton.onclick = () => {
			new AddScrapeTargetModal(this.app, this.plugin, () => this.display()).open();
		};

		const listEl = groupEl.createDiv({ cls: "setting-items" });
		listEl.createDiv({
			cls: "omx-section-hint",
			text: "Metric sources recorded into this vault's time-series database.",
		});

		const overrides = this.plugin.settings.scrape.stores;
		const sourceList = listEl.createDiv({ cls: "omx-source-card-list" });
		for (const source of sources) {
			this.createMetricSourceCard(sourceList, source, overrides);
		}

		const scrapeList = listEl.createDiv({ cls: "omx-source-card-list" });
		this.plugin.settings.scrape.jobs.forEach((job, index) => {
			this.createScrapeJobCard(scrapeList, job, index);
		});
	}

	private createMetricSourceCard(
		parent: HTMLElement,
		source: ReturnType<ObsidianMetricsPlugin["listMetricSources"]>[number],
		overrides: ObsidianMetricsPlugin["settings"]["scrape"]["stores"]
	): void {
		const card = parent.createDiv({
			cls: `omx-source-card ${source.enabled ? "" : "is-disabled"}`,
		});
		const header = card.createDiv({ cls: "omx-source-card-header" });
		const title = header.createDiv({ cls: "omx-source-card-title" });
		this.healthDot(
			title,
			source.enabled ? this.statusFor(source.name) ?? true : null
		);
		title.createSpan({ text: this.sourceTitle(source) });
		const toggleWrap = header.createDiv({ cls: "omx-source-toggle" });
		new ToggleComponent(toggleWrap).setValue(source.enabled).onChange(async (value) => {
			overrides[source.name] = {
				...overrides[source.name],
				enabled: value,
			};
			await this.plugin.saveSettings();
			this.plugin.restartScraper();
			this.display();
		});

		if (source.description) {
			card.createDiv({ cls: "omx-source-card-desc", text: source.description });
		}

		const options = card.createDiv({ cls: "omx-source-options" });
		this.createOptionField(options, {
			label: "Interval",
			value: String(source.intervalSeconds),
			unit: "seconds",
			disabled: !source.enabled,
			className: "tsdb-interval-input",
			onChange: async (value) => {
				const seconds = parseFloat(value);
				if (!isNaN(seconds) && seconds >= 1) {
					overrides[source.name] = {
						...overrides[source.name],
						intervalSeconds: seconds,
					};
					await this.plugin.saveSettings();
					this.plugin.restartScraper();
				}
			},
		});
	}

	private createScrapeJobCard(
		parent: HTMLElement,
		job: ScrapeJobSettings,
		index: number
	): void {
		const statuses = this.statusesFor(job.jobName);
		const health =
			!job.enabled || job.targets.length === 0
				? null
				: statuses.length === 0
				? null
				: statuses.every((status) => status.up);
		const card = parent.createDiv({
			cls: `omx-source-card omx-scrape-card ${job.enabled ? "" : "is-disabled"}`,
		});
		const header = card.createDiv({ cls: "omx-source-card-header" });
		const title = header.createDiv({ cls: "omx-source-card-title" });
		this.healthDot(title, health);
		title.createSpan({ text: job.jobName || `job_${index + 1}` });
		const toggleWrap = header.createDiv({ cls: "omx-source-toggle" });
		new ToggleComponent(toggleWrap).setValue(job.enabled).onChange(async (value) => {
			job.enabled = value;
			await this.plugin.saveSettings();
			this.plugin.restartScraper();
			this.display();
		});
		const removeButton = header.createEl("button", {
			cls: "clickable-icon omx-source-remove",
			attr: { "aria-label": "Remove scrape target" },
		});
		setIcon(removeButton, "trash-2");
		removeButton.onclick = async () => {
			this.plugin.settings.scrape.jobs.splice(index, 1);
			await this.plugin.saveSettings();
			this.plugin.restartScraper();
			this.display();
		};

		card.createDiv({
			cls: "omx-source-card-desc",
			text:
				job.targets.length > 0
					? job.targets.join(", ")
					: "No target URL set.",
		});

		this.createScrapeStatus(card, job, statuses);

		const options = card.createDiv({ cls: "omx-source-options omx-scrape-options" });
		this.createOptionField(options, {
			label: "Interval",
			value: String(job.intervalSeconds),
			unit: "seconds",
			fieldClassName: "omx-scrape-field-interval",
			className: "tsdb-interval-input",
			onChange: async (value) => {
				const seconds = parseFloat(value);
				if (!isNaN(seconds) && seconds >= 5) {
					job.intervalSeconds = seconds;
					await this.plugin.saveSettings();
					this.plugin.restartScraper();
				}
			},
		});
		this.createOptionField(options, {
			label: "Timeout",
			value: String(job.timeoutSeconds),
			unit: "seconds",
			fieldClassName: "omx-scrape-field-timeout",
			className: "tsdb-interval-input",
			onChange: async (value) => {
				const seconds = parseFloat(value);
				if (!isNaN(seconds) && seconds >= 1) {
					job.timeoutSeconds = seconds;
					await this.plugin.saveSettings();
					this.plugin.restartScraper();
				}
			},
		});
	}

	private createScrapeStatus(
		card: HTMLElement,
		job: ScrapeJobSettings,
		statuses: ReturnType<ObsidianMetricsPlugin["getScrapeStatuses"]>
	): void {
		const latest = statuses
			.filter((status) => status.lastScrapeMs !== null)
			.sort((a, b) => (b.lastScrapeMs ?? 0) - (a.lastScrapeMs ?? 0))[0];
		const upCount = statuses.filter((status) => status.up === true).length;
		const pendingCount = statuses.filter(
			(status) => status.lastScrapeMs === null
		).length;
		const healthText =
			statuses.length === 1
				? statuses[0].up === true
					? "Endpoint up"
					: statuses[0].up === false
					? "Endpoint down"
					: "Endpoint down"
				: `${upCount}/${statuses.length} endpoints up`;
		const statusText = !job.enabled
			? "Paused"
			: statuses.length === 0 || pendingCount === statuses.length
			? "Waiting for first scrape"
			: latest?.lastScrapeMs
			? `${healthText} · Last scrape ${this.relativeTime(latest.lastScrapeMs)}`
			: healthText;
		card.createDiv({ cls: "omx-scrape-status", text: statusText });
		const error = statuses.find((status) => status.lastError)?.lastError;
		if (error) {
			card.createDiv({ cls: "omx-scrape-error", text: `Last error: ${error}` });
		}

		const plot = card.createDiv({ cls: "omx-scrape-plot is-empty" });
		plot.createDiv({ cls: "omx-scrape-plot-label", text: "samples scraped" });
		const plotEl = plot.createDiv({ cls: "omx-scrape-plot-canvas" });
		void this.renderScrapeSparkline(
			plotEl,
			job.jobName,
			this.sparklineRenderId
		);
	}

	private relativeTime(ms: number): string {
		const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (seconds < 60) return `${seconds}s ago`;
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.round(minutes / 60);
		return `${hours}h ago`;
	}

	private async renderScrapeSparkline(
		el: HTMLElement,
		jobName: string,
		renderId: number
	): Promise<void> {
		const engine = this.plugin.engine;
		if (!engine) return;
		const endMs = Date.now();
		const startMs = endMs - 30 * 60 * 1000;
		const stepMs = 30_000;
		try {
			const result = await engine.rangeQuery(
				`sum(scrape_samples_scraped{job="${this.escapePromLabel(jobName)}"})`,
				startMs,
				endMs,
				stepMs
			);
			if (result.resultType !== "matrix" || result.result.length === 0) {
				this.renderEmptyScrapeSparkline(el, renderId);
				return;
			}
			const data = alignMatrix(
				result,
				startMs / 1000,
				endMs / 1000,
				stepMs / 1000
			);
			if (renderId !== this.sparklineRenderId || !el.isConnected) return;
			el.closest(".omx-scrape-plot")?.removeClass("is-empty");
			const accent =
				getComputedStyle(activeDocument.body)
					.getPropertyValue("--interactive-accent")
					.trim() || "#7c6ae6";
			const sparkline = new uPlot(
				{
					width: Math.max(180, el.clientWidth || 260),
					height: 40,
					series: [{}, { stroke: accent, width: 1.5, spanGaps: true }],
					axes: [{ show: false }, { show: false }],
					legend: { show: false },
					cursor: { show: false },
				},
				[data.xs, data.series[0].values] as uPlot.AlignedData,
				el
			);
			if (renderId !== this.sparklineRenderId || !el.isConnected) {
				sparkline.destroy();
				return;
			}
			this.sparklines.push(sparkline);
		} catch {
			this.renderEmptyScrapeSparkline(el, renderId);
		}
	}

	private renderEmptyScrapeSparkline(el: HTMLElement, renderId: number): void {
		if (renderId !== this.sparklineRenderId || !el.isConnected) return;
		el.empty();
		el.closest(".omx-scrape-plot")?.addClass("is-empty");
	}

	private escapePromLabel(value: string): string {
		return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	}

	private createOptionField(
		parent: HTMLElement,
		options: {
			label: string;
			value: string;
			unit?: string;
			disabled?: boolean;
			fieldClassName?: string;
			className?: string;
			onChange: (value: string) => Promise<void>;
		}
	): HTMLInputElement {
		const field = parent.createDiv({
			cls: ["omx-source-field", options.fieldClassName].filter(Boolean).join(" "),
		});
		const id = `omx-source-field-${Math.random().toString(36).slice(2)}`;
		field.createEl("label", { text: options.label, attr: { for: id } });
		const control = field.createDiv({ cls: "omx-source-field-control" });
		const input = control.createEl("input", {
			type: "text",
			value: options.value,
			attr: { id },
		});
		if (options.className) input.addClass(options.className);
		input.disabled = options.disabled ?? false;
		input.addEventListener("change", () => {
			void options.onChange(input.value);
		});
		if (options.unit) {
			control.createSpan({ cls: "omx-source-field-unit", text: options.unit });
		}
		return input;
	}

	// -- database -----------------------------------------------------------------

	private displayDatabaseGroup(containerEl: HTMLElement): void {
		const group = new SettingGroup(containerEl)
			.addClass("omx-settings-group")
			.setHeading("Database");
		this.hint(
			group,
			"History is kept in a SQLite database inside this vault's plugin folder."
		);

		group.addSetting((setting) => {
			setting
				.setName("Keep history for (days)")
				.setDesc("Older samples are pruned automatically")
				.addText((text) =>
					text
						.setPlaceholder("30")
						.setValue(String(this.plugin.settings.storage.retentionDays))
						.onChange(async (value) => {
							const days = parseFloat(value);
							if (!isNaN(days) && days > 0) {
								this.plugin.settings.storage.retentionDays = days;
								await this.plugin.saveSettings();
							}
						})
				);
		});
	}

	// -- http api -----------------------------------------------------------------

	private displayServerGroup(containerEl: HTMLElement): void {
		const serverStatus =
			this.plugin.boundPort !== null
				? true
				: this.plugin.settings.serverConfig.enabled
				? false
				: null;
		const group = new SettingGroup(containerEl)
			.addClass("omx-settings-group")
			.setHeading(this.headingWithDot("HTTP API", serverStatus));
		this.hint(
			group,
			"Optional: serve this vault's metrics to Grafana, curl, or Prometheus-compatible tools."
		);

		group.addSetting((setting) => {
			setting
				.setName("Serve metrics over HTTP")
				.setDesc("Prometheus exposition and query API for Grafana and other tools")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.serverConfig.enabled)
						.onChange(async (value) => {
							this.plugin.settings.serverConfig.enabled = value;
							await this.plugin.saveSettings();
							if (value) {
								await this.plugin.startMetricsServer();
							} else {
								await this.plugin.stopMetricsServer();
							}
							this.display();
						})
				);
		});

		const config = this.plugin.settings.serverConfig;
		group.addSetting((setting) => {
			setting
				.setName("Port or port range")
				.setDesc(
					'"9090" or "9090-9099" — with a range, the first free port is used, so several vaults can serve at once'
				)
				.addText((text) =>
					text
						.setPlaceholder("9090-9099")
						.setValue(
							config.portRangeEnd > config.port
								? `${config.port}-${config.portRangeEnd}`
								: `${config.port}`
						)
						.onChange(async (value) => {
							const match = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(value);
							if (!match) return;
							const start = parseInt(match[1]);
							const end = match[2] ? parseInt(match[2]) : start;
							if (start < 1 || end > 65535 || end < start) return;
							config.port = start;
							config.portRangeEnd = end;
							await this.plugin.saveSettings();
							if (config.enabled) {
								await this.plugin.stopMetricsServer();
								await this.plugin.startMetricsServer();
							}
						})
				);
		});

		group.addSetting((setting) => {
			setting
				.setName("Metrics path")
				.setDesc("Where the exposition page is served")
				.addText((text) =>
					text
						.setPlaceholder("/metrics")
						.setValue(this.plugin.settings.serverConfig.path)
						.onChange(async (value) => {
							this.plugin.settings.serverConfig.path = value.startsWith("/")
								? value
								: "/" + value;
							await this.plugin.saveSettings();
						})
				);
		});
	}

	// -- advanced ------------------------------------------------------------------

	private displayAdvancedGroup(containerEl: HTMLElement): void {
		const group = new SettingGroup(containerEl)
			.addClass("omx-settings-group")
			.setHeading("Advanced");

		group.addSetting((setting) => {
			setting
				.setName("Metric name prefix")
				.setDesc("Applied to every metric created in this vault")
				.addText((text) => {
					text
						.setPlaceholder("obsidian_")
						.setValue(this.plugin.settings.customMetricsPrefix)
						.onChange(async (value) => {
							this.plugin.settings.customMetricsPrefix = value;
							await this.plugin.saveSettings();
						});
				});
		});
	}
}

class AddScrapeTargetModal extends Modal {
	private plugin: ObsidianMetricsPlugin;
	private onSaved: () => void;
	private sourceName = "";
	private targets = "";
	private intervalSeconds = "30";
	private timeoutSeconds = "10";
	private enabled = true;

	constructor(app: App, plugin: ObsidianMetricsPlugin, onSaved: () => void) {
		super(app);
		this.plugin = plugin;
		this.onSaved = onSaved;
	}

	onOpen(): void {
		this.titleEl.setText("Add Prometheus scrape target");
		this.contentEl.empty();
		this.contentEl.addClass("omx-source-modal");

		new Setting(this.contentEl)
			.setName("Name")
			.setDesc("Shown in the Sources list")
			.addText((text) =>
				text
					.setPlaceholder(
						`prometheus_${this.plugin.settings.scrape.jobs.length + 1}`
					)
					.onChange((value) => {
						this.sourceName = value.trim();
					})
			);

		new Setting(this.contentEl)
			.setName("Endpoint URL")
			.setDesc("Prometheus exposition endpoint")
			.addText((text) => {
				text
					.setPlaceholder("http://localhost:9100/metrics")
					.onChange((value) => {
						this.targets = value;
					});
				text.inputEl.addClass("tsdb-target-input");
			});

		new Setting(this.contentEl)
			.setName("Interval")
			.setDesc("Seconds between scrapes")
			.addText((text) => {
				text
					.setPlaceholder("30")
					.setValue(this.intervalSeconds)
					.onChange((value) => {
						this.intervalSeconds = value;
					});
				text.inputEl.addClass("tsdb-interval-input");
			});

		new Setting(this.contentEl)
			.setName("Timeout")
			.setDesc("Seconds before a scrape is abandoned")
			.addText((text) => {
				text
					.setPlaceholder("10")
					.setValue(this.timeoutSeconds)
					.onChange((value) => {
						this.timeoutSeconds = value;
					});
				text.inputEl.addClass("tsdb-interval-input");
			});

		new Setting(this.contentEl)
			.setName("Enabled")
			.addToggle((toggle) =>
				toggle.setValue(this.enabled).onChange((value) => {
					this.enabled = value;
				})
			);

		const actions = this.contentEl.createDiv({ cls: "omx-modal-actions" });
		const cancel = actions.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
		const add = actions.createEl("button", {
			cls: "mod-cta",
			text: "Add target",
		});
		add.onclick = () => void this.save();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async save(): Promise<void> {
		const index = this.plugin.settings.scrape.jobs.length + 1;
		const intervalSeconds = parseFloat(this.intervalSeconds);
		const timeoutSeconds = parseFloat(this.timeoutSeconds);
		this.plugin.settings.scrape.jobs.push({
			jobName: this.sourceName || `prometheus_${index}`,
			targets: this.targets
				.split(",")
				.map((target) => target.trim())
				.filter((target) => target.length > 0),
			intervalSeconds:
				!isNaN(intervalSeconds) && intervalSeconds >= 5
					? intervalSeconds
					: 30,
			timeoutSeconds:
				!isNaN(timeoutSeconds) && timeoutSeconds >= 1 ? timeoutSeconds : 10,
			enabled: this.enabled,
		});
		await this.plugin.saveSettings();
		this.plugin.restartScraper();
		this.close();
		this.onSaved();
	}
}
