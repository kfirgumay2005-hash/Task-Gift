import { Menu, setIcon } from "obsidian";
import type TaskGiftPlugin from "../main";
import { CalendarEntry, timeLabel } from "../calendars/format";
import { checklistCount, renderNotes, toggleCheck } from "../calendars/notes";
import type { ExtraCalendar } from "../calendars/store";
import { taskColorCss } from "../defaults";
import { CalendarEditModal, CalendarEntryModal, CalendarImportModal } from "../modals/CalendarModals";
import type { CalendarRange, Task } from "../types";
import { describeRule, occurrencesBetween } from "../recurrence/rule";
import { addDays, addMonths, daysInMonth, MONTH_SHORT, parseDate, startOfWeek, today, toDateString, WEEKDAY_SHORT } from "../util/dates";
import { applyTaskColor, openCardMenu, renderCard } from "./card";

/** View-local (not saved) calendar state. */
export interface CalendarUiState {
	/** Any day inside the shown month / week. */
	anchor: string;
	/** Path of the extra calendar shown instead of the tasks; null = the tasks. */
	calendar: string | null;
}

interface Entry {
	task: Task;
	date: string;
	/**
	 * An upcoming occurrence of a repeating task. Only the next occurrence is a real task;
	 * later ones are computed for display and never stored or synced.
	 */
	ghost: boolean;
}

const RANGE_LABELS: Record<CalendarRange, string> = { week: "Week", month: "Month" };

function visibleRange(range: CalendarRange, anchor: string, weekStart: number): { from: string; to: string } {
	if (range === "week") {
		const from = startOfWeek(anchor, weekStart);
		return { from, to: addDays(from, 6) };
	}
	const d = parseDate(anchor);
	const first = toDateString(new Date(d.getFullYear(), d.getMonth(), 1));
	const last = toDateString(new Date(d.getFullYear(), d.getMonth(), daysInMonth(d.getFullYear(), d.getMonth())));
	return { from: startOfWeek(first, weekStart), to: addDays(startOfWeek(last, weekStart), 6) };
}

function rangeTitle(range: CalendarRange, anchor: string, from: string, to: string): string {
	if (range === "month") return parseDate(anchor).toLocaleDateString(undefined, { month: "long", year: "numeric" });
	const a = parseDate(from);
	const b = parseDate(to);
	const start = `${MONTH_SHORT[a.getMonth()]} ${a.getDate()}`;
	const end = a.getMonth() === b.getMonth() ? `${b.getDate()}` : `${MONTH_SHORT[b.getMonth()]} ${b.getDate()}`;
	return `${start} – ${end}, ${b.getFullYear()}`;
}

/** Tasks per day in [from, to], with upcoming repeats of repeating tasks. */
function collect(plugin: TaskGiftPlugin, from: string, to: string): Map<string, Entry[]> {
	const s = plugin.settings;
	const store = plugin.store;
	const t0 = today();
	const byDate = new Map<string, Entry[]>();
	const push = (date: string, task: Task, ghost: boolean) => {
		if (date < from || date > to) return;
		const list = byDate.get(date) ?? [];
		list.push({ task, date, ghost });
		byDate.set(date, list);
	};

	for (const task of store.all()) {
		if (task.status === "completed") {
			// Folding the board's Completed column with its eye hides completed tasks here too.
			if (s.collapsedColumns.includes("completed")) continue;
			const date = task.due ?? (task.completed ? toDateString(new Date(task.completed)) : null);
			if (date) push(date, task, false);
			continue;
		}
		if (!task.due) continue;
		push(task.due, task, false);
		const rule = store.rule(task.id);
		// Missed occurrences are skipped when an overdue repeating task is completed, so only today onwards are shown.
		if (rule) for (const d of occurrencesBetween(rule, task.due, from > t0 ? from : t0, to)) push(d, task, true);
	}

	for (const list of byDate.values()) {
		list.sort((a, b) => {
			const ad = a.task.status === "completed";
			const bd = b.task.status === "completed";
			if (ad !== bd) return ad ? 1 : -1;
			const at = store.time(a.task.id) ?? "99:99";
			const bt = store.time(b.task.id) ?? "99:99";
			if (at !== bt) return at < bt ? -1 : 1;
			return a.task.position.localeCompare(b.task.position);
		});
	}
	return byDate;
}

