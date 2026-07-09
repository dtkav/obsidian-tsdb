import * as VFS from "wa-sqlite/src/VFS.js";

/**
 * Subset of Obsidian's DataAdapter used by the chunked VFS. Structural, so
 * the real vault adapter satisfies it on desktop AND mobile, and tests can
 * fake it in memory.
 */
export interface ChunkAdapter {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	remove(path: string): Promise<void>;
}

export const CHUNK_SIZE = 64 * 1024;

/** Chunks cached per open file before clean ones get evicted (8 MiB). */
const MAX_CACHED_CHUNKS = 128;

interface OpenFile {
	name: string;
	flags: number;
	size: number;
	/** Chunk cache, dirty and clean; Map order doubles as LRU. */
	chunks: Map<number, Uint8Array>;
	dirty: Set<number>;
	metaDirty: boolean;
}

function sanitizeName(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * SQLite VFS backed by whole-file adapter I/O: each SQLite file (database,
 * journal) is stored as fixed-size chunk files plus a small JSON meta file,
 * so a page write rewrites one 64 KiB chunk instead of the whole database.
 * All methods are async (Asyncify build); SQLite's own journal protocol
 * provides crash recovery on top.
 */
export class AdapterChunkVFS extends VFS.Base {
	name: string;
	private adapter: ChunkAdapter;
	private directory: string;
	private openFiles = new Map<number, OpenFile>();
	private dirReady = false;

	constructor(vfsName: string, adapter: ChunkAdapter, directory: string) {
		super();
		this.name = vfsName;
		this.adapter = adapter;
		this.directory = directory;
	}

	private metaPath(name: string): string {
		return `${this.directory}/${sanitizeName(name)}.meta`;
	}

	private chunkPath(name: string, index: number): string {
		return `${this.directory}/${sanitizeName(name)}.c${index}`;
	}

	private async ensureDir(): Promise<void> {
		if (this.dirReady) return;
		if (!(await this.adapter.exists(this.directory))) {
			await this.adapter.mkdir(this.directory);
		}
		this.dirReady = true;
	}

	private async readMetaSize(name: string): Promise<number | null> {
		if (!(await this.adapter.exists(this.metaPath(name)))) return null;
		try {
			const meta = JSON.parse(
				await this.adapter.read(this.metaPath(name))
			) as { size?: unknown };
			const size = meta.size;
			return typeof size === "number" ? size : 0;
		} catch {
			return null;
		}
	}

	private async loadChunk(file: OpenFile, index: number): Promise<Uint8Array> {
		const cached = file.chunks.get(index);
		if (cached) {
			// Refresh LRU position.
			file.chunks.delete(index);
			file.chunks.set(index, cached);
			return cached;
		}
		let chunk = new Uint8Array(CHUNK_SIZE);
		const path = this.chunkPath(file.name, index);
		if (await this.adapter.exists(path)) {
			const data = new Uint8Array(await this.adapter.readBinary(path));
			chunk.set(data.subarray(0, Math.min(data.length, CHUNK_SIZE)));
		}
		file.chunks.set(index, chunk);
		return chunk;
	}

	private async flushFile(file: OpenFile): Promise<void> {
		for (const index of file.dirty) {
			const chunk = file.chunks.get(index);
			if (!chunk) continue;
			// Copy so later cache mutations can't race the adapter write.
			await this.adapter.writeBinary(
				this.chunkPath(file.name, index),
				chunk.slice().buffer
			);
		}
		file.dirty.clear();
		if (file.metaDirty) {
			await this.adapter.write(
				this.metaPath(file.name),
				JSON.stringify({ size: file.size })
			);
			file.metaDirty = false;
		}
		// Evict clean chunks beyond the cache cap (oldest first).
		if (file.chunks.size > MAX_CACHED_CHUNKS) {
			for (const index of file.chunks.keys()) {
				if (file.chunks.size <= MAX_CACHED_CHUNKS) break;
				if (!file.dirty.has(index)) file.chunks.delete(index);
			}
		}
	}

	/** Delete a stored file's chunks + meta (also used for recovery wipes). */
	async deleteStoredFile(name: string): Promise<void> {
		const size = await this.readMetaSize(name);
		if (size === null) return;
		const chunkCount = Math.ceil(size / CHUNK_SIZE);
		for (let i = 0; i < chunkCount; i++) {
			const path = this.chunkPath(name, i);
			if (await this.adapter.exists(path)) await this.adapter.remove(path);
		}
		await this.adapter.remove(this.metaPath(name));
	}

	// -- VFS methods (all routed through handleAsync for the Asyncify build) --

	xOpen(
		name: string | null,
		fileId: number,
		flags: number,
		pOutFlags: DataView
	): number {
		return this.handleAsync(async () => {
			await this.ensureDir();
			const fileName =
				name ??
				"tmp-" + Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
			const size = await this.readMetaSize(fileName);
			if (size === null && !(flags & VFS.SQLITE_OPEN_CREATE)) {
				return VFS.SQLITE_CANTOPEN;
			}
			this.openFiles.set(fileId, {
				name: fileName,
				flags,
				size: size ?? 0,
				chunks: new Map(),
				dirty: new Set(),
				metaDirty: size === null,
			});
			pOutFlags.setInt32(0, flags, true);
			return VFS.SQLITE_OK;
		});
	}

	xClose(fileId: number): number {
		return this.handleAsync(async () => {
			const file = this.openFiles.get(fileId);
			this.openFiles.delete(fileId);
			if (!file) return VFS.SQLITE_OK;
			try {
				await this.flushFile(file);
				if (file.flags & VFS.SQLITE_OPEN_DELETEONCLOSE) {
					await this.deleteStoredFile(file.name);
				}
				return VFS.SQLITE_OK;
			} catch (error) {
				console.error("tsdb: VFS close failed", error);
				return VFS.SQLITE_IOERR;
			}
		});
	}

	// @ts-expect-error upstream .d.ts declares pData as {size, value} but the
	// runtime glue passes a plain Uint8Array (see dist/wa-sqlite-async.mjs).
	xRead(fileId: number, pData: Uint8Array, iOffset: number): number {
		return this.handleAsync(async () => {
			const file = this.openFiles.get(fileId);
			if (!file) return VFS.SQLITE_IOERR;
			try {
				const begin = Math.min(iOffset, file.size);
				const end = Math.min(iOffset + pData.byteLength, file.size);
				let copied = 0;
				let position = begin;
				while (position < end) {
					const chunkIndex = Math.floor(position / CHUNK_SIZE);
					const chunkOffset = position % CHUNK_SIZE;
					const take = Math.min(CHUNK_SIZE - chunkOffset, end - position);
					const chunk = await this.loadChunk(file, chunkIndex);
					pData.set(
						chunk.subarray(chunkOffset, chunkOffset + take),
						copied
					);
					copied += take;
					position += take;
				}
				if (copied < pData.byteLength) {
					pData.fill(0, copied);
					return VFS.SQLITE_IOERR_SHORT_READ;
				}
				return VFS.SQLITE_OK;
			} catch (error) {
				console.error("tsdb: VFS read failed", error);
				return VFS.SQLITE_IOERR;
			}
		});
	}

	// @ts-expect-error upstream .d.ts declares pData as {size, value} but the
	// runtime glue passes a plain Uint8Array (see dist/wa-sqlite-async.mjs).
	xWrite(fileId: number, pData: Uint8Array, iOffset: number): number {
		return this.handleAsync(async () => {
			const file = this.openFiles.get(fileId);
			if (!file) return VFS.SQLITE_IOERR;
			try {
				let written = 0;
				let position = iOffset;
				const end = iOffset + pData.byteLength;
				while (position < end) {
					const chunkIndex = Math.floor(position / CHUNK_SIZE);
					const chunkOffset = position % CHUNK_SIZE;
					const take = Math.min(CHUNK_SIZE - chunkOffset, end - position);
					const chunk = await this.loadChunk(file, chunkIndex);
					chunk.set(pData.subarray(written, written + take), chunkOffset);
					file.dirty.add(chunkIndex);
					written += take;
					position += take;
				}
				if (end > file.size) {
					file.size = end;
					file.metaDirty = true;
				}
				return VFS.SQLITE_OK;
			} catch (error) {
				console.error("tsdb: VFS write failed", error);
				return VFS.SQLITE_IOERR;
			}
		});
	}

	xTruncate(fileId: number, iSize: number): number {
		return this.handleAsync(async () => {
			const file = this.openFiles.get(fileId);
			if (!file) return VFS.SQLITE_IOERR;
			if (iSize >= file.size) return VFS.SQLITE_OK;
			try {
				const oldChunkCount = Math.ceil(file.size / CHUNK_SIZE);
				const newChunkCount = Math.ceil(iSize / CHUNK_SIZE);
				for (let i = newChunkCount; i < oldChunkCount; i++) {
					file.chunks.delete(i);
					file.dirty.delete(i);
					const path = this.chunkPath(file.name, i);
					if (await this.adapter.exists(path)) await this.adapter.remove(path);
				}
				file.size = iSize;
				file.metaDirty = true;
				return VFS.SQLITE_OK;
			} catch (error) {
				console.error("tsdb: VFS truncate failed", error);
				return VFS.SQLITE_IOERR;
			}
		});
	}

	xSync(fileId: number, _flags: number): number {
		return this.handleAsync(async () => {
			const file = this.openFiles.get(fileId);
			if (!file) return VFS.SQLITE_IOERR;
			try {
				await this.flushFile(file);
				return VFS.SQLITE_OK;
			} catch (error) {
				console.error("tsdb: VFS sync failed", error);
				return VFS.SQLITE_IOERR;
			}
		});
	}

	xFileSize(fileId: number, pSize64: DataView): number {
		const file = this.openFiles.get(fileId);
		if (!file) return VFS.SQLITE_IOERR;
		pSize64.setBigInt64(0, BigInt(file.size), true);
		return VFS.SQLITE_OK;
	}

	xDelete(name: string, _syncDir: number): number {
		return this.handleAsync(async () => {
			try {
				await this.deleteStoredFile(name);
				return VFS.SQLITE_OK;
			} catch (error) {
				console.error("tsdb: VFS delete failed", error);
				return VFS.SQLITE_IOERR;
			}
		});
	}

	xAccess(name: string, _flags: number, pResOut: DataView): number {
		return this.handleAsync(async () => {
			await this.ensureDir();
			const exists = await this.adapter.exists(this.metaPath(name));
			pResOut.setInt32(0, exists ? 1 : 0, true);
			return VFS.SQLITE_OK;
		});
	}

	xSectorSize(_fileId: number): number {
		return 4096;
	}
}

/**
 * One-time migration: an old sql.js whole-file snapshot is already a valid
 * SQLite database image, so becoming the new engine's database is just a
 * matter of re-chunking its bytes into the VFS layout.
 */
export async function migrateLegacySnapshot(
	adapter: ChunkAdapter,
	legacyPath: string,
	directory: string,
	dbName: string
): Promise<boolean> {
	if (!(await adapter.exists(legacyPath))) return false;
	const metaPath = `${directory}/${sanitizeName(dbName)}.meta`;
	if (await adapter.exists(metaPath)) return false; // already migrated

	const bytes = new Uint8Array(await adapter.readBinary(legacyPath));
	if (!(await adapter.exists(directory))) {
		await adapter.mkdir(directory);
	}
	const chunkCount = Math.ceil(bytes.length / CHUNK_SIZE);
	for (let i = 0; i < chunkCount; i++) {
		const chunk = new Uint8Array(CHUNK_SIZE);
		chunk.set(bytes.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, bytes.length)));
		await adapter.writeBinary(
			`${directory}/${sanitizeName(dbName)}.c${i}`,
			chunk.buffer
		);
	}
	await adapter.write(metaPath, JSON.stringify({ size: bytes.length }));
	await adapter.remove(legacyPath);
	return true;
}
