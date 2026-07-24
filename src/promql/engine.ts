import {
	Labels,
	Matcher,
	NAME_LABEL,
	canonicalLabels,
	withoutName,
} from "../labels";
import { Point, SeriesData } from "../storage/store";
import {
	Aggregation,
	BinaryExpr,
	Call,
	Expr,
	PromQLError,
	Selector,
} from "./ast";
import { parseExpr } from "./parser";

export interface DataSource {
	select(
		matchers: Matcher[],
		startMs: number,
		endMs: number
	): Promise<SeriesData[]>;
}

/** Raw series data prefetched per selector AST node before evaluation. */
type SelectorData = Map<Selector, SeriesData[]>;

function collectSelectors(expr: Expr, out: Selector[]): void {
	switch (expr.kind) {
		case "selector":
			out.push(expr);
			return;
		case "call":
			for (const arg of expr.args) collectSelectors(arg, out);
			return;
		case "agg":
			collectSelectors(expr.expr, out);
			if (expr.param) collectSelectors(expr.param, out);
			return;
		case "binary":
			collectSelectors(expr.lhs, out);
			collectSelectors(expr.rhs, out);
			return;
		case "unary":
			collectSelectors(expr.expr, out);
			return;
		default:
			return;
	}
}

export interface EngineOptions {
	/** How far back an instant selector looks for the latest sample. */
	lookbackMs?: number;
	/** Maximum number of steps in a range query. */
	maxSteps?: number;
}

const DEFAULT_LOOKBACK_MS = 5 * 60 * 1000;
const DEFAULT_MAX_STEPS = 11000;

// ---------------------------------------------------------------------------
// Internal evaluation values. Vectors are stored as one Float64Array per
// series with one slot per evaluation step; NaN marks "no sample here"
// (raw NaN samples are dropped at ingest, so the marker is unambiguous).
// ---------------------------------------------------------------------------

interface VectorSeries {
	labels: Labels;
	values: Float64Array;
}

type Value =
	| { kind: "scalar"; values: Float64Array }
	| { kind: "vector"; series: VectorSeries[] }
	| { kind: "string"; value: string };

export function formatValue(v: number): string {
	if (v === Infinity) return "+Inf";
	if (v === -Infinity) return "-Inf";
	if (Number.isNaN(v)) return "NaN";
	return String(v);
}

// ---------------------------------------------------------------------------
// Range-window functions (rate & friends)
// ---------------------------------------------------------------------------

type RangeFunc = (
	points: Point[],
	lo: number,
	hi: number, // window is points[lo..hi)
	windowStartMs: number,
	windowEndMs: number,
	stepIndex: number
) => number;

/** Faithful port of Prometheus' extrapolatedRate (rate/increase/delta). */
function extrapolatedRate(
	points: Point[],
	lo: number,
	hi: number,
	windowStartMs: number,
	windowEndMs: number,
	isCounter: boolean,
	isRate: boolean
): number {
	const count = hi - lo;
	if (count < 2) return NaN;
	const first = points[lo];
	const last = points[hi - 1];

	let resultValue = last.v - first.v;
	if (isCounter) {
		let prev = first.v;
		for (let i = lo + 1; i < hi; i++) {
			if (points[i].v < prev) resultValue += prev;
			prev = points[i].v;
		}
	}

	let durationToStart = (first.t - windowStartMs) / 1000;
	const durationToEnd = (windowEndMs - last.t) / 1000;
	const sampledInterval = (last.t - first.t) / 1000;
	const averageDurationBetweenSamples = sampledInterval / (count - 1);

	if (isCounter && resultValue > 0 && first.v >= 0) {
		const durationToZero = sampledInterval * (first.v / resultValue);
		if (durationToZero < durationToStart) durationToStart = durationToZero;
	}

	const extrapolationThreshold = averageDurationBetweenSamples * 1.1;
	let extrapolateToInterval = sampledInterval;
	extrapolateToInterval +=
		durationToStart < extrapolationThreshold
			? durationToStart
			: averageDurationBetweenSamples / 2;
	extrapolateToInterval +=
		durationToEnd < extrapolationThreshold
			? durationToEnd
			: averageDurationBetweenSamples / 2;

	let factor = extrapolateToInterval / sampledInterval;
	if (isRate) factor /= (windowEndMs - windowStartMs) / 1000;
	return resultValue * factor;
}

function instantDelta(
	points: Point[],
	lo: number,
	hi: number,
	isRate: boolean
): number {
	if (hi - lo < 2) return NaN;
	const last = points[hi - 1];
	const prev = points[hi - 2];
	let delta = last.v - prev.v;
	if (isRate && delta < 0) delta = last.v; // counter reset
	const seconds = (last.t - prev.t) / 1000;
	if (seconds <= 0) return NaN;
	return isRate ? delta / seconds : last.v - prev.v;
}