export function renderCalendar(container: HTMLElement, plugin: TaskGiftPlugin, ui: CalendarUiState, rerender: () => void): void {
	const s = plugin.settings;
	const range = s.calendarRange;
	const { from, to } = visibleRange(range, ui.anchor, s.weekStart);
	const extra = plugin.calendars.get(ui.calendar);
	if (!extra) ui.calendar = null;
	const root = container.createDiv({ cls: `tg-calendar is-${range}` });
	root.toggleClass("is-extra", !!extra);

	// --- toolbar
	const bar = root.createDiv({ cls: "tg-cal-toolbar" });
	const nav = bar.createDiv({ cls: "tg-cal-nav" });
	const step = (dir: number) => {
		ui.anchor = range === "month" ? addMonths(ui.anchor, dir, 1) : addDays(ui.anchor, 7 * dir);
		rerender();
	};
	const prev = nav.createEl("button", { cls: "clickable-icon tg-icon-btn", attr: { "aria-label": range === "month" ? "Previous month" : "Previous week" } });
	setIcon(prev, "chevron-left");
	prev.addEventListener("click", () => step(-1));
	const todayBtn = nav.createEl("button", { cls: "tg-header-btn", text: "Today" });
	todayBtn.addEventListener("click", () => {
		ui.anchor = today();
		rerender();
	});
	const next = nav.createEl("button", { cls: "clickable-icon tg-icon-btn", attr: { "aria-label": range === "month" ? "Next month" : "Next week" } });
	setIcon(next, "chevron-right");
	next.addEventListener("click", () => step(1));
	bar.createDiv({ cls: "tg-cal-title", text: rangeTitle(range, ui.anchor, from, to) });
	renderCalendarPicker(bar, plugin, ui, extra, rerender);

	const toggle = bar.createDiv({ cls: "tg-mode-toggle", attr: { role: "tablist", "aria-label": "Calendar range" } });
	for (const r of Object.keys(RANGE_LABELS) as CalendarRange[]) {
		const b = toggle.createEl("button", { cls: "tg-mode-btn", text: RANGE_LABELS[r], attr: { role: "tab", "aria-selected": String(r === range) } });
		b.toggleClass("is-active", r === range);
		b.addEventListener("click", () => {
			if (s.calendarRange === r) return;
			s.calendarRange = r;
			void plugin.saveSettings();
		});
	}

	// --- grid
	const entries = extra ? new Map<string, Entry[]>() : collect(plugin, from, to);
	const extraEntries = new Map<string, CalendarEntry[]>();
	if (extra) {
		for (const e of extra.entries) {
			if (e.date < from || e.date > to) continue;
			const list = extraEntries.get(e.date) ?? [];
			list.push(e);
			extraEntries.set(e.date, list);
		}
	}
	const addOn = (date: string) => {
		if (extra) new CalendarEntryModal(plugin.app, plugin.calendars, extra, null, date).open();
		else plugin.openTaskModal(undefined, { due: date });
	};
	const t0 = today();
	const month = parseDate(ui.anchor).getMonth();
	const grid = root.createDiv({ cls: "tg-cal-grid" });
	const days = Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86400000) + 1;
	grid.style.setProperty("--tg-cal-rows", String(days / 7));
	for (let i = 0; i < 7; i++) grid.createDiv({ cls: "tg-cal-weekday", text: WEEKDAY_SHORT[(s.weekStart + i) % 7] });

	for (let i = 0; i < days; i++) {
		const date = addDays(from, i);
		const d = parseDate(date);
		const cell = grid.createDiv({ cls: "tg-cal-day" });
		cell.toggleClass("is-today", date === t0);
		cell.toggleClass("is-past", date < t0);
		cell.toggleClass("is-outside", range === "month" && d.getMonth() !== month);

		const head = cell.createDiv({ cls: "tg-cal-day-head" });
		const num = head.createSpan({ cls: "tg-cal-day-num", text: d.getDate() === 1 || range === "week" ? `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}` : String(d.getDate()) });
		num.setAttr("aria-label", d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }));
		const add = head.createEl("button", { cls: "clickable-icon tg-cal-add", attr: { "aria-label": extra ? `New entry in ${extra.name}` : "New task on this day" } });
		setIcon(add, "plus");
		add.addEventListener("click", () => addOn(date));

		const items = cell.createDiv({ cls: "tg-cal-items" });
		if (extra) for (const e of extraEntries.get(date) ?? []) renderEntry(items, plugin, extra, e, range === "week");
		for (const e of entries.get(date) ?? []) {
			if (range === "week" && !e.ghost) {
				renderCard(items, plugin, e.task, { showList: true, draggable: true, checkbox: true, notesLines: 2, colorIn: "calendar" });
			} else {
				renderItem(items, plugin, e);
			}
		}

		// Double-click on an empty spot creates a task on that day.
		cell.addEventListener("dblclick", (ev) => {
			if (ev.target === cell || ev.target === items || ev.target === head) addOn(date);
		});
		if (!extra) enableDrop(cell, plugin, date);
	}
}

