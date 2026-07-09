import { parseDuration } from "../promql/ast";
import { PanelConfig } from "../panels/config";

export type TimeMode = "relative" | "absolute";

export interface TimeState {
	mode: TimeMode;
	/** Used in relative mode. */
	rangeMs: number;
	/** null in relative mode means live/now. */
	endMs: number | null;
	/** Used in absolute mode. */
	startMs: number | null;
	stepMs: number | null;
}

export interface TimeOverrides {
	startMs?: number;
	endMs?: number;
	stepMs?: number;
}

export interface ResolvedTimeRange {
	startMs: number;
	endMs: number;
	stepMs: number;
	rangeMs: number;
	live: boolean;
	hasNoteOverride: boolean;
}

export type TimeListener = () => void;

export const DEFAULT_GLOBAL_RANGE_MS = 60 * 60 * 1000;
export const DEFAULT_TIME_STATE: TimeState = {
	mode: "relative",
	rangeMs: DEFAULT_GLOBAL_RANGE_MS,
	endMs: null,
	startMs: null,
	stepMs: null,
};

const STEP_TARGET_POINTS = 250;
const MIN_STEP_MS = 1000;

export function autoStepMs(rangeMs: number): number {
	const raw = rangeMs / STEP_TARGET_POINTS;
	return Math.max(MIN_STEP_MS, Math.ceil(raw / 1000) * 1000);
}

export function durationLabel(ms: number): string {
	const units: Array<[string, number]> = [
		["d", 24 * 60 * 60 * 1000],
		["h", 60 * 60 * 1000],
		["m", 60 * 1000],
		["s", 1000],
		["ms", 1],
	];
	let remaining = Math.max(0, Math.round(ms));
	let out = "";
	for (const [suffix, unitMs] of units) {
		if (remaining >= unitMs || (suffix === "ms" && out.length === 0)) {
			const value = Math.floor(remaining / unitMs);
			if (value > 0 || suffix === "ms") {
				out += `${value}${suffix}`;
				remaining -= value * unitMs;
			}
		}
	}
	return out;
}

export function parseDurationValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value * 1000;
	}
	if (typeof value === "string" && value.trim()) {
		return parseDuration(value.trim());
	}
	return undefined;
}

export function parseTimeValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		// Unix seconds are common in Prometheus-like APIs; ms are common in JS.
		return Math.abs(value) < 10_000_000_000
			? Math.round(value * 1000)
			: Math.round(value);
	}
	if (typeof value === "string" && value.trim()) {
		const ms = Date.parse(value.trim());
		return Number.isNaN(ms) ? undefined : ms;
	}
	return undefined;
}

export function resolveTimeRange(
	state: TimeState,
	panel: PanelConfig,
	overrides: TimeOverrides | null | undefined,
	nowMs = Date.now()
): ResolvedTimeRange {
	let startMs: number;
	let endMs: number;
	let live = false;

	if (state.mode === "absolute" && state.startMs !== null && state.endMs !== null) {
		startMs = state.startMs;
		endMs = state.endMs;
	} else {
		endMs = state.endMs ?? nowMs;
		startMs = endMs - state.rangeMs;
		live = state.endMs === null;
	}

	const hasNoteOverride = !!(
		overrides &&
		(overrides.startMs !== undefined ||
			overrides.endMs !== undefined ||
			overrides.stepMs !== undefined)
	);

	if (overrides?.startMs !== undefined) startMs = overrides.startMs;
	if (overrides?.endMs !== undefined) {
		endMs = overrides.endMs;
		live = false;
	}
	if (endMs < startMs) {
		const tmp = startMs;
		startMs = endMs;
		endMs = tmp;
	}

	const rangeMs = Math.max(1, endMs - startMs);
	const stepMs =
		overrides?.stepMs ?? state.stepMs ?? panel.stepMs ?? autoStepMs(rangeMs);

	return {
		startMs,
		endMs,
		stepMs,
		rangeMs,
		live,
		hasNoteOverride,
	};
}

export class TimeContext {
	private state: TimeState = { ...DEFAULT_TIME_STATE };
	private listeners = new Set<TimeListener>();

	getState(): TimeState {
		return { ...this.state };
	}

	subscribe(listener: TimeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setRelative(rangeMs: number, stepMs: number | null = this.state.stepMs): void {
		this.setState({
			mode: "relative",
			rangeMs,
			endMs: null,
			startMs: null,
			stepMs,
		});
	}

	setAbsolute(startMs: number, endMs: number, stepMs: number | null = this.state.stepMs): void {
		this.setState({
			mode: "absolute",
			rangeMs: Math.max(1, endMs - startMs),
			startMs,
			endMs,
			stepMs,
		});
	}

	setStep(stepMs: number | null): void {
		this.setState({ ...this.state, stepMs });
	}

	shiftWindow(direction: -1 | 1, nowMs = Date.now()): void {
		const resolved = resolveTimeRange(this.state, fakePanelConfig(), null, nowMs);
		const rangeMs = Math.max(1, resolved.endMs - resolved.startMs);
		const nextStart = resolved.startMs + direction * rangeMs;
		const nextEnd = resolved.endMs + direction * rangeMs;
		if (direction > 0 && nextEnd >= nowMs) {
			this.setRelative(rangeMs, this.state.stepMs);
			return;
		}
		this.setAbsolute(nextStart, nextEnd, this.state.stepMs);
	}

	zoom(factor: number, nowMs = Date.now()): void {
		const resolved = resolveTimeRange(this.state, fakePanelConfig(), null, nowMs);
		const center = (resolved.startMs + resolved.endMs) / 2;
		const nextRange = Math.max(1000, resolved.rangeMs * factor);
		const start = center - nextRange / 2;
		const end = center + nextRange / 2;
		if (resolved.live && end >= nowMs) {
			this.setRelative(nextRange, this.state.stepMs);
			return;
		}
		this.setAbsolute(Math.round(start), Math.round(end), this.state.stepMs);
	}

	resolve(
		panel: PanelConfig,
		overrides: TimeOverrides | null | undefined,
		nowMs = Date.now()
	): ResolvedTimeRange {
		return resolveTimeRange(this.state, panel, overrides, nowMs);
	}

	private setState(next: TimeState): void {
		this.state = normalizeState(next);
		for (const listener of Array.from(this.listeners)) listener();
	}
}

function normalizeState(state: TimeState): TimeState {
	if (state.mode === "absolute" && state.startMs !== null && state.endMs !== null) {
		const startMs = Math.min(state.startMs, state.endMs);
		const endMs = Math.max(state.startMs, state.endMs);
		return {
			...state,
			startMs,
			endMs,
			rangeMs: Math.max(1, endMs - startMs),
		};
	}
	return {
		mode: "relative",
		rangeMs: Math.max(1000, state.rangeMs),
		endMs: state.endMs,
		startMs: null,
		stepMs: state.stepMs,
	};
}

function fakePanelConfig(): PanelConfig {
	return {
		queries: [{ expr: "up" }],
		type: "timeseries",
		rangeMs: DEFAULT_GLOBAL_RANGE_MS,
		stepMs: null,
		refreshSeconds: null,
		height: 220,
	};
}
