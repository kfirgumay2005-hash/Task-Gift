import type { RecurrencePreset, RecurrenceRule, Weekday } from "../types";
import {
	addDays,
	addMonths,
	daysInMonth,
	diffDays,
	MONTH_SHORT,
	ordinal,
	parseDate,
	startOfWeek,
	toDateString,
	WEEKDAY_LONG,
	WEEKDAY_SHORT,
	weekday,
} from "../util/dates";

/** Which "Nth weekday" a date is in its month: 1..4, or -1 if it is the last one (and 5th). */
export function nthOfMonth(date: string): number {
	return Math.ceil(parseDate(date).getDate() / 7);
}

export function isLastWeekdayOfMonth(date: string): boolean {
	const d = parseDate(date);
	return d.getDate() + 7 > daysInMonth(d.getFullYear(), d.getMonth());
}

/** Builds a rule from a preset, using the due date for sensible defaults. */
export function ruleFromPreset(preset: Exclude<RecurrencePreset, "custom">, due: string): RecurrenceRule {
	const d = parseDate(due);
	return {
		preset,
		freq: preset,
		interval: 1,
		byWeekday: [d.getDay() as Weekday],
		monthlyMode: "day",
		monthDay: d.getDate(),
		nth: Math.min(4, nthOfMonth(due)),
		nthWeekday: d.getDay() as Weekday,
		end: { type: "never" },
		occurrence: 1,
		anchor: due,
	};
}

function nthWeekdayOf(year: number, month0: number, nth: number, wd: number): string {
	if (nth === -1) {
		const last = new Date(year, month0, daysInMonth(year, month0));
		const back = (last.getDay() - wd + 7) % 7;
		last.setDate(last.getDate() - back);
		return toDateString(last);
	}
	const first = new Date(year, month0, 1);
	const offset = (wd - first.getDay() + 7) % 7;
	const day = 1 + offset + (nth - 1) * 7;
	// Clamp a non-existent 5th weekday to the last one.
	if (day > daysInMonth(year, month0)) return nthWeekdayOf(year, month0, -1, wd);
	return toDateString(new Date(year, month0, day));
}

function monthIndex(date: string): number {
	const d = parseDate(date);
	return d.getFullYear() * 12 + d.getMonth();
}

/** "after" mode: the rule's date belonging to month `index` (year * 12 + month); it may fall in the next month. */
function afterDateOf(rule: RecurrenceRule, index: number): string {
	const year = Math.floor(index / 12);
	const month0 = index % 12;
	const start = Math.min(Math.max(1, rule.afterDay ?? 1), daysInMonth(year, month0)) + (rule.afterInclusive ? 0 : 1);
	const offset = (rule.nthWeekday - new Date(year, month0, start).getDay() + 7) % 7;
	return toDateString(new Date(year, month0, start + offset + (Math.max(1, rule.nth) - 1) * 7));
}

/** The month an "after" date belongs to (the 10th's Monday can be in the next month). */
function afterMonthOf(rule: RecurrenceRule, date: string): number {
	const m = monthIndex(date);
	return afterDateOf(rule, m - 1) === date ? m - 1 : m;
}

/** "after" mode: the first matching date after `from`, in a month that is a multiple of the interval from the anchor's. */
function nextAfterDate(rule: RecurrenceRule, from: string, interval: number): string {
	const anchorMonth = afterMonthOf(rule, rule.anchor || from);
	for (let m = monthIndex(from) - 1; ; m++) {
		if ((((m - anchorMonth) % interval) + interval) % interval !== 0) continue;
		const cand = afterDateOf(rule, m);
		if (cand > from) return cand;
	}
}

/** The first date on or after `date` that fits the rule's pattern (used to place a new "after" rule's due date). */
export function firstMatchOnOrAfter(rule: RecurrenceRule, date: string): string {
	if (rule.freq !== "monthly" || rule.monthlyMode !== "after") return date;
	return nextAfterDate({ ...rule, anchor: "" }, addDays(date, -1), 1);
}

