import type { DateFilter, DatePreset, Task, TaskGiftSettings } from "../types";
import { addDays, startOfWeek, today } from "../util/dates";
import { activeMode } from "../modes";

export const PRESET_LABELS: Record<DatePreset, string> = {
	all: "Any date",
	yesterday: "Yesterday",
	today: "Today",
	tomorrow: "Tomorrow",
	thisWeek: "This week",
	next7: "Next 7 days",
	overdue: "Overdue",
	noDate: "No due date",
	custom: "Custom range",
};

export const QUICK_COMBOS: { label: string; presets: DatePreset[] }[] = [
	{ label: "Yesterday + Today", presets: ["yesterday", "today"] },
	{ label: "Today + Tomorrow", presets: ["today", "tomorrow"] },
	{ label: "Overdue + Today + Tomorrow", presets: ["overdue", "today", "tomorrow"] },
];

type Range = [string, string];

function rangesFor(filter: DateFilter, weekStart: number, t: string): Range[] {
	const out: Range[] = [];
	for (const p of filter.presets) {
		switch (p) {
			case "yesterday": {
				const y = addDays(t, -1);
				out.push([y, y]);
				break;
			}
			case "today":
				out.push([t, t]);
				break;
			case "tomorrow": {
				const tm = addDays(t, 1);
				out.push([tm, tm]);
				break;
			}
			case "thisWeek": {
				const s = startOfWeek(t, weekStart);
				out.push([s, addDays(s, 6)]);
				break;
			}
			case "next7":
				out.push([t, addDays(t, 6)]);
				break;
			case "custom":
				out.push([addDays(t, -Math.max(0, filter.customFrom)), addDays(t, Math.max(0, filter.customTo))]);
				break;
			default:
				break;
		}
	}
	return out;
}

/** True when the task's due date passes the date filter. */
export function matchesDateFilter(task: Task, filter: DateFilter | null, weekStart: number): boolean {
	if (!filter || filter.presets.includes("all") || filter.presets.length === 0 && !filter.includeOverdue && !filter.includeNoDate) {
		return true;
	}
	const t = today();
	if (!task.due) return filter.includeNoDate || filter.presets.includes("noDate");
	if (task.due < t && task.status !== "completed" && (filter.includeOverdue || filter.presets.includes("overdue"))) return true;
	return rangesFor(filter, weekStart, t).some(([a, b]) => task.due !== null && task.due >= a && task.due <= b);
}

/** The date filter in effect: the active mode's, or null when the board shows every date. */
export function filterFor(settings: TaskGiftSettings, view: "board" | "gift"): DateFilter | null {
	const mode = activeMode(settings);
	return view === "gift" || mode.applyToBoard ? mode.filter : null;
}

export function isListIncluded(settings: TaskGiftSettings, listId: string, view: "board" | "gift"): boolean {
	const mode = activeMode(settings);
	if (view === "board" && !mode.applyToBoard) return true;
	return mode.includedLists === null || mode.includedLists.includes(listId);
}

/** True when the task's description contains one of the active mode's exclusion words (case-insensitive). */
export function isExcludedFromGift(settings: TaskGiftSettings, task: Task): boolean {
	const notes = task.notes.toLowerCase();
	return activeMode(settings).excludeKeywords.some((k) => k && notes.includes(k.toLowerCase()));
}

export function describeFilter(filter: DateFilter): string {
	if (filter.presets.includes("all")) return "Any date";
	const parts = filter.presets.map((p) => (p === "custom" ? `${filter.customFrom}d ago → ${filter.customTo}d ahead` : PRESET_LABELS[p]));
	if (filter.includeOverdue && !filter.presets.includes("overdue")) parts.push("overdue");
	if (filter.includeNoDate && !filter.presets.includes("noDate")) parts.push("no date");
	return parts.length ? parts.join(" + ") : "Any date";
}
