import { describe, expect, it } from "vitest";
import { encodeTsdbBatch } from "../src/storage/tsdb-batch";

describe("encodeTsdbBatch", () => {
	it("writes a TSI1 header and little-endian records", () => {
		const bytes = encodeTsdbBatch([
			{ seriesId: 7, ts: 1_700_000_000_123, value: -0 },
		]);
		expect(Array.from(bytes.slice(0, 4))).toEqual([0x54, 0x53, 0x49, 0x31]);
		const view = new DataView(bytes.buffer);
		expect(view.getUint16(4, true)).toBe(1);
		expect(view.getUint16(6, true)).toBe(24);
		expect(view.getUint32(8, true)).toBe(1);
		expect(view.getBigInt64(16, true)).toBe(7n);
		expect(view.getBigInt64(24, true)).toBe(1_700_000_000_123n);
		expect(Object.is(view.getFloat64(32, true), -0)).toBe(true);
	});
});
