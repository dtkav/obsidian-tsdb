import {
	migrateLegacySnapshot,
	readChunkedDatabaseImage,
	readChunkedDatabaseImageSize,
} from "./chunk-vfs";
import type { ChunkAdapter } from "./chunk-vfs";
import {
	migrateLegacySnapshotToNodeFile,
	nodeFileExists,
	nodeFileSize,
	nodeStorageDirectoryForAdapter,
	writeNodeFileDatabase,
} from "./node-file-vfs";
import { probeOpfsWorker } from "./opfs-probe";
import type { OpfsWorkerProbeResult } from "./opfs-probe";
import {
	DEFAULT_CHUNK_DB_NAME,
	DEFAULT_NODE_DB_NAME,
	MetricsStore,
} from "./store";
import type { OpenOptions, StoreLocation } from "./store";

export const LEGACY_DB_FILENAME = "metrics.db";
export const TSDB_DIRNAME = "metrics-tsdb";

export type StorageBackendKind = "node-file" | "chunks";
export type WorkerStorageBackendKind = "worker-opfs";

export interface StoreOpenPlan {
	backend: StorageBackendKind;
	dbName: string;
	location: StoreLocation;
}

export interface LegacyStorageMigrationSource {
	backend: StorageBackendKind;
	label: string;
	dbName: string;
	location: StoreLocation;
	sizeBytes: number;
}

export interface WorkerOpfsOpenPlan {
	backend: WorkerStorageBackendKind;
	dbName: string;
}

export interface StoreOpenPlanOptions {
	adapter: ChunkAdapter & { getBasePath?: () => string };
	pluginDir: string;
	wasmBinary?: OpenOptions["wasmBinary"];
	logger?: Pick<Console, "log" | "warn">;
}

export interface WorkerOpfsOpenPlanOptions {
	adapter: ChunkAdapter & { getBasePath?: () => string };
	pluginDir: string;
	namespace?: string;
	probe?: () => Promise<OpfsWorkerProbeResult>;
	onProbeFailure?: (error: string) => void;
	logger?: Pick<Console, "warn">;
}

export async function prepareWorkerOpfsOpenPlan(
	options: WorkerOpfsOpenPlanOptions
): Promise<WorkerOpfsOpenPlan | null> {
	const probe = options.probe ?? probeOpfsWorker;
	const probeResult = await probe();
	if (!probeResult.ok) {
		const error = probeResult.error ?? "unknown OPFS worker probe error";
		options.onProbeFailure?.(error);
		options.logger?.warn(
			"tsdb: OPFS worker backend unavailable",
			error
		);
		return null;
	}

	return {
		backend: "worker-opfs",
		dbName: workerOpfsDbName(options.pluginDir, options.namespace),
	};
}

export async function prepareStoreOpenPlan(
	options: StoreOpenPlanOptions
): Promise<StoreOpenPlan> {
	const logger = options.logger ?? console;
	const tsdbDir = `${options.pluginDir}/${TSDB_DIRNAME}`;
	const chunkLocation: StoreLocation = {
		kind: "chunks",
		adapter: options.adapter,
		directory: tsdbDir,
	};

	const nodeDirectory = nodeStorageDirectoryForAdapter(
		options.adapter,
		options.pluginDir
	);
	if (nodeDirectory) {
		try {
			await prepareNodeFileDatabase({
				adapter: options.adapter,
				chunkDirectory: tsdbDir,
				nodeDirectory,
				pluginDir: options.pluginDir,
				wasmBinary: options.wasmBinary,
				logger,
			});
			return {
				backend: "node-file",
				dbName: DEFAULT_NODE_DB_NAME,
				location: {
					kind: "node-file",
					directory: nodeDirectory,
				},
			};
		} catch (error) {
			logger.warn(
				"tsdb: desktop sqlite backend unavailable, falling back to chunks",
				error
			);
		}
	}

	await migrateLegacySnapshotToChunks({
		adapter: options.adapter,
		chunkDirectory: tsdbDir,
		pluginDir: options.pluginDir,
		logger,
	});
	return {
		backend: "chunks",
		dbName: DEFAULT_CHUNK_DB_NAME,
		location: chunkLocation,
	};
}

