import {
	Component,
	ItemView,
	MarkdownRenderer,
	Notice,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import type ObsidianMetricsPlugin from "../main";

export const METRICS_DASHBOARD_VIEW_TYPE = "tsdb-dashboard";
export const DASHBOARD_FILENAME = "dashboard.md";
const USER_DASHBOARD_FILENAME = "TSDB Dashboard.md";

/**
 * The trailhead: a working markdown dashboard that demonstrates panels and
 * points at the next steps (HTTP API, scraping) without requiring vault files.
 */
const DEMO_DASHBOARD_CONTENT = `# Vault metrics

This is a live dashboard. Every \`promql\` code block below renders from
the metrics this vault records about itself — give it a minute or two after
install to collect its first data.

## At a glance

\`\`\`promql
query: obsidian_vault_notes_total
type: stat
title: Notes
refresh: 60s
\`\`\`

\`\`\`promql
query: obsidian_vault_files_total
type: stat
title: Files
refresh: 60s
\`\`\`

\`\`\`promql
query: obsidian_vault_size_bytes
type: stat
title: Vault size
unit: bytes
refresh: 300s
\`\`\`

## Activity

\`\`\`promql
query: sum by (operation) (rate(obsidian_file_operations_total[5m]))
title: File operations per second
legend: "{{operation}}"
range: 3h
refresh: 30s
\`\`\`

\`\`\`promql
query: obsidian_browser_memory_usage_bytes
title: Memory usage
unit: bytes
range: 6h
refresh: 60s
\`\`\`

## Make it yours

Panels also work in **any note** — add a \`promql\` code block with a query:

\`\`\`\`
\`\`\`promql
query: rate(obsidian_file_operations_total[5m])
title: My panel
range: 1h
refresh: 30s
\`\`\`
\`\`\`\`

Options: \`type\` (timeseries / stat / table), \`range\`, \`step\`, \`refresh\`,
\`unit\`, \`legend\` (template like \`{{operation}}\`), \`min\`/\`max\`, \`height\`,
and multiple \`queries\`.

## Going further

- **Grafana or curl**: turn on *Serve metrics over HTTP* in the plugin
  settings, then point a Prometheus datasource at the shown URL.
- **Other machines/apps**: add scrape targets in settings to collect any
  Prometheus endpoint (e.g. node_exporter) into this vault's database.
- **Your own plugin's metrics**: \`app.plugins.plugins['tsdb']
  .api.getStore('my-plugin', { intervalSeconds: 1 })\`.
`;

export function dashboardPath(plugin: ObsidianMetricsPlugin): string {
	return `${plugin.manifest.dir}/${DASHBOARD_FILENAME}`;
}

async function ensurePluginDashboard(
	plugin: ObsidianMetricsPlugin
): Promise<string> {
	const path = dashboardPath(plugin);
	const adapter = plugin.app.vault.adapter;
	if (!(await adapter.exists(path))) {
		await adapter.write(path, DEMO_DASHBOARD_CONTENT);
	}
	return path;
}

async function uniqueVaultDashboardPath(
	plugin: ObsidianMetricsPlugin
): Promise<string> {
	const adapter = plugin.app.vault.adapter;
	if (!(await adapter.exists(USER_DASHBOARD_FILENAME))) {
		return USER_DASHBOARD_FILENAME;
	}
	for (let i = 2; i < 1000; i++) {
		const path = `TSDB Dashboard ${i}.md`;
		if (!(await adapter.exists(path))) return path;
	}
	throw new Error("Could not choose a dashboard filename");
}

export async function copyDashboardToVault(
	plugin: ObsidianMetricsPlugin
): Promise<void> {
	const existing = plugin.app.vault.getAbstractFileByPath(
		USER_DASHBOARD_FILENAME
	);
	if (existing instanceof TFile) {
		await plugin.app.workspace.getLeaf(true).openFile(existing, {
			active: true,
		});
		return;
	}

	const sourcePath = await ensurePluginDashboard(plugin);
	const markdown = await plugin.app.vault.adapter.read(sourcePath);
	const path = await uniqueVaultDashboardPath(plugin);
	const file = await plugin.app.vault.create(path, markdown);
	new Notice(`Created ${path}`);
	await plugin.app.workspace.getLeaf(true).openFile(file, { active: true });
}

export class MetricsDashboardView extends ItemView {
	private plugin: ObsidianMetricsPlugin;
	private openId = 0;
	private renderScope: Component | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: ObsidianMetricsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return METRICS_DASHBOARD_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Metrics dashboard";
	}

	getIcon(): string {
		return "bar-chart-2";
	}

	private clearRenderScope(): void {
		if (this.renderScope) {
			this.removeChild(this.renderScope);
			this.renderScope = null;
		}
	}

	async onOpen(): Promise<void> {
		const openId = ++this.openId;
		const container = this.contentEl;
		this.clearRenderScope();
		container.empty();
		container.addClass("omx-dashboard-view");

		const toolbar = container.createDiv({ cls: "omx-dashboard-toolbar" });
		toolbar
			.createEl("button", { text: "Edit in my vault" })
			.onClickEvent(() => void copyDashboardToVault(this.plugin));
		const body = container.createDiv({ cls: "omx-dashboard-body" });

		try {
			const path = await ensurePluginDashboard(this.plugin);
			const markdown = await this.app.vault.adapter.read(path);
			if (openId !== this.openId || !container.isConnected) return;
			const renderScope = this.addChild(new Component());
			this.renderScope = renderScope;
			await MarkdownRenderer.render(this.app, markdown, body, path, renderScope);
			if (openId !== this.openId || !container.isConnected) {
				if (this.renderScope === renderScope) {
					this.clearRenderScope();
				} else {
					this.removeChild(renderScope);
				}
			}
		} catch (error: any) {
			if (openId !== this.openId || !container.isConnected) return;
			container.createDiv({
				cls: "omx-panel-error",
				text: `Could not load metrics dashboard: ${error?.message ?? error}`,
			});
		}
	}

	async onClose(): Promise<void> {
		this.openId++;
		this.clearRenderScope();
		this.contentEl.empty();
	}
}

export async function openMetricsDashboard(
	plugin: ObsidianMetricsPlugin
): Promise<void> {
	await ensurePluginDashboard(plugin);
	const existing = plugin.app.workspace.getLeavesOfType(
		METRICS_DASHBOARD_VIEW_TYPE
	);
	if (existing.length > 0) {
		plugin.app.workspace.revealLeaf(existing[0]);
		return;
	}
	const leaf = plugin.app.workspace.getLeaf(true);
	await leaf.setViewState({ type: METRICS_DASHBOARD_VIEW_TYPE, active: true });
	plugin.app.workspace.revealLeaf(leaf);
}