/** Switches between the tasks and the extra calendars; the Import button fills the shown one from text. */
function renderCalendarPicker(bar: HTMLElement, plugin: TaskGiftPlugin, ui: CalendarUiState, extra: ExtraCalendar | null, rerender: () => void): void {
	const show = (cal: ExtraCalendar | null) => {
		ui.calendar = cal?.path ?? null;
		rerender();
	};
	const picker = bar.createEl("button", { cls: "tg-header-btn tg-cal-picker", attr: { "aria-label": "Choose calendar" } });
	if (extra?.color) picker.style.setProperty("--tg-task-color", taskColorCss(extra.color));
	picker.toggleClass("has-color", !!extra?.color);
	setIcon(picker.createSpan(), extra ? "calendar-range" : "list-checks");
	picker.createSpan({ text: extra ? extra.name : "Tasks", attr: { dir: "auto" } });
	setIcon(picker.createSpan({ cls: "tg-mode-chip-caret" }), "chevron-down");
	picker.addEventListener("click", (e) => {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Tasks").setIcon("list-checks").setChecked(!extra).onClick(() => show(null)));
		for (const cal of plugin.calendars.all()) {
			menu.addItem((i) =>
				i
					.setTitle(cal.name)
					.setIcon("calendar-range")
					.setChecked(cal.path === extra?.path)
					.onClick(() => show(cal)),
			);
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("New calendar…").setIcon("plus").onClick(() => new CalendarEditModal(plugin.app, plugin.calendars, null, show).open()));
		menu.addItem((i) => i.setTitle("Import text…").setIcon("clipboard-paste").onClick(() => new CalendarImportModal(plugin.app, plugin.calendars, extra, show).open()));
		if (extra) {
			menu.addItem((i) => i.setTitle("Edit calendar…").setIcon("pencil").onClick(() => new CalendarEditModal(plugin.app, plugin.calendars, extra, show).open()));
			menu.addItem((i) => i.setTitle("Open its note").setIcon("file-text").onClick(() => void plugin.app.workspace.openLinkText(extra.path, "", "tab")));
		}
		menu.showAtMouseEvent(e);
	});
	if (!extra) return;
	const imp = bar.createEl("button", { cls: "tg-header-btn", attr: { "aria-label": `Add entries to ${extra.name} by pasting text` } });
	setIcon(imp.createSpan(), "clipboard-paste");
	imp.createSpan({ text: "Import" });
	imp.addEventListener("click", () => new CalendarImportModal(plugin.app, plugin.calendars, extra, show).open());
}

