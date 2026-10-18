import type { DayColumn, TaskGiftSettings } from "./types";
import { friendlyDate, isDateString, shortDate, today } from "./util/dates";

export function newDayColumnId(): string {
	return `day-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Board column key, also used for its saved sort. */
export function dayColumnKey(c: DayColumn): string {
	return `day:${c.id}`;
}

function isExpired(c: DayColumn, t: string): boolean {
	return c.autoRemove && c.date < t;
}

/** Day columns still shown, in date order. */
export function visibleDayColumns(s: TaskGiftSettings): DayColumn[] {
	const t = today();
	return s.dayColumns.filter((c) => !isExpired(c, t)).sort((a, b) => a.date.localeCompare(b.date));
}

/** Drops columns whose day is over (when set to). Returns true if something was removed. */
export function pruneDayColumns(s: TaskGiftSettings): boolean {
	const t = today();
	const expired = s.dayColumns.filter((c) => isExpired(c, t));
	if (!expired.length) return false;
	for (const c of expired) delete s.columnSort[dayColumnKey(c)];
	s.dayColumns = s.dayColumns.filter((c) => !isExpired(c, t));
	return true;
}

/** Column title: its name, or a friendly date ("Tomorrow", "Friday", "Oct 20"). */
export function dayColumnTitle(c: DayColumn): string {
	const friendly = friendlyDate(c.date);
	const short = shortDate(c.date);
	if (c.title) return `${c.title} · ${short}`;
	return friendly === short ? short : `${friendly} · ${short}`;
}

export function normalizeDayColumns(raw: unknown): DayColumn[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((c): c is DayColumn => !!c && typeof c === "object" && isDateString(String((c as DayColumn).date)))
		.map((c) => ({
			id: typeof c.id === "string" && c.id ? c.id : newDayColumnId(),
			date: c.date,
			title: typeof c.title === "string" ? c.title : "",
			autoRemove: c.autoRemove !== false,
		}));
}