export async function findLegacyStorageMigrationSource(
	options: Pick<StoreOpenPlanOptions, "adapter" | "pluginDir">
): Promise<LegacyStorageMigrationSource | null> {
	const tsdbDir = `${options.pluginDir}/${TSDB_DIRNAME}`;
	const nodeDirectory = nodeStorageDirectoryForAdapter(
		options.adapter,
		options.pluginDir
	);
	if (nodeDirectory) {
		const size = await nodeFileSize(nodeDirectory, DEFAULT_NODE_DB_NAME);
		if (size !== null && size > 0) {
			return {
				backend: "node-file",
				label: "desktop SQLite",
				dbName: DEFAULT_NODE_DB_NAME,
				location: { kind: "node-file", directory: nodeDirectory },
				sizeBytes: size,
			};
		}
	}

	const chunkSize = await readChunkedDatabaseImageSize(
		options.adapter,
		tsdbDir,
		DEFAULT_CHUNK_DB_NAME
	);
	if (chunkSize !== null && chunkSize > 0) {
		return {
			backend: "chunks",
			label: "vault chunks",
			dbName: DEFAULT_CHUNK_DB_NAME,
			location: {
				kind: "chunks",
				adapter: options.adapter,
				directory: tsdbDir,
			},
			sizeBytes: chunkSize,
		};
	}

	return null;
}

export async function prepareNodeFileDatabase(options: {
	adapter: ChunkAdapter;
	chunkDirectory: string;
	nodeDirectory: string;
	pluginDir: string;
	wasmBinary?: OpenOptions["wasmBinary"];
	logger?: Pick<Console, "log">;
}): Promise<void> {
	const logger = options.logger ?? console;
	if (await nodeFileExists(options.nodeDirectory, DEFAULT_NODE_DB_NAME)) return;

	const legacyPath = `${options.pluginDir}/${LEGACY_DB_FILENAME}`;
	const migratedLegacy = await migrateLegacySnapshotToNodeFile(
		options.adapter,
		legacyPath,
		options.nodeDirectory,
		DEFAULT_NODE_DB_NAME
	);
	if (migratedLegacy) {
		logger.log("tsdb: migrated legacy metrics.db snapshot to metrics.sqlite");
		return;
	}

	const existingChunkImage = await readChunkedDatabaseImage(
		options.adapter,
		options.chunkDirectory,
		DEFAULT_CHUNK_DB_NAME
	);
	if (!existingChunkImage || existingChunkImage.byteLength === 0) return;

	const chunkStore = await MetricsStore.open({
		location: {
			kind: "chunks",
			adapter: options.adapter,
			directory: options.chunkDirectory,
		},
		dbName: DEFAULT_CHUNK_DB_NAME,
		wasmBinary: options.wasmBinary,
	});
	await chunkStore.close();

	const chunkImage = await readChunkedDatabaseImage(
		options.adapter,
		options.chunkDirectory,
		DEFAULT_CHUNK_DB_NAME
	);
	if (chunkImage && chunkImage.byteLength > 0) {
		await writeNodeFileDatabase(
			options.nodeDirectory,
			DEFAULT_NODE_DB_NAME,
			chunkImage
		);
		logger.log("tsdb: seeded metrics.sqlite from chunked database");
	}
}

function workerOpfsDbName(pluginDir: string, namespace?: string): string {
	const pluginName =
		pluginDir
			.split("/")
			.filter((part) => part.length > 0)
			.pop() ?? "tsdb";
	const suffix = namespace ? `-${hashNamespace(namespace)}` : "";
	return `${sanitizeOpfsSegment(pluginName)}${suffix}/${DEFAULT_NODE_DB_NAME}`;
}

function sanitizeOpfsSegment(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "_");
	return sanitized.length > 0 ? sanitized : "tsdb";
}

function hashNamespace(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

async function migrateLegacySnapshotToChunks(options: {
	adapter: ChunkAdapter;
	chunkDirectory: string;
	pluginDir: string;
	logger: Pick<Console, "log" | "warn">;
}): Promise<void> {
	try {
		const migrated = await migrateLegacySnapshot(
			options.adapter,
			`${options.pluginDir}/${LEGACY_DB_FILENAME}`,
			options.chunkDirectory,
			DEFAULT_CHUNK_DB_NAME
		);
		if (migrated) {
			options.logger.log("tsdb: migrated legacy metrics.db snapshot");
		}
	} catch (error) {
		options.logger.warn("tsdb: legacy snapshot migration failed", error);
	}
}