/** An entry of an extra calendar: one line in the month view, with its description in the week view. */
function renderEntry(parent: HTMLElement, plugin: TaskGiftPlugin, cal: ExtraCalendar, e: CalendarEntry, week: boolean): void {
	const el = parent.createDiv({ cls: "tg-cal-item tg-cal-entry" });
	el.toggleClass("is-done", e.done);
	el.toggleClass("is-week", week);
	if (cal.color) {
		el.addClass("has-color");
		el.style.setProperty("--tg-task-color", taskColorCss(cal.color));
	}
	const time = timeLabel(e);
	el.setAttr("aria-label", [time, e.title, e.notes].filter((x) => x).join("\n"));
	const cb = el.createEl("button", {
		cls: "tg-cal-check",
		attr: { "aria-label": e.done ? "Mark as not done" : "Mark as done", role: "checkbox", "aria-checked": String(e.done) },
	});
	setIcon(cb, e.done ? "check-circle-2" : "circle");
	cb.addEventListener("click", (ev) => {
		ev.stopPropagation();
		e.done = !e.done;
		void plugin.calendars.save(cal);
	});
	if (time) el.createSpan({ cls: "tg-cal-item-time", text: time });
	el.createSpan({ cls: "tg-cal-item-title", text: e.title, attr: { dir: "auto" } });
	const checks = checklistCount(e.notes);
	if (checks.total) {
		const badge = el.createSpan({ cls: "tg-cal-entry-progress", text: `${checks.done}/${checks.total}` });
		badge.toggleClass("is-complete", checks.done === checks.total);
	}
	if (week && e.notes) {
		renderNotes(el.createDiv({ cls: "tg-cal-entry-notes" }), e.notes, (line) => {
			e.notes = toggleCheck(e.notes, line);
			void plugin.calendars.save(cal);
		});
	}
	el.addEventListener("click", () => new CalendarEntryModal(plugin.app, plugin.calendars, cal, e, e.date).open());
}

/** A compact one-line entry (month view, and upcoming repeats in the week view). */
function renderItem(parent: HTMLElement, plugin: TaskGiftPlugin, e: Entry): void {
	const store = plugin.store;
	const task = e.task;
	const done = task.status === "completed";
	const el = parent.createDiv({ cls: "tg-cal-item" });
	el.toggleClass("is-done", done);
	el.toggleClass("is-ghost", e.ghost);
	el.toggleClass("is-overdue", !done && !e.ghost && e.date < today());
	applyTaskColor(el, plugin, task, "calendar");

	if (e.ghost) {
		setIcon(el.createSpan({ cls: "tg-cal-item-icon" }), "repeat");
		const rule = store.rule(task.id);
		el.setAttr("aria-label", `Upcoming repeat${rule ? ` (${describeRule(rule)})` : ""}. It is created when the current one is done.`);
	} else {
		const cb = el.createEl("button", {
			cls: "tg-cal-check",
			attr: { "aria-label": done ? "Mark as not done" : "Mark as done", role: "checkbox", "aria-checked": String(done) },
		});
		setIcon(cb, done ? "check-circle-2" : "circle");
		cb.addEventListener("click", (ev) => {
			ev.stopPropagation();
			store.setCompleted(task.id, !done);
		});
	}
	const time = store.time(task.id);
	if (time) el.createSpan({ cls: "tg-cal-item-time", text: time });
	el.createSpan({ cls: "tg-cal-item-title", text: task.title || "(untitled)", attr: { dir: "auto" } });
	if (!e.ghost && store.rule(task.id)) setIcon(el.createSpan({ cls: "tg-cal-item-icon" }), "repeat");

	el.addEventListener("click", () => plugin.openTaskModal(task));
	if (e.ghost) return;
	el.addEventListener("contextmenu", (ev) => {
		ev.preventDefault();
		openCardMenu(ev, plugin, task);
	});
	el.draggable = true;
	el.addEventListener("dragstart", (ev) => {
		ev.dataTransfer?.setData("text/x-task-gift", task.id);
		ev.dataTransfer?.setData("text/plain", task.title);
		if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
		el.addClass("is-dragging");
	});
	el.addEventListener("dragend", () => el.removeClass("is-dragging"));
}

/** Dropping a task on a day moves its due date there (the time is kept). */
function enableDrop(cell: HTMLElement, plugin: TaskGiftPlugin, date: string): void {
	cell.addEventListener("dragover", (e) => {
		if (!e.dataTransfer?.types.includes("text/x-task-gift")) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		cell.addClass("is-drop-target");
	});
	cell.addEventListener("dragleave", (e) => {
		if (!cell.contains(e.relatedTarget as Node | null)) cell.removeClass("is-drop-target");
	});
	cell.addEventListener("drop", (e) => {
		e.preventDefault();
		cell.removeClass("is-drop-target");
		const id = e.dataTransfer?.getData("text/x-task-gift");
		const task = id ? plugin.store.get(id) : undefined;
		if (task && task.due !== date) plugin.store.update(task.id, { due: date });
	});
}
