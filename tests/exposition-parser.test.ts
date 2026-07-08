import { describe, expect, it } from "vitest";
import { parseExposition } from "../src/scrape/parser";

describe("parseExposition", () => {
	it("parses simple samples", () => {
		const samples = parseExposition(
			"# HELP foo Some help\n# TYPE foo counter\nfoo 42\nbar 1e3\n"
		);
		expect(samples).toEqual([
			{ name: "foo", labels: {}, value: 42 },
			{ name: "bar", labels: {}, value: 1000 },
		]);
	});

	it("parses labels", () => {
		const samples = parseExposition(
			'http_requests_total{method="GET",code="200"} 1027'
		);
		expect(samples).toEqual([
			{
				name: "http_requests_total",
				labels: { method: "GET", code: "200" },
				value: 1027,
			},
		]);
	});

	it("handles escaped label values", () => {
		const samples = parseExposition(
			'foo{path="C:\\\\temp",msg="say \\"hi\\"",nl="a\\nb"} 1'
		);
		expect(samples[0].labels).toEqual({
			path: "C:\\temp",
			msg: 'say "hi"',
			nl: "a\nb",
		});
	});

	it("parses special float values", () => {
		const samples = parseExposition("a +Inf\nb -Inf\nc NaN");
		expect(samples[0].value).toBe(Infinity);
		expect(samples[1].value).toBe(-Infinity);
		expect(Number.isNaN(samples[2].value)).toBe(true);
	});

	it("parses timestamps (unix ms)", () => {
		const samples = parseExposition("foo 17 1700000000123");
		expect(samples[0].timestampMs).toBe(1700000000123);
	});

	it("skips malformed lines without failing the scrape", () => {
		const samples = parseExposition(
			'good 1\n{no_name="x"} 2\nbad{unclosed="y 3\nalso_good 4'
		);
		expect(samples.map((s) => s.name)).toEqual(["good", "also_good"]);
	});

	it("handles histogram bucket output", () => {
		const text = [
			'h_bucket{le="0.5"} 129',
			'h_bucket{le="+Inf"} 200',
			"h_sum 52.3",
			"h_count 200",
		].join("\n");
		const samples = parseExposition(text);
		expect(samples).toHaveLength(4);
		expect(samples[0].labels.le).toBe("0.5");
		expect(samples[1].labels.le).toBe("+Inf");
	});
});
