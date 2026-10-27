import { Component, MarkdownRenderer, Menu, Notice, setIcon } from "obsidian";
import type TaskGiftPlugin from "../main";
import type { StickyColor, StickyCommand, StickyNote } from "../types";
import { TASK_COLORS } from "../defaults";
import { ConfirmModal } from "../modals/ConfirmModal";
import type { BoardUiState } from "./board";
import { commandRegistry, isEditorOnly, stickyEditFor, TextEdit, wrapSelection } from "../stickyCommands";

const STICKY_WIDTH = 200;
const STICKY_HEIGHT = 170;
const STICKY_MIN = 110;
/** Room kept around the notes, so the area always reaches past the last one. */
const AREA_MARGIN = 40;
/** New notes from the "+" button are stacked this far apart, so they don't hide each other. */
const CASCADE = 24;
/** Icons of the default text-marker commands (Obsidian commands bring their own). */
const DEFAULT_COMMAND_ICONS: Record<string, string> = { highlight: "highlighter", underline: "underline", bold: "bold" };

/**
 * The empty side of the board, after the columns: sticky notes placed freely. Drag a note by its top bar,
 * resize it from its corner, double-click the empty area to add one there.
 */
export function renderStickies(board: HTMLElement, plugin: TaskGiftPlugin, ui: BoardUiState, owner: Component): void {
	const store = plugin.store;
	const zoom = () => plugin.settings.boardZoom / 100;
	const area = board.createDiv({ cls: "tg-stickies" });
	const toolbar = area.createDiv({ cls: "tg-stickies-toolbar" });
	const addBtn = toolbar.createDiv({ cls: "tg-stickies-add", attr: { role: "button", tabindex: "0", "aria-label": "Add a sticky note" } });
	setIcon(addBtn.createSpan(), "sticky-note");
	addBtn.createSpan({ text: "Add sticky note" });
	const canvas = area.createDiv({ cls: "tg-stickies-canvas" });

	const notes = store.stickyNotes();
	// The canvas grows with its notes, so a note dragged far away can still be scrolled to.
	let right = 0;
	let bottom = 0;
	for (const [, n] of notes) {
		right = Math.max(right, n.x + n.w);
		bottom = Math.max(bottom, n.y + n.h);
	}
	canvas.style.minWidth = `${right + AREA_MARGIN}px`;
	canvas.style.minHeight = `${bottom + AREA_MARGIN}px`;
	if (!notes.length) canvas.createDiv({ cls: "tg-stickies-hint", text: "Double-click here to add a sticky note" });

	const add = (x: number, y: number) => {
		const id = store.addSticky({ text: "", color: "default", x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), w: STICKY_WIDTH, h: STICKY_HEIGHT });
		ui.focusSticky = id;
		plugin.touch();
	};
	addBtn.addEventListener("click", () => {
		const n = notes.length % 8;
		add(16 + n * CASCADE, area.scrollTop / zoom() + 8 + n * CASCADE);
	});
	addBtn.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();
		addBtn.click();
	});
	canvas.addEventListener("dblclick", (e) => {
		if (e.target !== canvas && !(e.target as HTMLElement).hasClass("tg-stickies-hint")) return;
		const rect = canvas.getBoundingClientRect();
		const z = zoom();
		add((e.clientX - rect.left) / z - STICKY_WIDTH / 2, (e.clientY - rect.top) / z - 14);
	});

	for (const [id, n] of notes) renderSticky(canvas, plugin, ui, owner, id, n, zoom);
}

