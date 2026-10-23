import { ItemView, Menu, setIcon, WorkspaceLeaf } from "obsidian";
import type TaskGiftPlugin from "../main";
import { VIEW_TYPE } from "../defaults";
import { describeFilter } from "../filters/dates";
import { activeMode } from "../modes";
import { BOARD_ZOOM_MAX, BOARD_ZOOM_MIN, BOARD_ZOOM_STEP } from "../defaults";
import { DEFAULT_DAY_TITLE, DayTitleModal, renderDayTitle, renderDayTitleEnd, type DayTitleFields } from "../modals/DayTitleModal";
import type { SyncStatus } from "../sync/engine";
import type { Grouping } from "../types";
import { nowTime, today } from "../util/dates";
import { BoardUiState, renderBoard } from "./board";
import { CalendarUiState, renderCalendar } from "./calendar";
import { GiftController } from "./gift";
import { ModesEditor } from "./modes";
import { renderSearchResults } from "./search";

type ViewMode = "board" | "calendar" | "gift" | "modes";

const GROUPING_LABELS: Record<Grouping, string> = { list: "By list", date: "By due date", status: "By status" };

export class TaskView extends ItemView {
	private headerEl!: HTMLElement;
	/** Per-column search state; survives re-renders while the view is open. */
	private boardUi: BoardUiState = { queries: new Map(), searchOpen: new Set(), zoomDelta: 0 };
	private calendarUi: CalendarUiState = { anchor: today(), calendar: null };
	/** Header search over all tasks; while it has text, the body shows its results. */
	private search = { open: false, query: "" };
	private bodyEl!: HTMLElement;
	private syncBtn!: HTMLElement;
	private gift: GiftController;
	private modesEditor: ModesEditor;
	/** The Modes page is open (view-local, not saved). */
	private showingModes = false;
	private unsubscribe: (() => void) | null = null;
	private renderedMode: ViewMode | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: TaskGiftPlugin) {
		super(leaf);
		this.gift = new GiftController(plugin);
		this.modesEditor = new ModesEditor(plugin);
	}

	/** True when gift mode is on screen here (not the Modes page). */
	showsGift(): boolean {
		return this.plugin.settings.giftMode && !this.showingModes && this.containerEl.isShown();
	}

	/** Opens the Modes page. */
	showModes(): void {
		this.showingModes = true;
		this.gift.setOnScreen(false);
		this.refresh();
		this.plugin.updateMusic();
	}

	private closeModes(): void {
		this.showingModes = false;
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
		const syncMedia = () => this.gift.setOnScreen(this.showsGift());
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
		const s = this.plugin.settings;
		const mode: ViewMode = this.showingModes ? "modes" : s.giftMode ? "gift" : s.boardView;
		// A sync can re-render the header while someone is typing in the search box: keep focus and caret.
		const active = activeDocument.activeElement;
		const typing = active instanceof HTMLInputElement && active.hasClass("tg-global-search-input");
		const caret = typing ? [active.selectionStart, active.selectionEnd] : null;

		this.renderHeader(mode);
		this.contentEl.toggleClass("is-gift-mode", mode === "gift");
		this.contentEl.toggleClass("is-calendar-mode", mode === "calendar");
		this.contentEl.toggleClass("is-modes-mode", mode === "modes");
		if (mode === "modes") {
			// Redraws only when the settings were replaced (e.g. changed on another device), so typing keeps focus.
			this.modesEditor.render(this.bodyEl, this.renderedMode !== "modes");
		} else if (mode === "gift") {
			if (this.renderedMode !== "gift") this.bodyEl.empty();
			this.gift.render(this.bodyEl);
		} else {
			this.renderMainBody(mode);
		}
		this.renderedMode = mode;

		if (typing) {
			const input = this.headerEl.querySelector<HTMLInputElement>(".tg-global-search-input");
			if (input) {
				input.focus();
				if (caret) input.setSelectionRange(caret[0], caret[1]);
			}
		}
	}

	private renderMainBody(mode: "board" | "calendar"): void {
		if (this.search.query.trim()) {
			const scroll = this.bodyEl.querySelector(".tg-search-results")?.scrollTop ?? 0;
			this.bodyEl.empty();
			renderSearchResults(this.bodyEl, this.plugin, this.search.query);
			const results = this.bodyEl.querySelector(".tg-search-results");
			if (results) results.scrollTop = scroll;
		} else if (mode === "calendar") {
			// Ticking a checkbox in an entry redraws the calendar: keep the grid's and each day's scroll.
			const gridScroll = this.bodyEl.querySelector(".tg-cal-grid")?.scrollTop ?? 0;
			const dayScroll = new Map<string, number>();
			this.bodyEl.querySelectorAll<HTMLElement>(".tg-cal-day").forEach((c) => {
				const items = c.querySelector(".tg-cal-items");
				if (c.dataset.date && items?.scrollTop) dayScroll.set(c.dataset.date, items.scrollTop);
			});
			this.bodyEl.empty();
			renderCalendar(this.bodyEl, this.plugin, this.calendarUi, () => this.renderMainBody("calendar"));
			const grid = this.bodyEl.querySelector(".tg-cal-grid");
			if (grid) grid.scrollTop = gridScroll;
			this.bodyEl.querySelectorAll<HTMLElement>(".tg-cal-day").forEach((c) => {
				const items = c.querySelector(".tg-cal-items");
				const top = c.dataset.date ? dayScroll.get(c.dataset.date) : undefined;
				if (items && top) items.scrollTop = top;
			});
		} else {
			this.renderBoardBody();
		}
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


	private renderHeader(mode: ViewMode): void {
		const p = this.plugin;
		const h = this.headerEl;
		h.empty();

		const left = h.createDiv({ cls: "tg-header-left" });
		const toggle = left.createDiv({ cls: "tg-mode-toggle", attr: { role: "tablist" } });
		const mk = (m: ViewMode, icon: string, label: string) => {
			const b = toggle.createEl("button", { cls: "tg-mode-btn", attr: { role: "tab", "aria-selected": String(mode === m), "aria-label": label } });
			b.toggleClass("is-active", mode === m);
			setIcon(b.createSpan(), icon);
			b.createSpan({ cls: "tg-mode-btn-label", text: label });
			b.addEventListener("click", () => {
				if (m === "modes") {
					this.showModes();
					return;
				}
				this.closeModes();
				void (m === "gift" ? p.setGiftMode(true) : p.setBoardView(m));
			});
		};
		mk("board", "layout-dashboard", "Board");
		mk("calendar", "calendar-days", "Calendar");
		mk("gift", "gift", "Gift");
		// Modes only affect gifts, so they are switched and edited only from gift mode.
		const giftSide = mode === "gift" || mode === "modes";
		if (giftSide) mk("modes", "layers", "Modes");

		if (giftSide) {
			const current = activeMode(p.settings);
			const modeChip = left.createEl("button", {
				cls: "tg-filter-chip tg-mode-chip",
				attr: { "aria-label": `Mode: ${current.name} · ${describeFilter(current.filter)} (gifts)\nClick to switch` },
			});
			setIcon(modeChip.createSpan(), "layers");
			modeChip.createSpan({ cls: "tg-mode-chip-name", text: current.name });
			if (mode === "gift") modeChip.createSpan({ cls: "tg-mode-chip-filter", text: describeFilter(current.filter) });
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
				menu.addItem((i) => i.setTitle("Edit modes…").setIcon("pencil").onClick(() => this.showModes()));
				menu.showAtMouseEvent(e);
			});
		}

		if (mode !== "modes") this.renderDayTitle(h);

		const right = h.createDiv({ cls: "tg-header-right" });
		if (mode === "board" || mode === "calendar") this.renderSearch(right, mode);
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
			menu.addItem((i) => i.setTitle("Insert today's tasks into daily note").setIcon("calendar-check").onClick(() => void p.insertIntoDailyNote()));
			menu.addItem((i) => i.setTitle("Settings").setIcon("settings").onClick(() => this.openSettings()));
			menu.showAtMouseEvent(e);
		});
	}

	/** Today's heading ("what today is about"), between the view tabs and the search; click to write or style it. */
	private renderDayTitle(parent: HTMLElement): void {
		const store = this.plugin.store;
		const date = today();
		const active = store.activeDayTitle(date, nowTime());
		const current = active?.title ?? null;
		const slot = parent.createDiv({ cls: "tg-day-title-slot" });
		// Left to right, so the end date's "left" and "right" are on screen; each text has its own direction.
		const group = slot.createDiv({ cls: "tg-day-title-group", attr: { dir: "ltr" } });
		// Not a <button>: Obsidian's and the themes' button styles would override the heading's color and background.
		const btn = group.createDiv({ attr: { role: "button", tabindex: "0", "aria-label": current ? "Edit today's topic" : "Add a topic for today" } });
		renderDayTitle(btn, current ?? { ...DEFAULT_DAY_TITLE, text: "" }, "+ Today's topic");
		if (current) {
			const end = group.createDiv();
			renderDayTitleEnd(group, end, current);
			end.addEventListener("click", () => btn.click());
		}
		btn.addEventListener("keydown", (e) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			btn.click();
		});
		const save = (start: string) => (t: DayTitleFields) => {
			store.setDayTitle(start, t);
			this.plugin.touch();
		};
		// A new topic starts with the last heading's style, not its text, letter colors or end.
		const fresh = () => {
			const last = store.lastDayTitle();
			new DayTitleModal(this.app, date, { ...DEFAULT_DAY_TITLE, ...(last ?? {}), text: "", parts: undefined, until: undefined, untilTime: undefined }, save(date)).open();
		};
		btn.addEventListener("click", () => {
			if (!active) return fresh();
			// A topic that lasts from an earlier day is edited where it was written.
			const earlier = active.start !== date;
			new DayTitleModal(this.app, active.start, active.title, save(active.start), earlier ? fresh : undefined).open();
		});
	}

	/** Search box over all tasks (every list, date and status). */
	private renderSearch(parent: HTMLElement, mode: "board" | "calendar"): void {
		const wrap = parent.createDiv({ cls: "tg-global-search" });
		const btn = wrap.createEl("button", { cls: "clickable-icon tg-icon-btn", attr: { "aria-label": "Search all tasks" } });
		setIcon(btn, "search");
		btn.toggleClass("is-active", this.search.open);
		const close = () => {
			this.search = { open: false, query: "" };
			this.refresh();
		};
		btn.addEventListener("click", () => {
			if (this.search.open) close();
			else {
				this.search.open = true;
				this.refresh();
				this.headerEl.querySelector<HTMLInputElement>(".tg-global-search-input")?.focus();
			}
		});
		if (!this.search.open) return;
		const input = wrap.createEl("input", {
			cls: "tg-global-search-input",
			attr: { type: "search", placeholder: "Search all tasks…", "aria-label": "Search all tasks" },
		});
		input.value = this.search.query;
		input.addEventListener("input", () => {
			this.search.query = input.value;
			this.renderMainBody(mode);
		});
		input.addEventListener("keydown", (e) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			close();
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
