import { Labels } from "../labels";

export interface ParsedSample {
	name: string;
	labels: Labels;
	value: number;
	/** Timestamp from the exposition, if present (unix ms). */
	timestampMs?: number;
}

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*/;

function parsePrometheusValue(raw: string): number {
	switch (raw) {
		case "+Inf":
		case "Inf":
			return Infinity;
		case "-Inf":
			return -Infinity;
		case "NaN":
			return NaN;
		default: {
			const value = Number(raw);
			return Number.isNaN(value) && raw !== "NaN" ? NaN : value;
		}
	}
}

/**
 * Parse the Prometheus text exposition format (also tolerates basic
 * OpenMetrics output). HELP/TYPE/comment lines are skipped; only raw
 * samples are returned. Malformed lines are skipped rather than fatal,
 * so one bad target line can't poison a whole scrape.
 */
export function parseExposition(text: string): ParsedSample[] {
	const samples: ParsedSample[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const sample = parseSampleLine(line);
		if (sample) samples.push(sample);
	}
	return samples;
}

function parseSampleLine(line: string): ParsedSample | null {
	const nameMatch = NAME_RE.exec(line);
	if (!nameMatch) return null;
	const name = nameMatch[0];
	let rest = line.slice(name.length);

	const labels: Labels = {};
	if (rest.startsWith("{")) {
		const end = parseLabels(rest, labels);
		if (end < 0) return null;
		rest = rest.slice(end);
	}

	const parts = rest.trim().split(/\s+/);
	if (parts.length < 1 || parts[0] === "") return null;
	const value = parsePrometheusValue(parts[0]);

	const sample: ParsedSample = { name, labels, value };
	if (parts.length >= 2) {
		const ts = Number(parts[1]);
		// Text format timestamps are unix milliseconds.
		if (Number.isFinite(ts)) sample.timestampMs = ts;
	}
	return sample;
}

/**
 * Parse a `{label="value",...}` block starting at index 0 of `text`.
 * Returns the index just past the closing brace, or -1 on malformed input.
 */
function parseLabels(text: string, out: Labels): number {
	let i = 1; // skip '{'
	for (;;) {
		while (text[i] === " " || text[i] === ",") i++;
		if (i >= text.length) return -1;
		if (text[i] === "}") return i + 1;

		const nameMatch = LABEL_NAME_RE.exec(text.slice(i));
		if (!nameMatch) return -1;
		const labelName = nameMatch[0];
		i += labelName.length;
		if (text[i] !== "=") return -1;
		i++;
		if (text[i] !== '"') return -1;
		i++;

		let value = "";
		for (;;) {
			if (i >= text.length) return -1;
			const ch = text[i];
			if (ch === "\\") {
				const next = text[i + 1];
				if (next === "n") value += "\n";
				else if (next === '"') value += '"';
				else if (next === "\\") value += "\\";
				else value += next ?? "";
				i += 2;
			} else if (ch === '"') {
				i++;
				break;
			} else {
				value += ch;
				i++;
			}
		}
		out[labelName] = value;
	}
}