function renderSticky(canvas: HTMLElement, plugin: TaskGiftPlugin, ui: BoardUiState, owner: Component, id: string, n: StickyNote, zoom: () => number): void {
	const store = plugin.store;
	const el = canvas.createDiv({ cls: "tg-sticky" });
	el.dataset.sticky = id;
	if (n.color === "default") el.addClass("is-neutral");
	else el.style.setProperty("--tg-sticky-color", `var(--color-${n.color})`);
	el.style.left = `${n.x}px`;
	el.style.top = `${n.y}px`;
	el.style.width = `${n.w}px`;
	el.style.height = `${n.h}px`;

	const bar = el.createDiv({ cls: "tg-sticky-bar", attr: { "aria-label": "Drag to move" } });
	bar.createDiv({ cls: "tg-spacer" });
	const commandsEl = bar.createDiv({ cls: "tg-sticky-commands" });
	const menuBtn = bar.createDiv({ cls: "clickable-icon tg-sticky-tool", attr: { role: "button", "aria-label": "Color" } });
	setIcon(menuBtn, "palette");
	const delBtn = bar.createDiv({ cls: "clickable-icon tg-sticky-tool", attr: { role: "button", "aria-label": "Delete sticky note" } });
	setIcon(delBtn, "x");

	// Shown rendered (bold, highlight, links…); clicking it switches to the Markdown text.
	const view = el.createDiv({ cls: "tg-sticky-view markdown-rendered", attr: { dir: "auto" } });
	const text = el.createEl("textarea", { cls: "tg-sticky-text", attr: { dir: "auto", placeholder: "Write something…", spellcheck: "false" } });
	text.value = n.text;
	text.dataset.sticky = id;

	// Each render gets its own child of the board's owner, unloaded when the note is rendered again.
	let rendered: Component | null = null;
	const renderView = () => {
		view.empty();
		if (rendered) owner.removeChild(rendered);
		rendered = null;
		if (!text.value.trim()) {
			view.createDiv({ cls: "tg-sticky-placeholder", text: "Write something…" });
			return;
		}
		rendered = owner.addChild(new Component());
		void MarkdownRenderer.render(plugin.app, text.value, view, "", rendered);
	};
	const startEdit = () => {
		el.addClass("is-editing");
		text.focus();
	};
	if (ui.focusSticky === id) el.addClass("is-editing");
	else renderView();

	view.addEventListener("click", (e) => {
		const link = (e.target as HTMLElement).closest("a");
		if (link) {
			// Internal links open the note; external ones are left to the browser.
			if (link.hasClass("internal-link")) {
				e.preventDefault();
				void plugin.app.workspace.openLinkText(link.getAttr("data-href") ?? link.getText(), "");
			}
			return;
		}
		startEdit();
	});
	text.addEventListener("focus", () => el.addClass("is-editing"));
	text.addEventListener("blur", () => {
		// A redraw removes the textarea while it has focus; the new one takes over then.
		if (!el.isConnected) return;
		ui.stickySelection = { id, start: text.selectionStart, end: text.selectionEnd };
		el.removeClass("is-editing");
		renderView();
	});
	text.addEventListener("input", () => {
		store.updateSticky(id, { text: text.value });
		plugin.saveLater();
	});
	text.addEventListener("keydown", (e) => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		text.blur();
	});

	const runCommand = (cmd: StickyCommand) => {
		const edit = cmd.commandId ? stickyEditFor(cmd.commandId) : (v: string, s: number, e: number) => wrapSelection(v, s, e, cmd.before, cmd.after);
		if (!edit) return runObsidianCommand(cmd);
		const editing = el.hasClass("is-editing");
		const last = ui.stickySelection?.id === id ? ui.stickySelection : null;
		// Not editing and nothing selected before: the markers go at the end of the text.
		const len = text.value.length;
		const start = Math.min(editing ? text.selectionStart : last?.start ?? len, len);
		const end = Math.min(editing ? text.selectionEnd : last?.end ?? len, len);
		const r: TextEdit = edit(text.value, start, end);
		text.value = r.value;
		store.updateSticky(id, { text: r.value });
		plugin.saveLater();
		startEdit();
		text.setSelectionRange(r.start, r.end);
	};

	/** Any other Obsidian command runs as from the command palette. */
	const runObsidianCommand = (cmd: StickyCommand) => {
		const commandId = cmd.commandId ?? "";
		if (isEditorOnly(commandId)) {
			new Notice(`"${cmd.name}" only works in a note's editor, not in a sticky note.`);
			return;
		}
		const registry = commandRegistry(plugin.app);
		if (!registry.commands[commandId]) new Notice(`The command "${cmd.name}" isn't available (is its plugin turned off?).`);
		else if (!registry.executeCommandById(commandId)) new Notice(`"${cmd.name}" can't run right now.`);
	};

	// --- the commands, as buttons next to the color button
	const registry = commandRegistry(plugin.app);
	for (const cmd of plugin.settings.stickyCommands) {
		const found = cmd.commandId ? registry?.commands[cmd.commandId] : undefined;
		const title = cmd.name || found?.name || cmd.commandId || `${cmd.before}…${cmd.after}`;
		const btn = commandsEl.createDiv({ cls: "clickable-icon tg-sticky-tool", attr: { role: "button", "aria-label": title } });
		btn.dataset.command = cmd.id;
		const icon = found?.icon ?? DEFAULT_COMMAND_ICONS[cmd.id];
		if (icon) setIcon(btn, icon);
		// Text markers of your own have no icon: show the start of their name.
		else btn.createSpan({ cls: "tg-sticky-tool-text", text: [...title].slice(0, 2).join(""), attr: { dir: "auto" } });
		// Keep the text's focus and selection when the button is pressed.
		btn.addEventListener("mousedown", (e) => e.preventDefault());
		btn.addEventListener("click", () => runCommand(cmd));
	}

	menuBtn.addEventListener("mousedown", (e) => e.preventDefault());
	menuBtn.addEventListener("click", (e) => {
		const menu = new Menu();
		const colors: [StickyColor, string][] = [["default", "Default"], ...(Object.entries(TASK_COLORS) as [StickyColor, string][])];
		for (const [value, label] of colors) {
			menu.addItem((i) =>
				i
					.setTitle(label)
					.setChecked(n.color === value)
					.onClick(() => {
						store.updateSticky(id, { color: value });
						plugin.touch();
					}),
			);
		}
		menu.showAtMouseEvent(e);
	});
	delBtn.addEventListener("mousedown", (e) => e.preventDefault());
	delBtn.addEventListener("click", () => {
		const remove = () => {
			store.deleteSticky(id);
			plugin.touch();
		};
		if (!text.value.trim()) return remove();
		new ConfirmModal(plugin.app, "Delete sticky note?", "Its text will be gone on every device.", "Delete", remove).open();
	});

	// --- move by the top bar
	bar.addEventListener("pointerdown", (e) => {
		if (e.button !== 0 || (e.target as HTMLElement).closest(".tg-sticky-tool")) return;
		e.preventDefault();
		const z = zoom();
		const startX = e.clientX;
		const startY = e.clientY;
		const x0 = n.x;
		const y0 = n.y;
		let x = x0;
		let y = y0;
		bar.setPointerCapture(e.pointerId);
		el.addClass("is-moving");
		const move = (ev: PointerEvent) => {
			x = Math.max(0, Math.round(x0 + (ev.clientX - startX) / z));
			y = Math.max(0, Math.round(y0 + (ev.clientY - startY) / z));
			el.style.left = `${x}px`;
			el.style.top = `${y}px`;
		};
		const end = () => {
			bar.removeEventListener("pointermove", move);
			bar.removeEventListener("pointerup", end);
			bar.removeEventListener("pointercancel", end);
			el.removeClass("is-moving");
			// Saving also brings the note to the front (newest edit is drawn on top).
			store.updateSticky(id, { x, y });
			plugin.touch();
		};
		bar.addEventListener("pointermove", move);
		bar.addEventListener("pointerup", end);
		bar.addEventListener("pointercancel", end);
	});

	// --- resize from the corner (CSS resize sets the inline size; save it when the mouse is let go)
	el.addEventListener("pointerup", () => {
		const w = Math.max(STICKY_MIN, Math.round(parseFloat(el.style.width) || n.w));
		const h = Math.max(STICKY_MIN, Math.round(parseFloat(el.style.height) || n.h));
		if (w === n.w && h === n.h) return;
		store.updateSticky(id, { w, h });
		plugin.touch();
	});
}
