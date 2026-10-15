/** Helpers for local calendar dates represented as YYYY-MM-DD strings. */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateString(s: string): boolean {
	return DATE_RE.test(s);
}

export function toDateString(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function parseDate(s: string): Date {
	const [y, m, d] = s.split("-").map(Number);
	return new Date(y, m - 1, d);
}

export function today(): string {
	return toDateString(new Date());
}

export function addDays(s: string, n: number): string {
	const d = parseDate(s);
	d.setDate(d.getDate() + n);
	return toDateString(d);
}

export function daysInMonth(year: number, month0: number): number {
	return new Date(year, month0 + 1, 0).getDate();
}

/** Adds months, clamping the day to the target month's length. */
export function addMonths(s: string, n: number, day?: number): string {
	const d = parseDate(s);
	const targetDay = day ?? d.getDate();
	const total = d.getFullYear() * 12 + d.getMonth() + n;
	const y = Math.floor(total / 12);
	const m = total % 12;
	return toDateString(new Date(y, m, Math.min(targetDay, daysInMonth(y, m))));
}

export function weekday(s: string): number {
	return parseDate(s).getDay();
}

export function startOfWeek(s: string, weekStart: number): string {
	const wd = weekday(s);
	const diff = (wd - weekStart + 7) % 7;
	return addDays(s, -diff);
}

export function diffDays(a: string, b: string): number {
	return Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / 86400000);
}

/** Google returns due as RFC 3339 at midnight UTC; the date part is the intended date. */
export function fromGoogleDue(due: string | undefined): string | null {
	if (!due) return null;
	return due.slice(0, 10);
}

export function toGoogleDue(due: string | null): string | null {
	return due ? `${due}T00:00:00.000Z` : null;
}

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ordinal(n: number): string {
	if (n === -1) return "last";
	const s = ["th", "st", "nd", "rd"];
	const v = n % 100;
	return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Friendly label: Today, Tomorrow, Yesterday, weekday within a week, or "Oct 16". */
export function friendlyDate(s: string): string {
	const t = today();
	const delta = diffDays(s, t);
	if (delta === 0) return "Today";
	if (delta === 1) return "Tomorrow";
	if (delta === -1) return "Yesterday";
	const d = parseDate(s);
	if (delta > 1 && delta < 7) return WEEKDAY_LONG[d.getDay()];
	const base = `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
	return d.getFullYear() === new Date().getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}