const RANGE_FUNCS: Record<string, RangeFunc> = {
	rate: (p, lo, hi, s, e) => extrapolatedRate(p, lo, hi, s, e, true, true),
	increase: (p, lo, hi, s, e) => extrapolatedRate(p, lo, hi, s, e, true, false),
	delta: (p, lo, hi, s, e) => extrapolatedRate(p, lo, hi, s, e, false, false),
	irate: (p, lo, hi) => instantDelta(p, lo, hi, true),
	idelta: (p, lo, hi) => instantDelta(p, lo, hi, false),
	sum_over_time: (p, lo, hi) => {
		if (hi <= lo) return NaN;
		let sum = 0;
		for (let i = lo; i < hi; i++) sum += p[i].v;
		return sum;
	},
	avg_over_time: (p, lo, hi) => {
		if (hi <= lo) return NaN;
		let sum = 0;
		for (let i = lo; i < hi; i++) sum += p[i].v;
		return sum / (hi - lo);
	},
	min_over_time: (p, lo, hi) => {
		if (hi <= lo) return NaN;
		let min = Infinity;
		for (let i = lo; i < hi; i++) min = Math.min(min, p[i].v);
		return min;
	},
	max_over_time: (p, lo, hi) => {
		if (hi <= lo) return NaN;
		let max = -Infinity;
		for (let i = lo; i < hi; i++) max = Math.max(max, p[i].v);
		return max;
	},
	count_over_time: (p, lo, hi) => (hi > lo ? hi - lo : NaN),
	last_over_time: (p, lo, hi) => (hi > lo ? p[hi - 1].v : NaN),
	present_over_time: (p, lo, hi) => (hi > lo ? 1 : NaN),
	stddev_over_time: (p, lo, hi) => Math.sqrt(variance(p, lo, hi)),
	stdvar_over_time: (p, lo, hi) => variance(p, lo, hi),
	changes: (p, lo, hi) => {
		if (hi <= lo) return NaN;
		let changes = 0;
		for (let i = lo + 1; i < hi; i++) {
			if (p[i].v !== p[i - 1].v) changes++;
		}
		return changes;
	},
	resets: (p, lo, hi) => {
		if (hi <= lo) return NaN;
		let resets = 0;
		for (let i = lo + 1; i < hi; i++) {
			if (p[i].v < p[i - 1].v) resets++;
		}
		return resets;
	},
};

function variance(points: Point[], lo: number, hi: number): number {
	const count = hi - lo;
	if (count <= 0) return NaN;
	let mean = 0;
	for (let i = lo; i < hi; i++) mean += points[i].v;
	mean /= count;
	let sumSq = 0;
	for (let i = lo; i < hi; i++) {
		const d = points[i].v - mean;
		sumSq += d * d;
	}
	return sumSq / count;
}

// ---------------------------------------------------------------------------
// Simple per-value math functions
// ---------------------------------------------------------------------------

const MATH_FUNCS: Record<string, (v: number) => number> = {
	abs: Math.abs,
	ceil: Math.ceil,
	floor: Math.floor,
	sqrt: Math.sqrt,
	exp: Math.exp,
	ln: Math.log,
	log2: Math.log2,
	log10: Math.log10,
	sgn: Math.sign,
};

const COMPARATORS: Record<string, (a: number, b: number) => boolean> = {
	"==": (a, b) => a === b,
	"!=": (a, b) => a !== b,
	">": (a, b) => a > b,
	"<": (a, b) => a < b,
	">=": (a, b) => a >= b,
	"<=": (a, b) => a <= b,
};

const ARITHMETIC: Record<string, (a: number, b: number) => number> = {
	"+": (a, b) => a + b,
	"-": (a, b) => a - b,
	"*": (a, b) => a * b,
	"/": (a, b) => a / b,
	"%": (a, b) => a % b,
	"^": (a, b) => Math.pow(a, b),
};

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

class Evaluator {
	constructor(
		private data: SelectorData,
		private times: number[],
		private lookbackMs: number
	) {}

	private get stepCount(): number {
		return this.times.length;
	}

	eval(expr: Expr): Value {
		switch (expr.kind) {
			case "number": {
				const values = new Float64Array(this.stepCount).fill(expr.value);
				return { kind: "scalar", values };
			}
			case "string":
				return { kind: "string", value: expr.value };
			case "selector":
				if (expr.rangeMs !== null) {
					throw new PromQLError(
						"range vector is not allowed here (did you mean to wrap it in rate()/…_over_time()?)"
					);
				}
				return this.evalInstantSelector(expr);
			case "call":
				return this.evalCall(expr);
			case "agg":
				return this.evalAggregation(expr);
			case "binary":
				return this.evalBinary(expr);
			case "unary": {
				const value = this.eval(expr.expr);
				if (expr.op === "+") return value;
				if (value.kind === "scalar") {
					return {
						kind: "scalar",
						values: value.values.map((v) => -v),
					};
				}
				if (value.kind === "vector") {
					return {
						kind: "vector",
						series: value.series.map((s) => ({
							labels: withoutName(s.labels),
							values: s.values.map((v) => -v),
						})),
					};
				}
				throw new PromQLError("unary operator not applicable to strings");
			}
		}
	}

