/**
 * Label sets and label matchers, shared by the storage layer, the PromQL
 * engine and the HTTP API. Follows Prometheus data-model conventions:
 * the metric name is carried as the reserved "__name__" label.
 */

export type Labels = Record<string, string>;

export const NAME_LABEL = "__name__";

export type MatchOp = "=" | "!=" | "=~" | "!~";

export interface Matcher {
	name: string;
	op: MatchOp;
	value: string;
}

/**
 * Canonical string for a label set (sorted keys), used as the series
 * identity. The metric name label is included when present.
 */
export function canonicalLabels(labels: Labels): string {
	const keys = Object.keys(labels).sort();
	const parts: string[] = [];
	for (const key of keys) {
		parts.push(JSON.stringify(key) + ":" + JSON.stringify(labels[key]));
	}
	return "{" + parts.join(",") + "}";
}

/** Prometheus regexes are fully anchored. */
export function compileAnchoredRegex(pattern: string): RegExp {
	return new RegExp("^(?:" + pattern + ")$");
}

export type LabelPredicate = (labels: Labels) => boolean;

/**
 * Compile a matcher into a predicate. Per Prometheus semantics a missing
 * label is treated as the empty string.
 */
export function compileMatcher(matcher: Matcher): LabelPredicate {
	const { name, op, value } = matcher;
	switch (op) {
		case "=":
			return (labels) => (labels[name] ?? "") === value;
		case "!=":
			return (labels) => (labels[name] ?? "") !== value;
		case "=~": {
			const re = compileAnchoredRegex(value);
			return (labels) => re.test(labels[name] ?? "");
		}
		case "!~": {
			const re = compileAnchoredRegex(value);
			return (labels) => !re.test(labels[name] ?? "");
		}
	}
}

export function compileMatchers(matchers: Matcher[]): LabelPredicate {
	const predicates = matchers.map(compileMatcher);
	return (labels) => predicates.every((p) => p(labels));
}

/** Drop the __name__ label (Prometheus does this for most function outputs). */
export function withoutName(labels: Labels): Labels {
	const out: Labels = {};
	for (const key of Object.keys(labels)) {
		if (key !== NAME_LABEL) out[key] = labels[key];
	}
	return out;
}
