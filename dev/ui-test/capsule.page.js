import { DEFAULT_DAY_TITLE, DayTitleModal } from "../../src/modals/DayTitleModal";
import { CapsuleModal } from "../../src/modals/CapsuleModal";
import { TaskStore } from "../../src/sync/store";
import { emptyStore } from "../../src/defaults";
import { addDays, today } from "../../src/util/dates";

window.errors = [];
window.addEventListener("error", (e) => window.errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.errors.push(String(e.reason && e.reason.stack)));
window.store = new TaskStore(emptyStore(), () => {});
window.today = today();
window.inWeek = addDays(today(), 7);
window.addDays = addDays;
// A tiny vault: saved files are kept as blob URLs.
window.files = {};
window.opened = null;
const media = {
	save: async (file) => {
		const path = "Images/" + file.name;
		window.files[path] = URL.createObjectURL(file);
		return path;
	},
	url: (path) => window.files[path] ?? null,
	open: (path) => (window.opened = path),
};
window.touched = 0;
const capsules = {
	pending: () => store.pendingCapsules(today()),
	add: (fields) => {
		store.addCapsule(fields);
		window.touched++;
	},
	remove: (id) => {
		store.deleteCapsule(id);
		window.touched++;
	},
	media,
};
window.makePng = (w, h, name) =>
	new Promise((resolve) => {
		const c = document.createElement("canvas");
		c.width = w;
		c.height = h;
		c.getContext("2d").fillRect(0, 0, w, h);
		c.toBlob((b) => resolve(new File([b], name, { type: "image/png" })), "image/png");
	});
window.dropFiles = (el, files) => {
	const dt = new DataTransfer();
	for (const f of files) dt.items.add(f);
	el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
	el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
};
window.openTopic = () => {
	const palette = { custom: [], save: () => {} };
	new DayTitleModal({}, today(), { ...DEFAULT_DAY_TITLE, text: "Exam" }, palette, (t) => (window.saved = t), undefined, capsules).open();
};
window.openCapsules = (list) => new CapsuleModal({}, list, media).open();
window.closeAll = () => document.querySelectorAll(".modal-container").forEach((m) => m.remove());
try {
	window.openTopic();
} catch (e) {
	window.errors.push(String(e && e.stack));
}