	private evalInstantSelector(selector: Selector): Value {
		const offset = selector.offsetMs;
		const data = this.data.get(selector) ?? [];

		const series: VectorSeries[] = [];
		for (const raw of data) {
			const values = new Float64Array(this.stepCount).fill(NaN);
			let idx = -1;
			let any = false;
			for (let step = 0; step < this.stepCount; step++) {
				const target = this.times[step] - offset;
				while (idx + 1 < raw.points.length && raw.points[idx + 1].t <= target) {
					idx++;
				}
				if (idx >= 0 && raw.points[idx].t > target - this.lookbackMs) {
					values[step] = raw.points[idx].v;
					any = true;
				}
			}
			if (any) series.push({ labels: raw.labels, values });
		}
		return { kind: "vector", series };
	}

	/**
	 * Evaluate a range function over a matrix selector: for every series and
	 * step, apply fn to the samples inside (t - offset - range, t - offset].
	 */
	private evalRangeFunc(
		selector: Selector,
		fn: RangeFunc,
		dropName = true
	): Value {
		const offset = selector.offsetMs;
		const range = selector.rangeMs as number;
		const data = this.data.get(selector) ?? [];

		const series: VectorSeries[] = [];
		for (const raw of data) {
			const values = new Float64Array(this.stepCount).fill(NaN);
			let lo = 0;
			let hi = 0;
			let any = false;
			for (let step = 0; step < this.stepCount; step++) {
				const windowEnd = this.times[step] - offset;
				const windowStart = windowEnd - range;
				while (hi < raw.points.length && raw.points[hi].t <= windowEnd) hi++;
				while (lo < raw.points.length && raw.points[lo].t <= windowStart) lo++;
				const v = fn(raw.points, lo, hi, windowStart, windowEnd, step);
				if (!Number.isNaN(v)) {
					values[step] = v;
					any = true;
				}
			}
			if (any) {
				series.push({
					labels: dropName ? withoutName(raw.labels) : raw.labels,
					values,
				});
			}
		}
		return { kind: "vector", series };
	}

	private expectMatrixSelector(expr: Expr, func: string): Selector {
		if (expr.kind !== "selector" || expr.rangeMs === null) {
			throw new PromQLError(
				`${func}() expects a range vector like metric[5m] as its argument`
			);
		}
		return expr;
	}

	private evalScalarArg(expr: Expr, func: string): Float64Array {
		const value = this.eval(expr);
		if (value.kind !== "scalar") {
			throw new PromQLError(`${func}() expects a scalar here`);
		}
		return value.values;
	}

	private evalVectorArg(expr: Expr, func: string): VectorSeries[] {
		const value = this.eval(expr);
		if (value.kind !== "vector") {
			throw new PromQLError(`${func}() expects an instant vector here`);
		}
		return value.series;
	}

