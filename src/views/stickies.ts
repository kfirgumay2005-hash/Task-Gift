import { Component, MarkdownRenderer, Menu, Notice, setIcon } from "obsidian";
import type TaskGiftPlugin from "../main";
import type { StickyColor, StickyCommand, StickyNote } from "../types";
import { TASK_COLORS } from "../defaults";
import { ConfirmModal } from "../modals/ConfirmModal";
import type { BoardUiState } from "./board";
import { commandRegistry, isEditorOnly, stickyEditFor, TextEdit, wrapSelection } from "../stickyCommands";
import { IMAGE_EXTENSIONS, imageFile, imageFiles, imageSize, isImageFile as isImage, saveStickyImage } from "../stickyImages";
import { pickFiles } from "../util/importFiles";

const STICKY_WIDTH = 200;
const STICKY_HEIGHT = 170;
const STICKY_MIN = 110;
/** Room kept around the notes, so the area always reaches past the last one. */
const AREA_MARGIN = 40;
/** New notes from the "+" button are stacked this far apart, so they don't hide each other. */
const CASCADE = 24;
/** Icons of the default text-marker commands (Obsidian commands bring their own). */
const DEFAULT_COMMAND_ICONS: Record<string, string> = { highlight: "highlighter", underline: "underline", bold: "bold" };
/** A new picture on the board fits in this square (keeping its shape). */
const IMAGE_FIT = 240;
/** Height of a picture note's top bar (fixed in styles.css: `.tg-sticky.is-image .tg-sticky-bar`). */
const BAR_HEIGHT = 28;
/** A picture note's border (1px) and padding (4px) around the image, both sides together (see styles.css). */
const IMAGE_FRAME = 10;
/** How often a picture that hasn't arrived from the other device yet is looked for again. */
const MISSING_IMAGE_POLL_MS = 3000;

/** Note size that shows a w × h picture at the given scale. */
function imageNoteSize(w: number, h: number, scale: number): { w: number; h: number } {
	return { w: Math.max(STICKY_MIN, Math.round(w * scale) + IMAGE_FRAME), h: Math.max(STICKY_MIN, Math.round(h * scale) + BAR_HEIGHT + IMAGE_FRAME) };
}

