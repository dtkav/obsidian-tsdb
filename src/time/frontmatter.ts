import {
	TimeOverrides,
	parseDurationValue,
	parseTimeValue,
} from "./context";

export function parseTimeOverrides(frontmatter: unknown): TimeOverrides | null {
	if (!frontmatter || typeof frontmatter !== "object") return null;
	const root = frontmatter as Record<string, unknown>;
	const tsdb = root.tsdb;
	if (!tsdb || typeof tsdb !== "object") return null;
	const time = (tsdb as Record<string, unknown>).time;
	if (!time || typeof time !== "object") return null;
	const data = time as Record<string, unknown>;

	const overrides: TimeOverrides = {};
	const startMs = parseTimeValue(data.start);
	const endMs = parseTimeValue(data.end);
	const stepMs = parseDurationValue(data.step);
	if (startMs !== undefined) overrides.startMs = startMs;
	if (endMs !== undefined) overrides.endMs = endMs;
	if (stepMs !== undefined) overrides.stepMs = stepMs;
	return Object.keys(overrides).length > 0 ? overrides : null;
}
