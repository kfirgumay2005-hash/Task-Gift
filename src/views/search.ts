import type TaskGiftPlugin from "../main";
import type { Task } from "../types";
import { occurrencesBetween } from "../recurrence/rule";
import { addDays, today } from "../util/dates";
import { matchesQuery } from "./board";
import { renderCard } from "./card";

const MAX_RESULTS = 300;
/** Upcoming repeats shown per repeating task, as if each one were done on its day; a series never ending stays short. */
const UPCOMING_REPEATS = 3;

interface Result {
	task: Task;
	/** Set for an upcoming repeat of the task (computed, not a task yet): its date. */
	upcoming?: string;
}

const dateOf = (r: Result): string => r.upcoming ?? r.task.due ?? "9999-99-99";

/** Open tasks and upcoming repeats first (by date, undated last), then completed ones (most recently completed first). */
function byRelevance(a: Result, b: Result): number {
	const ad = a.task.status === "completed";
	const bd = b.task.status === "completed";
	if (ad !== bd) return ad ? 1 : -1;
	if (ad) return (b.task.completed ?? "").localeCompare(a.task.completed ?? "");
	const ax = dateOf(a);
	const bx = dateOf(b);
	if (ax !== bx) return ax < bx ? -1 : 1;
	if (!a.upcoming !== !b.upcoming) return a.upcoming ? 1 : -1;
	return a.task.position.localeCompare(b.task.position);
}

/** Results of the header search: every task in every list, whatever its date, mode or status, and the next repeats. */
export function renderSearchResults(container: HTMLElement, plugin: TaskGiftPlugin, query: string): void {
	const wrap = container.createDiv({ cls: "tg-search-results" });
	const q = query.trim();
	const t0 = today();
	const results: Result[] = [];
	let upcomingCount = 0;
	for (const task of plugin.store.all()) {
		if (!matchesQuery(task, q)) continue;
		results.push({ task });
		const rule = task.status !== "completed" && task.due ? plugin.store.rule(task.id) : null;
		if (!rule || !task.due) continue;
		// Like the calendar: missed repeats are skipped when an overdue task is completed, so only from today on.
		const from = task.due < t0 ? t0 : addDays(task.due, 1);
		for (const date of occurrencesBetween(rule, task.due, from, "9999-12-31", UPCOMING_REPEATS)) {
			results.push({ task, upcoming: date });
			upcomingCount++;
		}
	}
	results.sort(byRelevance);
	const taskCount = results.length - upcomingCount;

	const head = wrap.createDiv({ cls: "tg-search-head" });
	const repeats = upcomingCount ? ` and ${upcomingCount} upcoming ${upcomingCount === 1 ? "repeat" : "repeats"}` : "";
	head.createSpan({ cls: "tg-search-count", text: `${taskCount} ${taskCount === 1 ? "task" : "tasks"}${repeats} matching “${q}”` });
	head.createSpan({ cls: "tg-search-scope", text: `All lists, dates and completed tasks kept locally, and the next ${UPCOMING_REPEATS} repeats of repeating tasks` });

	if (!results.length) {
		const empty = wrap.createDiv({ cls: "tg-empty" });
		empty.createDiv({ cls: "tg-empty-emoji", text: "🔍" });
		empty.createDiv({ text: "No tasks match." });
		return;
	}
	const list = wrap.createDiv({ cls: "tg-search-list" });
	for (const r of results.slice(0, MAX_RESULTS)) {
		renderCard(list, plugin, r.task, { showList: true, draggable: false, checkbox: true, notesLines: 3, colorIn: plugin.settings.boardView, upcoming: r.upcoming });
	}
	if (results.length > MAX_RESULTS) list.createDiv({ cls: "tg-column-empty", text: `Showing the first ${MAX_RESULTS}. Type more to narrow down.` });
}
