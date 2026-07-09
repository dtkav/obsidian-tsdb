import { Events, Plugin } from "obsidian";
import { ObsidianMetricsAPI } from "./metrics-api";

/**
 * Register built-in vault activity and size metrics. Listeners/intervals are
 * registered on the plugin so they are cleaned up on unload.
 */
export function setupVaultMetrics(
	plugin: Plugin,
	metricsAPI: ObsidianMetricsAPI
): void {
	const app = plugin.app;
	let disposed = false;
	let currentNoteTimer: (() => void) | null = null;

	plugin.register(() => {
		disposed = true;
		if (currentNoteTimer) {
			currentNoteTimer();
			currentNoteTimer = null;
		}
	});

	// Real file operations counter
	const fileOpsCounter = metricsAPI.createCounter({
		name: "file_operations_total",
		help: "Total number of file operations in Obsidian",
		labelNames: ["operation", "file_type"],
	});

	const extensionOf = (path: string) => path.split(".").pop() || "unknown";

	plugin.registerEvent(
		app.workspace.on("file-open", (file) => {
			if (disposed) return;
			if (file) {
				fileOpsCounter.inc(1, {
					operation: "open",
					file_type: extensionOf(file.path),
				});
			}
		})
	);

	const vaultOps: Array<"create" | "delete" | "modify" | "rename"> = [
		"create",
		"delete",
		"modify",
		"rename",
	];
	for (const operation of vaultOps) {
		plugin.registerEvent(
			(app.vault as Events).on(operation, (file: { path: string }) => {
				if (disposed) return;
				fileOpsCounter.inc(1, {
					operation,
					file_type: extensionOf(file.path),
				});
			})
		);
	}

	// Vault statistics gauges
	const totalFilesGauge = metricsAPI.createGauge({
		name: "vault_files_total",
		help: "Total number of files in the vault",
	});
	const totalNotesGauge = metricsAPI.createGauge({
		name: "vault_notes_total",
		help: "Total number of markdown notes in the vault",
	});
	const totalSizeGauge = metricsAPI.createGauge({
		name: "vault_size_bytes",
		help: "Total size of all files in the vault (bytes)",
	});
	const activeNotesGauge = metricsAPI.createGauge({
		name: "active_notes_count",
		help: "Number of currently open notes",
	});
	const pluginCountGauge = metricsAPI.createGauge({
		name: "plugins_enabled_total",
		help: "Number of enabled plugins",
	});

	const updateMetrics = async () => {
		if (disposed) return;
		try {
			const allFiles = app.vault.getAllLoadedFiles();
			const notes = allFiles.filter((file) => file.path.endsWith(".md"));
			if (disposed) return;
			totalFilesGauge.set(allFiles.length);
			totalNotesGauge.set(notes.length);

			let totalSize = 0;
			for (const file of allFiles) {
				if (disposed) return;
				try {
					const stat = await app.vault.adapter.stat(file.path);
					if (stat && stat.type === "file") {
						totalSize += stat.size || 0;
					}
				} catch {
					// File might not exist or be accessible; skip it.
				}
			}
			if (disposed) return;
			totalSizeGauge.set(totalSize);

			activeNotesGauge.set(app.workspace.getLeavesOfType("markdown").length);

			const enabledPlugins = (app as { plugins?: { enabledPlugins?: unknown } })
				.plugins?.enabledPlugins;
			pluginCountGauge.set(
				enabledPlugins instanceof Set
					? enabledPlugins.size
					: Object.keys((enabledPlugins as Record<string, unknown>) ?? {})
							.length
			);
		} catch (error) {
			console.warn("Error updating vault metrics:", error);
		}
	};

	void updateMetrics();
	plugin.registerInterval(window.setInterval(() => void updateMetrics(), 30000));

	// Note view time tracking
	const noteViewHistogram = metricsAPI.createHistogram({
		name: "note_view_duration_seconds",
		help: "Time spent viewing individual notes",
		buckets: [1, 5, 10, 30, 60, 300, 1800], // 1s to 30min
	});

	plugin.registerEvent(
		app.workspace.on("active-leaf-change", (leaf) => {
			if (disposed) return;
			if (currentNoteTimer) {
				currentNoteTimer();
				currentNoteTimer = null;
			}
			if (leaf && leaf.view.getViewType() === "markdown") {
				currentNoteTimer = noteViewHistogram.startTimer();
			}
		})
	);
}

/**
 * Register built-in performance metrics. Any monkey-patches are restored on
 * unload so the plugin instance and its registries can be collected.
 */
export function setupPerformanceMetrics(
	plugin: Plugin,
	metricsAPI: ObsidianMetricsAPI
): void {
	const app = plugin.app;
	let disposed = false;

	plugin.register(() => {
		disposed = true;
	});

	const memoryGauge = metricsAPI.createGauge({
		name: "browser_memory_usage_bytes",
		help: "Browser memory usage (if available)",
	});

	const updatePerformanceMetrics = () => {
		if (disposed) return;
		const perfMemory = (performance as { memory?: { usedJSHeapSize: number } })
			.memory;
		if (perfMemory) {
			memoryGauge.set(perfMemory.usedJSHeapSize);
		}
	};

	updatePerformanceMetrics();
	plugin.registerInterval(
		window.setInterval(updatePerformanceMetrics, 30000)
	);

	// App performance metrics
	const appPerformanceHistogram = metricsAPI.createHistogram({
		name: "app_performance_timing_seconds",
		help: "Various app performance timings",
		labelNames: ["operation"],
		buckets: [0.001, 0.01, 0.1, 0.5, 1, 2, 5],
	});

	const adapter = app.vault.adapter as typeof app.vault.adapter & {
		list?: (path: string) => Promise<unknown>;
	};
	const originalList = adapter.list;
	if (originalList) {
		let startTimer: ((labels: { operation: string }) => () => void) | null =
			(labels) => appPerformanceHistogram.startTimer(labels);
		const wrappedList = function (this: unknown, path: string) {
			const timer = startTimer?.({ operation: "vault_list" });
			const result = originalList.call(this, path);
			if (timer) result.then(() => timer()).catch(() => timer());
			return result;
		};
		adapter.list = wrappedList;
		plugin.register(() => {
			startTimer = null;
			if (adapter.list === wrappedList) {
				adapter.list = originalList;
			}
		});
	}
}
