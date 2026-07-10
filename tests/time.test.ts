import { describe, expect, it } from "vitest";
import {
	TimeState,
	durationLabel,
	resolveTimeRange,
} from "../src/time/context";
import { parseTimeOverrides } from "../src/time/frontmatter";
import { expandTimeMacros } from "../src/time/query-vars";
import { PanelConfig } from "../src/panels/config";

const panel: PanelConfig = {
	queries: [{ expr: "up" }],
	type: "timeseries",
	rangeMs: 60 * 60 * 1000,
	stepMs: null,
	refreshSeconds: null,
	height: 220,
};

describe("global time context resolution", () => {
	it("uses the global relative window by default", () => {
		const state: TimeState = {
			mode: "relative",
			rangeMs: 3 * 60 * 60 * 1000,
			endMs: null,
			startMs: null,
			stepMs: null,
		};
		const resolved = resolveTimeRange(state, panel, null, 10_000_000);
		expect(resolved.startMs).toBe(10_000_000 - 3 * 60 * 60 * 1000);
		expect(resolved.endMs).toBe(10_000_000);
		expect(resolved.live).toBe(true);
		expect(resolved.stepMs).toBeGreaterThan(0);
	});

	it("overlays note frontmatter start/end/step on the global window", () => {
		const state: TimeState = {
			mode: "relative",
			rangeMs: 60 * 60 * 1000,
			endMs: null,
			startMs: null,
			stepMs: null,
		};
		const resolved = resolveTimeRange(
			state,
			panel,
			{ startMs: 1_000, endMs: 61_000, stepMs: 10_000 },
			10_000_000
		);
		expect(resolved.startMs).toBe(1_000);
		expect(resolved.endMs).toBe(61_000);
		expect(resolved.stepMs).toBe(10_000);
		expect(resolved.live).toBe(false);
		expect(resolved.hasNoteOverride).toBe(true);
	});

	it("uses a panel step when the global and note step are unset", () => {
		const state: TimeState = {
			mode: "relative",
			rangeMs: 60 * 60 * 1000,
			endMs: null,
			startMs: null,
			stepMs: null,
		};
		const resolved = resolveTimeRange(
			state,
			{ ...panel, stepMs: 30_000 },
			null,
			10_000_000
		);
		expect(resolved.stepMs).toBe(30_000);
	});

	it("formats compact PromQL durations", () => {
		expect(durationLabel(90_000)).toBe("1m30s");
		expect(durationLabel(3 * 60 * 60 * 1000)).toBe("3h");
	});
});

describe("time frontmatter", () => {
	it("parses direct tsdb start/end/step overrides", () => {
		const overrides = parseTimeOverrides({
			tsdb: {
				start: "2026-07-08T09:00:00-07:00",
				end: "2026-07-08T12:00:00-07:00",
				step: "30s",
			},
		});
		expect(overrides?.startMs).toBe(Date.parse("2026-07-08T09:00:00-07:00"));
		expect(overrides?.endMs).toBe(Date.parse("2026-07-08T12:00:00-07:00"));
		expect(overrides?.stepMs).toBe(30_000);
	});

	it("parses nested tsdb time overrides", () => {
		const overrides = parseTimeOverrides({
			tsdb: {
				time: {
					start: "2026-07-08T09:00:00-07:00",
					end: "2026-07-08T12:00:00-07:00",
					step: "30s",
				},
			},
		});
		expect(overrides?.startMs).toBe(Date.parse("2026-07-08T09:00:00-07:00"));
		expect(overrides?.endMs).toBe(Date.parse("2026-07-08T12:00:00-07:00"));
		expect(overrides?.stepMs).toBe(30_000);
	});
});

describe("time macros", () => {
	it("expands selected range and interval macros", () => {
		const query = expandTimeMacros(
			"sum(increase(foo_total[$__range])) / $__range_s # $__interval",
			{
				startMs: 0,
				endMs: 90_000,
				stepMs: 10_000,
				rangeMs: 90_000,
				live: true,
				hasNoteOverride: false,
			}
		);
		expect(query).toBe("sum(increase(foo_total[1m30s])) / 90 # 10s");
	});
});
