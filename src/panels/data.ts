import { Labels, NAME_LABEL } from "../labels";
import { ApiResultData } from "../promql/engine";

export interface AlignedSeries {
	metric: Labels;
	/** Legend template from the query config, if any. */
	template?: string;
	values: Array<number | null>;
}

export interface AlignedData {
	/** Step timestamps in unix seconds (uPlot's native x for time scales). */
	xs: number[];
	series: AlignedSeries[];
}

/** Default Grafana-style legend: name{k="v", ...}. */
export function formatLegend(metric: Labels, template?: string): string {
	if (template) {
		return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_m, key: string) => {
			return metric[key] ?? "";
		});
	}
	const name = metric[NAME_LABEL] ?? "";
	const pairs = Object.keys(metric)
		.filter((key) => key !== NAME_LABEL)
		.sort()
		.map((key) => `${key}="${metric[key]}"`);
	if (pairs.length === 0) return name || "value";
	return `${name}{${pairs.join(", ")}}`;
}

/**
 * Align a range-query matrix onto the fixed step grid so uPlot gets one
 * y-array per series with nulls for missing steps.
 */
export function alignMatrix(
	result: ApiResultData,
	startSec: number,
	endSec: number,
	stepSec: number,
	legendTemplate?: string
): AlignedData {
	const stepCount = Math.floor((endSec - startSec) / stepSec) + 1;
	const xs: number[] = [];
	for (let i = 0; i < stepCount; i++) xs.push(startSec + i * stepSec);

	if (result.resultType !== "matrix") {
		return { xs, series: [] };
	}

	const series: AlignedSeries[] = result.result.map((entry) => {
		const values = new Array<number | null>(stepCount).fill(null);
		for (const [t, v] of entry.values) {
			const slot = Math.round((t - startSec) / stepSec);
			if (slot >= 0 && slot < stepCount) {
				values[slot] = Number(v);
			}
		}
		return { metric: entry.metric, template: legendTemplate, values };
	});

	return { xs, series };
}

/**
 * Legends for a whole panel: templates win; otherwise labels whose value is
 * identical across every series are elided (they identify the panel, not the
 * series), and a metric name shared by all series is dropped too.
 */
export function buildPanelLegends(
	series: Array<{ metric: Labels; template?: string }>
): string[] {
	const untemplated = series.filter((s) => !s.template);
	const commonKeys = new Set<string>();
	if (untemplated.length > 0) {
		const first = untemplated[0].metric;
		for (const key of Object.keys(first)) {
			if (key === NAME_LABEL) continue;
			if (untemplated.every((s) => s.metric[key] === first[key])) {
				commonKeys.add(key);
			}
		}
	}
	const names = new Set(untemplated.map((s) => s.metric[NAME_LABEL] ?? ""));
	const dropName = untemplated.length > 1 && names.size === 1;

	return series.map((s) => {
		if (s.template) return formatLegend(s.metric, s.template);
		const name = dropName ? "" : s.metric[NAME_LABEL] ?? "";
		const pairs = Object.keys(s.metric)
			.filter((key) => key !== NAME_LABEL && !commonKeys.has(key))
			.sort()
			.map((key) => `${key}="${s.metric[key]}"`);
		if (pairs.length === 0) return name || "value";
		return name ? `${name}{${pairs.join(", ")}}` : pairs.join(", ");
	});
}

const BYTE_UNITS = new Set(["b", "byte", "bytes"]);
const SECOND_UNITS = new Set(["s", "sec", "secs", "second", "seconds"]);

/** Unit-aware tick/stat formatting (bytes → KiB/MiB/GiB, seconds → ms). */
export function formatUnitValue(value: number, unit?: string): string {
	if (!Number.isFinite(value)) return formatStatValue(value);
	const u = unit?.toLowerCase();
	if (u && BYTE_UNITS.has(u)) {
		const abs = Math.abs(value);
		if (abs >= 1024 ** 3) return (value / 1024 ** 3).toFixed(2) + " GiB";
		if (abs >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + " MiB";
		if (abs >= 1024) return (value / 1024).toFixed(1) + " KiB";
		return value.toFixed(0) + " B";
	}
	if (u && SECOND_UNITS.has(u)) {
		const abs = Math.abs(value);
		if (abs > 0 && abs < 1) return (value * 1000).toFixed(abs < 0.01 ? 2 : 0) + " ms";
		return formatStatValue(value) + " s";
	}
	return formatStatValue(value) + (unit ? ` ${unit}` : "");
}

/** Human-friendly value formatting for stat panels and table cells. */
export function formatStatValue(value: number): string {
	if (!Number.isFinite(value)) {
		return value > 0 ? "∞" : value < 0 ? "-∞" : "NaN";
	}
	const abs = Math.abs(value);
	if (abs >= 1e9) return (value / 1e9).toFixed(2) + "B";
	if (abs >= 1e6) return (value / 1e6).toFixed(2) + "M";
	if (abs >= 1e4) return (value / 1e3).toFixed(2) + "k";
	if (Number.isInteger(value)) return String(value);
	if (abs >= 1) return value.toFixed(2);
	return value.toPrecision(3);
}
