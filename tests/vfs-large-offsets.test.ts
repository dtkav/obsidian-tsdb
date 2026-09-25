import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import * as SQLite from "wa-sqlite";
import SQLiteAsyncESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import * as VFS from "wa-sqlite/src/VFS.js";

// The C side of the VFS bridge passes 64-bit offsets and sizes by pointer.
// Read with a 32-bit load they wrap at 2 GiB, so every page past that point
// lands on the wrong offset and SQLite walks garbage. This drives one
// database file past 2 GiB and checks that every offset the bridge hands the
// VFS is the real one and that the data reads back intact.

const WASM = readFileSync("node_modules/wa-sqlite/dist/wa-sqlite-async.wasm");
const CHUNK = 65_536;
const TWO_GIB = 2 ** 31;

interface SparseFile {
	/** Chunk index -> bytes up to and including the last non-zero byte. */
	chunks: Map<number, Uint8Array>;
	size: number;
	flags: number;
}

/**
 * In-memory VFS that keeps only the non-zero prefix of each chunk, so a
 * multi-gigabyte file of zeroblob overflow pages costs a few bytes per page.
 */
class SparseMemoryVFS extends VFS.Base {
	name: string;
	files = new Map<string, SparseFile>();
	private open = new Map<number, SparseFile>();
	offsets: number[] = [];
	truncations: number[] = [];

	constructor(name: string) {
		super();
		this.name = name;
	}

	private record(offset: number): void {
		if (!Number.isSafeInteger(offset) || offset < 0) {
			throw new Error(`bridge passed an invalid offset: ${offset}`);
		}
		this.offsets.push(offset);
	}

	xOpen(name: string | null, fileId: number, flags: number, pOutFlags: DataView): number {
		const key = name ?? `tmp-${fileId}`;
		let file = this.files.get(key);
		if (!file) {
			if (!(flags & VFS.SQLITE_OPEN_CREATE)) return VFS.SQLITE_CANTOPEN;
			file = { chunks: new Map(), size: 0, flags };
			this.files.set(key, file);
		}
		this.open.set(fileId, file);
		pOutFlags.setInt32(0, flags, true);
		return VFS.SQLITE_OK;
	}

	xClose(fileId: number): number {
		const file = this.open.get(fileId);
		this.open.delete(fileId);
		if (file && file.flags & VFS.SQLITE_OPEN_DELETEONCLOSE) {
			for (const [key, value] of this.files) {
				if (value === file) this.files.delete(key);
			}
		}
		return VFS.SQLITE_OK;
	}

	// @ts-expect-error the runtime glue passes a plain Uint8Array.
	xRead(fileId: number, pData: Uint8Array, iOffset: number): number {
		this.record(iOffset);
		const file = this.open.get(fileId);
		if (!file) return VFS.SQLITE_IOERR_READ;
		pData.fill(0);
		const available = Math.max(0, Math.min(pData.byteLength, file.size - iOffset));
		let done = 0;
		while (done < available) {
			const at = iOffset + done;
			const index = Math.floor(at / CHUNK);
			const within = at - index * CHUNK;
			const span = Math.min(CHUNK - within, available - done);
			const stored = file.chunks.get(index);
			if (stored && within < stored.length) {
				const end = Math.min(stored.length, within + span);
				pData.set(stored.subarray(within, end), done);
			}
			done += span;
		}
		return available < pData.byteLength ? VFS.SQLITE_IOERR_SHORT_READ : VFS.SQLITE_OK;
	}

	// @ts-expect-error the runtime glue passes a plain Uint8Array.
	xWrite(fileId: number, pData: Uint8Array, iOffset: number): number {
		this.record(iOffset);
		const file = this.open.get(fileId);
		if (!file) return VFS.SQLITE_IOERR_WRITE;
		let done = 0;
		while (done < pData.byteLength) {
			const at = iOffset + done;
			const index = Math.floor(at / CHUNK);
			const within = at - index * CHUNK;
			const span = Math.min(CHUNK - within, pData.byteLength - done);
			const full = new Uint8Array(CHUNK);
			const stored = file.chunks.get(index);
			if (stored) full.set(stored);
			full.set(pData.subarray(done, done + span), within);
			let last = CHUNK - 1;
			while (last >= 0 && full[last] === 0) last--;
			if (last < 0) file.chunks.delete(index);
			else file.chunks.set(index, full.slice(0, last + 1));
			done += span;
		}
		file.size = Math.max(file.size, iOffset + pData.byteLength);
		return VFS.SQLITE_OK;
	}

