import { App, Modal, Notice } from "obsidian";
import type ObsidianMetricsPlugin from "../main";

export class MetricsModal extends Modal {
	private plugin: ObsidianMetricsPlugin;
	private renderId = 0;

	constructor(app: App, plugin: ObsidianMetricsPlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen() {
		const { contentEl } = this;
		const renderId = ++this.renderId;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Current metrics" });

		const statsLine = contentEl.createEl("p");
		try {
			const stats = await this.plugin.getTsdbStats();
			if (renderId !== this.renderId || !contentEl.isConnected) return;
			if (stats) {
				const oldest = stats.oldestSampleMs
					? new Date(stats.oldestSampleMs).toLocaleString()
					: "n/a";
				const samples =
					stats.sampleCount === null
						? "sample count pending"
						: `${stats.sampleCount} samples`;
				statsLine.textContent =
					`Stored: ${stats.seriesCount} series, ${samples} ` +
					`(oldest: ${oldest})`;
			} else {
				statsLine.textContent = "Local metrics database not running.";
			}
		} catch (error) {
			if (renderId !== this.renderId || !contentEl.isConnected) return;
			statsLine.textContent =
				"Stats unavailable: " +
				(error instanceof Error ? error.message : String(error));
		}

		const metricsContainer = contentEl.createDiv();
		metricsContainer.addClass("metrics-display");

		try {
			const metricsText = await this.plugin.getExposition();
			if (renderId !== this.renderId || !contentEl.isConnected) return;
			if (metricsText) {
				const preEl = metricsContainer.createEl("pre");
				preEl.addClass("tsdb-pre");
				preEl.textContent = metricsText;
			} else {
				metricsContainer.createEl("p", { text: "No metrics available" });
			}
		} catch (error) {
			if (renderId !== this.renderId || !contentEl.isConnected) return;
			metricsContainer.createEl("p", {
				text:
					"Error loading metrics: " +
					(error instanceof Error ? error.message : String(error)),
			});
		}

		const buttonContainer = contentEl.createDiv();
		buttonContainer.addClass("tsdb-buttons");

		const refreshButton = buttonContainer.createEl("button", {
			text: "Refresh",
		});
		refreshButton.onclick = () => {
			void this.onOpen();
		};

		const clearButton = buttonContainer.createEl("button", {
			text: "Clear custom metrics",
		});
		clearButton.onclick = () => {
			this.plugin.clearAllMetrics();
			new Notice("Custom metrics cleared");
			void this.onOpen();
		};
	}

	onClose() {
		this.renderId++;
		this.contentEl.empty();
	}
}
