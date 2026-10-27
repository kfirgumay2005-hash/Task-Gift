import { Component } from "obsidian";
import { TaskStore } from "../../src/sync/store";
import { DEFAULT_STICKY_COMMANDS, emptyStore } from "../../src/defaults";
import { renderStickies } from "../../src/views/stickies";

window.errors = [];
window.addEventListener("error", (e) => window.errors.push(String(e.message)));
window.saves = 0;
const store = new TaskStore(emptyStore(), () => {});
const ui = { queries: new Map(), searchOpen: new Set(), zoomDelta: 0 };
document.body.style.margin = "0";
const host = document.body.createDiv();
host.style.height = "600px";
// Like TaskView: what the board renders belongs to a component that is unloaded on the next redraw.
let owner = null;
// Redraws the whole board on every change, like the plugin's view does.
const draw = () => {
	// Like TaskView: the note being typed in stays open for editing.
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
// Obsidian's command registry, with a few real command IDs.
window.ran = [];
const commands = {};
for (const [id, name] of [["editor:toggle-bold", "Toggle bold"], ["editor:toggle-bullet-list", "Toggle bullet list"], ["editor:toggle-highlight-red", "Toggle red highlight"], ["editor:undo", "Undo"], ["daily-notes", "Open today's daily note"]]) commands[id] = { id, name };
const app = { commands: { commands, executeCommandById: (id) => (window.ran.push(id), true) } };
const plugin = { app, store, settings: { boardZoom: 100, stickyCommands: DEFAULT_STICKY_COMMANDS.map((c) => ({ ...c })) }, touch: draw, saveLater: () => window.saves++ };
window.store = store;
window.plugin = plugin;
window.draw = draw;
try {
	draw();
} catch (e) {
	window.errors.push(String(e && e.stack));
}
