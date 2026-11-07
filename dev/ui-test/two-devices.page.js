// Two copies of the whole plugin (main.ts), each with its own vault "disk", and a LiveSync stand-in that copies
// changed notes from one disk to the other after a delay, keeping the source's mtime (as LiveSync does) and
// writing straight to disk without the vault's "modify" event (as LiveSync sometimes does).
import { TFile } from "obsidian";
import TaskGiftPlugin from "../../src/main";

window.errors = [];
window.addEventListener("error", (e) => window.errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.errors.push(String(e.reason && e.reason.stack)));
const origError = console.error;
console.error = (...a) => { window.errors.push(a.map(String).join(" ")); origError(...a); };

const DATA = "TG/Task Gift Data.md";
/** Per device: clock offset in ms (to try clock skew), LiveSync delay in ms. */
window.config = { delay: 300, skew: { A: 0, B: 0 }, events: false };
window.log = [];

function makeDevice(name) {
	const disk = new Map(); // path -> { content, mtime }
	const listeners = { modify: [], create: [] };
	const fileFor = (path) => Object.assign(new TFile(), { path, name: path.split("/").pop() });
	const now = () => Date.now() + window.config.skew[name];
	const writeLocal = (path, content) => {
		const existed = disk.has(path);
		disk.set(path, { content, mtime: now() + Math.random() / 1000 });
		window.log.push(`${name} writes ${path.split("/").pop()}`);
		liveSync(name, path);
		for (const cb of listeners[existed ? "modify" : "create"]) cb(fileFor(path));
	};
	const adapter = {
		exists: async (p) => disk.has(p) || [...disk.keys()].some((k) => k.startsWith(p + "/")),
		read: async (p) => { if (!disk.has(p)) throw new Error("no file " + p); return disk.get(p).content; },
		write: async (p, c) => writeLocal(p, c),
		stat: async (p) => (disk.has(p) ? { mtime: Math.floor(disk.get(p).mtime), size: new Blob([disk.get(p).content]).size, type: "file" } : null),
		mkdir: async () => {},
	};
	const app = {
		vault: {
			adapter,
			getAbstractFileByPath: (p) => (disk.has(p) ? fileFor(p) : null),
			modify: async (f, c) => writeLocal(f.path, c),
			read: async (f) => disk.get(f.path).content,
			create: async (p, c) => (writeLocal(p, c), fileFor(p)),
			createFolder: async () => {},
			on: (ev, cb) => { (listeners[ev] ??= []).push(cb); return {}; },
			getMarkdownFiles: () => [],
			getResourcePath: () => "",
		},
		workspace: { on: () => ({}), onLayoutReady: (cb) => setTimeout(cb, 0), getLeavesOfType: () => [], getLeaf: () => ({}) },
		metadataCache: { getFileCache: () => null },
		fileManager: {},
		commands: { commands: {}, executeCommandById: () => true },
	};
	return { name, disk, app, listeners, plugin: null, receive(path, entry) {
		const existed = disk.has(path);
		disk.set(path, { ...entry });
		window.log.push(`${name} receives ${path.split("/").pop()}`);
		if (window.config.events) for (const cb of listeners[existed ? "modify" : "create"]) cb(fileFor(path));
	} };
}

const devices = { A: makeDevice("A"), B: makeDevice("B") };
function liveSync(from, path) {
	const to = from === "A" ? devices.B : devices.A;
	const entry = { ...devices[from].disk.get(path) };
	setTimeout(() => to.receive(path, entry), window.config.delay);
}

window.devices = devices;
window.start = async (name) => {
	const d = devices[name];
	const plugin = new TaskGiftPlugin(d.app, { id: "task-gift", dir: undefined, version: "test" });
	plugin._data = { dataFilePath: DATA };
	d.plugin = plugin;
	await plugin.onload();
	await new Promise((r) => setTimeout(r, 50));
	return true;
};
window.stop = async (name) => {
	const p = devices[name].plugin;
	for (const id of p._intervals) clearInterval(id);
	p.onunload();
	devices[name].plugin = null;
	await new Promise((r) => setTimeout(r, 50));
	return true;
};
window.sticky = (name, id) => {
	const n = devices[name].plugin.store.data.stickies[id];
	return n ? { x: n.x, y: n.y, updated: n.updated } : null;
};
/** What a drag in the board does: updateSticky + touch. */
window.move = (name, id, x, y) => {
	const p = devices[name].plugin;
	p.store.updateSticky(id, { x, y });
	p.touch();
};
window.addNote = (name) => {
	const p = devices[name].plugin;
	const id = p.store.addSticky({ text: "hello", color: "default", x: 10, y: 10, w: 200, h: 170 });
	p.touch();
	return id;
};
window.onDisk = (name, id) => {
	const e = devices[name].disk.get("TG/Task Gift Topics.md");
	if (!e) return null;
	const m = /```json\r?\n([\s\S]*?)\r?\n```/.exec(e.content);
	const n = JSON.parse(m[1]).stickies?.[id];
	return n ? { x: n.x, y: n.y, updated: n.updated } : null;
};
window.ready = true;
