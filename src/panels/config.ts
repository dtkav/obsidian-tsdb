import { PromQLError, parseDuration } from "../promql/ast";

export interface PanelQuery {
	expr: string;
	/** Legend template, e.g. "{{operation}} on {{instance}}". */
	legend?: string;
}

export type PanelType = "timeseries" | "stat" | "table";

export interface PanelConfig {
	queries: PanelQuery[];
	type: PanelType;
	title?: string;
	rangeMs: number;
	/** null = auto (range / ~target-points). */
	stepMs: number | null;
	/** null = render once, no auto refresh. */
	refreshSeconds: number | null;
	unit?: string;
	min?: number;
	max?: number;
	height: number;
}

const DEFAULT_RANGE_MS = 60 * 60 * 1000; // 1h
const DEFAULT_HEIGHT = 220;

function asDurationMs(value: unknown, what: string): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value * 1000; // bare numbers are seconds
	}
	if (typeof value === "string") {
		return parseDuration(value.trim());
	}
	throw new PromQLError(`invalid ${what}: ${JSON.stringify(value)}`);
}

function asOptionalNumber(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

/** Normalize a parsed YAML object (or bare query string) into a PanelConfig. */
export function normalizePanelConfig(raw: unknown): PanelConfig {
	if (typeof raw === "string") {
		raw = { query: raw };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new PromQLError(
			"panel config must be a PromQL query or a YAML mapping"
		);
	}
	const obj = raw as Record<string, unknown>;

	const queries: PanelQuery[] = [];
	const single = obj.query ?? obj.expr;
	if (typeof single === "string" && single.trim().length > 0) {
		queries.push({
			expr: single.trim(),
			legend: typeof obj.legend === "string" ? obj.legend : undefined,
		});
	}
	if (Array.isArray(obj.queries)) {
		for (const entry of obj.queries) {
			if (typeof entry === "string") {
				queries.push({ expr: entry.trim() });
			} else if (
				typeof entry === "object" &&
				entry !== null &&
				typeof (entry as Record<string, unknown>).expr === "string"
			) {
				const e = entry as Record<string, unknown>;
				queries.push({
					expr: (e.expr as string).trim(),
					legend: typeof e.legend === "string" ? e.legend : undefined,
				});
			}
		}
	}
	if (queries.length === 0) {
		throw new PromQLError(
			'panel needs a query — either a bare PromQL expression or a "query:" key'
		);
	}

	const type = (obj.type as string) ?? "timeseries";
	if (!["timeseries", "stat", "table"].includes(type)) {
		throw new PromQLError(
			`unknown panel type "${type}" (use timeseries, stat, or table)`
		);
	}

	let refreshSeconds: number | null = null;
	if (obj.refresh !== undefined && obj.refresh !== null && obj.refresh !== false) {
		refreshSeconds = Math.max(5, asDurationMs(obj.refresh, "refresh") / 1000);
	}

	return {
		queries,
		type: type as PanelType,
		title: typeof obj.title === "string" ? obj.title : undefined,
		rangeMs:
			obj.range !== undefined
				? asDurationMs(obj.range, "range")
				: DEFAULT_RANGE_MS,
		stepMs: obj.step !== undefined ? asDurationMs(obj.step, "step") : null,
		refreshSeconds,
		unit: typeof obj.unit === "string" ? obj.unit : undefined,
		min: asOptionalNumber(obj.min),
		max: asOptionalNumber(obj.max),
		height: asOptionalNumber(obj.height) ?? DEFAULT_HEIGHT,
	};
}

/**
 * Parse a ```promql code block. A block that is just a PromQL expression
 * works as-is; anything more structured is YAML. The YAML parser is
 * injected (Obsidian's parseYaml in the app, a stub in tests).
 */
export function parsePanelConfig(
	source: string,
	yaml: (text: string) => unknown
): PanelConfig {
	const trimmed = source.trim();
	if (trimmed.length === 0) {
		throw new PromQLError("empty promql block");
	}
	let parsed: unknown;
	try {
		parsed = yaml(trimmed);
	} catch {
		// Not valid YAML (e.g. a query with braces) — treat as a bare query.
		parsed = trimmed;
	}
	if (typeof parsed !== "object" || parsed === null) {
		parsed = trimmed; // YAML scalar — the block is a bare query
	}
	return normalizePanelConfig(parsed);
}

/** Auto step: aim for ~250 points, snapped to a sane floor. */
export function resolveStepMs(config: PanelConfig): number {
	if (config.stepMs !== null) return config.stepMs;
	const raw = config.rangeMs / 250;
	return Math.max(1000, Math.ceil(raw / 1000) * 1000);
}