/** Scale at which a new picture fits in IMAGE_FIT (never enlarged). */
function fitScale(w: number, h: number): number {
	return Math.min(1, IMAGE_FIT / Math.max(w, h));
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Copies the pictures into the vault and resolves with their paths (failures are reported and skipped). */
async function savePictures(plugin: TaskGiftPlugin, files: File[]): Promise<{ path: string; file: File }[]> {
	const saved: { path: string; file: File }[] = [];
	for (const file of files) {
		try {
			saved.push({ path: await saveStickyImage(plugin.app, plugin.settings.stickyImagesLocation === "plugin" ? plugin.stickyImagesFolder() : null, file), file });
		} catch (e) {
			new Notice(`Could not add the picture "${file.name}": ${errorText(e)}`);
		}
	}
	return saved;
}

/** Markdown that shows a picture inside a note's text: just its name when that's unique in the vault, else its path. */
function embedFor(plugin: TaskGiftPlugin, path: string): string {
	const file = imageFile(plugin.app, path);
	const cache = plugin.app.metadataCache as typeof plugin.app.metadataCache | undefined;
	return "![[" + (file && cache ? cache.fileToLinktext(file, "") : path) + "]]";
}

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
	const imageBtn = toolbar.createDiv({ cls: "tg-stickies-add", attr: { role: "button", tabindex: "0", "aria-label": "Add a picture" } });
	setIcon(imageBtn.createSpan(), "image-plus");
	imageBtn.createSpan({ text: "Add image" });
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
	for (const btn of [addBtn, imageBtn]) {
		btn.addEventListener("keydown", (e) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			btn.click();
		});
	}

	/** Puts pictures on the board as their own notes, the first at (x, y), the others stacked after it. */
	const addImages = async (files: File[], x: number, y: number) => {
		const saved = await savePictures(plugin, files);
		if (!saved.length) return;
		let i = 0;
		for (const { path, file } of saved) {
			const size = await imageSize(file);
			const { w, h } = size ? imageNoteSize(size.w, size.h, fitScale(size.w, size.h)) : imageNoteSize(IMAGE_FIT, IMAGE_FIT, 1);
			store.addSticky({ text: "", image: path, color: "default", x: Math.max(0, Math.round(x + i * CASCADE)), y: Math.max(0, Math.round(y + i * CASCADE)), w, h });
			i++;
		}
		plugin.touch();
	};
	imageBtn.addEventListener("click", () => {
		const n = notes.length % 8;
		const x = 16 + n * CASCADE;
		const y = area.scrollTop / zoom() + 8 + n * CASCADE;
		void pickFiles(IMAGE_EXTENSIONS, true).then((files) => addImages(files.filter(isImage), x, y));
	});

	// Pictures dropped on the empty board become notes of their own (dropped on a note, they go into its text).
	const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
	canvas.addEventListener("dragover", (e) => {
		if (!hasFiles(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		canvas.addClass("is-drop-target");
	});
	canvas.addEventListener("dragleave", (e) => {
		if (!canvas.contains(e.relatedTarget as Node | null)) canvas.removeClass("is-drop-target");
	});
	canvas.addEventListener("drop", (e) => {
		canvas.removeClass("is-drop-target");
		const files = imageFiles(e.dataTransfer?.files);
		if (!files.length) return;
		e.preventDefault();
		const rect = canvas.getBoundingClientRect();
		const z = zoom();
		void addImages(files, (e.clientX - rect.left) / z - 40, (e.clientY - rect.top) / z - 12);
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
	if (n.image) el.addClass("is-image");

	const bar = el.createDiv({ cls: "tg-sticky-bar", attr: { "aria-label": "Drag to move" } });
	bar.createDiv({ cls: "tg-spacer" });
	const commandsEl = bar.createDiv({ cls: "tg-sticky-commands" });
	const menuBtn = bar.createDiv({ cls: "clickable-icon tg-sticky-tool", attr: { role: "button", "aria-label": "Color" } });
	setIcon(menuBtn, "palette");
	const delBtn = bar.createDiv({ cls: "clickable-icon tg-sticky-tool", attr: { role: "button", "aria-label": n.image ? "Delete picture" : "Delete sticky note" } });
	setIcon(delBtn, "x");
	addMoveAndResize(el, bar, plugin, id, n, zoom);
	addColorMenu(menuBtn, plugin, id, n);

	if (n.image) {
		renderImage(el, bar, menuBtn, plugin, id, n, n.image);
		delBtn.addEventListener("mousedown", (e) => e.preventDefault());
		delBtn.addEventListener("click", () => {
			const path = n.image ?? "";
			new ConfirmModal(plugin.app, "Delete picture?", "It will be gone from the board on every device, and its file goes to the trash.", "Delete", () => {
				store.deleteSticky(id);
				plugin.touch();
				const file = imageFile(plugin.app, path);
				if (file) void plugin.app.fileManager.trashFile(file).catch((e: unknown) => new Notice(`Could not move the picture to the trash: ${errorText(e)}`));
			}).open();
		});
		return;
	}

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

	/** Saves the pictures and puts them into the text where the caret was (or at the end when not editing). */
	const insertPictures = async (files: File[], start: number, end: number) => {
		const saved = await savePictures(plugin, files);
		if (!saved.length) return;
		const value = text.value;
		start = Math.min(start, value.length);
		end = Math.min(end, value.length);
		const before = value.slice(0, start);
		const lead = before && !before.endsWith("\n") ? "\n" : "";
		const embeds = lead + saved.map((s) => embedFor(plugin, s.path)).join("\n") + "\n";
		text.value = before + embeds + value.slice(end);
		store.updateSticky(id, { text: text.value });
		plugin.saveLater();
		startEdit();
		const caret = start + embeds.length;
		text.setSelectionRange(caret, caret);
	};
	text.addEventListener("paste", (e) => {
		const files = imageFiles(e.clipboardData?.files);
		if (!files.length) return;
		e.preventDefault();
		void insertPictures(files, text.selectionStart, text.selectionEnd);
	});
	el.addEventListener("dragover", (e) => {
		if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = "copy";
	});
	el.addEventListener("drop", (e) => {
		const files = imageFiles(e.dataTransfer?.files);
		if (!files.length) return;
		e.preventDefault();
		e.stopPropagation();
		const editing = el.hasClass("is-editing");
		const len = text.value.length;
		void insertPictures(files, editing ? text.selectionStart : len, editing ? text.selectionEnd : len);
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

	delBtn.addEventListener("mousedown", (e) => e.preventDefault());
	delBtn.addEventListener("click", () => {
		const remove = () => {
			store.deleteSticky(id);
			plugin.touch();
		};
		if (!text.value.trim()) return remove();
		new ConfirmModal(plugin.app, "Delete sticky note?", "Its text will be gone on every device.", "Delete", remove).open();
	});
}

/** The color button's menu (default, or one of the task colors). */
function addColorMenu(menuBtn: HTMLElement, plugin: TaskGiftPlugin, id: string, n: StickyNote): void {
	const store = plugin.store;
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
}

/** A picture note: the image fills the note, keeping its shape. Double-click opens it in a tab. */
function renderImage(el: HTMLElement, bar: HTMLElement, beforeBtn: HTMLElement, plugin: TaskGiftPlugin, id: string, n: StickyNote, path: string): void {
	const box = el.createDiv({ cls: "tg-sticky-image" });
	const file = imageFile(plugin.app, path);
	if (!file) {
		// Not synced from the other device yet: look again now and then, and redraw once it's there.
		box.createDiv({ cls: "tg-sticky-placeholder", text: "Picture not here yet (still syncing?)" });
		const timer = window.setInterval(() => {
			if (!el.isConnected) return window.clearInterval(timer);
			if (!imageFile(plugin.app, path)) return;
			window.clearInterval(timer);
			plugin.refreshViews();
		}, MISSING_IMAGE_POLL_MS);
		return;
	}
	const img = box.createEl("img", { attr: { src: plugin.app.vault.getResourcePath(file), alt: file.basename, draggable: "false" } });
	img.addEventListener("error", () => {
		img.remove();
		box.createDiv({ cls: "tg-sticky-placeholder", text: `Can't show "${file.name}"` });
	});
	box.addEventListener("dblclick", () => void plugin.app.workspace.getLeaf("tab").openFile(file));

	// Expand: the note grows to the picture's own full size; pressed again (at full size) it shrinks back to the fit size.
	const expandBtn = bar.createDiv({ cls: "clickable-icon tg-sticky-tool tg-sticky-expand", attr: { role: "button" } });
	bar.insertBefore(expandBtn, beforeBtn);
	const fullSize = () => (img.naturalWidth ? imageNoteSize(img.naturalWidth, img.naturalHeight, 1) : null);
	const isFull = () => {
		const full = fullSize();
		return !!full && n.w === full.w && n.h === full.h;
	};
	const showState = () => {
		const full = isFull();
		expandBtn.empty();
		setIcon(expandBtn, full ? "minimize-2" : "maximize-2");
		expandBtn.setAttr("aria-label", full ? "Shrink back" : "Expand to the picture's full size");
	};
	showState();
	img.addEventListener("load", showState);
	expandBtn.addEventListener("mousedown", (e) => e.preventDefault());
	expandBtn.addEventListener("click", () => {
		const full = fullSize();
		if (!full) return;
		const size = isFull() ? imageNoteSize(img.naturalWidth, img.naturalHeight, fitScale(img.naturalWidth, img.naturalHeight)) : full;
		// Saved like a resize, so the other device gets it too.
		plugin.store.updateSticky(id, size);
		plugin.touch();
	});
}

/** Moving by the top bar and resizing from the corner; both are saved on release. */
function addMoveAndResize(el: HTMLElement, bar: HTMLElement, plugin: TaskGiftPlugin, id: string, n: StickyNote, zoom: () => number): void {
	const store = plugin.store;
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

	// --- resize from the corner handle. Pointer events (not CSS `resize`), so it works with a finger on the phone
	// too: the mobile app has no native resize handle, and the size it showed was never saved.
	const grip = el.createDiv({ cls: "tg-sticky-resize", attr: { "aria-label": "Drag to resize" } });
	grip.addEventListener("pointerdown", (e) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const z = zoom();
		const startX = e.clientX;
		const startY = e.clientY;
		const w0 = n.w;
		const h0 = n.h;
		let w = w0;
		let h = h0;
		grip.setPointerCapture(e.pointerId);
		el.addClass("is-resizing");
		const move = (ev: PointerEvent) => {
			w = Math.max(STICKY_MIN, Math.round(w0 + (ev.clientX - startX) / z));
			h = Math.max(STICKY_MIN, Math.round(h0 + (ev.clientY - startY) / z));
			el.style.width = `${w}px`;
			el.style.height = `${h}px`;
		};
		const end = (ev: PointerEvent) => {
			if (ev.type === "pointerup") move(ev);
			grip.removeEventListener("pointermove", move);
			grip.removeEventListener("pointerup", end);
			grip.removeEventListener("pointercancel", end);
			el.removeClass("is-resizing");
			if (w === w0 && h === h0) return;
			// Saved in the store, i.e. the topics note next to the data note, so the other device gets it.
			store.updateSticky(id, { w, h });
			plugin.touch();
		};
		grip.addEventListener("pointermove", move);
		grip.addEventListener("pointerup", end);
		grip.addEventListener("pointercancel", end);
	});
}
