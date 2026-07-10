export interface TsdbBatchRow {
	seriesId: number;
	ts: number;
	value: number;
}

const HEADER_BYTES = 16;
const RECORD_BYTES = 24;
const MAX_RECORDS = 1_048_576;

/** Encode the versioned fixed-width input consumed by tsdb_batch(?). */
export function encodeTsdbBatch(rows: TsdbBatchRow[]): Uint8Array {
	if (rows.length > MAX_RECORDS) {
		throw new Error(`tsdb: batch exceeds ${MAX_RECORDS} records`);
	}
	const bytes = new Uint8Array(HEADER_BYTES + rows.length * RECORD_BYTES);
	bytes.set([0x54, 0x53, 0x49, 0x31]); // TSI1
	const view = new DataView(bytes.buffer);
	view.setUint16(4, 1, true);
	view.setUint16(6, RECORD_BYTES, true);
	view.setUint32(8, rows.length, true);
	view.setUint32(12, 0, true);
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		const offset = HEADER_BYTES + index * RECORD_BYTES;
		view.setBigInt64(offset, BigInt(row.seriesId), true);
		view.setBigInt64(offset + 8, BigInt(row.ts), true);
		view.setFloat64(offset + 16, row.value, true);
	}
	return bytes;
}
