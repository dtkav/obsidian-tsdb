import { Matcher, MatchOp, NAME_LABEL } from "../labels";
import {
	Aggregation,
	Expr,
	PromQLError,
	Selector,
	VectorMatching,
	parseDuration,
} from "./ast";

type TokenType =
	| "number"
	| "duration"
	| "string"
	| "ident"
	| "op"
	| "lparen"
	| "rparen"
	| "lbrace"
	| "rbrace"
	| "lbracket"
	| "rbracket"
	| "comma"
	| "colon"
	| "eof";

interface Token {
	type: TokenType;
	text: string;
	pos: number;
}

const IDENT_START = /[a-zA-Z_:]/;
const IDENT_CHAR = /[a-zA-Z0-9_:]/;
const DIGIT = /[0-9]/;
const DURATION_UNIT_START = /[smhdwy]/;

const TWO_CHAR_OPS = ["==", "!=", ">=", "<=", "=~", "!~"];
const ONE_CHAR_OPS = ["+", "-", "*", "/", "%", "^", "=", "<", ">"];

function lex(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const push = (type: TokenType, text: string, pos: number) =>
		tokens.push({ type, text, pos });

	while (i < input.length) {
		const ch = input[i];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			i++;
			continue;
		}
		if (ch === "(") { push("lparen", ch, i); i++; continue; }
		if (ch === ")") { push("rparen", ch, i); i++; continue; }
		if (ch === "{") { push("lbrace", ch, i); i++; continue; }
		if (ch === "}") { push("rbrace", ch, i); i++; continue; }
		if (ch === "[") { push("lbracket", ch, i); i++; continue; }
		if (ch === "]") { push("rbracket", ch, i); i++; continue; }
		if (ch === ",") { push("comma", ch, i); i++; continue; }
		if (ch === ":") {
			// Colons inside identifiers (recording-rule names like foo:rate5m)
			// are consumed by the ident path; a ':' seen here is standalone
			// (subquery syntax), surfaced as its own token for error reporting.
			push("colon", ch, i);
			i++;
			continue;
		}

		if (ch === '"' || ch === "'") {
			const start = i;
			i++;
			let value = "";
			while (i < input.length && input[i] !== ch) {
				if (input[i] === "\\") {
					const next = input[i + 1];
					if (next === "n") value += "\n";
					else if (next === "t") value += "\t";
					else value += next ?? "";
					i += 2;
				} else {
					value += input[i];
					i++;
				}
			}
			if (i >= input.length) {
				throw new PromQLError(`unterminated string at position ${start}`);
			}
			i++; // closing quote
			push("string", value, start);
			continue;
		}

		if (DIGIT.test(ch) || (ch === "." && DIGIT.test(input[i + 1] ?? ""))) {
			const start = i;
			while (i < input.length && DIGIT.test(input[i])) i++;
			let isFloat = false;
			if (input[i] === ".") {
				isFloat = true;
				i++;
				while (i < input.length && DIGIT.test(input[i])) i++;
			}
			if (input[i] === "e" || input[i] === "E") {
				isFloat = true;
				i++;
				if (input[i] === "+" || input[i] === "-") i++;
				while (i < input.length && DIGIT.test(input[i])) i++;
			}
			// Integer immediately followed by a duration unit => duration.
			if (!isFloat && i < input.length && DURATION_UNIT_START.test(input[i])) {
				while (
					i < input.length &&
					(DIGIT.test(input[i]) || DURATION_UNIT_START.test(input[i]))
				) {
					i++;
				}
				push("duration", input.slice(start, i), start);
				continue;
			}
			push("number", input.slice(start, i), start);
			continue;
		}

		const two = input.slice(i, i + 2);
		if (TWO_CHAR_OPS.includes(two)) {
			push("op", two, i);
			i += 2;
			continue;
		}
		if (ONE_CHAR_OPS.includes(ch)) {
			push("op", ch, i);
			i++;
			continue;
		}

		if (IDENT_START.test(ch)) {
			const start = i;
			while (i < input.length && IDENT_CHAR.test(input[i])) i++;
			push("ident", input.slice(start, i), start);
			continue;
		}

		throw new PromQLError(`unexpected character "${ch}" at position ${i}`);
	}
	push("eof", "", input.length);
	return tokens;
}

const AGG_OPS = new Set([
	"sum", "avg", "min", "max", "count",
	"stddev", "stdvar", "quantile", "topk", "bottomk",
]);
const AGG_OPS_WITH_PARAM = new Set(["quantile", "topk", "bottomk"]);

