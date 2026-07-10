declare module "wa-sqlite/src/examples/OriginPrivateFileSystemVFS.js" {
	export class OriginPrivateFileSystemVFS {
		readonly name: string;
		close(): Promise<void>;
	}
}

declare module "wa-sqlite/src/examples/AccessHandlePoolVFS.js" {
	export class AccessHandlePoolVFS {
		readonly name: string;
		readonly isReady: Promise<void>;
		constructor(directoryPath: string);
		close(): Promise<void>;
	}
}
