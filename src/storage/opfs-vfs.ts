import { AccessHandlePoolVFS } from "wa-sqlite/src/examples/AccessHandlePoolVFS.js";

export const OPFS_VFS_NAME = "AccessHandlePool";

interface OpfsStorageManager {
	getDirectory(): Promise<OpfsDirectoryHandle>;
}

interface OpfsNavigator {
	storage?: OpfsStorageManager;
}

interface OpfsDirectoryHandle {
	getDirectoryHandle(
		name: string,
		options?: { create?: boolean }
	): Promise<OpfsDirectoryHandle>;
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export function createOpfsVfs(dbName: string): AccessHandlePoolVFS {
	return new AccessHandlePoolVFS(opfsPoolDirectory(dbName));
}

export async function deleteOpfsDatabaseFiles(dbName: string): Promise<void> {
	await deleteOpfsPath(opfsPoolDirectory(dbName), true);
	for (const name of [
		dbName,
		`${dbName}-journal`,
		`${dbName}-wal`,
		`${dbName}-shm`,
	]) {
		await deleteOpfsFile(name);
	}
}

async function deleteOpfsFile(path: string): Promise<void> {
	await deleteOpfsPath(path, false);
}

async function deleteOpfsPath(path: string, recursive: boolean): Promise<void> {
	try {
		const [directory, fileName] = await opfsPathComponents(path, false);
		await directory.removeEntry(fileName, { recursive });
	} catch {
		// Missing OPFS files are already deleted.
	}
}

function opfsPoolDirectory(dbName: string): string {
	return `${dbName}.opfs-pool`;
}

async function opfsPathComponents(
	path: string,
	create: boolean
): Promise<[OpfsDirectoryHandle, string]> {
	const storage = (navigator as unknown as OpfsNavigator).storage;
	if (!storage) throw new Error("tsdb: OPFS storage manager is unavailable");
	let directory = await storage.getDirectory();
	const parts = path.split("/").filter(Boolean);
	const fileName = parts.pop();
	if (!fileName) throw new Error("tsdb: OPFS database name is empty");
	for (const part of parts) {
		directory = await directory.getDirectoryHandle(part, { create });
	}
	return [directory, fileName];
}