const SET_OPS = new Set(["and", "or", "unless"]);
const COMPARISON_OPS = new Set(["==", "!=", ">", "<", ">=", "<="]);

const PRECEDENCE: Record<string, number> = {
	or: 1,
	and: 2,
	unless: 2,
	"==": 3, "!=": 3, ">": 3, "<": 3, ">=": 3, "<=": 3,
	"+": 4, "-": 4,
	"*": 5, "/": 5, "%": 5,
	"^": 6,
};

class Parser {
	private tokens: Token[];
	private pos = 0;

	constructor(input: string) {
		this.tokens = lex(input);
	}

	private peek(): Token {
		return this.tokens[this.pos];
	}

	private next(): Token {
		return this.tokens[this.pos++];
	}

	private expect(type: TokenType, what: string): Token {
		const token = this.peek();
		if (token.type !== type) {
			throw new PromQLError(
				`expected ${what} but found "${token.text || "end of input"}" at position ${token.pos}`
			);
		}
		return this.next();
	}

	parse(): Expr {
		const expr = this.parseExpression(1);
		const token = this.peek();
		if (token.type !== "eof") {
			throw new PromQLError(
				`unexpected "${token.text}" at position ${token.pos}`
			);
		}
		return expr;
	}

	private binaryOpFor(token: Token): string | null {
		if (token.type === "op" && PRECEDENCE[token.text] !== undefined) {
			return token.text;
		}
		if (token.type === "ident" && SET_OPS.has(token.text)) {
			return token.text;
		}
		return null;
	}

	private parseExpression(minPrec: number): Expr {
		let lhs = this.parseUnary();
		for (;;) {
			const op = this.binaryOpFor(this.peek());
			if (op === null) break;
			const prec = PRECEDENCE[op];
			if (prec < minPrec) break;
			this.next();

			let bool = false;
			if (this.peek().type === "ident" && this.peek().text === "bool") {
				if (!COMPARISON_OPS.has(op)) {
					throw new PromQLError(`bool modifier is only valid on comparison operators`);
				}
				bool = true;
				this.next();
			}

			let matching: VectorMatching | null = null;
			const modifier = this.peek();
			if (
				modifier.type === "ident" &&
				(modifier.text === "on" || modifier.text === "ignoring")
			) {
				this.next();
				matching = {
					on: modifier.text === "on",
					labels: this.parseLabelList(),
				};
				const group = this.peek();
				if (
					group.type === "ident" &&
					(group.text === "group_left" || group.text === "group_right")
				) {
					throw new PromQLError(
						`${group.text} is not supported by this engine (one-to-one matching only)`
					);
				}
			}

			const nextMin = op === "^" ? prec : prec + 1;
			const rhs = this.parseExpression(nextMin);
			lhs = { kind: "binary", op, lhs, rhs, bool, matching };
		}
		return lhs;
	}

	private parseUnary(): Expr {
		const token = this.peek();
		if (token.type === "op" && (token.text === "-" || token.text === "+")) {
			this.next();
			const expr = this.parseUnary();
			return { kind: "unary", op: token.text, expr };
		}
		return this.parsePostfix(this.parsePrimary());
	}

	private parsePostfix(expr: Expr): Expr {
		for (;;) {
			const token = this.peek();
			if (token.type === "lbracket") {
				this.next();
				const duration = this.expect("duration", "a duration");
				if (this.peek().type === "colon") {
					throw new PromQLError("subqueries are not supported by this engine");
				}
				this.expect("rbracket", '"]"');
				if (expr.kind !== "selector" || expr.rangeMs !== null) {
					throw new PromQLError("range specifier is only allowed after a selector");
				}
				expr = { ...expr, rangeMs: parseDuration(duration.text) };
				continue;
			}
			if (token.type === "ident" && token.text === "offset") {
				this.next();
				const duration = this.expect("duration", "a duration");
				if (expr.kind !== "selector") {
					throw new PromQLError("offset is only allowed after a selector");
				}
				expr = { ...expr, offsetMs: parseDuration(duration.text) };
				continue;
			}
			break;
		}
		return expr;
	}

