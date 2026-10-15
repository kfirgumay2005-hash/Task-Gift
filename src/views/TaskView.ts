import { ItemView, Menu, setIcon, WorkspaceLeaf } from "obsidian";
import type TaskGiftPlugin from "../main";
import { VIEW_TYPE } from "../defaults";
import { describeFilter, filterFor } from "../filters/dates";
import type { SyncStatus } from "../sync/engine";
import type { Grouping } from "../types";
import { BoardUiState, renderBoard } from "./board";
import { GiftController } from "./gift";

const GROUPING_LABELS: Record<Grouping, string> = { list: "By list", date: "By due date", status: "By status" };

export class TaskView extends ItemView {
	private headerEl!: HTMLElement;
	/** Per-column search state; survives re-renders while the view is open. */
	private boardUi: BoardUiState = { queries: new Map(), searchOpen: new Set() };
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
		this.refresh();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
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
		renderBoard(this.bodyEl, this.plugin, this.boardUi);

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

		const filterChip = left.createEl("button", {
			cls: "tg-filter-chip",
			attr: { "aria-label": "Date filter (change in settings)" },
		});
		setIcon(filterChip.createSpan(), "filter");
		filterChip.createSpan({ text: describeFilter(filterFor(p.settings, mode)) });
		filterChip.addEventListener("click", () => this.openSettings());

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
