import { Menu, Notice, setIcon } from "obsidian";
import type TaskGiftPlugin from "../main";
import type { BoardSort, DayColumn, Task } from "../types";
import { dayColumnKey, dayColumnTitle, newDayColumnId, visibleDayColumns } from "../dayColumns";
import { DayColumnModal } from "../modals/DayColumnModal";
import { addDays, today } from "../util/dates";
import { renderCard } from "./card";

/** View-local (not saved) per-column search state. */
export interface BoardUiState {
	/** Search text per column key. */
	queries: Map<string, string>;
	/** Columns whose search box is open. */
	searchOpen: Set<string>;
	/** Ctrl + wheel / pinch movement not yet turned into a zoom step. */
	zoomDelta: number;
}

/** Wheel / pinch distance for one zoom step. */
const ZOOM_WHEEL_STEP = 60;

interface Column {
	key: string;
	title: string;
	icon: string;
	tasks: Task[];
	/** Applies a drop of this task onto the column; undefined = column doesn't accept drops. */
	onDrop?: (task: Task) => void;
	/** Defaults for the "+" button. */
	newDefaults?: { listId?: string; due?: string | null };
	accent?: string;
	/** Extra actions in a ⋯ menu in the column header. */
	menu?: (menu: Menu) => void;
}

function byDueThenPosition(a: Task, b: Task): number {
	if (a.status !== b.status) return a.status === "completed" ? 1 : -1;
	const ad = a.due ?? "9999-99-99";
	const bd = b.due ?? "9999-99-99";
	if (ad !== bd) return ad < bd ? -1 : 1;
	return a.position.localeCompare(b.position);
}

/** Completion date for completed tasks, due date otherwise. */
function sortDate(t: Task): string | null {
	return (t.status === "completed" ? t.completed ?? t.due : t.due) ?? null;
}

function comparator(sort: BoardSort): (a: Task, b: Task) => number {
	if (sort === "default") return byDueThenPosition;
	const dir = sort === "dateAsc" ? 1 : -1;
	return (a, b) => {
		if (a.status !== b.status) return a.status === "completed" ? 1 : -1;
		const ad = sortDate(a);
		const bd = sortDate(b);
		// Undated tasks always go last.
		if (ad !== bd) {
			if (!ad) return 1;
			if (!bd) return -1;
			return ad < bd ? -dir : dir;
		}
		return a.position.localeCompare(b.position);
	};
}

/** True when the title or description contains the search text (case-insensitive). */
export function matchesQuery(t: Task, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q);
}

const SORT_LABELS: Record<BoardSort, string> = { default: "Default order", dateAsc: "Date: oldest first", dateDesc: "Date: newest first" };

