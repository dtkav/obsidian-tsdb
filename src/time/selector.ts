import { MarkdownView, setIcon } from "obsidian";
import type ObsidianMetricsPlugin from "../main";
import { METRICS_DASHBOARD_VIEW_TYPE } from "../ui/demo-dashboard";
import {
	TimeContext,
	TimeState,
	durationLabel,
	parseDurationValue,
	parseTimeValue,
	resolveTimeRange,
} from "./context";
import { parseTimeOverrides } from "./frontmatter";

const PROMQL_FENCE_RE = /(?:^|\n)```[ \t]*promql(?:[ \t\r\n]|$)/i;

const PRESETS: Array<{ label: string; shortLabel: string; ms: number }> = [
	{ label: "Last 5 minutes", shortLabel: "5m", ms: 5 * 60 * 1000 },
	{ label: "Last 15 minutes", shortLabel: "15m", ms: 15 * 60 * 1000 },
	{ label: "Last 30 minutes", shortLabel: "30m", ms: 30 * 60 * 1000 },
	{ label: "Last 1 hour", shortLabel: "1h", ms: 60 * 60 * 1000 },
	{ label: "Last 3 hours", shortLabel: "3h", ms: 3 * 60 * 60 * 1000 },
	{ label: "Last 6 hours", shortLabel: "6h", ms: 6 * 60 * 60 * 1000 },
	{ label: "Last 12 hours", shortLabel: "12h", ms: 12 * 60 * 60 * 1000 },
	{ label: "Last 24 hours", shortLabel: "24h", ms: 24 * 60 * 60 * 1000 },
	{ label: "Last 2 days", shortLabel: "2d", ms: 2 * 24 * 60 * 60 * 1000 },
	{ label: "Last 7 days", shortLabel: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
	{ label: "Last 30 days", shortLabel: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
];

const STEP_OPTIONS: Array<{ label: string; value: string }> = [
	{ label: "Auto", value: "auto" },
	{ label: "10s", value: "10s" },
	{ label: "30s", value: "30s" },
	{ label: "1m", value: "1m" },
	{ label: "5m", value: "5m" },
	{ label: "15m", value: "15m" },
	{ label: "1h", value: "1h" },
];

const POPOVER_EVENT_GUARD_TYPES = [
	"pointerdown",
	"mousedown",
	"mouseup",
	"click",
	"dblclick",
] as const;

const SELECTOR_PANEL_CONFIG = {
	queries: [{ expr: "up" }],
	type: "timeseries" as const,
	rangeMs: 60 * 60 * 1000,
	stepMs: null,
	refreshSeconds: null,
	height: 220,
};

export class TimeSelectorController {
	private plugin: ObsidianMetricsPlugin;
	private context: TimeContext;
	private statusEl: HTMLElement;
	private visible = false;
	private refreshId = 0;
	private popover: TimeSelectorPopover | null = null;

	constructor(plugin: ObsidianMetricsPlugin, context: TimeContext) {
		this.plugin = plugin;
		this.context = context;
		this.statusEl = activeDocument.createElement("div");
		this.statusEl.addClass("tsdb-time-status");
		this.statusEl.setAttr("aria-label", "TSDB time range");
		this.statusEl.setAttr("aria-expanded", "false");
		this.statusEl.setAttr("role", "button");
		this.statusEl.tabIndex = 0;
		this.statusEl.setCssStyles({ display: "none" });

		this.registerCapturedEvent("pointerdown", (event) =>
			this.stopHeaderEvent(event)
		);
		this.registerCapturedEvent("mousedown", (event) =>
			this.stopHeaderEvent(event)
		);
		this.registerCapturedEvent("mouseup", (event) =>
			this.stopHeaderEvent(event)
		);
		this.registerCapturedEvent("dblclick", (event) => {
			this.stopHeaderEvent(event);
			event.preventDefault();
		});
		this.registerCapturedEvent("click", (event) => {
			this.stopHeaderEvent(event);
			event.preventDefault();
			if (event.detail > 1) return;
			this.togglePopover();
		});
		this.registerCapturedEvent("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			this.stopHeaderEvent(event);
			event.preventDefault();
			this.togglePopover();
		});
		plugin.registerEvent(
			plugin.app.workspace.on("active-leaf-change", () => {
				void this.refreshVisibility();
			})
		);
		plugin.registerEvent(
			plugin.app.workspace.on("layout-change", () => {
				void this.refreshVisibility();
			})
		);
		plugin.registerEvent(
			plugin.app.workspace.on("file-open", () => {
				void this.refreshVisibility();
			})
		);
		plugin.registerEvent(
			plugin.app.metadataCache.on("changed", () => {
				void this.refreshVisibility();
			})
		);
		plugin.register(this.context.subscribe(() => this.render()));
		plugin.register(() => this.dispose());
		void this.refreshVisibility();
	}

	dispose(): void {
		this.closePopover();
		this.statusEl.remove();
	}

	private registerCapturedEvent<K extends keyof HTMLElementEventMap>(
		type: K,
		listener: (event: HTMLElementEventMap[K]) => void
	): void {
		this.statusEl.addEventListener(type, listener, true);
		this.plugin.register(() => {
			this.statusEl.removeEventListener(type, listener, true);
		});
	}

	private stopHeaderEvent(event: Event): void {
		event.stopPropagation();
	}

	private async refreshVisibility(): Promise<void> {
		const refreshId = ++this.refreshId;
		const visible = await this.hasOpenPromqlSurface();
		if (refreshId !== this.refreshId) return;
		this.visible = visible;
		this.mount();
		this.statusEl.setCssStyles({ display: visible ? "" : "none" });
		if (!visible) this.closePopover();
		this.render();
	}

	private mount(): void {
		const tabList = activeDocument.querySelector(
			".workspace-tabs.mod-active .workspace-tab-header-tab-list"
		);
		if (!tabList?.parentElement) return;
		if (this.statusEl.parentElement !== tabList.parentElement) {
			tabList.parentElement.insertBefore(this.statusEl, tabList);
			return;
		}
		if (this.statusEl.nextElementSibling !== tabList) {
			tabList.parentElement.insertBefore(this.statusEl, tabList);
		}
	}

	private async hasOpenPromqlSurface(): Promise<boolean> {
		if (
			this.plugin.app.workspace.getLeavesOfType(METRICS_DASHBOARD_VIEW_TYPE)
				.length > 0
		) {
			return true;
		}
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file) continue;
			try {
				const text = await this.plugin.app.vault.cachedRead(view.file);
				if (PROMQL_FENCE_RE.test(text)) return true;
			} catch {
				// Ignore transient file reads while leaves are changing.
			}
		}
		return false;
	}

	private togglePopover(): void {
		if (!this.visible) return;
		if (this.popover) {
			this.closePopover();
			return;
		}
		const popover = new TimeSelectorPopover(
			this.plugin,
			this.context,
			this.statusEl,
			() => {
				if (this.popover === popover) this.popover = null;
				this.statusEl.removeClass("is-active");
				this.statusEl.setAttr("aria-expanded", "false");
			}
		);
		this.popover = popover;
		this.statusEl.addClass("is-active");
		this.statusEl.setAttr("aria-expanded", "true");
	}

	private closePopover(): void {
		this.popover?.close();
	}

	private render(): void {
		if (!this.visible) return;
		const state = this.context.getState();
		const override = this.activeNoteHasOverride();
		this.statusEl.empty();
		const logo = this.statusEl.createSpan({ cls: "tsdb-time-status-logo" });
		logo.setAttr("aria-hidden", "true");
		setIcon(logo, "database-zap");
		const label = this.statusEl.createSpan({
			cls: "tsdb-time-status-label",
			text: labelForState(state),
		});
		if (override) {
			label.addClass("tsdb-time-status-override");
			this.statusEl.createSpan({
				cls: "tsdb-time-status-note",
				text: " note override",
			});
		}
		this.statusEl.createSpan({ cls: "tsdb-time-status-caret" });
		this.popover?.render();
	}

	private activeNoteHasOverride(): boolean {
		const file = this.plugin.app.workspace.getActiveFile();
		if (!file) return false;
		const frontmatter =
			this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		return !!parseTimeOverrides(frontmatter);
	}
}

class TimeSelectorPopover {
	private plugin: ObsidianMetricsPlugin;
	private context: TimeContext;
	private anchorEl: HTMLElement;
	private rootEl: HTMLElement;
	private onClose: () => void;
	private unsubscribe: () => void;
	private errorText: string | null = null;
	private isClosed = false;

	private readonly handleDocumentMouseDown = (event: MouseEvent) => {
		const target = event.target;
		if (!(target instanceof Node)) return;
		if (this.rootEl.contains(target) || this.anchorEl.contains(target)) return;
		this.close();
	};

	private readonly handleDocumentKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			this.close();
		}
	};

	private readonly reposition = () => this.position();

	private readonly stopPopoverEvent = (event: Event) => {
		event.stopPropagation();
	};

	constructor(
		plugin: ObsidianMetricsPlugin,
		context: TimeContext,
		anchorEl: HTMLElement,
		onClose: () => void
	) {
		this.plugin = plugin;
		this.context = context;
		this.anchorEl = anchorEl;
		this.onClose = onClose;
		this.rootEl = anchorEl.ownerDocument.body.createDiv({
			cls: "omx-time-popover",
		});
		this.rootEl.setAttr("role", "dialog");
		this.rootEl.setAttr("aria-label", "TSDB time range");
		this.unsubscribe = this.context.subscribe(() => this.render());
		this.render();

		const doc = this.anchorEl.ownerDocument;
		const win = doc.defaultView ?? window;
		for (const type of POPOVER_EVENT_GUARD_TYPES) {
			this.rootEl.addEventListener(type, this.stopPopoverEvent);
		}
		doc.addEventListener("mousedown", this.handleDocumentMouseDown, true);
		doc.addEventListener("keydown", this.handleDocumentKeyDown, true);
		win.addEventListener("resize", this.reposition);
		win.addEventListener("scroll", this.reposition, true);
	}

	close(): void {
		if (this.isClosed) return;
		this.isClosed = true;
		this.unsubscribe();
		const doc = this.anchorEl.ownerDocument;
		const win = doc.defaultView ?? window;
		for (const type of POPOVER_EVENT_GUARD_TYPES) {
			this.rootEl.removeEventListener(type, this.stopPopoverEvent);
		}
		doc.removeEventListener("mousedown", this.handleDocumentMouseDown, true);
		doc.removeEventListener("keydown", this.handleDocumentKeyDown, true);
		win.removeEventListener("resize", this.reposition);
		win.removeEventListener("scroll", this.reposition, true);
		this.rootEl.remove();
		this.onClose();
	}

	render(): void {
		if (this.isClosed) return;
		const state = this.context.getState();
		const resolved = resolveTimeRange(state, SELECTOR_PANEL_CONFIG, null);
		this.rootEl.empty();

		const header = this.rootEl.createDiv({ cls: "omx-time-popover-header" });
		const titleGroup = header.createDiv({ cls: "omx-time-title-group" });
		titleGroup.createDiv({ cls: "omx-time-title", text: "Time range" });
		titleGroup.createDiv({
			cls: "omx-time-summary",
			text: labelForState(state),
		});

		const nav = header.createDiv({ cls: "omx-time-header-actions" });
		this.addActionButton(nav, "Previous", () => this.context.shiftWindow(-1));
		this.addActionButton(nav, "Next", () => this.context.shiftWindow(1));
		this.addActionButton(nav, "Zoom out", () => this.context.zoom(2));
		this.addActionButton(nav, "Live", () => {
			this.context.setRelative(state.rangeMs, state.stepMs);
		});

		const body = this.rootEl.createDiv({ cls: "omx-time-popover-body" });
		this.renderRelativeColumn(body, state);
		this.renderAbsoluteColumn(body, state, resolved.startMs, resolved.endMs);

		const footer = this.rootEl.createDiv({ cls: "omx-time-popover-footer" });
		this.renderStepControl(footer, state);
		this.renderActiveOverride(footer);
		this.renderError(footer);

		this.position();
	}

	private renderRelativeColumn(containerEl: HTMLElement, state: TimeState): void {
		const column = containerEl.createDiv({ cls: "omx-time-column" });
		column.createDiv({
			cls: "omx-time-section-title",
			text: "Relative time ranges",
		});

		const custom = column.createDiv({ cls: "omx-time-custom" });
		const input = custom.createEl("input");
		input.type = "text";
		input.placeholder = "13h or now-6h to now";
		input.value = state.mode === "relative" ? durationLabel(state.rangeMs) : "";
		input.setAttr("aria-label", "Relative time range");
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") this.applyRelativeInput(input.value, state);
		});
		custom
			.createEl("button", { text: "Apply" })
			.onClickEvent(() => this.applyRelativeInput(input.value, state));

		const presetList = column.createDiv({ cls: "omx-time-preset-list" });
		for (const preset of PRESETS) {
			const button = presetList.createEl("button");
			button.createSpan({ text: preset.label });
			button.createSpan({
				cls: "omx-time-preset-short",
				text: preset.shortLabel,
			});
			button.toggleClass(
				"is-selected",
				state.mode === "relative" &&
					state.endMs === null &&
					Math.abs(state.rangeMs - preset.ms) < 1000
			);
			button.onClickEvent(() => {
				this.clearError();
				this.context.setRelative(preset.ms, state.stepMs);
			});
		}
	}

	private renderAbsoluteColumn(
		containerEl: HTMLElement,
		state: TimeState,
		startMs: number,
		endMs: number
	): void {
		const column = containerEl.createDiv({ cls: "omx-time-column" });
		column.createDiv({
			cls: "omx-time-section-title",
			text: "Absolute time range",
		});
		const startInput = this.addDateTimeField(
			column,
			"From",
			toDateTimeLocal(startMs)
		);
		const endInput = this.addDateTimeField(column, "To", toDateTimeLocal(endMs));
		column
			.createEl("button", {
				cls: "omx-time-primary-action",
				text: "Apply time range",
			})
			.onClickEvent(() => {
				const nextStart = parseTimeValue(startInput.value);
				const nextEnd = parseTimeValue(endInput.value);
				if (nextStart === undefined || nextEnd === undefined) {
					this.setError("Enter a valid start and end time.");
					return;
				}
				this.clearError();
				this.context.setAbsolute(nextStart, nextEnd, state.stepMs);
			});
	}

	private renderStepControl(containerEl: HTMLElement, state: TimeState): void {
		const step = containerEl.createDiv({ cls: "omx-time-step" });
		step.createSpan({ cls: "omx-time-field-label", text: "Step" });
		const select = step.createEl("select");
		select.setAttr("aria-label", "Query step");
		for (const option of STEP_OPTIONS) {
			select.createEl("option", {
				value: option.value,
				text: option.label,
			});
		}
		select.value = stepValue(state.stepMs);
		select.onchange = () => {
			this.clearError();
			this.context.setStep(
				select.value === "auto" ? null : parseDurationValue(select.value) ?? null
			);
		};
	}

	private renderActiveOverride(containerEl: HTMLElement): void {
		const file = this.plugin.app.workspace.getActiveFile();
		const overrides = file
			? parseTimeOverrides(
					this.plugin.app.metadataCache.getFileCache(file)?.frontmatter
			  )
			: null;
		if (!overrides) return;
		const parts = [];
		if (overrides.startMs !== undefined) {
			parts.push(`start ${new Date(overrides.startMs).toLocaleString()}`);
		}
		if (overrides.endMs !== undefined) {
			parts.push(`end ${new Date(overrides.endMs).toLocaleString()}`);
		}
		if (overrides.stepMs !== undefined) {
			parts.push(`step ${durationLabel(overrides.stepMs)}`);
		}
		containerEl.createDiv({
			cls: "omx-time-note-override",
			text: `Active note overrides ${parts.join(", ")}.`,
		});
	}

	private renderError(containerEl: HTMLElement): void {
		if (!this.errorText) return;
		containerEl.createDiv({
			cls: "omx-time-error",
			text: this.errorText,
		});
	}

	private addDateTimeField(
		containerEl: HTMLElement,
		label: string,
		value: string
	): HTMLInputElement {
		const field = containerEl.createDiv({ cls: "omx-time-field" });
		field.createSpan({ cls: "omx-time-field-label", text: label });
		const input = field.createEl("input");
		input.type = "datetime-local";
		input.value = value;
		input.setAttr("aria-label", label);
		return input;
	}

	private addActionButton(
		containerEl: HTMLElement,
		label: string,
		callback: () => void
	): void {
		containerEl
			.createEl("button", { cls: "omx-time-action", text: label })
			.onClickEvent(() => {
				this.clearError();
				callback();
			});
	}

	private applyRelativeInput(value: string, state: TimeState): void {
		const parsed = parseRangeInput(value);
		if (!parsed) {
			this.setError("Use a duration like 13h or a range like now-6h to now.");
			return;
		}
		this.clearError();
		if (parsed.type === "relative") {
			this.context.setRelative(parsed.rangeMs, state.stepMs);
			return;
		}
		this.context.setAbsolute(parsed.startMs, parsed.endMs, state.stepMs);
	}

	private setError(text: string): void {
		this.errorText = text;
		this.render();
	}

	private clearError(): void {
		if (!this.errorText) return;
		this.errorText = null;
		this.render();
	}

	private position(): void {
		const doc = this.anchorEl.ownerDocument;
		const win = doc.defaultView ?? window;
		const anchorRect = this.anchorEl.getBoundingClientRect();
		const popoverRect = this.rootEl.getBoundingClientRect();
		const margin = 8;
		const width = popoverRect.width || 620;
		const height = popoverRect.height || 420;
		const left = Math.min(
			Math.max(margin, anchorRect.right - width),
			Math.max(margin, win.innerWidth - width - margin)
		);
		const below = anchorRect.bottom + 6;
		const top =
			below + height + margin > win.innerHeight
				? Math.max(margin, anchorRect.top - height - 6)
				: below;

		this.rootEl.setCssStyles({
			left: `${Math.round(left)}px`,
			top: `${Math.round(top)}px`,
		});
	}
}

type ParsedRangeInput =
	| { type: "relative"; rangeMs: number }
	| { type: "absolute"; startMs: number; endMs: number };

function parseRangeInput(value: string, nowMs = Date.now()): ParsedRangeInput | null {
	const text = value.trim();
	if (!text) return null;

	const durationText = text.replace(/^last\s+/i, "");
	const durationMs = parseDurationValue(durationText);
	if (durationMs !== undefined) return { type: "relative", rangeMs: durationMs };

	const relativeToNow = text.match(/^now\s*-\s*(.+?)\s+to\s+now$/i);
	if (relativeToNow) {
		const rangeMs = parseDurationValue(relativeToNow[1]);
		return rangeMs === undefined ? null : { type: "relative", rangeMs };
	}

	const endpoints = text.split(/\s+to\s+/i);
	if (endpoints.length !== 2) return null;

	const startMs = parseTimePoint(endpoints[0], nowMs);
	const endMs = parseTimePoint(endpoints[1], nowMs);
	if (startMs === undefined || endMs === undefined) return null;
	return { type: "absolute", startMs, endMs };
}

function parseTimePoint(value: string, nowMs: number): number | undefined {
	const text = value.trim();
	if (/^now$/i.test(text)) return nowMs;
	const relative = text.match(/^now\s*([+-])\s*(.+)$/i);
	if (relative) {
		const delta = parseDurationValue(relative[2]);
		if (delta === undefined) return undefined;
		return relative[1] === "-" ? nowMs - delta : nowMs + delta;
	}
	return parseTimeValue(text);
}

function labelForState(state: TimeState): string {
	const step = state.stepMs ? ` - ${durationLabel(state.stepMs)} step` : "";
	if (state.mode === "absolute" && state.startMs !== null && state.endMs !== null) {
		return `${shortDateTime(state.startMs)} - ${shortDateTime(state.endMs)}${step}`;
	}
	const live = state.endMs === null ? " - live" : "";
	return `Last ${durationLabel(state.rangeMs)}${step}${live}`;
}

function stepValue(stepMs: number | null): string {
	if (stepMs === null) return "auto";
	const label = durationLabel(stepMs);
	return STEP_OPTIONS.some((option) => option.value === label) ? label : "auto";
}

function shortDateTime(ms: number): string {
	return new Date(ms).toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function toDateTimeLocal(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
		d.getHours()
	)}:${pad(d.getMinutes())}`;
}
