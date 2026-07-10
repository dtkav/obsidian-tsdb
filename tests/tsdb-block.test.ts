import { describe, expect, it } from "vitest";
import { decodeTsdbBlock } from "../src/storage/tsdb-block";

const RAW_BLOCK =
	"535442310101000003000000E80300000000000004000000180000003A658D15" +
	"E807E807000000000000F83F00000000000004400000000000000080";
const XOR_BLOCK =
	"535442310101010003000000E803000000000000030000001000000003E0085B" +
	"E8070000000000000045400080808080808020";

describe("decodeTsdbBlock", () => {
	it("decodes raw values and delta-of-delta timestamps", () => {
		const points = decodeTsdbBlock(fromHex(RAW_BLOCK));
		expect(points.slice(0, 2)).toEqual([
			{ t: 1000, v: 1.5 },
			{ t: 2000, v: 2.5 },
		]);
		expect(points[2].t).toBe(3500);
		expect(Object.is(points[2].v, -0)).toBe(true);
	});

	it("decodes XOR-varint values", () => {
		expect(decodeTsdbBlock(fromHex(XOR_BLOCK))).toEqual([
			{ t: 1000, v: 42 },
			{ t: 2000, v: 42 },
			{ t: 3000, v: 43 },
		]);
	});

	it("rejects a block with a bad checksum", () => {
		const block = fromHex(XOR_BLOCK);
		block[block.length - 1] ^= 1;
		expect(() => decodeTsdbBlock(block)).toThrow(/corrupt packed result/);
	});
});

function fromHex(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < bytes.length; index++) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}
