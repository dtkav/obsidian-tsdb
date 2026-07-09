import { MarkdownRenderChild, parseYaml } from "obsidian";
import uPlot from "uplot";
import { ApiResultData, PromQLEngine } from "../promql/engine";
import { PanelConfig, parsePanelConfig } from "./config";
import {
	alignMatrix,
	buildPanelLegends,
	formatLegend,
	formatUnitValue,
} from "./data";
import { TimeContext } from "../time/context";
import { parseTimeOverrides } from "../time/frontmatter";
import { expandTimeMacros } from "../time/query-vars";

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
	engine: PromQLEngine | null;
	timeContext: TimeContext;
	isUnloading?: boolean;
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
	private frontmatter: unknown;
	private config: PanelConfig | null = null;
	private plot: uPlot | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private bodyEl: HTMLElement | null = null;
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
		this.frontmatter = frontmatter;
	}

	onload(): void {
		this.unloaded = false;
		this.containerEl.addClass("omx-panel");
		try {
			this.config = parsePanelConfig(this.source, parseYaml);
		} catch (error) {
			this.renderError(error instanceof Error ? error.message : String(error));
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

	private renderError(message: string): void {
		if (this.unloaded) return;
		this.containerEl.empty();
		this.containerEl.createDiv({
			cls: "omx-panel-error",
			text: `promql panel: ${message}`,
		});
	}

	private async refresh(): Promise<void> {
		const config = this.config;
		const body = this.bodyEl;
		if (!config || !body || this.unloaded) return;

		const engine = this.host.engine;
		if (!engine) {
			this.renderError("metrics store is not running");
			return;
		}

		try {
			if (config.type === "timeseries") {
				await this.renderTimeseries(engine, config, body);
			} else {
				await this.renderInstant(engine, config, body);
			}
		} catch (error) {
			if (this.unloaded) return;
			body.empty();
			body.createDiv({
				cls: "omx-panel-error",
				text: `query error: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	// -- timeseries ----------------------------------------------------------

	private async renderTimeseries(
		engine: PromQLEngine,
		config: PanelConfig,
		body: HTMLElement
	): Promise<void> {
		const resolved = this.host.timeContext.resolve(
			config,
			parseTimeOverrides(this.frontmatter)
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
			this.plot?.destroy();
			this.plot = null;
			body.empty();
			body.createDiv({ cls: "omx-panel-empty", text: "no data" });
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
					size: 70,
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
		engine: PromQLEngine,
		config: PanelConfig,
		body: HTMLElement
	): Promise<void> {
		const resolved = this.host.timeContext.resolve(
			config,
			parseTimeOverrides(this.frontmatter)
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
				body.createDiv({ cls: "omx-panel-empty", text: "no data" });
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
			body.empty();
			body.createDiv({ cls: "omx-panel-empty", text: "no data" });
		}
	}
}
