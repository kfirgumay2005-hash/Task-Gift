import { Component, TFile } from "obsidian";
import { TaskStore } from "../../src/sync/store";
import { DEFAULT_STICKY_COMMANDS, emptyStore } from "../../src/defaults";
import { renderStickies } from "../../src/views/stickies";

window.errors = [];
window.addEventListener("error", (e) => window.errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.errors.push(String(e.reason && e.reason.stack)));
const store = new TaskStore(emptyStore(), () => {});
const ui = { queries: new Map(), searchOpen: new Set(), zoomDelta: 0 };
document.body.style.margin = "0";
const host = document.body.createDiv();
host.style.height = "700px";
let owner = null;
const draw = () => {
	const active = document.activeElement?.classList.contains("tg-sticky-text") ? document.activeElement.dataset.sticky : undefined;
	ui.focusSticky = active ?? ui.focusSticky;
	host.empty();
	const b = host.createDiv({ cls: "tg-board" });
	b.style.setProperty("--tg-zoom", String(plugin.settings.boardZoom / 100));
	b.createDiv({ cls: "tg-column" }).style.flexBasis = "200px";
	owner?.unload();
	owner = new Component();
	owner.load();
	renderStickies(b, plugin, ui, owner);
	if (ui.focusSticky) document.querySelector(`.tg-sticky-text[data-sticky="${ui.focusSticky}"]`)?.focus();
	ui.focusSticky = undefined;
};

// A tiny vault: files are kept as blob URLs so <img> can show them.
window.files = {};
window.trashed = [];
const fileAt = (path) => {
	const f = window.files[path];
	if (!f) return null;
	return Object.assign(new TFile(), { path, name: path.split("/").pop(), basename: path.split("/").pop().replace(/\.[^.]*$/, "") });
};
const vault = {
	getAbstractFileByPath: (p) => fileAt(p) ?? (Object.keys(window.files).some((k) => k.startsWith(p + "/")) || window.folders.has(p) ? {} : null),
	createFolder: async (p) => void window.folders.add(p),
	createBinary: async (p, buf) => {
		if (window.files[p]) throw new Error("exists");
		window.files[p] = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
	},
	getResourcePath: (f) => window.files[f.path],
};
window.folders = new Set();
const app = {
	vault,
	// Like Obsidian with "Images" as the attachment folder: a free name in that folder.
	fileManager: {
		getAvailablePathForAttachment: async (name) => {
			const dot = name.lastIndexOf(".");
			let p = "Images/" + name;
			for (let i = 1; window.files[p]; i++) p = `Images/${name.slice(0, dot)} ${i}${name.slice(dot)}`;
			return p;
		},
		trashFile: async (f) => { window.trashed.push(f.path); delete window.files[f.path]; },
	},
	workspace: { getLeaf: () => ({ openFile: async (f) => (window.opened = f.path) }) },
	commands: { commands: {}, executeCommandById: () => true },
};
const plugin = {
	app,
	store,
	settings: { stickyImagesLocation: "plugin", boardZoom: 100, stickyCommands: DEFAULT_STICKY_COMMANDS.map((c) => ({ ...c })) },
	touch: draw,
	refreshViews: draw,
	saveLater: () => {},
	stickyImagesFolder: () => "ארכיון/Tasksgift/Sticky images",
};

/** A real PNG file of the given size, as a dropped or pasted picture would be. */
window.makePng = (w, h, name) =>
	new Promise((resolve) => {
		const c = document.createElement("canvas");
		c.width = w;
		c.height = h;
		const g = c.getContext("2d");
		g.fillStyle = "#e93147";
		g.fillRect(0, 0, w, h);
		c.toBlob((b) => resolve(new File([b], name, { type: "image/png" })), "image/png");
	});
/** Drops files on an element at (x, y), as the system's drag and drop does. */
window.dropFiles = (el, files, x, y) => {
	const dt = new DataTransfer();
	for (const f of files) dt.items.add(f);
	el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
	el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
};
window.pasteFiles = (el, files) => {
	const dt = new DataTransfer();
	for (const f of files) dt.items.add(f);
	const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
	el.dispatchEvent(ev);
	return ev.defaultPrevented;
};
window.store = store;
window.plugin = plugin;
window.draw = draw;
try {
	draw();
} catch (e) {
	window.errors.push(String(e && e.stack));
}