function buildColumns(plugin: TaskGiftPlugin, tasks: Task[]): Column[] {
	const s = plugin.settings;
	const store = plugin.store;
	const t0 = today();
	const t1 = addDays(t0, 1);

	const completed: Column = {
		key: "completed",
		title: "Completed",
		icon: "check-circle-2",
		tasks: [],
		onDrop: (t) => store.setCompleted(t.id, true),
		accent: "done",
	};

	if (s.grouping === "list") {
		const cols = store.lists().map(
			(l): Column => ({
				key: l.id,
				title: l.title,
				icon: "list",
				tasks: tasks.filter((t) => t.listId === l.id && t.status !== "completed"),
				onDrop: (task) => store.update(task.id, { listId: l.id }),
				newDefaults: { listId: l.id },
			}),
		);
		// Completed tasks of every list get their own column, which can be folded away with its eye button.
		completed.tasks = tasks.filter((t) => t.status === "completed");
		return completed.tasks.length ? [...cols, completed] : cols;
	}

	if (s.grouping === "status") {
		return [
			{
				key: "todo",
				title: "To do",
				icon: "circle",
				tasks: tasks.filter((t) => t.status !== "completed"),
				onDrop: (task) => store.setCompleted(task.id, false),
				newDefaults: {},
			},
			{
				key: "done",
				title: "Done",
				icon: "check-circle-2",
				tasks: tasks.filter((t) => t.status === "completed"),
				onDrop: (task) => store.setCompleted(task.id, true),
				accent: "done",
			},
		];
	}

	const dayCols = visibleDayColumns(s);
	const dayColByDate = new Map<string, DayColumn>();
	for (const c of dayCols) if (!dayColByDate.has(c.date)) dayColByDate.set(c.date, c);
	const group = (t: Task): string => {
		// Completed tasks are never overdue; they get their own column.
		if (t.status === "completed") return "completed";
		// Tasks without a date have no column here (they show when grouped by list or status).
		if (!t.due) return "";
		// A day column takes the tasks of its day.
		const dc = dayColByDate.get(t.due);
		if (dc) return dayColumnKey(dc);
		if (t.due < t0) return "overdue";
		if (t.due === t0) return "today";
		if (t.due === t1) return "tomorrow";
		return "later";
	};
	const setDue = (task: Task, due: string | null) => store.update(task.id, { due, time: due ? undefined : null });
	const cols: Column[] = [
		{ key: "overdue", title: "Overdue", icon: "alarm-clock", tasks: [], accent: "overdue" },
		{ key: "today", title: "Today", icon: "sun", tasks: [], onDrop: (t) => setDue(t, t0), newDefaults: { due: t0 }, accent: "today" },
		{ key: "tomorrow", title: "Tomorrow", icon: "sunrise", tasks: [], onDrop: (t) => setDue(t, t1), newDefaults: { due: t1 } },
		{
			key: "later",
			title: "Later",
			icon: "calendar-range",
			tasks: [],
			onDrop: (t) => setDue(t, t.due && t.due > t1 ? t.due : addDays(t0, 2)),
			newDefaults: { due: addDays(t0, 2) },
		},
		...dayCols.map(
			(c): Column => ({
				key: dayColumnKey(c),
				title: dayColumnTitle(c),
				icon: "calendar-days",
				tasks: [],
				onDrop: (t) => setDue(t, c.date),
				newDefaults: { due: c.date },
				accent: c.date < t0 ? "overdue" : c.date === t0 ? "today" : undefined,
				menu: (menu) => {
					menu.addItem((i) => i.setTitle("Edit column…").setIcon("pencil").onClick(() => openDayColumnModal(plugin, c)));
					menu.addItem((i) =>
						i
							.setTitle("Remove column")
							.setIcon("trash-2")
							.setWarning(true)
							.onClick(() => {
								s.dayColumns = s.dayColumns.filter((x) => x.id !== c.id);
								delete s.columnSort[dayColumnKey(c)];
								void plugin.saveSettings();
							}),
					);
				},
			}),
		),
		completed,
	];
	for (const t of tasks) cols.find((c) => c.key === group(t))?.tasks.push(t);
	return cols.filter((c) => (c.key !== "overdue" && c.key !== "completed") || c.tasks.length > 0);
}

export function renderBoard(container: HTMLElement, plugin: TaskGiftPlugin, ui: BoardUiState, onZoom: (zoom: number) => void): void {
	const columns = buildColumns(plugin, plugin.store.all());
	const board = container.createDiv({ cls: "tg-board" });
	board.style.setProperty("--tg-zoom", String(plugin.settings.boardZoom / 100));
	enableBoardNavigation(board, plugin, ui, onZoom);

	if (!columns.length) {
		const empty = board.createDiv({ cls: "tg-empty" });
		empty.createDiv({ cls: "tg-empty-emoji", text: "🗂️" });
		empty.createDiv({ text: plugin.isConnected() ? "No task lists to show yet." : "Connect your Google account in settings to get started." });
		return;
	}

	for (const col of columns) renderColumn(board, plugin, ui, col);

	if (plugin.settings.grouping === "date") {
		const add = board.createEl("button", { cls: "tg-add-column", attr: { "aria-label": "Add a column for a chosen day" } });
		setIcon(add.createSpan(), "calendar-plus");
		add.createSpan({ text: "Add day column" });
		add.addEventListener("click", () => openDayColumnModal(plugin, null));
	}
}

/** Adds a day column, or edits `existing`. */
export function openDayColumnModal(plugin: TaskGiftPlugin, existing: DayColumn | null): void {
	const s = plugin.settings;
	const taken = s.dayColumns.filter((c) => c.id !== existing?.id).map((c) => c.date);
	new DayColumnModal(plugin.app, existing, taken, (fields) => {
		if (existing) Object.assign(existing, fields);
		else s.dayColumns.push({ id: newDayColumnId(), ...fields });
		void plugin.saveSettings();
	}).open();
}

/**
 * Ways to move around a board wider than the screen, for mice and laptop trackpads that can't scroll sideways:
 * the wheel scrolls sideways outside the card lists, dragging the background pans, Ctrl + wheel (or pinch) zooms.
 */
