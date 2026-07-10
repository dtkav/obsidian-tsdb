import { describe, expect, it } from "vitest";
import { Labels, compileMatchers } from "../src/labels";
import { PromQLError } from "../src/promql/ast";
import { DataSource, PromQLEngine } from "../src/promql/engine";
import { parseExpr, parseSeriesSelector } from "../src/promql/parser";
import { Point } from "../src/storage/store";

function makeDs(
	series: Array<{ labels: Labels; points: Point[] }>
): DataSource {
	return {
		select: async (matchers, startMs, endMs) => {
			const predicate = compileMatchers(matchers);
			return series
				.filter((s) => predicate(s.labels))
				.map((s) => ({
					labels: s.labels,
					points: s.points.filter((p) => p.t >= startMs && p.t <= endMs),
				}))
				.filter((s) => s.points.length > 0);
		},
	};
}

/** A counter increasing 1/sec, sampled every 10s from t=0 to t=120s. */
function counterSeries(labels: Labels): { labels: Labels; points: Point[] } {
	const points: Point[] = [];
	for (let t = 0; t <= 120_000; t += 10_000) {
		points.push({ t, v: t / 1000 });
	}
	return { labels, points };
}

const T = 120_000; // evaluation time

describe("PromQL parser", () => {
	it("parses selectors with matchers into __name__ matcher", () => {
		const expr = parseExpr('http_requests_total{job="api",code=~"5.."}');
		expect(expr.kind).toBe("selector");
		if (expr.kind === "selector") {
			expect(expr.matchers).toContainEqual({
				name: "__name__",
				op: "=",
				value: "http_requests_total",
			});
			expect(expr.matchers).toContainEqual({
				name: "code",
				op: "=~",
				value: "5..",
			});
		}
	});

	it("parses range and offset", () => {
		const expr = parseExpr("foo[5m] offset 1h");
		expect(expr.kind).toBe("selector");
		if (expr.kind === "selector") {
			expect(expr.rangeMs).toBe(5 * 60 * 1000);
			expect(expr.offsetMs).toBe(60 * 60 * 1000);
		}
	});

	it("respects operator precedence", () => {
		const expr = parseExpr("1 + 2 * 3");
		expect(expr.kind).toBe("binary");
		if (expr.kind === "binary") {
			expect(expr.op).toBe("+");
			expect(expr.rhs.kind).toBe("binary");
		}
	});

	it("parses aggregation grouping before or after parens", () => {
		for (const q of ["sum by (job) (m)", "sum(m) by (job)"]) {
			const expr = parseExpr(q);
			expect(expr.kind).toBe("agg");
			if (expr.kind === "agg") {
				expect(expr.grouping).toEqual(["job"]);
				expect(expr.without).toBe(false);
			}
		}
	});

	it("rejects unsupported constructs with clear errors", () => {
		expect(() => parseExpr("m[5m:1m]")).toThrowError(PromQLError);
		expect(() => parseExpr("a / on(x) group_left b")).toThrowError(/group_left/);
		expect(() => parseExpr("m{")).toThrowError(PromQLError);
		expect(() => parseExpr("rate(m[5m]) extra")).toThrowError(/unexpected/);
	});

	it("parses series selectors for match[] params", () => {
		expect(parseSeriesSelector('up{job="obsidian"}')).toHaveLength(2);
		expect(() => parseSeriesSelector("up[5m]")).toThrowError(PromQLError);
	});
});

