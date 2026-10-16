import { ItemView, Menu, setIcon, WorkspaceLeaf } from "obsidian";
import type TaskGiftPlugin from "../main";
import { VIEW_TYPE } from "../defaults";
import { describeFilter } from "../filters/dates";
import { activeMode } from "../modes";
import { BOARD_ZOOM_MAX, BOARD_ZOOM_MIN, BOARD_ZOOM_STEP } from "../defaults";
import type { SyncStatus } from "../sync/engine";
import type { Grouping } from "../types";
import { BoardUiState, renderBoard } from "./board";
import { GiftController } from "./gift";

const GROUPING_LABELS: Record<Grouping, string> = { list: "By list", date: "By due date", status: "By status" };

export class TaskView extends ItemView {
	private headerEl!: HTMLElement;
	/** Per-column search state; survives re-renders while the view is open. */
	private boardUi: BoardUiState = { queries: new Map(), searchOpen: new Set(), zoomDelta: 0 };
	private bodyEl!: HTMLElement;
	private syncBtn!: HTMLElement;
	private gift: GiftController;
	private unsubscribe: (() => void) | null = null;
	private renderedMode: "board" | "gift" | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: TaskGiftPlugin) {
		super(leaf);
		this.gift = new GiftController(plugin);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Task Gift";
	}

	getIcon(): string {
		return "gift";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("tg-view");
		this.headerEl = root.createDiv({ cls: "tg-header" });
		this.bodyEl = root.createDiv({ cls: "tg-body" });
		this.unsubscribe = this.plugin.onStatus((s) => this.updateSyncButton(s));
		// Pause a video background (and its sound) while this tab is hidden.
		const syncMedia = () => this.gift.setOnScreen(this.plugin.settings.giftMode && this.containerEl.isShown());
		this.registerEvent(this.app.workspace.on("active-leaf-change", syncMedia));
		this.registerEvent(this.app.workspace.on("layout-change", syncMedia));
		this.refresh();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.gift.setOnScreen(false);
		// Stops the gift music once no gift view is left.
		window.setTimeout(() => this.plugin.updateMusic(), 0);
	}

	refresh(): void {
		if (!this.bodyEl) return;
		const mode = this.plugin.settings.giftMode ? "gift" : "board";
		this.renderHeader(mode);
		this.contentEl.toggleClass("is-gift-mode", mode === "gift");
		if (mode === "gift") {
			if (this.renderedMode !== "gift") this.bodyEl.empty();
			this.gift.render(this.bodyEl);
		} else {
			this.renderBoardBody();
		}
		this.renderedMode = mode;
	}

	private renderBoardBody(): void {
		const board = this.bodyEl.querySelector(".tg-board");
		const scrollLeft = board?.scrollLeft ?? 0;
		// Remember each column's scroll so long columns (e.g. Completed) don't jump back to the top.
		const columnScroll = new Map<string, number>();
		this.bodyEl.querySelectorAll<HTMLElement>(".tg-column").forEach((c) => {
			const cards = c.querySelector(".tg-column-cards");
			if (c.dataset.column && cards) columnScroll.set(c.dataset.column, cards.scrollTop);
		});
		// A sync can re-render the board while someone is typing in a column's search box: keep focus and caret.
		const active = activeDocument.activeElement;
		const typingIn = active instanceof HTMLInputElement && active.hasClass("tg-column-search-input") ? active : null;
		const caret = typingIn ? [typingIn.selectionStart, typingIn.selectionEnd] : null;

		this.bodyEl.empty();
		renderBoard(this.bodyEl, this.plugin, this.boardUi, (zoom) => void this.setZoom(zoom));

		const next = this.bodyEl.querySelector(".tg-board");
		if (next) next.scrollLeft = scrollLeft;
		this.bodyEl.querySelectorAll<HTMLElement>(".tg-column").forEach((c) => {
			const cards = c.querySelector(".tg-column-cards");
			if (c.dataset.column && cards) cards.scrollTop = columnScroll.get(c.dataset.column) ?? 0;
		});
		if (typingIn?.dataset.column) {
			const input = this.bodyEl.querySelector<HTMLInputElement>(`.tg-column-search-input[data-column="${CSS.escape(typingIn.dataset.column)}"]`);
			if (input) {
				input.focus();
				if (caret) input.setSelectionRange(caret[0], caret[1]);
			}
		}
	}


	private renderHeader(mode: "board" | "gift"): void {
		const p = this.plugin;
		const h = this.headerEl;
		h.empty();

		const left = h.createDiv({ cls: "tg-header-left" });
		const toggle = left.createDiv({ cls: "tg-mode-toggle", attr: { role: "tablist" } });
		const mk = (m: "board" | "gift", icon: string, label: string) => {
			const b = toggle.createEl("button", { cls: "tg-mode-btn", attr: { role: "tab", "aria-selected": String(mode === m) } });
			b.toggleClass("is-active", mode === m);
			setIcon(b.createSpan(), icon);
			b.createSpan({ text: label });
			b.addEventListener("click", () => void p.setGiftMode(m === "gift"));
		};
		mk("board", "layout-dashboard", "Board");
		mk("gift", "gift", "Gift");

		const current = activeMode(p.settings);
		const boardFiltered = mode === "gift" || current.applyToBoard;
		const modeChip = left.createEl("button", {
			cls: "tg-filter-chip tg-mode-chip",
			attr: { "aria-label": `Mode: ${current.name} · ${describeFilter(current.filter)}${boardFiltered ? "" : " (gifts only)"}
Click to switch` },
		});
		setIcon(modeChip.createSpan(), "layers");
		modeChip.createSpan({ cls: "tg-mode-chip-name", text: current.name });
		if (boardFiltered) modeChip.createSpan({ cls: "tg-mode-chip-filter", text: describeFilter(current.filter) });
		setIcon(modeChip.createSpan({ cls: "tg-mode-chip-caret" }), "chevron-down");
		modeChip.addEventListener("click", (e) => {
			const menu = new Menu();
			for (const m of p.settings.modes) {
				menu.addItem((i) =>
					i
						.setTitle(m.name)
						.setChecked(m.id === current.id)
						.onClick(() => void p.setActiveMode(m.id)),
				);
			}
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("Edit modes…").setIcon("settings").onClick(() => this.openSettings()));
			menu.showAtMouseEvent(e);
		});

		const right = h.createDiv({ cls: "tg-header-right" });
		if (mode === "board") {
			const group = right.createEl("button", { cls: "tg-header-btn", attr: { "aria-label": "Group columns" } });
			setIcon(group.createSpan(), "columns-3");
			group.createSpan({ text: GROUPING_LABELS[p.settings.grouping] });
			group.addEventListener("click", (e) => {
				const menu = new Menu();
				for (const g of Object.keys(GROUPING_LABELS) as Grouping[]) {
					menu.addItem((i) =>
						i
							.setTitle(GROUPING_LABELS[g])
							.setChecked(p.settings.grouping === g)
							.onClick(() => {
								p.settings.grouping = g;
								void p.saveSettings();
							}),
					);
				}
				menu.addSeparator();
				menu.addItem((i) =>
					i
						.setTitle("Show completed")
						.setChecked(p.settings.showCompleted)
						.onClick(() => {
							p.settings.showCompleted = !p.settings.showCompleted;
							void p.saveSettings();
						}),
				);
				menu.showAtMouseEvent(e);
			});

			const zoom = right.createDiv({ cls: "tg-zoom", attr: { role: "group", "aria-label": "Board zoom" } });
			const zoomOut = zoom.createEl("button", { cls: "clickable-icon tg-icon-btn", attr: { "aria-label": "Zoom out (Ctrl + scroll)" } });
			setIcon(zoomOut, "zoom-out");
			zoomOut.disabled = p.settings.boardZoom <= BOARD_ZOOM_MIN;
			zoomOut.addEventListener("click", () => void this.setZoom(p.settings.boardZoom - BOARD_ZOOM_STEP));
			const reset = zoom.createEl("button", { cls: "tg-zoom-level", text: `${p.settings.boardZoom}%`, attr: { "aria-label": "Reset zoom" } });
			reset.addEventListener("click", () => void this.setZoom(100));
			const zoomIn = zoom.createEl("button", { cls: "clickable-icon tg-icon-btn", attr: { "aria-label": "Zoom in (Ctrl + scroll)" } });
			setIcon(zoomIn, "zoom-in");
			zoomIn.disabled = p.settings.boardZoom >= BOARD_ZOOM_MAX;
			zoomIn.addEventListener("click", () => void this.setZoom(p.settings.boardZoom + BOARD_ZOOM_STEP));

			const completed = right.createEl("button", {
				cls: "clickable-icon tg-icon-btn",
				attr: { "aria-label": p.settings.showCompleted ? "Hide completed" : "Show completed" },
			});
			completed.toggleClass("is-active", p.settings.showCompleted);
			setIcon(completed, p.settings.showCompleted ? "eye" : "eye-off");
			completed.addEventListener("click", () => {
				p.settings.showCompleted = !p.settings.showCompleted;
				void p.saveSettings();
			});
		}

		const add = right.createEl("button", { cls: "clickable-icon tg-icon-btn", attr: { "aria-label": "New task" } });
		setIcon(add, "plus");
		add.addEventListener("click", () => p.openTaskModal());

		this.syncBtn = right.createEl("button", { cls: "clickable-icon tg-icon-btn tg-sync-btn" });
		setIcon(this.syncBtn, "refresh-cw");
		this.syncBtn.createSpan({ cls: "tg-sync-dot" });
		this.syncBtn.addEventListener("click", () => void p.syncNow());
		this.updateSyncButton(p.engine.status);

		const more = right.createEl("button", { cls: "clickable-icon tg-icon-btn", attr: { "aria-label": "More" } });
		setIcon(more, "more-vertical");
		more.addEventListener("click", (e) => {
			const menu = new Menu();
			menu.addItem((i) => i.setTitle("Full resync").setIcon("refresh-ccw").onClick(() => void p.syncNow(true)));
			menu.addItem((i) => i.setTitle("Settings").setIcon("settings").onClick(() => this.openSettings()));
			menu.showAtMouseEvent(e);
		});
	}

	private async setZoom(zoom: number): Promise<void> {
		const next = Math.min(BOARD_ZOOM_MAX, Math.max(BOARD_ZOOM_MIN, Math.round(zoom / BOARD_ZOOM_STEP) * BOARD_ZOOM_STEP));
		if (next === this.plugin.settings.boardZoom) return;
		this.plugin.settings.boardZoom = next;
		await this.plugin.saveSettings();
	}

	private updateSyncButton(s: SyncStatus): void {
		if (!this.syncBtn) return;
		const connected = this.plugin.isConnected();
		const state = connected ? s.state : "disconnected";
		this.syncBtn.className = `clickable-icon tg-icon-btn tg-sync-btn is-${state}`;
		let label = connected ? s.message : "Not connected — open settings";
		if (connected && s.lastSync) label += ` · last sync ${new Date(s.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
		if (s.pending) label += ` · ${s.pending} pending`;
		this.syncBtn.setAttr("aria-label", label);
	}

	private openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.plugin.manifest.id);
	}
}