	private evalCall(call: Call): Value {
		const { func, args } = call;

		if (RANGE_FUNCS[func]) {
			if (args.length !== 1) {
				throw new PromQLError(`${func}() expects exactly 1 argument`);
			}
			return this.evalRangeFunc(
				this.expectMatrixSelector(args[0], func),
				RANGE_FUNCS[func]
			);
		}

		if (func === "quantile_over_time") {
			if (args.length !== 2) {
				throw new PromQLError("quantile_over_time() expects 2 arguments");
			}
			const phis = this.evalScalarArg(args[0], func);
			const selector = this.expectMatrixSelector(args[1], func);
			const fn: RangeFunc = (p, lo, hi, _s, _e, step) => {
				if (hi <= lo) return NaN;
				const window: number[] = [];
				for (let i = lo; i < hi; i++) window.push(p[i].v);
				return quantile(phis[step], window);
			};
			return this.evalRangeFunc(selector, fn);
		}

		if (MATH_FUNCS[func]) {
			if (args.length !== 1) {
				throw new PromQLError(`${func}() expects exactly 1 argument`);
			}
			const mathFn = MATH_FUNCS[func];
			const series = this.evalVectorArg(args[0], func);
			return {
				kind: "vector",
				series: series.map((s) => ({
					labels: withoutName(s.labels),
					values: s.values.map((v) =>
						Number.isNaN(v) ? NaN : mathFn(v)
					),
				})),
			};
		}

		switch (func) {
			case "round": {
				if (args.length < 1 || args.length > 2) {
					throw new PromQLError("round() expects 1 or 2 arguments");
				}
				const series = this.evalVectorArg(args[0], func);
				const nearest =
					args.length === 2
						? this.evalScalarArg(args[1], func)
						: new Float64Array(this.stepCount).fill(1);
				return {
					kind: "vector",
					series: series.map((s) => ({
						labels: withoutName(s.labels),
						values: s.values.map((v, i) =>
							Number.isNaN(v) ? NaN : Math.round(v / nearest[i]) * nearest[i]
						),
					})),
				};
			}
			case "clamp":
			case "clamp_min":
			case "clamp_max": {
				const expectedArgs = func === "clamp" ? 3 : 2;
				if (args.length !== expectedArgs) {
					throw new PromQLError(`${func}() expects ${expectedArgs} arguments`);
				}
				const series = this.evalVectorArg(args[0], func);
				const first = this.evalScalarArg(args[1], func);
				const second =
					func === "clamp" ? this.evalScalarArg(args[2], func) : null;
				return {
					kind: "vector",
					series: series.map((s) => ({
						labels: withoutName(s.labels),
						values: s.values.map((v, i) => {
							if (Number.isNaN(v)) return NaN;
							if (func === "clamp") {
								return Math.min(Math.max(v, first[i]), (second as Float64Array)[i]);
							}
							return func === "clamp_min"
								? Math.max(v, first[i])
								: Math.min(v, first[i]);
						}),
					})),
				};
			}
			case "histogram_quantile": {
				if (args.length !== 2) {
					throw new PromQLError("histogram_quantile() expects 2 arguments");
				}
				const phis = this.evalScalarArg(args[0], func);
				const series = this.evalVectorArg(args[1], func);
				return this.histogramQuantile(phis, series);
			}
			case "scalar": {
				if (args.length !== 1) {
					throw new PromQLError("scalar() expects exactly 1 argument");
				}
				const series = this.evalVectorArg(args[0], func);
				const values = new Float64Array(this.stepCount).fill(NaN);
				for (let step = 0; step < this.stepCount; step++) {
					let found = NaN;
					let count = 0;
					for (const s of series) {
						if (!Number.isNaN(s.values[step])) {
							found = s.values[step];
							count++;
						}
					}
					values[step] = count === 1 ? found : NaN;
				}
				return { kind: "scalar", values };
			}
			case "vector": {
				if (args.length !== 1) {
					throw new PromQLError("vector() expects exactly 1 argument");
				}
				const values = this.evalScalarArg(args[0], func);
				return {
					kind: "vector",
					series: [{ labels: {}, values: values.slice() }],
				};
			}
			case "time": {
				if (args.length !== 0) {
					throw new PromQLError("time() expects no arguments");
				}
				const values = new Float64Array(this.stepCount);
				for (let step = 0; step < this.stepCount; step++) {
					values[step] = this.times[step] / 1000;
				}
				return { kind: "scalar", values };
			}
			case "absent": {
				if (args.length !== 1) {
					throw new PromQLError("absent() expects exactly 1 argument");
				}
				const series = this.evalVectorArg(args[0], func);
				const labels: Labels = {};
				if (args[0].kind === "selector") {
					for (const m of args[0].matchers) {
						if (m.op === "=" && m.name !== NAME_LABEL) labels[m.name] = m.value;
					}
				}
				const values = new Float64Array(this.stepCount).fill(NaN);
				let any = false;
				for (let step = 0; step < this.stepCount; step++) {
					const present = series.some((s) => !Number.isNaN(s.values[step]));
					if (!present) {
						values[step] = 1;
						any = true;
					}
				}
				return {
					kind: "vector",
					series: any ? [{ labels, values }] : [],
				};
			}
			case "sort":
			case "sort_desc": {
				// Ordering is applied at output time for instant queries;
				// values pass through unchanged.
				if (args.length !== 1) {
					throw new PromQLError(`${func}() expects exactly 1 argument`);
				}
				const value = this.eval(args[0]);
				if (value.kind !== "vector") {
					throw new PromQLError(`${func}() expects an instant vector`);
				}
				return value;
			}
			default:
				throw new PromQLError(`unknown or unsupported function "${func}"`);
		}
	}

	private histogramQuantile(
		phis: Float64Array,
		series: VectorSeries[]
	): Value {
		interface BucketGroup {
			labels: Labels;
			buckets: Array<{ le: number; series: VectorSeries }>;
		}
		const groups = new Map<string, BucketGroup>();
		for (const s of series) {
			const leRaw = s.labels.le;
			if (leRaw === undefined) continue;
			const le =
				leRaw === "+Inf" ? Infinity : leRaw === "-Inf" ? -Infinity : Number(leRaw);
			if (Number.isNaN(le)) continue;
			const groupLabels: Labels = {};
			for (const key of Object.keys(s.labels)) {
				if (key !== "le" && key !== NAME_LABEL) groupLabels[key] = s.labels[key];
			}
			const key = canonicalLabels(groupLabels);
			let group = groups.get(key);
			if (!group) {
				group = { labels: groupLabels, buckets: [] };
				groups.set(key, group);
			}
			group.buckets.push({ le, series: s });
		}

		const result: VectorSeries[] = [];
		for (const group of groups.values()) {
			group.buckets.sort((a, b) => a.le - b.le);
			const values = new Float64Array(this.stepCount).fill(NaN);
			let any = false;
			for (let step = 0; step < this.stepCount; step++) {
				const counts: Array<{ le: number; count: number }> = [];
				for (const bucket of group.buckets) {
					const v = bucket.series.values[step];
					if (!Number.isNaN(v)) counts.push({ le: bucket.le, count: v });
				}
				const v = bucketQuantile(phis[step], counts);
				if (!Number.isNaN(v)) {
					values[step] = v;
					any = true;
				}
			}
			if (any) result.push({ labels: group.labels, values });
		}
		return { kind: "vector", series: result };
	}

