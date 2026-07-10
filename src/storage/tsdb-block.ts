import type { Point } from "./store";

const HEADER_BYTES = 32;
const MAX_POINTS = 1_048_576;
const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);
const BIG_SEVEN = BigInt(7);
const BIG_63 = BigInt(63);
const BIG_64 = BigInt(64);
const BIG_MAX_I64 = BigInt("9223372036854775807");

export function decodeTsdbBlock(bytes: Uint8Array): Point[] {
	if (bytes.byteLength < HEADER_BYTES) throw corruptBlock();
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		bytes[0] !== 0x53 ||
		bytes[1] !== 0x54 ||
		bytes[2] !== 0x42 ||
		bytes[3] !== 0x31 ||
		bytes[4] !== 1 ||
		bytes[5] !== 1 ||
		bytes[7] !== 0
	) {
		throw corruptBlock();
	}
	const codec = bytes[6];
	if (codec !== 0 && codec !== 1) throw corruptBlock();
	const count = view.getUint32(8, true);
	const timestampBytes = view.getUint32(20, true);
	const valueBytes = view.getUint32(24, true);
	if (
		count === 0 ||
		count > MAX_POINTS ||
		HEADER_BYTES + timestampBytes + valueBytes !== bytes.byteLength ||
		view.getUint32(28, true) !== blockCrc32(bytes)
	) {
		throw corruptBlock();
	}
	if (
		(codec === 0 && valueBytes !== count * 8) ||
		(codec === 1 && valueBytes < 8)
	) {
		throw corruptBlock();
	}

	const timestamps = new Array<number>(count);
	let timestamp = view.getBigInt64(12, true);
	timestamps[0] = safeTimestamp(timestamp);
	let timestampOffset = HEADER_BYTES;
	const timestampEnd = timestampOffset + timestampBytes;
	let previousDelta = BIG_ZERO;
	for (let index = 1; index < count; index++) {
		const encoded = readUleb(bytes, timestampOffset, timestampEnd);
		timestampOffset = encoded.nextOffset;
		const delta =
			index === 1
				? encoded.value
				: previousDelta + zigzagDecode(encoded.value);
		if (delta <= BIG_ZERO || delta > BIG_MAX_I64) throw corruptBlock();
		timestamp += delta;
		timestamps[index] = safeTimestamp(timestamp);
		previousDelta = delta;
	}
	if (timestampOffset !== timestampEnd) throw corruptBlock();

	let valueOffset = timestampEnd;
	const valueEnd = valueOffset + valueBytes;
	const points = new Array<Point>(count);
	if (codec === 0) {
		for (let index = 0; index < count; index++) {
			points[index] = {
				t: timestamps[index],
				v: view.getFloat64(valueOffset + index * 8, true),
			};
		}
	} else {
		let bits = view.getBigUint64(valueOffset, true);
		valueOffset += 8;
		points[0] = { t: timestamps[0], v: bitsToDouble(bits) };
		for (let index = 1; index < count; index++) {
			const encoded = readUleb(bytes, valueOffset, valueEnd);
			valueOffset = encoded.nextOffset;
			bits ^= encoded.value;
			points[index] = { t: timestamps[index], v: bitsToDouble(bits) };
		}
		if (valueOffset !== valueEnd) throw corruptBlock();
	}
	return points;
}

function readUleb(
	bytes: Uint8Array,
	offset: number,
	end: number
): { value: bigint; nextOffset: number } {
	let value = BIG_ZERO;
	let shift = BIG_ZERO;
	while (offset < end && shift < BIG_64) {
		const byte = bytes[offset++];
		const part = BigInt(byte & 0x7f);
		if (shift === BIG_63 && part > BIG_ONE) throw corruptBlock();
		value |= part << shift;
		if ((byte & 0x80) === 0) return { value, nextOffset: offset };
		shift += BIG_SEVEN;
	}
	throw corruptBlock();
}

function zigzagDecode(value: bigint): bigint {
	const magnitude = value >> BIG_ONE;
	return (value & BIG_ONE) === BIG_ZERO
		? magnitude
		: -magnitude - BIG_ONE;
}

function safeTimestamp(value: bigint): number {
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result < 0) throw corruptBlock();
	return result;
}

const floatScratch = new DataView(new ArrayBuffer(8));

function bitsToDouble(bits: bigint): number {
	floatScratch.setBigUint64(0, bits, true);
	return floatScratch.getFloat64(0, true);
}

function blockCrc32(bytes: Uint8Array): number {
	let crc = 0xffff_ffff;
	for (let index = 0; index < bytes.byteLength; index++) {
		const byte = index >= 28 && index < 32 ? 0 : bytes[index];
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			const mask = -(crc & 1);
			crc = (crc >>> 1) ^ (0xedb8_8320 & mask);
		}
	}
	return (~crc) >>> 0;
}

function corruptBlock(): Error {
	return new Error("tsdb: corrupt packed result block");
}