describe("PromQL engine", () => {
	it("evaluates an instant selector with lookback", async () => {
		const ds = makeDs([
			{ labels: { __name__: "m", job: "a" }, points: [{ t: 100_000, v: 7 }] },
		]);
		const engine = new PromQLEngine(ds);
		const result = await engine.instantQuery("m", T);
		expect(result.resultType).toBe("vector");
		if (result.resultType === "vector") {
			expect(result.result).toHaveLength(1);
			expect(result.result[0].value[1]).toBe("7");
		}
	});

	it("deduplicates identical selector fetches within a query", async () => {
		let selectCalls = 0;
		const ds: DataSource = {
			select: async (_matchers, startMs, endMs) => {
				selectCalls++;
				return [
					{
						labels: { __name__: "m", job: "a" },
						points: [{ t: T, v: 7 }].filter(
							(p) => p.t >= startMs && p.t <= endMs
						),
					},
				];
			},
		};
		const engine = new PromQLEngine(ds);

		const result = await engine.instantQuery("m + m", T);

		expect(selectCalls).toBe(1);
		expect(result.resultType).toBe("vector");
		if (result.resultType === "vector") {
			expect(Number(result.result[0].value[1])).toBe(14);
		}
	});

	it("returns nothing when the only sample is outside the lookback window", async () => {
		const ds = makeDs([
			{ labels: { __name__: "m" }, points: [{ t: 0, v: 7 }] },
		]);
		const engine = new PromQLEngine(ds);
		const result = await engine.instantQuery("m", 10 * 60 * 1000);
		if (result.resultType === "vector") {
			expect(result.result).toHaveLength(0);
		}
	});

	it("computes rate() on a steady counter", async () => {
		const ds = makeDs([counterSeries({ __name__: "c", job: "a" })]);
		const engine = new PromQLEngine(ds);
		const result = await engine.instantQuery("rate(c[60s])", T);
		if (result.resultType === "vector") {
			expect(result.result).toHaveLength(1);
			expect(Number(result.result[0].value[1])).toBeCloseTo(1.0, 6);
			// rate() drops the metric name
			expect(result.result[0].metric.__name__).toBeUndefined();
			expect(result.result[0].metric.job).toBe("a");
		}
	});

	it("handles counter resets in rate()", async () => {
		const points: Point[] = [
			{ t: 0, v: 100 },
			{ t: 30_000, v: 130 },
			{ t: 60_000, v: 10 }, // reset
			{ t: 90_000, v: 40 },
			{ t: 120_000, v: 70 },
		];
		const ds = makeDs([{ labels: { __name__: "c" }, points }]);
		const engine = new PromQLEngine(ds);
		const result = await engine.instantQuery("rate(c[120s])", T);
		if (result.resultType === "vector") {
			// increases: 30 + (reset correction 130) + 30 + 30 => 100+130-100+70-10...
			// resultValue = 70 - 100 + 130 = 100 over ~120s window
			const v = Number(result.result[0].value[1]);
			expect(v).toBeGreaterThan(0.5);
			expect(v).toBeLessThan(1.5);
		}
	});

	it("aggregates with sum by()", async () => {
		const ds = makeDs([
			{
				labels: { __name__: "m", job: "a", instance: "1" },
				points: [{ t: T, v: 1 }],
			},
			{
				labels: { __name__: "m", job: "a", instance: "2" },
				points: [{ t: T, v: 2 }],
			},
			{
				labels: { __name__: "m", job: "b", instance: "3" },
				points: [{ t: T, v: 5 }],
			},
		]);
		const engine = new PromQLEngine(ds);
		const result = await engine.instantQuery("sum by (job) (m)", T);
		if (result.resultType === "vector") {
			expect(result.result).toHaveLength(2);
			const byJob = Object.fromEntries(
				result.result.map((r) => [r.metric.job, Number(r.value[1])])
			);
			expect(byJob).toEqual({ a: 3, b: 5 });
		}
	});

	it("computes histogram_quantile", async () => {
		const mk = (le: string, v: number) => ({
			labels: { __name__: "h_bucket", le, job: "x" },
			points: [{ t: T, v }],
		});
		const ds = makeDs([mk("1", 50), mk("2", 100), mk("+Inf", 100)]);
		const engine = new PromQLEngine(ds);
		const result = await engine.instantQuery(
			"histogram_quantile(0.5, h_bucket)",
			T
		);
		if (result.resultType === "vector") {
			expect(result.result).toHaveLength(1);
			expect(Number(result.result[0].value[1])).toBeCloseTo(1.0, 6);
			expect(result.result[0].metric).toEqual({ job: "x" });
		}
	});

	it("applies vector-scalar arithmetic and comparison filters", async () => {
		const ds = makeDs([
			{ labels: { __name__: "m", i: "1" }, points: [{ t: T, v: 3 }] },
			{ labels: { __name__: "m", i: "2" }, points: [{ t: T, v: 10 }] },
		]);
		const engine = new PromQLEngine(ds);

		const doubled = await engine.instantQuery("m * 2", T);
		if (doubled.resultType === "vector") {
			expect(doubled.result.map((r) => Number(r.value[1])).sort((a, b) => a - b)).toEqual([6, 20]);
			expect(doubled.result[0].metric.__name__).toBeUndefined();
		}

		const filtered = await engine.instantQuery("m > 5", T);
		if (filtered.resultType === "vector") {
			expect(filtered.result).toHaveLength(1);
			expect(Number(filtered.result[0].value[1])).toBe(10);
			// filter comparisons keep the metric name
			expect(filtered.result[0].metric.__name__).toBe("m");
		}

		const boolMode = await engine.instantQuery("m > bool 5", T);
		if (boolMode.resultType === "vector") {
			expect(boolMode.result.map((r) => Number(r.value[1])).sort()).toEqual([0, 1]);
		}
	});

	it("joins vectors one-to-one on matching labels", async () => {
		const ds = makeDs([
			{ labels: { __name__: "a", job: "x" }, points: [{ t: T, v: 10 }] },
			{ labels: { __name__: "b", job: "x" }, points: [{ t: T, v: 4 }] },
		]);
		const engine = new PromQLEngine(ds);
		const result = await engine.instantQuery("a / b", T);
		if (result.resultType === "vector") {
			expect(result.result).toHaveLength(1);
			expect(Number(result.result[0].value[1])).toBeCloseTo(2.5);
			expect(result.result[0].metric).toEqual({ job: "x" });
		}
	});

	it("selects topk per step", async () => {
		const ds = makeDs([
			{ labels: { __name__: "m", i: "1" }, points: [{ t: T, v: 3 }] },
			{ labels: { __name__: "m", i: "2" }, points: [{ t: T, v: 10 }] },
		]);
		const engine = new PromQLEngine(ds);
		const result = await engine.instantQuery("topk(1, m)", T);
		if (result.resultType === "vector") {
			expect(result.result).toHaveLength(1);
			expect(result.result[0].metric.i).toBe("2");
		}
	});

	it("evaluates range queries into matrices", async () => {
		const ds = makeDs([counterSeries({ __name__: "c" })]);
		const engine = new PromQLEngine(ds);
		const result = await engine.rangeQuery("rate(c[60s])", 60_000, 120_000, 30_000);
		expect(result.resultType).toBe("matrix");
		if (result.resultType === "matrix") {
			expect(result.result).toHaveLength(1);
			expect(result.result[0].values).toHaveLength(3);
			for (const [, v] of result.result[0].values) {
				expect(Number(v)).toBeCloseTo(1.0, 6);
			}
		}
	});

	it("returns raw samples for a bare range selector in instant queries", async () => {
		const ds = makeDs([counterSeries({ __name__: "c" })]);
		const engine = new PromQLEngine(ds);
		const result = await engine.instantQuery("c[30s]", T);
		expect(result.resultType).toBe("matrix");
		if (result.resultType === "matrix") {
			expect(result.result[0].values).toHaveLength(3); // 100s, 110s, 120s
		}
	});

	it("evaluates scalar expressions", async () => {
		const engine = new PromQLEngine(makeDs([]));
		const result = await engine.instantQuery("1 + 2 * 3", T);
		expect(result.resultType).toBe("scalar");
		if (result.resultType === "scalar") {
			expect(result.result[1]).toBe("7");
		}
	});

	it("rejects range selectors in range queries", async () => {
		const engine = new PromQLEngine(makeDs([]));
		await expect(
			engine.rangeQuery("c[5m]", 0, 60_000, 15_000)
		).rejects.toThrowError(PromQLError);
	});

	it("enforces the step-count limit", async () => {
		const engine = new PromQLEngine(makeDs([]), { maxSteps: 10 });
		await expect(
			engine.rangeQuery("up", 0, 1_000_000, 1_000)
		).rejects.toThrowError(/steps/);
	});
});
