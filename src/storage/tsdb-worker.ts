import { MetricsStore } from "./store";
import { WorkerStoreServer } from "./worker-server";
import type {
	WorkerStoreRequest,
	WorkerStoreResponse,
} from "./worker-protocol";

const workerScope = self as unknown as {
	postMessage(response: WorkerStoreResponse): void;
	addEventListener(
		type: "message",
		listener: (event: { data: WorkerStoreRequest }) => void
	): void;
	removeEventListener(
		type: "message",
		listener: (event: { data: WorkerStoreRequest }) => void
	): void;
};

new WorkerStoreServer(
	{
		post(response) {
			workerScope.postMessage(response);
		},
		onMessage(listener) {
			const handler = (event: { data: WorkerStoreRequest }) => {
				listener(event.data);
			};
			workerScope.addEventListener("message", handler);
			return () => workerScope.removeEventListener("message", handler);
		},
	},
	async (request) => {
		return await MetricsStore.open({
			location: { kind: "opfs" },
			dbName: request.dbName,
			wasmBinary: request.wasmBinary,
		});
	}
);
