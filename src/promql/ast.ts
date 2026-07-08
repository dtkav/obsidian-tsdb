import { Matcher } from "../labels";

/** Error with an errorType matching the Prometheus HTTP API envelope. */
export class PromQLError extends Error {
	readonly errorType: string;

	constructor(message: string, errorType = "bad_data") {
		super(message);
		this.name = "PromQLError";
		this.errorType = errorType;
	}
}

export interface NumberLiteral {
	kind: "number";
	value: number;
}

export interface StringLiteral {
	kind: "string";
	value: string;
}

export interface Selector {
	kind: "selector";
	/** Metric name, also present in matchers as __name__ when set. */
	name: string | null;
	matchers: Matcher[];
	offsetMs: number;
	/** Non-null for range selectors like foo[5m]. */
	rangeMs: number | null;
}

export interface Call {
	kind: "call";
	func: string;
	args: Expr[];
}

export interface Aggregation {
	kind: "agg";
	op: string;
	expr: Expr;
	/** Parameter for topk/bottomk/quantile. */
	param: Expr | null;
	grouping: string[];
	without: boolean;
}

export interface VectorMatching {
	on: boolean;
	labels: string[];
}

export interface BinaryExpr {
	kind: "binary";
	op: string;
	lhs: Expr;
	rhs: Expr;
	bool: boolean;
	matching: VectorMatching | null;
}

export interface UnaryExpr {
	kind: "unary";
	op: "-" | "+";
	expr: Expr;
}

export type Expr =
	| NumberLiteral
	| StringLiteral
	| Selector
	| Call
	| Aggregation
	| BinaryExpr
	| UnaryExpr;

const DURATION_RE = /^(?:([0-9]+)y)?(?:([0-9]+)w)?(?:([0-9]+)d)?(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+)s)?(?:([0-9]+)ms)?$/;

const DURATION_UNIT_MS: Record<string, number> = {
	y: 365 * 24 * 3600 * 1000,
	w: 7 * 24 * 3600 * 1000,
	d: 24 * 3600 * 1000,
	h: 3600 * 1000,
	m: 60 * 1000,
	s: 1000,
	ms: 1,
};

/** Parse a PromQL duration like "1h30m" into milliseconds. */
export function parseDuration(text: string): number {
	const match = DURATION_RE.exec(text);
	if (!match || text.length === 0) {
		throw new PromQLError(`invalid duration: "${text}"`);
	}
	const units = ["y", "w", "d", "h", "m", "s", "ms"];
	let ms = 0;
	let sawAny = false;
	for (let i = 0; i < units.length; i++) {
		const group = match[i + 1];
		if (group !== undefined) {
			ms += parseInt(group, 10) * DURATION_UNIT_MS[units[i]];
			sawAny = true;
		}
	}
	if (!sawAny) throw new PromQLError(`invalid duration: "${text}"`);
	return ms;
}
