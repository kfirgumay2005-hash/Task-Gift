import { DEFAULT_DAY_TITLE, DayTitleModal } from "../../src/modals/DayTitleModal";

window.errors = [];
window.addEventListener("error", (e) => window.errors.push(String(e.message)));
window.saved = null;
try {
	window.savedPalette = null;
	const palette = { custom: ["#123456"], save: (list) => (window.savedPalette = list) };
	new DayTitleModal({}, "2026-10-21", { ...DEFAULT_DAY_TITLE }, palette, (t) => (window.saved = t)).open();
} catch (e) {
	window.errors.push(String(e && e.stack));
}