	private evalAggregation(agg: Aggregation): Value {
		const input = this.eval(agg.expr);
		if (input.kind !== "vector") {
			throw new PromQLError(`${agg.op}() expects an instant vector`);
		}

		const groupLabelsFor = (labels: Labels): Labels => {
			const out: Labels = {};
			if (agg.without) {
				for (const key of Object.keys(labels)) {
					if (key === NAME_LABEL || agg.grouping.includes(key)) continue;
					out[key] = labels[key];
				}
			} else {
				for (const key of agg.grouping) {
					if (labels[key] !== undefined) out[key] = labels[key];
				}
			}
			return out;
		};

		let param: Float64Array | null = null;
		if (agg.param) {
			param = this.evalScalarArg(agg.param, agg.op);
		}

		// topk/bottomk keep original series identities.
		if (agg.op === "topk" || agg.op === "bottomk") {
			if (!param) throw new PromQLError(`${agg.op} requires a parameter`);
			const keep: boolean[][] = input.series.map(() =>
				new Array<boolean>(this.stepCount).fill(false)
			);
			for (let step = 0; step < this.stepCount; step++) {
				const k = Math.trunc(param[step]);
				if (!(k > 0)) continue;
				const groups = new Map<string, number[]>(); // groupKey -> series idx
				for (let i = 0; i < input.series.length; i++) {
					if (Number.isNaN(input.series[i].values[step])) continue;
					const key = canonicalLabels(groupLabelsFor(input.series[i].labels));
					const list = groups.get(key) ?? [];
					list.push(i);
					groups.set(key, list);
				}
				for (const list of groups.values()) {
					list.sort((a, b) => {
						const av = input.series[a].values[step];
						const bv = input.series[b].values[step];
						return agg.op === "topk" ? bv - av : av - bv;
					});
					for (const idx of list.slice(0, k)) keep[idx][step] = true;
				}
			}
			const series: VectorSeries[] = [];
			for (let i = 0; i < input.series.length; i++) {
				const values = new Float64Array(this.stepCount).fill(NaN);
				let any = false;
				for (let step = 0; step < this.stepCount; step++) {
					if (keep[i][step]) {
						values[step] = input.series[i].values[step];
						any = true;
					}
				}
				if (any) series.push({ labels: input.series[i].labels, values });
			}
			return { kind: "vector", series };
		}

		interface Group {
			labels: Labels;
			memberIdx: number[];
		}
		const groups = new Map<string, Group>();
		const memberGroupKey: string[] = [];
		for (let i = 0; i < input.series.length; i++) {
			const groupLabels = groupLabelsFor(input.series[i].labels);
			const key = canonicalLabels(groupLabels);
			memberGroupKey.push(key);
			let group = groups.get(key);
			if (!group) {
				group = { labels: groupLabels, memberIdx: [] };
				groups.set(key, group);
			}
			group.memberIdx.push(i);
		}

		const series: VectorSeries[] = [];
		for (const group of groups.values()) {
			const values = new Float64Array(this.stepCount).fill(NaN);
			let any = false;
			for (let step = 0; step < this.stepCount; step++) {
				const present: number[] = [];
				for (const idx of group.memberIdx) {
					const v = input.series[idx].values[step];
					if (!Number.isNaN(v)) present.push(v);
				}
				if (present.length === 0) continue;
				let v: number;
				switch (agg.op) {
					case "sum":
						v = present.reduce((a, b) => a + b, 0);
						break;
					case "avg":
						v = present.reduce((a, b) => a + b, 0) / present.length;
						break;
					case "min":
						v = Math.min(...present);
						break;
					case "max":
						v = Math.max(...present);
						break;
					case "count":
						v = present.length;
						break;
					case "stddev":
					case "stdvar": {
						const mean = present.reduce((a, b) => a + b, 0) / present.length;
						const varSum =
							present.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
							present.length;
						v = agg.op === "stddev" ? Math.sqrt(varSum) : varSum;
						break;
					}
					case "quantile": {
						if (!param) throw new PromQLError("quantile requires a parameter");
						v = quantile(param[step], present);
						break;
					}
					default:
						throw new PromQLError(`unsupported aggregation "${agg.op}"`);
				}
				if (!Number.isNaN(v)) {
					values[step] = v;
					any = true;
				}
			}
			if (any) series.push({ labels: group.labels, values });
		}
		return { kind: "vector", series };
	}

	private evalBinary(expr: BinaryExpr): Value {
		const isComparison = COMPARISON_OPS_SET.has(expr.op);
		const isSetOp = expr.op === "and" || expr.op === "or" || expr.op === "unless";

		const lhs = this.eval(expr.lhs);
		const rhs = this.eval(expr.rhs);
		if (lhs.kind === "string" || rhs.kind === "string") {
			throw new PromQLError("string literals are not allowed in binary operations");
		}

		if (isSetOp) {
			if (lhs.kind !== "vector" || rhs.kind !== "vector") {
				throw new PromQLError(`set operator "${expr.op}" requires vector operands`);
			}
			return this.evalSetOp(expr, lhs.series, rhs.series);
		}

		// scalar ∘ scalar
		if (lhs.kind === "scalar" && rhs.kind === "scalar") {
			if (isComparison && !expr.bool) {
				throw new PromQLError(
					"comparisons between scalars must use the bool modifier"
				);
			}
			const values = new Float64Array(this.stepCount);
			for (let step = 0; step < this.stepCount; step++) {
				values[step] = isComparison
					? COMPARATORS[expr.op](lhs.values[step], rhs.values[step])
						? 1
						: 0
					: ARITHMETIC[expr.op](lhs.values[step], rhs.values[step]);
			}
			return { kind: "scalar", values };
		}

		// vector ∘ scalar (either side)
		if (lhs.kind === "vector" && rhs.kind === "scalar") {
			return this.vectorScalarOp(expr, lhs.series, rhs.values, false);
		}
		if (lhs.kind === "scalar" && rhs.kind === "vector") {
			return this.vectorScalarOp(expr, rhs.series, lhs.values, true);
		}

		// vector ∘ vector, one-to-one
		return this.vectorVectorOp(
			expr,
			(lhs as { kind: "vector"; series: VectorSeries[] }).series,
			(rhs as { kind: "vector"; series: VectorSeries[] }).series
		);
	}

