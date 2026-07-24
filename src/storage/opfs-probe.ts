export interface OpfsWorkerProbeResult {
	ok: boolean;
	error?: string;
}

export interface OpfsProbeWorkerLike {
	postMessage(message: { id: number }): void;
	addEventListener(
		type: "message",
		listener: (event: { data: OpfsWorkerProbeMessage }) => void
	): void;
	removeEventListener(
		type: "message",
		listener: (event: { data: OpfsWorkerProbeMessage }) => void
	): void;
	terminate(): void;
}

export type OpfsWorkerProbeMessage =
	| { id: number; ok: true }
	| { id: number; ok: false; error: string };

export const OPFS_WORKER_PROBE_TIMEOUT_MS = 5000;

export const OPFS_WORKER_PROBE_SOURCE = `
self.onmessage = async (event) => {
  const id = event.data && typeof event.data.id === "number" ? event.data.id : 0;
  try {
    const storage = self.navigator && self.navigator.storage;
    if (!storage || typeof storage.getDirectory !== "function") {
      throw new Error("navigator.storage.getDirectory is unavailable");
    }
    const root = await storage.getDirectory();
    const fileName = "tsdb-opfs-probe-" + Math.random().toString(36).slice(2);
    const file = await root.getFileHandle(fileName, { create: true });
    if (typeof file.createSyncAccessHandle !== "function") {
      throw new Error("FileSystemSyncAccessHandle is unavailable");
    }
    const handle = await file.createSyncAccessHandle();
    try {
      const bytes = new Uint8Array([116, 115, 100, 98]);
      const written = handle.write(bytes, { at: 0 });
      if (written !== bytes.byteLength) {
        throw new Error("OPFS sync access handle wrote a short block");
      }
      await handle.flush();
    } finally {
      await handle.close();
    }
    await root.removeEntry(fileName).catch(() => undefined);
    self.postMessage({ id, ok: true });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
`;

export async function probeOpfsWorker(options: {
	timeoutMs?: number;
	createWorker?: (source: string) => OpfsProbeWorkerLike;
} = {}): Promise<OpfsWorkerProbeResult> {
	const createWorker = options.createWorker ?? createProbeWorker;
	const timeoutMs = options.timeoutMs ?? OPFS_WORKER_PROBE_TIMEOUT_MS;
	let worker: OpfsProbeWorkerLike;
	try {
		worker = createWorker(OPFS_WORKER_PROBE_SOURCE);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	return await new Promise<OpfsWorkerProbeResult>((resolve) => {
		const id = 1;
		let settled = false;
		const finish = (result: OpfsWorkerProbeResult) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeout);
			worker.removeEventListener("message", onMessage);
			worker.terminate();
			resolve(result);
		};
		const onMessage = (event: { data: OpfsWorkerProbeMessage }) => {
			if (event.data.id !== id) return;
			if (event.data.ok) {
				finish({ ok: true });
			} else {
				finish({ ok: false, error: event.data.error });
			}
		};
		const timeout = window.setTimeout(() => {
			finish({ ok: false, error: "OPFS worker probe timed out" });
		}, timeoutMs);

		worker.addEventListener("message", onMessage);
		try {
			worker.postMessage({ id });
		} catch (error) {
			finish({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

function createProbeWorker(source: string): OpfsProbeWorkerLike {
	const url = URL.createObjectURL(
		new Blob([source], { type: "text/javascript" })
	);
	const worker = new Worker(url);
	let closed = false;
	return {
		postMessage(message) {
			worker.postMessage(message);
		},
		addEventListener(type, listener) {
			worker.addEventListener(type, listener);
		},
		removeEventListener(type, listener) {
			worker.removeEventListener(type, listener);
		},
		terminate() {
			if (closed) return;
			closed = true;
			worker.terminate();
			URL.revokeObjectURL(url);
		},
	};
}