function enableBoardNavigation(board: HTMLElement, plugin: TaskGiftPlugin, ui: BoardUiState, onZoom: (zoom: number) => void): void {
	board.addEventListener(
		"wheel",
		(e) => {
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				ui.zoomDelta += e.deltaY;
				if (Math.abs(ui.zoomDelta) < ZOOM_WHEEL_STEP) return;
				const steps = Math.trunc(ui.zoomDelta / ZOOM_WHEEL_STEP);
				ui.zoomDelta = 0;
				onZoom(plugin.settings.boardZoom - steps * 10);
				return;
			}
			if (e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
			if (board.scrollWidth <= board.clientWidth) return;
			const cards = (e.target as HTMLElement).closest(".tg-column-cards");
			if (cards && cards.scrollHeight > cards.clientHeight) return;
			e.preventDefault();
			board.scrollLeft += e.deltaY;
		},
		{ passive: false },
	);

	board.addEventListener("pointerdown", (e) => {
		const target = e.target as HTMLElement;
		const onBackground = target === board || target.hasClass("tg-column-empty") || target.hasClass("tg-column-cards");
		if (e.pointerType !== "mouse" || e.button !== 0 || !onBackground) return;
		const startX = e.clientX;
		const startScroll = board.scrollLeft;
		board.setPointerCapture(e.pointerId);
		board.addClass("is-panning");
		const move = (ev: PointerEvent) => (board.scrollLeft = startScroll - (ev.clientX - startX));
		const end = () => {
			board.removeClass("is-panning");
			board.removeEventListener("pointermove", move);
			board.removeEventListener("pointerup", end);
			board.removeEventListener("pointercancel", end);
		};
		board.addEventListener("pointermove", move);
		board.addEventListener("pointerup", end);
		board.addEventListener("pointercancel", end);
	});
}

