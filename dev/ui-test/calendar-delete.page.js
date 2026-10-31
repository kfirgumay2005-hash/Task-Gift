import { renderCalendar } from "../../src/views/calendar";

window.errors = [];
window.addEventListener("error", (e) => window.errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.errors.push(String(e.reason)));

// Just what the calendar view uses; `removed` lists the calendars really deleted.
const cal = (name) => ({ path: `Calendars/${name}.md`, name, color: "blue", entries: [{ date: "2026-10-15", start: null, end: null, title: "x", notes: "", done: false }] });
const list = [cal("Shifts"), cal("Trips")];
window.removed = [];
window.ui = { anchor: "2026-10-15", calendar: null };
const calendars = {
	all: () => [...list],
	get: (path) => list.find((c) => c.path === path) ?? null,
	remove: async (c) => {
		list.splice(list.indexOf(c), 1);
		window.removed.push(c.name);
	},
};
const plugin = {
	app: {},
	calendars,
	settings: { calendarRange: "month", weekStart: 0, collapsedColumns: [] },
	store: { all: () => [], rule: () => null, time: () => null },
};
window.draw = () => {
	document.querySelector(".tg-root")?.remove();
	const root = document.body.createDiv("tg-root");
	try {
		renderCalendar(root, plugin, window.ui, window.draw);
	} catch (e) {
		window.errors.push(String(e && e.stack));
	}
};
window.draw();
