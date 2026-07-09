import { ResolvedTimeRange, durationLabel } from "./context";

export function expandTimeMacros(
	query: string,
	range: ResolvedTimeRange
): string {
	const replacements: Record<string, string> = {
		$__range_ms: String(Math.round(range.rangeMs)),
		$__range_s: String(Math.round(range.rangeMs / 1000)),
		$__range: durationLabel(range.rangeMs),
		$__interval_ms: String(Math.round(range.stepMs)),
		$__interval_s: String(Math.round(range.stepMs / 1000)),
		$__interval: durationLabel(range.stepMs),
		$__from: String(Math.round(range.startMs)),
		$__to: String(Math.round(range.endMs)),
	};
	return query.replace(
		/\$__range_ms|\$__range_s|\$__range|\$__interval_ms|\$__interval_s|\$__interval|\$__from|\$__to/g,
		(token) => replacements[token] ?? token
	);
}