/** Computes the due date after `from` for the rule, ignoring end conditions. */
export function computeNext(rule: RecurrenceRule, from: string): string {
	const interval = Math.max(1, Math.floor(rule.interval) || 1);
	switch (rule.freq) {
		case "daily":
			return addDays(from, interval);
		case "weekly": {
			const days = rule.byWeekday.length ? rule.byWeekday : [weekday(from) as Weekday];
			const anchorWeek = startOfWeek(rule.anchor || from, 0);
			for (let i = 1; i <= 7 * interval * 2 + 7; i++) {
				const cand = addDays(from, i);
				if (!days.includes(weekday(cand) as Weekday)) continue;
				const weeks = Math.floor(diffDays(startOfWeek(cand, 0), anchorWeek) / 7);
				if (((weeks % interval) + interval) % interval === 0) return cand;
			}
			return addDays(from, 7 * interval);
		}
		case "monthly": {
			if (rule.monthlyMode === "after") return nextAfterDate(rule, from, interval);
			if (rule.monthlyMode === "nth") {
				const d = parseDate(from);
				const total = d.getFullYear() * 12 + d.getMonth() + interval;
				return nthWeekdayOf(Math.floor(total / 12), total % 12, rule.nth, rule.nthWeekday);
			}
			return addMonths(from, interval, rule.monthDay || parseDate(from).getDate());
		}
		case "yearly":
			return addMonths(from, 12 * interval, parseDate(rule.anchor || from).getDate());
	}
}

/**
 * Returns the next occurrence's due date and rule, or null if the series has ended.
 * Occurrences before `notBefore` (missed while the task was overdue) are skipped, but still
 * count towards an "after N occurrences" end, like in Google Calendar.
 */
export function nextOccurrence(
	rule: RecurrenceRule,
	currentDue: string,
	notBefore?: string,
): { due: string; rule: RecurrenceRule } | null {
	let due = currentDue;
	let occurrence = rule.occurrence;
	for (let i = 0; i < 10000; i++) {
		due = computeNext(rule, due);
		occurrence++;
		if (rule.end.type === "count" && occurrence > rule.end.count) return null;
		if (rule.end.type === "until" && due > rule.end.date) return null;
		if (!notBefore || due >= notBefore) break;
	}
	return { due, rule: { ...rule, occurrence } };
}

/**
 * Upcoming due dates after `currentDue` that fall in [from, to], honouring the rule's end.
 * Only used for display (calendar): no task is created for them.
 */
export function occurrencesBetween(rule: RecurrenceRule, currentDue: string, from: string, to: string, limit = 400): string[] {
	const out: string[] = [];
	let due = currentDue;
	let occurrence = rule.occurrence;
	for (let i = 0; i < 5000 && out.length < limit; i++) {
		due = computeNext(rule, due);
		occurrence++;
		if (rule.end.type === "count" && occurrence > rule.end.count) break;
		if (rule.end.type === "until" && due > rule.end.date) break;
		if (due > to) break;
		if (due >= from) out.push(due);
	}
	return out;
}

export function describeRule(rule: RecurrenceRule): string {
	const n = Math.max(1, rule.interval);
	const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rule.freq];
	let s = n === 1 ? (rule.freq === "daily" ? "daily" : `${rule.freq}`) : `every ${n} ${unit}s`;
	if (rule.freq === "weekly" && rule.byWeekday.length) {
		const days = [...rule.byWeekday].sort().map((d) => WEEKDAY_SHORT[d]);
		s += ` on ${days.join(", ")}`;
	} else if (rule.freq === "monthly") {
		if (rule.monthlyMode === "after") {
			const which = `${ordinal(Math.max(1, rule.nth))} ${WEEKDAY_LONG[rule.nthWeekday]}`;
			s += ` on the ${which} ${rule.afterInclusive ? "on or after" : "after"} day ${rule.afterDay ?? 1}`;
		} else s += rule.monthlyMode === "nth" ? ` on the ${ordinal(rule.nth)} ${WEEKDAY_LONG[rule.nthWeekday]}` : ` on day ${rule.monthDay}`;
	} else if (rule.freq === "yearly" && rule.anchor) {
		const a = parseDate(rule.anchor);
		s += ` on ${MONTH_SHORT[a.getMonth()]} ${a.getDate()}`;
	}
	if (rule.end.type === "count") s += `, ${rule.end.count} times`;
	if (rule.end.type === "until") s += `, until ${rule.end.date}`;
	return s;
}
