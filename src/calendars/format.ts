import { daysInMonth, isDateString, parseDate, today, toDateString } from "../util/dates";

/** One entry of an extra calendar (e.g. a shift). Lives only in the calendar's note, never in Google Tasks. */
export interface CalendarEntry {
	/** YYYY-MM-DD */
	date: string;
	/** HH:MM, or null for an all-day entry. */
	start: string | null;
	/** HH:MM; earlier than start means it ends the next day (night shift). */
	end: string | null;
	title: string;
	/** Description, may span several lines. */
	notes: string;
	done: boolean;
}

export interface ParseResult {
	entries: CalendarEntry[];
	/** Non-empty lines that were neither an entry nor a description (e.g. an AI's "Here are your shifts:"). */
	skipped: string[];
}

/** List bullet ("- ", "* ", "1. ") and task checkbox ("[ ] ", "[x] ") in front of an entry. */
const BULLET_RE = /^(?:[-*+•]\s+|\d+[.)]\s+)?(?:\[([ xX])\]\s*)?/;
/** A weekday name in front of the date ("Sunday 18/10", "יום ראשון 18/10"). */
const WEEKDAY_RE =
	/^(?:(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?|(?:יום\s+)?(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|יום\s+[א-ו]'?)[,.]?\s+/i;
const ISO_DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?![\d/.-])/;
/** 18/10, 18/10/2026, 18.10.26 (day first). */
const DMY_DATE_RE = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?(?![\d/.])/;
const TIME_RANGE_RE = /^[\s,]*(\d{1,2})[:.](\d{2})(?:\s*(?:-|–|—|to|עד)\s*(\d{1,2})[:.](\d{2}))?(?!\d)/i;
/** Separator between date / time and the title. */
const TITLE_SEP_RE = /^[\s,]*(?:[|:–—-]\s*)?/;

function validDate(y: number, m: number, d: number): string | null {
	if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m - 1)) return null;
	return toDateString(new Date(y, m - 1, d));
}

/** Without a year, the year that puts the date closest to today. */
function nearestYear(m: number, d: number): string | null {
	const now = parseDate(today()).getTime();
	const y = new Date().getFullYear();
	let best: string | null = null;
	for (const year of [y - 1, y, y + 1]) {
		const date = validDate(year, m, d);
		if (!date) continue;
		if (best === null || Math.abs(parseDate(date).getTime() - now) < Math.abs(parseDate(best).getTime() - now)) best = date;
	}
	return best;
}

function hhmm(h: string, m: string): string | null {
	const hour = Number(h);
	const min = Number(m);
	if (hour > 24 || min > 59 || (hour === 24 && min > 0)) return null;
	return `${String(hour).padStart(2, "0")}:${m}`;
}

/** Reads a line that starts an entry; null when the line doesn't start with a date. */
function parseEntryLine(line: string): CalendarEntry | null {
	let rest = line.trim();
	const bullet = BULLET_RE.exec(rest);
	const done = !!bullet?.[1] && bullet[1].toLowerCase() === "x";
	if (bullet) rest = rest.slice(bullet[0].length);
	rest = rest.replace(/^\*\*|\*\*(?=\s)/g, "");
	rest = rest.replace(WEEKDAY_RE, "");

	let date: string | null = null;
	const iso = ISO_DATE_RE.exec(rest);
	const dmy = iso ? null : DMY_DATE_RE.exec(rest);
	if (iso) date = validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
	else if (dmy) {
		const d = Number(dmy[1]);
		const m = Number(dmy[2]);
		if (dmy[3]) {
			const y = Number(dmy[3]);
			date = validDate(y < 100 ? 2000 + y : y, m, d);
		} else date = nearestYear(m, d);
	}
	const match = iso ?? dmy;
	if (!date || !match) return null;
	rest = rest.slice(match[0].length);

	let start: string | null = null;
	let end: string | null = null;
	const time = TIME_RANGE_RE.exec(rest);
	if (time) {
		start = hhmm(time[1], time[2]);
		end = time[3] !== undefined ? hhmm(time[3], time[4]) : null;
		if (start) rest = rest.slice(time[0].length);
		else end = null;
	}
	rest = rest.replace(TITLE_SEP_RE, "");

	// "Title | description" on one line.
	let notes = "";
	const bar = rest.indexOf(" | ");
	if (bar !== -1) {
		notes = rest.slice(bar + 3).trim();
		rest = rest.slice(0, bar);
	}
	return { date, start, end, title: rest.replace(/\*\*/g, "").trim(), notes, done };
}