	private vectorScalarOp(
		expr: BinaryExpr,
		series: VectorSeries[],
		scalar: Float64Array,
		scalarIsLhs: boolean
	): Value {
		const isComparison = COMPARISON_OPS_SET.has(expr.op);
		const result: VectorSeries[] = [];
		for (const s of series) {
			const values = new Float64Array(this.stepCount).fill(NaN);
			let any = false;
			for (let step = 0; step < this.stepCount; step++) {
				const v = s.values[step];
				if (Number.isNaN(v)) continue;
				const a = scalarIsLhs ? scalar[step] : v;
				const b = scalarIsLhs ? v : scalar[step];
				if (isComparison) {
					const pass = COMPARATORS[expr.op](a, b);
					if (expr.bool) {
						values[step] = pass ? 1 : 0;
						any = true;
					} else if (pass) {
						values[step] = v;
						any = true;
					}
				} else {
					values[step] = ARITHMETIC[expr.op](a, b);
					any = true;
				}
			}
			if (any) {
				const keepName = isComparison && !expr.bool;
				result.push({
					labels: keepName ? s.labels : withoutName(s.labels),
					values,
				});
			}
		}
		return { kind: "vector", series: result };
	}

	private matchSignature(expr: BinaryExpr): (labels: Labels) => string {
		const matching = expr.matching;
		if (matching?.on) {
			const onLabels = matching.labels;
			return (labels) => {
				const subset: Labels = {};
				for (const key of onLabels) {
					if (labels[key] !== undefined) subset[key] = labels[key];
				}
				return canonicalLabels(subset);
			};
		}
		const ignoring = new Set(matching?.labels ?? []);
		return (labels) => {
			const subset: Labels = {};
			for (const key of Object.keys(labels)) {
				if (key === NAME_LABEL || ignoring.has(key)) continue;
				subset[key] = labels[key];
			}
			return canonicalLabels(subset);
		};
	}

	private evalSetOp(
		expr: BinaryExpr,
		lhs: VectorSeries[],
		rhs: VectorSeries[]
	): Value {
		const sig = this.matchSignature(expr);
		// Per-step presence of each signature on the rhs (and lhs for `or`).
		const rhsPresence = new Map<string, boolean[]>();
		for (const s of rhs) {
			const key = sig(s.labels);
			const present =
				rhsPresence.get(key) ?? new Array<boolean>(this.stepCount).fill(false);
			for (let step = 0; step < this.stepCount; step++) {
				if (!Number.isNaN(s.values[step])) present[step] = true;
			}
			rhsPresence.set(key, present);
		}

		const result: VectorSeries[] = [];
		if (expr.op === "and" || expr.op === "unless") {
			const wantPresent = expr.op === "and";
			for (const s of lhs) {
				const present = rhsPresence.get(sig(s.labels));
				const values = new Float64Array(this.stepCount).fill(NaN);
				let any = false;
				for (let step = 0; step < this.stepCount; step++) {
					const v = s.values[step];
					if (Number.isNaN(v)) continue;
					const rhsHas = present?.[step] ?? false;
					if (rhsHas === wantPresent) {
						values[step] = v;
						any = true;
					}
				}
				if (any) result.push({ labels: s.labels, values });
			}
			return { kind: "vector", series: result };
		}

		// or: lhs series win; rhs contributes at steps where its signature
		// has no lhs presence.
		const lhsPresence = new Map<string, boolean[]>();
		for (const s of lhs) {
			const key = sig(s.labels);
			const present =
				lhsPresence.get(key) ?? new Array<boolean>(this.stepCount).fill(false);
			for (let step = 0; step < this.stepCount; step++) {
				if (!Number.isNaN(s.values[step])) present[step] = true;
			}
			lhsPresence.set(key, present);
		}
		for (const s of lhs) result.push(s);
		for (const s of rhs) {
			const present = lhsPresence.get(sig(s.labels));
			const values = new Float64Array(this.stepCount).fill(NaN);
			let any = false;
			for (let step = 0; step < this.stepCount; step++) {
				const v = s.values[step];
				if (Number.isNaN(v)) continue;
				if (!(present?.[step] ?? false)) {
					values[step] = v;
					any = true;
				}
			}
			if (any) result.push({ labels: s.labels, values });
		}
		return { kind: "vector", series: result };
	}

