import { MarkdownRenderChild, parseYaml } from "obsidian";
import uPlot from "uplot";
import type { ApiResultData, PromQLQueryEngine } from "../promql/engine";
import { PanelConfig, parsePanelConfig } from "./config";
import {
	alignMatrix,
	axisSizeForLabels,
	buildPanelLegends,
	formatLegend,
	formatUnitValue,
} from "./data";
import { TimeContext } from "../time/context";
import { parseTimeOverrides } from "../time/frontmatter";
import { expandTimeMacros } from "../time/query-vars";
import type { ApiHealthStatus } from "../health";
import {
	PanelStatusMessage,
	panelNoDataStatus,
	panelQueryErrorStatus,
	panelUnavailableStatus,
} from "./status";

// Validated categorical palettes (CVD-safe slot ordering; the dark column is
// the same hues re-stepped for dark surfaces, not a separate palette).
const LIGHT_PALETTE = [
	"#2a78d6", "#1baf7a", "#eda100", "#008300",
	"#4a3aa7", "#e34948", "#e87ba4", "#eb6834",
];
const DARK_PALETTE = [
	"#3987e5", "#199e70", "#c98500", "#008300",
	"#9085e9", "#e66767", "#d55181", "#d95926",
];

function activePalette(): string[] {
	return activeDocument.body.classList.contains("theme-dark")
		? DARK_PALETTE
		: LIGHT_PALETTE;
}

export interface PanelHost {
	engine: PromQLQueryEngine | null;
	timeContext: TimeContext;
	isUnloading?: boolean;
	getHealthStatus?: () => ApiHealthStatus;
	getFrontmatter?: (sourcePath: string) => unknown;
	loadFrontmatter?: (sourcePath: string) => Promise<unknown>;
	onFrontmatterChanged?: (
		sourcePath: string,
		listener: () => void
	) => () => void;
}

/**
 * Renders one ```promql code block as a live panel. Blocks can be hosted by
 * a real MarkdownView or by this plugin's custom ItemView; either way, every
 * panel queries the local TSDB directly (no HTTP hop) and optionally
 * auto-refreshes while visible.
 */
export class PromQLPanel extends MarkdownRenderChild {
	private host: PanelHost;
	private source: string;
	private sourcePath: string;
	private initialFrontmatter: unknown;
	private config: PanelConfig | null = null;
	private plot: uPlot | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private bodyEl: HTMLElement | null = null;
	private loadedFrontmatter: unknown = undefined;
	private loadFrontmatterPromise: Promise<unknown> | null = null;
	private unloaded = false;

	constructor(
		containerEl: HTMLElement,
		host: PanelHost,
		source: string,
		sourcePath: string,
		frontmatter: unknown
	) {
		super(containerEl);
		this.host = host;
		this.source = source;
		this.sourcePath = sourcePath;
		this.initialFrontmatter = frontmatter;
	}

