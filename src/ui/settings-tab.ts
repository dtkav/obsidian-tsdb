import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	SettingGroup,
} from "obsidian";
import uPlot from "uplot";
import type ObsidianMetricsPlugin from "../main";
import { alignMatrix, formatUnitValue } from "../panels/data";
import { ScrapeJobSettings } from "../settings";
import { openMetricsDashboard } from "./demo-dashboard";

export class MetricsSettingTab extends PluginSettingTab {
	plugin: ObsidianMetricsPlugin;
	private sparkline: uPlot | null = null;
	private sparklineRenderId = 0;

	constructor(app: App, plugin: ObsidianMetricsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const sparklineRenderId = ++this.sparklineRenderId;
		this.destroySparkline();

		this.displayStatusHeader(containerEl, sparklineRenderId);
		this.displayStoreGroups(containerEl);
		this.displayDatabaseGroup(containerEl);
		this.displayServerGroup(containerEl);
		this.displayScrapingGroup(containerEl);
		this.displayAdvancedGroup(containerEl);
	}

	hide(): void {
		this.sparklineRenderId++;
		this.destroySparkline();
	}

	private destroySparkline(): void {
		this.sparkline?.destroy();
		this.sparkline = null;
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

		const headline = main.createDiv({ cls: "omx-settings-status-headline" });
		this.healthDot(headline, port !== null);
		headline.createSpan({
			text:
				port !== null
					? `Serving on port ${port}`
					: this.plugin.settings.serverConfig.enabled
					? "Server enabled, not running"
					: "Server off",
		});
		if (port === null && this.plugin.settings.serverConfig.enabled) {
			const retry = headline.createEl("button", { text: "Retry" });
			retry.onclick = async () => {
				await this.plugin.startMetricsServer();
				this.display();
			};
		}

		if (port !== null) {
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
				`${stats.sampleCount.toLocaleString()} samples`,
			];
			if (stats.samplesLastHour > 0 && stats.sampleCount > 0) {
				const bytesPerDay =
					(stats.sizeBytes / stats.sampleCount) * stats.samplesLastHour * 24;
				parts.push(`growing ≈${formatUnitValue(bytesPerDay, "bytes")}/day`);
			}
			dbLine.setText(`SQLite database — ${parts.join(" · ")}`);
		});

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
				getComputedStyle(document.body)
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
			this.sparkline = sparkline;
		} catch {
			// No activity yet — the card simply shows no sparkline.
		}
	}

	// -- per-store groups --------------------------------------------------------

	private displayStoreGroups(containerEl: HTMLElement): void {
		for (const source of this.plugin.listMetricSources()) {
			const title = this.sourceTitle(source);
			const overrides = this.plugin.settings.scrape.stores;

			const group = new SettingGroup(containerEl)
				.addClass("omx-settings-group")
				.setHeading(
					this.headingWithDot(
						title,
						source.enabled ? this.statusFor(source.name) : null
					)
				);
			if (source.description) this.hint(group, source.description);

			group.addSetting((setting) =>
				setting
					.setName("Record")
					.setDesc(
						source.enabled
							? `Recording every ${source.intervalSeconds}s into this vault's database`
							: "Not recording"
					)
					.addToggle((toggle) =>
						toggle.setValue(source.enabled).onChange(async (value) => {
							overrides[source.name] = {
								...overrides[source.name],
								enabled: value,
							};
							await this.plugin.saveSettings();
							this.plugin.restartScraper();
							this.display();
						})
					)
			);

			if (source.enabled) {
				group.addSetting((setting) =>
					setting.setName("Interval (seconds)").addText((text) =>
						text
							.setPlaceholder(String(source.intervalSeconds))
							.setValue(String(source.intervalSeconds))
							.onChange(async (value) => {
								const seconds = parseFloat(value);
								if (!isNaN(seconds) && seconds >= 1) {
									overrides[source.name] = {
										...overrides[source.name],
										intervalSeconds: seconds,
									};
									await this.plugin.saveSettings();
									this.plugin.restartScraper();
								}
							})
					)
				);
			}
		}
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

		group.addSetting((setting) =>
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
				)
		);

		group.addSetting((setting) =>
			setting
				.setName("Recovery log checkpoint (seconds)")
				.setDesc(
					"Samples are saved the moment they are recorded; the recovery log is a safety net that gets trimmed on this interval"
				)
				.addText((text) =>
					text
						.setPlaceholder("300")
						.setValue(String(this.plugin.settings.storage.flushIntervalSeconds))
						.onChange(async (value) => {
							const seconds = parseFloat(value);
							if (!isNaN(seconds) && seconds >= 10) {
								this.plugin.settings.storage.flushIntervalSeconds = seconds;
								await this.plugin.saveSettings();
								this.plugin.restartMaintenanceTimers();
							}
						})
				)
		);
	}

	// -- http api -----------------------------------------------------------------

	private displayServerGroup(containerEl: HTMLElement): void {
		const group = new SettingGroup(containerEl)
			.addClass("omx-settings-group")
			.setHeading(this.headingWithDot("HTTP API", this.plugin.boundPort !== null));
		this.hint(
			group,
			"Optional: serve this vault's metrics to Grafana, curl, or Prometheus-compatible tools."
		);

		group.addSetting((setting) =>
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
				)
		);

		const config = this.plugin.settings.serverConfig;
		group.addSetting((setting) =>
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
				)
		);

		group.addSetting((setting) =>
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
				)
		);
	}

	// -- scraping ------------------------------------------------------------------

	private displayScrapingGroup(containerEl: HTMLElement): void {
		const group = new SettingGroup(containerEl)
			.addClass("omx-settings-group")
			.setHeading("Scraping");
		this.hint(
			group,
			"External Prometheus endpoints to collect, e.g. a node_exporter."
		);

		this.plugin.settings.scrape.jobs.forEach((job, index) => {
			group.addSetting((setting) => this.configureScrapeJob(setting, job, index));
		});

		group.addSetting((setting) =>
			setting.setName("Add scrape target").addButton((button) =>
				button.setButtonText("Add").onClick(async () => {
					this.plugin.settings.scrape.jobs.push({
						jobName: `job_${this.plugin.settings.scrape.jobs.length + 1}`,
						targets: [],
						intervalSeconds: 30,
						timeoutSeconds: 10,
						enabled: true,
					});
					await this.plugin.saveSettings();
					this.display();
				})
			)
		);
	}

	private configureScrapeJob(
		setting: Setting,
		job: ScrapeJobSettings,
		index: number
	): void {
		setting.setDesc("Name, target URLs (comma-separated), interval");
		this.healthDot(
			setting.nameEl,
			job.enabled ? this.statusFor(job.jobName) : null
		);
		setting.nameEl.createSpan({ text: job.jobName });

		setting.addText((text) =>
			text
				.setPlaceholder("job name")
				.setValue(job.jobName)
				.onChange(async (value) => {
					job.jobName = value || `job_${index + 1}`;
					await this.plugin.saveSettings();
					this.plugin.restartScraper();
				})
		);

		setting.addText((text) => {
			text
				.setPlaceholder("http://localhost:9100/metrics")
				.setValue(job.targets.join(", "))
				.onChange(async (value) => {
					job.targets = value
						.split(",")
						.map((t) => t.trim())
						.filter((t) => t.length > 0);
					await this.plugin.saveSettings();
					this.plugin.restartScraper();
				});
			text.inputEl.addClass("tsdb-target-input");
		});

		setting.addText((text) => {
			text
				.setPlaceholder("30")
				.setValue(String(job.intervalSeconds))
				.onChange(async (value) => {
					const seconds = parseFloat(value);
					if (!isNaN(seconds) && seconds >= 5) {
						job.intervalSeconds = seconds;
						await this.plugin.saveSettings();
						this.plugin.restartScraper();
					}
				});
			text.inputEl.addClass("tsdb-interval-input");
		});

		setting.addToggle((toggle) =>
			toggle.setValue(job.enabled).onChange(async (value) => {
				job.enabled = value;
				await this.plugin.saveSettings();
				this.plugin.restartScraper();
			})
		);

		setting.addExtraButton((button) =>
			button
				.setIcon("trash")
				.setTooltip("Remove target")
				.onClick(async () => {
					this.plugin.settings.scrape.jobs.splice(index, 1);
					await this.plugin.saveSettings();
					this.plugin.restartScraper();
					this.display();
				})
		);
	}

	// -- advanced ------------------------------------------------------------------

	private displayAdvancedGroup(containerEl: HTMLElement): void {
		const group = new SettingGroup(containerEl)
			.addClass("omx-settings-group")
			.setHeading("Advanced");

		group.addSetting((setting) =>
			setting
				.setName("Metric name prefix")
				.setDesc("Applied to every metric created in this vault")
				.addText((text) =>
					text
						.setPlaceholder("obsidian_")
						.setValue(this.plugin.settings.customMetricsPrefix)
						.onChange(async (value) => {
							this.plugin.settings.customMetricsPrefix = value;
							await this.plugin.saveSettings();
						})
				)
		);

		group.addSetting((setting) =>
			setting
				.setName("Clear committed recovery log now")
				.setDesc(
					"Removes recovery entries that are already covered by committed database writes"
				)
				.addButton((button) =>
					button.setButtonText("Clear").onClick(async () => {
						await this.plugin.flushStore();
						new Notice("Committed recovery log cleared");
					})
				)
		);
	}
}