	xTruncate(fileId: number, iSize: number): number {
		this.record(iSize);
		this.truncations.push(iSize);
		const file = this.open.get(fileId);
		if (!file) return VFS.SQLITE_IOERR_TRUNCATE;
		for (const index of [...file.chunks.keys()]) {
			if (index * CHUNK >= iSize) file.chunks.delete(index);
		}
		file.size = Math.min(file.size, iSize);
		return VFS.SQLITE_OK;
	}

	xFileSize(fileId: number, pSize64: DataView): number {
		const file = this.open.get(fileId);
		if (!file) return VFS.SQLITE_IOERR_FSTAT;
		pSize64.setBigInt64(0, BigInt(file.size), true);
		return VFS.SQLITE_OK;
	}

	xAccess(name: string, _flags: number, pResOut: DataView): number {
		pResOut.setInt32(0, this.files.has(name) ? 1 : 0, true);
		return VFS.SQLITE_OK;
	}

	xDelete(name: string, _syncDir: number): number {
		this.files.delete(name);
		return VFS.SQLITE_OK;
	}
}

describe("VFS bridge past 2 GiB", () => {
	it("hands the VFS real 64-bit offsets and reads pages past 2 GiB back intact", async () => {
		const module = await SQLiteAsyncESMFactory({ wasmBinary: WASM });
		const sqlite3 = SQLite.Factory(module);
		const vfs = new SparseMemoryVFS("sparse-large");
		sqlite3.vfs_register(vfs, false);
		const db = await sqlite3.open_v2(
			"large.db",
			SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE,
			vfs.name
		);
		try {
			await sqlite3.exec(
				db,
				`PRAGMA page_size=65536;
				 PRAGMA auto_vacuum=INCREMENTAL;
				 PRAGMA journal_mode=OFF;
				 PRAGMA synchronous=OFF;
				 CREATE TABLE t(id INTEGER PRIMARY KEY, kind TEXT, b BLOB);`
			);
			const file = vfs.files.get("large.db")!;
			const blobBytes = 8_000_000;
			let rows = 0;
			await sqlite3.exec(db, "BEGIN");
			while (file.size < TWO_GIB + 64 * 1024 * 1024) {
				await sqlite3.exec(
					db,
					`INSERT INTO t(kind, b) VALUES('filler', zeroblob(${blobBytes}))`
				);
				rows++;
			}
			await sqlite3.exec(db, "COMMIT");
			expect(file.size).toBeGreaterThan(TWO_GIB);

			// A distinctive row whose bytes live beyond the 2 GiB boundary.
			const marker = "beyond-two-gib-" + "x".repeat(4000);
			await sqlite3.exec(
				db,
				`INSERT INTO t(kind, b) VALUES('marker', CAST('${marker}' AS BLOB))`
			);
			expect(Math.max(...vfs.offsets)).toBeGreaterThanOrEqual(TWO_GIB);

			let markerBack = "";
			let fillerCount = 0;
			await sqlite3.exec(
				db,
				"SELECT CAST(b AS TEXT) FROM t WHERE kind='marker'",
				(row) => {
					markerBack = String(row[0]);
				}
			);
			await sqlite3.exec(
				db,
				`SELECT count(*) FROM t WHERE kind='filler' AND length(b)=${blobBytes}`,
				(row) => {
					fillerCount = Number(row[0]);
				}
			);
			expect(markerBack).toBe(marker);
			expect(fillerCount).toBe(rows);

			let integrity = "";
			await sqlite3.exec(db, "PRAGMA integrity_check", (row) => {
				integrity = String(row[0]);
			});
			expect(integrity).toBe("ok");

			// Freeing pages past 2 GiB truncates the file with a real size.
			await sqlite3.exec(db, "DELETE FROM t WHERE kind='filler'");
			await sqlite3.exec(db, "PRAGMA incremental_vacuum");
			expect(file.size).toBeLessThan(TWO_GIB);
			expect(vfs.truncations.length).toBeGreaterThan(0);
			await sqlite3.exec(db, "PRAGMA integrity_check", (row) => {
				integrity = String(row[0]);
			});
			expect(integrity).toBe("ok");
		} finally {
			await sqlite3.close(db);
		}
	}, 600_000);
});