function renderColumn(board: HTMLElement, plugin: TaskGiftPlugin, ui: BoardUiState, col: Column): void {
	const settings = plugin.settings;
	const colEl = board.createDiv({ cls: "tg-column" });
	colEl.dataset.column = col.key;
	if (col.accent) colEl.addClass(`is-${col.accent}`);
	const header = colEl.createDiv({ cls: "tg-column-header" });
	setIcon(header.createSpan({ cls: "tg-column-icon" }), col.icon);
	header.createSpan({ cls: "tg-column-title", text: col.title, attr: { dir: "auto" } });
	const countEl = header.createSpan({ cls: "tg-column-count" });

	// --- eye: folds the column so its tasks are hidden (saved)
	const collapsed = settings.collapsedColumns.includes(col.key);
	const eyeBtn = header.createEl("button", {
		cls: "clickable-icon tg-column-tool tg-column-eye",
		attr: { "aria-label": collapsed ? `Show ${col.title}` : `Hide ${col.title}` },
	});
	setIcon(eyeBtn, collapsed ? "eye-off" : "eye");
	eyeBtn.addEventListener("click", () => {
		settings.collapsedColumns = collapsed ? settings.collapsedColumns.filter((k) => k !== col.key) : [...settings.collapsedColumns, col.key];
		void plugin.saveSettings();
	});
	if (collapsed) {
		colEl.addClass("is-collapsed");
		// Completed-only columns count their (completed) cards; others count open tasks.
		const allDone = col.tasks.every((t) => t.status === "completed");
		countEl.setText(String(allDone ? col.tasks.length : col.tasks.filter((t) => t.status !== "completed").length));
		colEl.setAttr("aria-label", `${col.title} (hidden)`);
		addDropTarget(colEl, plugin, col);
		return;
	}

	// --- search (this column only)
	const searchBtn = header.createEl("button", { cls: "clickable-icon tg-column-tool", attr: { "aria-label": `Search in ${col.title}` } });
	setIcon(searchBtn, "search");
	// --- sort (this column only, saved)
	const sort = settings.columnSort[col.key] ?? "default";
	const sortBtn = header.createEl("button", { cls: "clickable-icon tg-column-tool", attr: { "aria-label": `Sort ${col.title}: ${SORT_LABELS[sort]}` } });
	setIcon(sortBtn, sort === "dateDesc" ? "arrow-down-wide-narrow" : sort === "dateAsc" ? "arrow-up-narrow-wide" : "arrow-up-down");
	sortBtn.toggleClass("is-active", sort !== "default");
	sortBtn.addEventListener("click", (e) => {
		const menu = new Menu();
		for (const k of Object.keys(SORT_LABELS) as BoardSort[]) {
			menu.addItem((i) =>
				i
					.setTitle(SORT_LABELS[k])
					.setChecked(sort === k)
					.onClick(() => {
						if (k === "default") delete settings.columnSort[col.key];
						else settings.columnSort[col.key] = k;
						void plugin.saveSettings();
					}),
			);
		}
		menu.showAtMouseEvent(e);
	});

	if (col.menu) {
		const fillMenu = col.menu;
		const moreBtn = header.createEl("button", { cls: "clickable-icon tg-column-tool", attr: { "aria-label": "Column actions" } });
		setIcon(moreBtn, "more-horizontal");
		moreBtn.addEventListener("click", (e) => {
			const menu = new Menu();
			fillMenu(menu);
			menu.showAtMouseEvent(e);
		});
	}

	if (col.newDefaults) {
		const add = header.createEl("button", { cls: "clickable-icon tg-column-add", attr: { "aria-label": `Add task to ${col.title}` } });
		setIcon(add, "plus");
		add.addEventListener("click", () => plugin.openTaskModal(undefined, col.newDefaults));
	}

	const searchRow = colEl.createDiv({ cls: "tg-column-search" });
	const input = searchRow.createEl("input", {
		cls: "tg-column-search-input",
		attr: { type: "search", placeholder: `Search ${col.title}…`, "aria-label": `Search in ${col.title}` },
	});
	input.dataset.column = col.key;
	input.value = ui.queries.get(col.key) ?? "";

	const list = colEl.createDiv({ cls: "tg-column-cards" });

	/** Renders only this column's cards, so typing in its search box never loses focus. */
	const fill = () => {
		const query = ui.queries.get(col.key) ?? "";
		const searching = query.trim() !== "";
		const shown = col.tasks.filter((t) => matchesQuery(t, query)).sort(comparator(sort));
		list.empty();
		for (const t of shown) {
			renderCard(list, plugin, t, { showList: settings.grouping !== "list", draggable: true, checkbox: true, colorIn: "board" });
		}
		if (!shown.length) list.createDiv({ cls: "tg-column-empty", text: searching ? "No matches" : col.onDrop ? "Drop tasks here" : "Nothing here" });
		const open = shown.filter((t) => t.status !== "completed").length;
		const total = shown.length;
		// Completed-only columns count their (completed) cards; others count open tasks.
		countEl.setText(String(col.tasks.every((t) => t.status === "completed") ? total : open));
		countEl.toggleClass("is-filtered", searching);
		searchBtn.toggleClass("is-active", searching);
	};

	const setSearchOpen = (open: boolean) => {
		if (open) ui.searchOpen.add(col.key);
		else ui.searchOpen.delete(col.key);
		colEl.toggleClass("is-searching", open);
	};
	setSearchOpen(ui.searchOpen.has(col.key) || input.value !== "");

	searchBtn.addEventListener("click", () => {
		const open = !ui.searchOpen.has(col.key);
		setSearchOpen(open);
		if (open) input.focus();
		else if (input.value) {
			input.value = "";
			ui.queries.delete(col.key);
			fill();
		}
	});
	input.addEventListener("input", () => {
		if (input.value) ui.queries.set(col.key, input.value);
		else ui.queries.delete(col.key);
		fill();
	});
	input.addEventListener("keydown", (e) => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		input.value = "";
		ui.queries.delete(col.key);
		setSearchOpen(false);
		fill();
	});

	fill();
	addDropTarget(colEl, plugin, col);
}

/** Lets cards be dropped onto the column (also while it is folded). */
function addDropTarget(colEl: HTMLElement, plugin: TaskGiftPlugin, col: Column): void {
	const settings = plugin.settings;
	if (col.onDrop) {
		const onDrop = col.onDrop;
		colEl.addEventListener("dragover", (e) => {
			if (!e.dataTransfer?.types.includes("text/x-task-gift")) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			colEl.addClass("is-drop-target");
		});
		colEl.addEventListener("dragleave", (e) => {
			if (!colEl.contains(e.relatedTarget as Node | null)) colEl.removeClass("is-drop-target");
		});
		colEl.addEventListener("drop", (e) => {
			e.preventDefault();
			colEl.removeClass("is-drop-target");
			const id = e.dataTransfer?.getData("text/x-task-gift");
			const task = id ? plugin.store.get(id) : undefined;
			if (!task) return;
			if (col.tasks.some((t) => t.id === task.id)) return;
			if (task.parent && settings.grouping === "list") new Notice("Subtask moved to the other list as a top-level task.");
			onDrop(task);
		});
	}
}
