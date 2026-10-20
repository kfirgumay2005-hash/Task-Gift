import { DEFAULT_DAY_TITLE, DayTitleModal } from "../../src/modals/DayTitleModal";

window.errors = [];
window.addEventListener("error", (e) => window.errors.push(String(e.message)));
window.saved = null;
try {
	new DayTitleModal({}, "2026-10-21", { ...DEFAULT_DAY_TITLE }, (t) => (window.saved = t)).open();
} catch (e) {
	window.errors.push(String(e && e.stack));
}