	private parsePrimary(): Expr {
		const token = this.peek();

		if (token.type === "number") {
			this.next();
			return { kind: "number", value: Number(token.text) };
		}
		if (token.type === "duration") {
			// Durations used as literals evaluate to seconds.
			this.next();
			return { kind: "number", value: parseDuration(token.text) / 1000 };
		}
		if (token.type === "string") {
			this.next();
			return { kind: "string", value: token.text };
		}
		if (token.type === "lparen") {
			this.next();
			const expr = this.parseExpression(1);
			this.expect("rparen", '")"');
			return expr;
		}
		if (token.type === "lbrace") {
			return this.parseSelector(null);
		}
		if (token.type === "ident") {
			const lower = token.text.toLowerCase();
			if (lower === "inf") {
				this.next();
				return { kind: "number", value: Infinity };
			}
			if (lower === "nan") {
				this.next();
				return { kind: "number", value: NaN };
			}
			if (AGG_OPS.has(token.text)) {
				return this.parseAggregation();
			}
			this.next();
			if (this.peek().type === "lparen") {
				return this.parseCallArgs(token.text);
			}
			return this.parseSelector(token.text);
		}
		throw new PromQLError(
			`unexpected "${token.text || "end of input"}" at position ${token.pos}`
		);
	}

	private parseCallArgs(func: string): Expr {
		this.expect("lparen", '"("');
		const args: Expr[] = [];
		if (this.peek().type !== "rparen") {
			for (;;) {
				args.push(this.parseExpression(1));
				if (this.peek().type === "comma") {
					this.next();
					continue;
				}
				break;
			}
		}
		this.expect("rparen", '")"');
		return { kind: "call", func, args };
	}

	private parseAggregation(): Expr {
		const op = this.next().text;
		let grouping: string[] | null = null;
		let without = false;

		const readGrouping = () => {
			const token = this.peek();
			if (
				token.type === "ident" &&
				(token.text === "by" || token.text === "without")
			) {
				if (grouping !== null) {
					throw new PromQLError("duplicate grouping clause in aggregation");
				}
				without = token.text === "without";
				this.next();
				grouping = this.parseLabelList();
			}
		};

		readGrouping();
		this.expect("lparen", '"("');
		const args: Expr[] = [];
		for (;;) {
			args.push(this.parseExpression(1));
			if (this.peek().type === "comma") {
				this.next();
				continue;
			}
			break;
		}
		this.expect("rparen", '")"');
		readGrouping();

		let param: Expr | null = null;
		let expr: Expr;
		if (AGG_OPS_WITH_PARAM.has(op)) {
			if (args.length !== 2) {
				throw new PromQLError(`${op} expects exactly 2 arguments`);
			}
			param = args[0];
			expr = args[1];
		} else {
			if (args.length !== 1) {
				throw new PromQLError(`${op} expects exactly 1 argument`);
			}
			expr = args[0];
		}

		const agg: Aggregation = {
			kind: "agg",
			op,
			expr,
			param,
			grouping: grouping ?? [],
			without,
		};
		return agg;
	}

	private parseLabelList(): string[] {
		this.expect("lparen", '"("');
		const labels: string[] = [];
		if (this.peek().type !== "rparen") {
			for (;;) {
				const token = this.expect("ident", "a label name");
				labels.push(token.text);
				if (this.peek().type === "comma") {
					this.next();
					continue;
				}
				break;
			}
		}
		this.expect("rparen", '")"');
		return labels;
	}

	/** Parse selector body; `name` was consumed already (null for bare {}). */
	private parseSelector(name: string | null): Expr {
		const matchers: Matcher[] = [];
		if (name !== null) {
			matchers.push({ name: NAME_LABEL, op: "=", value: name });
		}
		if (this.peek().type === "lbrace") {
			this.next();
			while (this.peek().type !== "rbrace") {
				const labelToken = this.expect("ident", "a label name");
				const opToken = this.peek();
				if (
					opToken.type !== "op" ||
					!["=", "!=", "=~", "!~"].includes(opToken.text)
				) {
					throw new PromQLError(
						`expected a matcher operator at position ${opToken.pos}`
					);
				}
				this.next();
				const valueToken = this.expect("string", "a quoted string");
				matchers.push({
					name: labelToken.text,
					op: opToken.text as MatchOp,
					value: valueToken.text,
				});
				if (this.peek().type === "comma") this.next();
			}
			this.expect("rbrace", '"}"');
		}
		if (matchers.length === 0) {
			throw new PromQLError("vector selector must contain at least one matcher");
		}
		const selector: Selector = {
			kind: "selector",
			name,
			matchers,
			offsetMs: 0,
			rangeMs: null,
		};
		return selector;
	}
}

export function parseExpr(input: string): Expr {
	return new Parser(input).parse();
}

/** Parse a series selector (for match[] params); range/offset not allowed. */
export function parseSeriesSelector(input: string): Matcher[] {
	const expr = parseExpr(input);
	if (expr.kind !== "selector" || expr.rangeMs !== null || expr.offsetMs !== 0) {
		throw new PromQLError(`"${input}" is not a valid series selector`);
	}
	return expr.matchers;
}