	private vectorVectorOp(
		expr: BinaryExpr,
		lhs: VectorSeries[],
		rhs: VectorSeries[]
	): Value {
		const isComparison = COMPARISON_OPS_SET.has(expr.op);
		const sig = this.matchSignature(expr);

		const rhsBySig = new Map<string, VectorSeries>();
		for (const s of rhs) {
			const key = sig(s.labels);
			if (rhsBySig.has(key)) {
				throw new PromQLError(
					"many-to-many matching not allowed: multiple matches on the right side"
				);
			}
			rhsBySig.set(key, s);
		}
		const seenLhsSig = new Set<string>();

		const result: VectorSeries[] = [];
		for (const s of lhs) {
			const key = sig(s.labels);
			if (seenLhsSig.has(key)) {
				throw new PromQLError(
					"many-to-many matching not allowed: multiple matches on the left side"
				);
			}
			seenLhsSig.add(key);
			const other = rhsBySig.get(key);
			if (!other) continue;

			const values = new Float64Array(this.stepCount).fill(NaN);
			let any = false;
			for (let step = 0; step < this.stepCount; step++) {
				const a = s.values[step];
				const b = other.values[step];
				if (Number.isNaN(a) || Number.isNaN(b)) continue;
				if (isComparison) {
					const pass = COMPARATORS[expr.op](a, b);
					if (expr.bool) {
						values[step] = pass ? 1 : 0;
						any = true;
					} else if (pass) {
						values[step] = a;
						any = true;
					}
				} else {
					values[step] = ARITHMETIC[expr.op](a, b);
					any = true;
				}
			}
			if (any) {
				const keepName = isComparison && !expr.bool;
				result.push({
					labels: keepName ? s.labels : withoutName(s.labels),
					values,
				});
			}
		}
		return { kind: "vector", series: result };
	}
}

const COMPARISON_OPS_SET = new Set(["==", "!=", ">", "<", ">=", "<="]);

