import type TaskGiftPlugin from "../main";
import type { Task } from "../types";
import { matchesQuery } from "./board";
import { renderCard } from "./card";

const MAX_RESULTS = 300;

/** Open tasks first (by due date, undated last), then completed ones (most recently completed first). */
function byRelevance(a: Task, b: Task): number {
	const ad = a.status === "completed";
	const bd = b.status === "completed";
	if (ad !== bd) return ad ? 1 : -1;
	if (ad) return (b.completed ?? "").localeCompare(a.completed ?? "");
	const ax = a.due ?? "9999-99-99";
	const bx = b.due ?? "9999-99-99";
	if (ax !== bx) return ax < bx ? -1 : 1;
	return a.position.localeCompare(b.position);
}

/** Results of the header search: every task in every list, whatever its date, mode or status. */
export function renderSearchResults(container: HTMLElement, plugin: TaskGiftPlugin, query: string): void {
	const wrap = container.createDiv({ cls: "tg-search-results" });
	const q = query.trim();
	const matches = plugin.store
		.all()
		.filter((t) => matchesQuery(t, q))
		.sort(byRelevance);

	const head = wrap.createDiv({ cls: "tg-search-head" });
	head.createSpan({ cls: "tg-search-count", text: `${matches.length} ${matches.length === 1 ? "task" : "tasks"} matching “${q}”` });
	head.createSpan({ cls: "tg-search-scope", text: "All lists, dates and completed tasks kept locally" });

	if (!matches.length) {
		const empty = wrap.createDiv({ cls: "tg-empty" });
		empty.createDiv({ cls: "tg-empty-emoji", text: "🔍" });
		empty.createDiv({ text: "No tasks match." });
		return;
	}
	const list = wrap.createDiv({ cls: "tg-search-list" });
	for (const t of matches.slice(0, MAX_RESULTS)) renderCard(list, plugin, t, { showList: true, draggable: false, checkbox: true, notesLines: 3, colorIn: plugin.settings.boardView });
	if (matches.length > MAX_RESULTS) list.createDiv({ cls: "tg-column-empty", text: `Showing the first ${MAX_RESULTS}. Type more to narrow down.` });
}
