import { Notice, setIcon } from "obsidian";
import type TaskGiftPlugin from "../main";
import type { Task } from "../types";
import { filterFor, isListIncluded, matchesDateFilter } from "../filters/dates";
import { addDays, today } from "../util/dates";
import { renderCard } from "./card";

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
}

function byDueThenPosition(a: Task, b: Task): number {
	if (a.status !== b.status) return a.status === "completed" ? 1 : -1;
	const ad = a.due ?? "9999-99-99";
	const bd = b.due ?? "9999-99-99";
	if (ad !== bd) return ad < bd ? -1 : 1;
	return a.position.localeCompare(b.position);
}

/** Tasks shown in the board, after list / date / completed filters. */
export function boardTasks(plugin: TaskGiftPlugin): Task[] {
	const s = plugin.settings;
	const filter = filterFor(s, "board");
	return plugin.store
		.all()
		.filter((t) => isListIncluded(s, t.listId))
		.filter((t) => s.grouping === "status" || s.showCompleted || t.status !== "completed")
		.filter((t) => matchesDateFilter(t, filter, s.weekStart));
}

function buildColumns(plugin: TaskGiftPlugin, tasks: Task[]): Column[] {
	const s = plugin.settings;
	const store = plugin.store;
	const t0 = today();
	const t1 = addDays(t0, 1);

	if (s.grouping === "list") {
		return store
			.lists()
			.filter((l) => isListIncluded(s, l.id))
			.map((l) => ({
				key: l.id,
				title: l.title,
				icon: "list",
				tasks: tasks.filter((t) => t.listId === l.id),
				onDrop: (task) => store.update(task.id, { listId: l.id }),
				newDefaults: { listId: l.id },
			}));
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

	const group = (t: Task): string => {
		if (!t.due) return "none";
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
		{ key: "none", title: "No date", icon: "calendar-off", tasks: [], onDrop: (t) => setDue(t, null), newDefaults: { due: null } },
	];
	for (const t of tasks) cols.find((c) => c.key === group(t))?.tasks.push(t);
	return cols.filter((c) => c.key !== "overdue" || c.tasks.length > 0);
}

export function renderBoard(container: HTMLElement, plugin: TaskGiftPlugin): void {
	const tasks = boardTasks(plugin);
	const columns = buildColumns(plugin, tasks);
	const board = container.createDiv({ cls: "tg-board" });

	if (!columns.length) {
		const empty = board.createDiv({ cls: "tg-empty" });
		empty.createDiv({ cls: "tg-empty-emoji", text: "🗂️" });
		empty.createDiv({ text: plugin.isConnected() ? "No task lists to show. Check the included lists in settings." : "Connect your Google account in settings to get started." });
		return;
	}

	for (const col of columns) {
		const colEl = board.createDiv({ cls: "tg-column" });
		if (col.accent) colEl.addClass(`is-${col.accent}`);
		const header = colEl.createDiv({ cls: "tg-column-header" });
		setIcon(header.createSpan({ cls: "tg-column-icon" }), col.icon);
		header.createSpan({ cls: "tg-column-title", text: col.title });
		header.createSpan({ cls: "tg-column-count", text: String(col.tasks.filter((t) => t.status !== "completed").length) });
		if (col.newDefaults) {
			const add = header.createEl("button", { cls: "clickable-icon tg-column-add", attr: { "aria-label": `Add task to ${col.title}` } });
			setIcon(add, "plus");
			add.addEventListener("click", () => plugin.openTaskModal(undefined, col.newDefaults));
		}

		const list = colEl.createDiv({ cls: "tg-column-cards" });
		const sorted = [...col.tasks].sort(byDueThenPosition);
		for (const t of sorted) {
			renderCard(list, plugin, t, { showList: plugin.settings.grouping !== "list", draggable: true, checkbox: true });
		}
		if (!sorted.length) list.createDiv({ cls: "tg-column-empty", text: col.onDrop ? "Drop tasks here" : "Nothing here" });

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
				if (task.parent && plugin.settings.grouping === "list") new Notice("Subtask moved to the other list as a top-level task.");
				onDrop(task);
			});
		}
	}
}
