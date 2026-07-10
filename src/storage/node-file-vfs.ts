import * as VFS from "wa-sqlite/src/VFS.js";
import type {
	ErrnoError,
	NodeFileHandle,
	NodeFsModule,
	NodePathModule,
} from "../types/runtime";
import { ChunkAdapter } from "./chunk-vfs";

interface OpenFile {
	name: string;
	path: string;
	flags: number;
	handle: NodeFileHandle;
}

interface NodeFileModules {
	fs: NodeFsModule;
	path: NodePathModule;
}

let cachedModules: NodeFileModules | null = null;

function loadNodeFileModules(): NodeFileModules {
	if (cachedModules) return cachedModules;
	const nodeRequire = require;
	cachedModules = {
		fs: nodeRequire("fs") as NodeFsModule,
		path: nodeRequire("path") as NodePathModule,
	};
	return cachedModules;
}

function sanitizeName(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

function isMissingFile(error: unknown): boolean {
	return (error as ErrnoError | undefined)?.code === "ENOENT";
}

/**
 * SQLite VFS backed by Node's random-access filesystem APIs. This is the
 * desktop backend: SQLite sees one normal database file, while mobile can
 * continue loading this module without touching Node until this class is used.
 */
export class NodeFileVFS extends VFS.Base {
	name: string;
	private directory: string;
	private openFiles = new Map<number, OpenFile>();
	private dirReady = false;
	private modules: NodeFileModules | null = null;

	constructor(vfsName: string, directory: string) {
		super();
		this.name = vfsName;
		this.directory = directory;
	}

	private get fs(): NodeFsModule {
		this.modules ??= loadNodeFileModules();
		return this.modules.fs;
	}

	private get path(): NodePathModule {
		this.modules ??= loadNodeFileModules();
		return this.modules.path;
	}

	private async ensureDir(): Promise<void> {
		if (this.dirReady) return;
		await this.fs.promises.mkdir(this.directory, { recursive: true });
		this.dirReady = true;
	}

	private filePath(name: string): string {
		return this.path.join(this.directory, sanitizeName(name));
	}

	private openFlags(flags: number): number {
		const constants = this.fs.constants;
		let result =
			flags & VFS.SQLITE_OPEN_READWRITE
				? constants.O_RDWR
				: constants.O_RDONLY;
		if (flags & VFS.SQLITE_OPEN_CREATE) result |= constants.O_CREAT;
		if (flags & VFS.SQLITE_OPEN_EXCLUSIVE) result |= constants.O_EXCL;
		return result;
	}

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
			const path = this.filePath(fileName);
			try {
				const handle = await this.fs.promises.open(
					path,
					this.openFlags(flags),
					0o600
				);
				this.openFiles.set(fileId, {
					name: fileName,
					path,
					flags,
					handle,
				});
				pOutFlags.setInt32(0, flags, true);
				return VFS.SQLITE_OK;
			} catch (error) {
				if (isMissingFile(error)) return VFS.SQLITE_CANTOPEN;
				console.error("tsdb: Node VFS open failed", error);
				return VFS.SQLITE_CANTOPEN;
			}
		});
	}

	xClose(fileId: number): number {
		return this.handleAsync(async () => {
			const file = this.openFiles.get(fileId);
			this.openFiles.delete(fileId);
			if (!file) return VFS.SQLITE_OK;
			try {
				await file.handle.close();
				if (file.flags & VFS.SQLITE_OPEN_DELETEONCLOSE) {
					await this.deletePath(file.path);
				}
				return VFS.SQLITE_OK;
			} catch (error) {
				console.error("tsdb: Node VFS close failed", error);
				return VFS.SQLITE_IOERR_CLOSE;
			}
		});
	}

	// @ts-expect-error upstream .d.ts declares pData as {size, value} but the
	// runtime glue passes a plain Uint8Array (see dist/wa-sqlite-async.mjs).
	xRead(fileId: number, pData: Uint8Array, iOffset: number): number {
		return this.handleAsync(async () => {
			const file = this.openFiles.get(fileId);
			if (!file) return VFS.SQLITE_IOERR_READ;
			try {
				const { bytesRead } = await file.handle.read(
					pData,
					0,
					pData.byteLength,
					iOffset
				);
				if (bytesRead < pData.byteLength) {
					pData.fill(0, bytesRead);
					return VFS.SQLITE_IOERR_SHORT_READ;
				}
				return VFS.SQLITE_OK;
			} catch (error) {
				console.error("tsdb: Node VFS read failed", error);
				return VFS.SQLITE_IOERR_READ;
			}
		});
	}

	// @ts-expect-error upstream .d.ts declares pData as {size, value} but the
	// runtime glue passes a plain Uint8Array (see dist/wa-sqlite-async.mjs).
	xWrite(fileId: number, pData: Uint8Array, iOffset: number): number {
		return this.handleAsync(async () => {
			const file = this.openFiles.get(fileId);
			if (!file) return VFS.SQLITE_IOERR_WRITE;
			try {
				let written = 0;
				while (written < pData.byteLength) {
					const { bytesWritten } = await file.handle.write(
						pData,
						written,
						pData.byteLength - written,
						iOffset + written
					);
					if (bytesWritten <= 0) return VFS.SQLITE_IOERR_WRITE;
					written += bytesWritten;
				}
				return VFS.SQLITE_OK;
			} catch (error) {
				console.error("tsdb: Node VFS write failed", error);
				return VFS.SQLITE_IOERR_WRITE;
			}
		});
	}

	xTruncate(fileId: number, iSize: number): number {
		return this.handleAsync(async () => {
			const file = this.openFiles.get(fileId);
			if (!file) return VFS.SQLITE_IOERR_TRUNCATE;
			try {
				await file.handle.truncate(iSize);
				return VFS.SQLITE_OK;
			} catch (error) {
				console.error("tsdb: Node VFS truncate failed", error);
				return VFS.SQLITE_IOERR_TRUNCATE;
			}
		});
	}

	xSync(fileId: number, _flags: number): number {
		return this.handleAsync(async () => {
			const file = this.openFiles.get(fileId);
			if (!file) return VFS.SQLITE_IOERR_FSYNC;
			try {
				await file.handle.sync();
				return VFS.SQLITE_OK;
			} catch (error) {
				console.error("tsdb: Node VFS sync failed", error);
				return VFS.SQLITE_IOERR_FSYNC;
			}
		});
	}

	xFileSize(fileId: number, pSize64: DataView): number {
		return this.handleAsync(async () => {
			const file = this.openFiles.get(fileId);
			if (!file) return VFS.SQLITE_IOERR_FSTAT;
			try {
				const stats = await file.handle.stat();
				pSize64.setBigInt64(0, BigInt(stats.size), true);
				return VFS.SQLITE_OK;
			} catch (error) {
				console.error("tsdb: Node VFS stat failed", error);
				return VFS.SQLITE_IOERR_FSTAT;
			}
		});
	}

	xDelete(name: string, _syncDir: number): number {
		return this.handleAsync(async () => {
			try {
				await this.deletePath(this.filePath(name));
				return VFS.SQLITE_OK;
			} catch (error) {
				console.error("tsdb: Node VFS delete failed", error);
				return VFS.SQLITE_IOERR_DELETE;
			}
		});
	}

	xAccess(name: string, _flags: number, pResOut: DataView): number {
		return this.handleAsync(async () => {
			await this.ensureDir();
			try {
				await this.fs.promises.stat(this.filePath(name));
				pResOut.setInt32(0, 1, true);
			} catch (error) {
				if (!isMissingFile(error)) {
					console.error("tsdb: Node VFS access failed", error);
					return VFS.SQLITE_IOERR_ACCESS;
				}
				pResOut.setInt32(0, 0, true);
			}
			return VFS.SQLITE_OK;
		});
	}

	xSectorSize(_fileId: number): number {
		return 4096;
	}

	xDeviceCharacteristics(_fileId: number): number {
		return VFS.SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN;
	}

	private async deletePath(path: string): Promise<void> {
		try {
			await this.fs.promises.unlink(path);
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}
}