/** φ-quantile over unordered values, Prometheus semantics. */
function quantile(phi: number, values: number[]): number {
	if (values.length === 0 || Number.isNaN(phi)) return NaN;
	if (phi < 0) return -Infinity;
	if (phi > 1) return Infinity;
	const sorted = values.slice().sort((a, b) => a - b);
	const n = sorted.length;
	const rank = phi * (n - 1);
	const lower = Math.floor(rank);
	const upper = Math.ceil(rank);
	const weight = rank - lower;
	return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/** Prometheus histogram_quantile bucket interpolation. */
function bucketQuantile(
	phi: number,
	buckets: Array<{ le: number; count: number }>
): number {
	if (Number.isNaN(phi)) return NaN;
	if (buckets.length < 2) return NaN;
	if (buckets[buckets.length - 1].le !== Infinity) return NaN;
	if (phi < 0) return -Infinity;
	if (phi > 1) return Infinity;

	// Enforce monotonicity (scrapes of moving windows can be slightly off).
	let running = 0;
	const cum = buckets.map((b) => {
		running = Math.max(running, b.count);
		return running;
	});
	const total = cum[cum.length - 1];
	if (total === 0) return NaN;

	const rank = phi * total;
	let b = 0;
	while (b < cum.length - 1 && cum[b] < rank) b++;

	if (b === buckets.length - 1) {
		// Falls into the +Inf bucket: return the highest finite bound.
		return buckets[buckets.length - 2].le;
	}
	const bucketEnd = buckets[b].le;
	const bucketStart = b === 0 ? Math.min(0, bucketEnd) : buckets[b - 1].le;
	const prevCum = b === 0 ? 0 : cum[b - 1];
	const countInBucket = cum[b] - prevCum;
	if (countInBucket <= 0) return bucketEnd;
	const fraction = (rank - prevCum) / countInBucket;
	return bucketStart + (bucketEnd - bucketStart) * fraction;
}

// ---------------------------------------------------------------------------
// Public engine API — returns data shaped like the Prometheus HTTP API.
// ---------------------------------------------------------------------------

export type ApiResultData =
	| { resultType: "scalar"; result: [number, string] }
	| { resultType: "string"; result: [number, string] }
	| {
			resultType: "vector";
			result: Array<{ metric: Labels; value: [number, string] }>;
	  }
	| {
			resultType: "matrix";
			result: Array<{ metric: Labels; values: Array<[number, string]> }>;
	  };

/** Query surface shared by the in-process engine and the OPFS worker proxy. */
export interface PromQLQueryEngine {
	instantQuery(query: string, timeMs: number): Promise<ApiResultData>;
	rangeQuery(
		query: string,
		startMs: number,
		endMs: number,
		stepMs: number
	): Promise<ApiResultData>;
}

export class PromQLEngine implements PromQLQueryEngine {
	private lookbackMs: number;
	private maxSteps: number;

	constructor(private ds: DataSource, options: EngineOptions = {}) {
		this.lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
		this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
	}

	/**
	 * Fetch raw series for every selector in the expression up front, so
	 * the evaluator itself stays synchronous.
	 */
	private async prefetch(expr: Expr, times: number[]): Promise<SelectorData> {
		const selectors: Selector[] = [];
		collectSelectors(expr, selectors);
		const data: SelectorData = new Map();
		const fetches = new Map<string, Promise<SeriesData[]>>();
		await Promise.all(
			selectors.map(async (selector) => {
				const offset = selector.offsetMs;
				const back = selector.rangeMs ?? this.lookbackMs;
				const start = times[0] - offset - back;
				const end = times[times.length - 1] - offset;
				const key = selectorFetchKey(selector.matchers, start, end);
				let fetch = fetches.get(key);
				if (!fetch) {
					fetch = this.ds.select(selector.matchers, start, end);
					fetches.set(key, fetch);
				}
				data.set(selector, await fetch);
			})
		);
		return data;
	}

	async instantQuery(query: string, timeMs: number): Promise<ApiResultData> {
		const expr = parseExpr(query);
		const timeSec = timeMs / 1000;

		// A bare range selector returns the raw samples (matrix).
		if (expr.kind === "selector" && expr.rangeMs !== null) {
			const end = timeMs - expr.offsetMs;
			const start = end - expr.rangeMs;
			const data = await this.ds.select(expr.matchers, start, end);
			return {
				resultType: "matrix",
				result: data
					.map((s) => ({
						metric: s.labels,
						// Range windows are left-open: (start, end].
						values: s.points
							.filter((p) => p.t > start)
							.map((p) => [p.t / 1000, formatValue(p.v)] as [number, string]),
					}))
					.filter((s) => s.values.length > 0)
					.sort((a, b) =>
						canonicalLabels(a.metric).localeCompare(canonicalLabels(b.metric))
					),
			};
		}

		const data = await this.prefetch(expr, [timeMs]);
		const evaluator = new Evaluator(data, [timeMs], this.lookbackMs);
		const value = evaluator.eval(expr);

		if (value.kind === "string") {
			return { resultType: "string", result: [timeSec, value.value] };
		}
		if (value.kind === "scalar") {
			return {
				resultType: "scalar",
				result: [timeSec, formatValue(value.values[0])],
			};
		}

		let entries = value.series
			.filter((s) => !Number.isNaN(s.values[0]))
			.map((s) => ({
				metric: s.labels,
				value: [timeSec, formatValue(s.values[0])] as [number, string],
			}));

		if (expr.kind === "call" && (expr.func === "sort" || expr.func === "sort_desc")) {
			const dir = expr.func === "sort" ? 1 : -1;
			entries = entries.sort(
				(a, b) => dir * (Number(a.value[1]) - Number(b.value[1]))
			);
		} else {
			entries = entries.sort((a, b) =>
				canonicalLabels(a.metric).localeCompare(canonicalLabels(b.metric))
			);
		}
		return { resultType: "vector", result: entries };
	}

	async rangeQuery(
		query: string,
		startMs: number,
		endMs: number,
		stepMs: number
	): Promise<ApiResultData> {
		const expr = parseExpr(query);
		if (expr.kind === "selector" && expr.rangeMs !== null) {
			throw new PromQLError(
				"range queries require an instant vector or scalar expression"
			);
		}
		if (!(stepMs > 0)) throw new PromQLError("step must be positive");
		if (endMs < startMs) throw new PromQLError("end must not be before start");
		const stepCount = Math.floor((endMs - startMs) / stepMs) + 1;
		if (stepCount > this.maxSteps) {
			throw new PromQLError(
				`query would evaluate ${stepCount} steps, exceeding the limit of ${this.maxSteps}; increase the step`
			);
		}
		const times: number[] = [];
		for (let i = 0; i < stepCount; i++) times.push(startMs + i * stepMs);

		const data = await this.prefetch(expr, times);
		const evaluator = new Evaluator(data, times, this.lookbackMs);
		const value = evaluator.eval(expr);

		if (value.kind === "string") {
			throw new PromQLError("string expressions are not valid in range queries");
		}
		if (value.kind === "scalar") {
			return {
				resultType: "matrix",
				result: [
					{
						metric: {},
						values: times.map(
							(t, i) =>
								[t / 1000, formatValue(value.values[i])] as [number, string]
						),
					},
				],
			};
		}

		const result = value.series
			.map((s) => {
				const values: Array<[number, string]> = [];
				for (let i = 0; i < times.length; i++) {
					if (!Number.isNaN(s.values[i])) {
						values.push([times[i] / 1000, formatValue(s.values[i])]);
					}
				}
				return { metric: s.labels, values };
			})
			.filter((s) => s.values.length > 0)
			.sort((a, b) =>
				canonicalLabels(a.metric).localeCompare(canonicalLabels(b.metric))
			);
		return { resultType: "matrix", result };
	}
}

export { PromQLError };

function selectorFetchKey(
	matchers: Matcher[],
	startMs: number,
	endMs: number
): string {
	const normalizedMatchers = matchers
		.map((matcher) => ({
			name: matcher.name,
			op: matcher.op,
			value: matcher.value,
		}))
		.sort((a, b) => {
			const byName = a.name.localeCompare(b.name);
			if (byName !== 0) return byName;
			const byOp = a.op.localeCompare(b.op);
			if (byOp !== 0) return byOp;
			return a.value.localeCompare(b.value);
		});
	return JSON.stringify([startMs, endMs, normalizedMatchers]);
}