/**
 * Turns free text into calendar entries. An entry is a line starting with a date (optionally a time or time range,
 * then the title); the other indented or "> " lines below it are its description. Bullets, checkboxes, weekday names,
 * headings, code fences and chatter around the list are tolerated.
 */
export function parseEntries(text: string): ParseResult {
	const entries: CalendarEntry[] = [];
	const skipped: string[] = [];
	let cur: CalendarEntry | null = null;
	/** A blank line was seen since the current entry's last line. */
	let gap = false;

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/\s+$/, "");
		const trimmed = line.trim();
		if (!trimmed) {
			gap = true;
			continue;
		}
		if (/^(```|~~~|#|%%|---$)/.test(trimmed)) {
			cur = null;
			continue;
		}
		const indented = /^(\s{2,}|\t)/.test(line);
		const quoted = trimmed.startsWith(">");
		// A line starting with a date is a new entry even when indented (pasted lists are often indented as a whole).
		const entry = quoted ? null : parseEntryLine(line);
		if (entry) {
			// The entry's own line repeated right below it (e.g. a heading copied along) is not another entry.
			if (cur && !cur.notes && !entry.notes && sameSlot(cur, entry)) continue;
			entries.push(entry);
			cur = entry;
			gap = false;
			continue;
		}
		if (cur && (indented || quoted)) {
			const textLine = trimmed.replace(/^>\s?/, "");
			cur.notes = cur.notes ? `${cur.notes}\n${textLine}` : textLine;
			gap = false;
			continue;
		}
		// Plain text right below an entry (no blank line between) also belongs to its description.
		if (cur && !gap) {
			cur.notes = cur.notes ? `${cur.notes}\n${trimmed}` : trimmed;
			continue;
		}
		cur = null;
		skipped.push(trimmed);
	}
	// The same entry twice (same slot and description) is kept once.
	const unique: CalendarEntry[] = [];
	for (const e of entries) {
		const twin = unique.find((u) => sameSlot(u, e) && u.notes === e.notes);
		if (twin) twin.done ||= e.done;
		else unique.push(e);
	}
	return { entries: unique, skipped };
}

export function compareEntries(a: CalendarEntry, b: CalendarEntry): number {
	if (a.date !== b.date) return a.date < b.date ? -1 : 1;
	const at = a.start ?? "";
	const bt = b.start ?? "";
	if (at !== bt) return at < bt ? -1 : 1;
	return a.title.localeCompare(b.title);
}

export function timeLabel(e: CalendarEntry): string {
	if (!e.start) return "";
	return e.end ? `${e.start}–${e.end}` : e.start;
}

/** One entry in the note's own format, the same format the import reads. */
export function formatEntry(e: CalendarEntry): string {
	const time = e.start ? ` ${e.end ? `${e.start}-${e.end}` : e.start}` : "";
	const head = `- [${e.done ? "x" : " "}] ${e.date}${time} ${e.title.replace(/\s*\n\s*/g, " ").trim()}`;
	const notes = e.notes
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l)
		.map((l) => `    ${l}`);
	return [head, ...notes].join("\n");
}

function sameSlot(a: CalendarEntry, b: CalendarEntry): boolean {
	return a.date === b.date && a.start === b.start && a.end === b.end && a.title === b.title;
}

/**
 * Adds imported entries. With `replaceDays`, entries already on the imported days are replaced (re-importing an
 * updated weekly schedule doesn't duplicate it); an entry that comes back unchanged keeps its done mark.
 */
export function mergeEntries(existing: CalendarEntry[], incoming: CalendarEntry[], replaceDays: boolean): CalendarEntry[] {
	const days = new Set(incoming.map((e) => e.date));
	const removed = replaceDays ? existing.filter((e) => days.has(e.date)) : [];
	const result = replaceDays ? existing.filter((e) => !days.has(e.date)) : [...existing];
	for (const e of incoming) {
		if (result.some((r) => sameSlot(r, e) && r.notes === e.notes)) continue;
		const before = removed.find((r) => sameSlot(r, e));
		result.push({ ...e, done: e.done || (before?.done ?? false) });
	}
	return result.sort(compareEntries);
}

export function isValidEntry(e: CalendarEntry): boolean {
	return isDateString(e.date) && e.title.trim() !== "";
}