export function nodeFileBackendAvailable(): boolean {
	try {
		loadNodeFileModules();
		return true;
	} catch {
		return false;
	}
}

export function joinNodePath(...parts: string[]): string {
	return loadNodeFileModules().path.join(...parts);
}

export function nodeStorageDirectoryForAdapter(
	adapter: { getBasePath?: () => string },
	pluginDir: string,
	deps: {
		nodeFileBackendAvailable?: () => boolean;
		joinNodePath?: (...parts: string[]) => string;
	} = {}
): string | null {
	if (typeof adapter.getBasePath !== "function") return null;
	const isAvailable = deps.nodeFileBackendAvailable ?? nodeFileBackendAvailable;
	if (!isAvailable()) return null;
	const basePath = adapter.getBasePath();
	if (!basePath) return null;
	const joinPath = deps.joinNodePath ?? joinNodePath;
	return joinPath(basePath, pluginDir);
}

export async function nodeFileExists(
	directory: string,
	dbName: string
): Promise<boolean> {
	return (await nodeFileSize(directory, dbName)) !== null;
}

export async function nodeFileSize(
	directory: string,
	dbName: string
): Promise<number | null> {
	const { fs, path } = loadNodeFileModules();
	try {
		const stats = await fs.promises.stat(
			path.join(directory, sanitizeName(dbName))
		);
		return stats.size;
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
}

export async function writeNodeFileDatabase(
	directory: string,
	dbName: string,
	bytes: Uint8Array
): Promise<void> {
	const { fs, path } = loadNodeFileModules();
	await fs.promises.mkdir(directory, { recursive: true });
	await fs.promises.writeFile(path.join(directory, sanitizeName(dbName)), bytes);
}

export async function readNodeFileDatabase(
	directory: string,
	dbName: string
): Promise<Uint8Array | null> {
	const { fs, path } = loadNodeFileModules();
	try {
		return new Uint8Array(
			await fs.promises.readFile(path.join(directory, sanitizeName(dbName)))
		);
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
}

export async function deleteNodeDatabaseFiles(
	directory: string,
	dbName: string
): Promise<void> {
	const { fs, path } = loadNodeFileModules();
	for (const name of [dbName, `${dbName}-journal`, `${dbName}-wal`, `${dbName}-shm`]) {
		try {
			await fs.promises.unlink(path.join(directory, sanitizeName(name)));
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}
}

export async function migrateLegacySnapshotToNodeFile(
	adapter: ChunkAdapter,
	legacyPath: string,
	directory: string,
	dbName: string
): Promise<boolean> {
	if (await nodeFileExists(directory, dbName)) return false;
	if (!(await adapter.exists(legacyPath))) return false;
	const bytes = new Uint8Array(await adapter.readBinary(legacyPath));
	await writeNodeFileDatabase(directory, dbName, bytes);
	await adapter.remove(legacyPath);
	return true;
}