	onload(): void {
		this.unloaded = false;
		this.containerEl.addClass("omx-panel");
		try {
			this.config = parsePanelConfig(this.source, parseYaml);
		} catch (error) {
			this.renderRootStatus({
				tone: "error",
				title: "Panel config error",
				detail: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		if (this.config.title) {
			this.containerEl.createDiv({
				cls: "omx-panel-title",
				text: this.config.title,
			});
		}
		this.bodyEl = this.containerEl.createDiv({ cls: "omx-panel-body" });

		void this.refresh();
		this.register(this.host.timeContext.subscribe(() => void this.refresh()));
		const unsubscribeFrontmatter = this.host.onFrontmatterChanged?.(
			this.sourcePath,
			() => void this.refresh()
		);
		if (unsubscribeFrontmatter) this.register(unsubscribeFrontmatter);
		if (this.config.refreshSeconds !== null) {
			this.registerInterval(
				window.setInterval(
					() => void this.refresh(),
					this.config.refreshSeconds * 1000
				)
			);
		}
	}

	onunload(): void {
		this.unloaded = true;
		this.plot?.destroy();
		this.plot = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
	}

	private healthStatus(): ApiHealthStatus | null {
		try {
			return this.host.getHealthStatus?.() ?? null;
		} catch {
			return null;
		}
	}

	private renderRootStatus(status: PanelStatusMessage): void {
		if (this.unloaded) return;
		this.containerEl.empty();
		this.createStatus(this.containerEl, status);
	}

	private renderUnavailable(status: PanelStatusMessage): void {
		if (this.unloaded || !this.bodyEl) return;
		this.plot?.destroy();
		this.plot = null;
		this.bodyEl.empty();
		this.createStatus(this.bodyEl, status);
	}

	private renderNoData(body: HTMLElement): void {
		this.plot?.destroy();
		this.plot = null;
		body.empty();
		this.createStatus(body, panelNoDataStatus(this.healthStatus()));
	}

	private createStatus(parent: HTMLElement, status: PanelStatusMessage): void {
		const el = parent.createDiv({
			cls: `omx-panel-state is-${status.tone}`,
		});
		el.createDiv({ cls: "omx-panel-state-title", text: status.title });
		if (status.detail) {
			el.createDiv({ cls: "omx-panel-state-detail", text: status.detail });
		}
	}

	private async refresh(): Promise<void> {
		const config = this.config;
		const body = this.bodyEl;
		if (!config || !body || this.unloaded) return;

		const engine = this.host.engine;
		if (!engine) {
			if (this.host.isUnloading) return;
			this.renderUnavailable(panelUnavailableStatus(this.healthStatus()));
			return;
		}

		try {
			if (config.type === "timeseries") {
				await this.renderTimeseries(engine, config, body);
			} else {
				await this.renderInstant(engine, config, body);
			}
		} catch (error) {
			if (this.unloaded || this.host.isUnloading) return;
			body.empty();
			this.createStatus(body, panelQueryErrorStatus(error));
		}
	}

	// -- timeseries ----------------------------------------------------------

	private async renderTimeseries(
		engine: PromQLQueryEngine,
		config: PanelConfig,
		body: HTMLElement
	): Promise<void> {
		const resolved = this.host.timeContext.resolve(
			config,
			await this.currentTimeOverrides()
		);

		const aligned: {
			metric: Record<string, string>;
			template?: string;
			values: Array<number | null>;
		}[] = [];
		let xs: number[] | null = null;
		for (const query of config.queries) {
			const expr = expandTimeMacros(query.expr, resolved);
			const result = await engine.rangeQuery(
				expr,
				resolved.startMs,
				resolved.endMs,
				resolved.stepMs
			);
			if (this.unloaded) return;
			const data = alignMatrix(
				result,
				resolved.startMs / 1000,
				resolved.endMs / 1000,
				resolved.stepMs / 1000,
				query.legend
			);
			xs = data.xs;
			aligned.push(...data.series);
		}
		if (!xs) return;
		const legends = buildPanelLegends(aligned);

		if (aligned.length === 0) {
			this.renderNoData(body);
			return;
		}

		const plotData = [xs, ...aligned.map((s) => s.values)] as uPlot.AlignedData;
		const width = Math.max(200, body.clientWidth || this.containerEl.clientWidth || 600);

		// Rebuild if the series set changed; otherwise just push new data.
		if (this.plot && this.plot.series.length - 1 === aligned.length) {
			this.plot.setData(plotData);
			return;
		}
		this.plot?.destroy();
		body.empty();

		const styles = getComputedStyle(activeDocument.body);
		const textColor = styles.getPropertyValue("--text-muted").trim() || "#888";
		const gridColor =
			styles.getPropertyValue("--background-modifier-border").trim() ||
			"rgba(128,128,128,0.2)";

		const palette = activePalette();
		const options: uPlot.Options = {
			width,
			height: config.height,
			series: [
				{},
				...aligned.map((s, i) => ({
					label: legends[i],
					stroke: palette[i % palette.length],
					width: 2,
					// (no points override: uPlot auto-shows points where data
					// is too sparse for the line to be visible)
				})),
			],
			axes: [
				{ stroke: textColor, grid: { stroke: gridColor }, ticks: { stroke: gridColor } },
				{
					stroke: textColor,
					size: (_u, values) => axisSizeForLabels(values),
					grid: { stroke: gridColor },
					ticks: { stroke: gridColor },
					values: (_u: uPlot, ticks: number[]) =>
						ticks.map((v) => formatUnitValue(v, config.unit)),
				},
			],
			scales: {
				y: {
					range: (u: uPlot, min: number, max: number) => [
						config.min ?? Math.min(min, 0),
						config.max ?? max,
					],
				},
			},
			// A single series needs no legend box — the title names it.
			legend: { show: aligned.length > 1, live: true },
			cursor: { drag: { x: false, y: false } },
		};

		this.plot = new uPlot(options, plotData, body);

		// Track container width changes (sidebar toggles, window resize).
		this.resizeObserver?.disconnect();
		const observer = new ResizeObserver(() => {
			if (!this.plot) return;
			const newWidth = Math.max(200, body.clientWidth || width);
			if (Math.abs(newWidth - this.plot.width) > 4) {
				this.plot.setSize({ width: newWidth, height: config.height });
			}
		});
		observer.observe(body);
		this.resizeObserver = observer;
	}

	// -- stat / table ----------------------------------------------------------

	private async renderInstant(
		engine: PromQLQueryEngine,
		config: PanelConfig,
		body: HTMLElement
	): Promise<void> {
		const resolved = this.host.timeContext.resolve(
			config,
			await this.currentTimeOverrides()
		);
		const results: ApiResultData[] = await Promise.all(
			config.queries.map((q) =>
				engine.instantQuery(expandTimeMacros(q.expr, resolved), resolved.endMs)
			)
		);
		if (this.unloaded) return;
		body.empty();

		if (config.type === "stat") {
			const entries: Array<{
				metric: Record<string, string>;
				template?: string;
				value: number;
			}> = [];
			for (let i = 0; i < results.length; i++) {
				const result = results[i];
				if (result.resultType === "scalar") {
					entries.push({ metric: {}, value: Number(result.result[1]) });
				} else if (result.resultType === "vector") {
					for (const entry of result.result) {
						entries.push({
							metric: entry.metric,
							template: config.queries[i].legend,
							value: Number(entry.value[1]),
						});
					}
				}
			}
			if (entries.length === 0) {
				this.renderNoData(body);
				return;
			}
			// The title names a lone stat; labels only disambiguate multiples.
			const legends = buildPanelLegends(entries);
			const values = entries.map((entry, i) => ({
				label: entries.length === 1 && config.title ? "" : legends[i],
				value: entry.value,
			}));
			const grid = body.createDiv({ cls: "omx-stat-grid" });
			for (const entry of values) {
				const cell = grid.createDiv({ cls: "omx-stat" });
				cell.createDiv({
					cls: "omx-stat-value",
					text: formatUnitValue(entry.value, config.unit),
				});
				if (entry.label) {
					cell.createDiv({ cls: "omx-stat-label", text: entry.label });
				}
			}
			return;
		}

		// table
		const table = body.createEl("table", { cls: "omx-table" });
		const head = table.createEl("thead").createEl("tr");
		head.createEl("th", { text: "series" });
		head.createEl("th", { text: "value" });
		const tbody = table.createEl("tbody");
		let rows = 0;
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			if (result.resultType !== "vector") continue;
			for (const entry of result.result) {
				const row = tbody.createEl("tr");
				row.createEl("td", {
					text: formatLegend(entry.metric, config.queries[i].legend),
				});
				row.createEl("td", {
					text: formatUnitValue(Number(entry.value[1]), config.unit),
				});
				rows++;
			}
		}
		if (rows === 0) {
			this.renderNoData(body);
		}
	}

	private currentFrontmatter(): unknown {
		if (this.host.getFrontmatter) {
			return this.host.getFrontmatter(this.sourcePath);
		}
		return this.initialFrontmatter;
	}

	private async currentTimeOverrides() {
		let frontmatter = this.currentFrontmatter() ?? this.initialFrontmatter;
		let overrides = parseTimeOverrides(frontmatter);
		if (overrides || !this.host.loadFrontmatter) return overrides;

		if (this.loadedFrontmatter === undefined) {
			this.loadFrontmatterPromise ??= this.host.loadFrontmatter(this.sourcePath);
			this.loadedFrontmatter = await this.loadFrontmatterPromise;
		}
		if (this.unloaded) return null;
		frontmatter = this.currentFrontmatter() ?? this.loadedFrontmatter;
		overrides = parseTimeOverrides(frontmatter);
		return overrides;
	}
}
