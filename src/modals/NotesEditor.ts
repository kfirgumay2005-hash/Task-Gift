import { getIcon, Notice, Platform, setIcon } from "obsidian";
import { BULLET_LINE_RE, CHECK_LINE_RE, NUMBER_LINE_RE, renderNotes, toggleCheck, uncheckAll } from "../calendars/notes";

type ListKind = "check" | "bullet" | "number";

const INDENT = "    ";

/** Sets the first of `names` this Obsidian version has (Lucide renamed a few icons over time). */
function icon(el: HTMLElement, ...names: string[]): void {
	const name = names.find((n) => getIcon(n)) ?? names[0];
	setIcon(el, name);
}

/** A line's indent and the rest of it with any list marker / checkbox taken off. */
function splitLine(line: string): { indent: string; kind: ListKind | null; text: string } {
	const check = CHECK_LINE_RE.exec(line);
	if (check) return { indent: check[1], kind: "check", text: check[4] };
	const bullet = BULLET_LINE_RE.exec(line);
	if (bullet) return { indent: bullet[1], kind: "bullet", text: bullet[3] };
	const num = NUMBER_LINE_RE.exec(line);
	if (num) return { indent: num[1], kind: "number", text: num[3] };
	const indent = /^\s*/.exec(line)?.[0] ?? "";
	return { indent, kind: null, text: line.slice(indent.length) };
}

function marker(kind: ListKind, n: number): string {
	return kind === "check" ? "- [ ] " : kind === "bullet" ? "- " : `${n}. `;
}

/** Copies a description to the clipboard, with a notice either way. */
export function copyDescription(text: string): void {
	if (!text.trim()) {
		new Notice("No description to copy.");
		return;
	}
	navigator.clipboard.writeText(text).then(
		() => new Notice("Description copied."),
		() => new Notice("Could not copy the description."),
	);
}

export interface NotesToolbar {
	/** Adds a button before the preview button; it stays usable in the preview. */
	addButton(iconNames: string[], label: string, run: (e: MouseEvent) => void): HTMLButtonElement;
	/** Inserts text as its own block: at the caret while editing, otherwise at the end. Switches to editing. */
	insert(text: string): void;
}

/**
 * A formatting toolbar over a description textarea: checkboxes, lists, bold / italic / strike / highlight / code,
 * links, headings, and a preview where checkboxes can be ticked. Enter continues a list, Tab / Shift+Tab indent
 * list lines. `onChange` gets the new text after every edit (typing included). With `startInPreview` it opens on the
 * preview (an existing entry: ticking a packing list is what it's opened for most).
 */
export function attachNotesToolbar(area: HTMLTextAreaElement, onChange: (value: string) => void, fit: () => void, startInPreview = false): NotesToolbar {
	const toolbar = createDiv({ cls: "tg-notes-toolbar", attr: { role: "toolbar", "aria-label": "Formatting" } });
	area.before(toolbar);
	const preview = createDiv({ cls: "tg-notes-preview" });
	area.after(preview);
	preview.hide();

	const mod = Platform.isMacOS ? "Cmd" : "Ctrl";
	const changed = () => {
		onChange(area.value);
		fit();
	};
	/** Replaces [from, to) and selects [selFrom, selTo) afterwards (positions in the new text). */
	const replace = (from: number, to: number, text: string, selFrom: number, selTo: number) => {
		area.focus();
		area.setRangeText(text, from, to);
		area.setSelectionRange(selFrom, selTo);
		changed();
	};
	/** Start and end of the whole lines the selection touches. */
	const lineRange = (): [number, number] => {
		const v = area.value;
		const start = v.lastIndexOf("\n", area.selectionStart - 1) + 1;
		let end = v.indexOf("\n", Math.max(area.selectionEnd - (area.selectionEnd > area.selectionStart ? 1 : 0), area.selectionStart));
		if (end === -1) end = v.length;
		return [start, end];
	};

	/** Puts the selected lines into a list of `kind`, or takes them out of it when they all already are. */
	const toggleList = (kind: ListKind) => {
		const [start, end] = lineRange();
		const lines = area.value.slice(start, end).split("\n");
		const parts = lines.map(splitLine);
		const all = parts.every((p, i) => p.kind === kind || !lines[i].trim());
		let n = 0;
		const out = parts.map((p, i) => {
			if (!lines[i].trim() && lines.length > 1) return lines[i];
			if (all) return p.indent + p.text;
			return p.indent + marker(kind, ++n) + p.text;
		});
		const text = out.join("\n");
		// A single line: the cursor keeps its place in the text; several: the lines stay selected.
		if (lines.length === 1) {
			const oldPrefix = lines[0].length - parts[0].text.length;
			const newPrefix = text.length - parts[0].text.length;
			const pos = start + newPrefix + Math.max(0, area.selectionEnd - start - oldPrefix);
			replace(start, end, text, pos, pos);
		} else replace(start, end, text, start, start + text.length);
	};

	/** Wraps the selection (or a placeholder) in `mark`, or unwraps it when it already is. */
	const wrap = (before: string, after: string, placeholder: string) => {
		const v = area.value;
		const s = area.selectionStart;
		const e = area.selectionEnd;
		if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
			replace(s - before.length, e + after.length, v.slice(s, e), s - before.length, e - before.length);
			return;
		}
		const inner = v.slice(s, e) || placeholder;
		replace(s, e, before + inner + after, s + before.length, s + before.length + inner.length);
	};

	const addLink = () => {
		const v = area.value;
		const s = area.selectionStart;
		const e = area.selectionEnd;
		const sel = v.slice(s, e);
		if (/^https?:\/\/\S+$/.test(sel)) {
			replace(s, e, `[link](${sel})`, s + 1, s + 5);
			return;
		}
		const text = sel || "link";
		const out = `[${text}](https://)`;
		const url = s + text.length + 3;
		replace(s, e, out, url, url + 8);
	};

	const toggleHeading = () => {
		const [start, end] = lineRange();
		const line = area.value.slice(start, end);
		const m = /^(\s*)(#{1,6}\s+)?(.*)$/.exec(line);
		if (!m) return;
		const text = m[2] ? m[1] + m[3] : `${m[1]}## ${m[3]}`;
		const pos = start + text.length;
		replace(start, end, text, pos, pos);
	};

	/** Indents (or outdents) the selected lines by one level. */
	const shift = (out: boolean) => {
		const [start, end] = lineRange();
		const lines = area.value.slice(start, end).split("\n");
		const moved = lines.map((l) => (out ? l.replace(/^( {1,4}|\t)/, "") : INDENT + l));
		const text = moved.join("\n");
		if (lines.length === 1) {
			const caret = Math.max(start, area.selectionStart + (text.length - lines[0].length));
			replace(start, end, text, caret, caret);
		} else replace(start, end, text, start, start + text.length);
	};

	const showPreview = (on: boolean) => {
		area.toggle(!on);
		preview.toggle(on);
		previewBtn.toggleClass("is-active", on);
		previewBtn.setAttr("aria-pressed", String(on));
		for (const b of editButtons) b.disabled = on;
		if (!on) {
			area.focus();
			fit();
			return;
		}
		// Redrawing after a tick must not scroll the list (or the window around it) back to the top.
		const scrolled: [HTMLElement, number][] = [];
		for (let el: HTMLElement | null = preview; el; el = el.parentElement) if (el.scrollTop) scrolled.push([el, el.scrollTop]);
		preview.empty();
		if (!area.value.trim()) preview.createDiv({ cls: "tg-notes-empty", text: "No description yet." });
		renderNotes(preview, area.value, (line) => {
			area.value = toggleCheck(area.value, line);
			onChange(area.value);
			showPreview(true);
		});
		preview.createDiv({ cls: "tg-notes-hint", text: "Double-click to edit" });
		for (const [el, top] of scrolled) el.scrollTop = top;
	};
	// Double-click on the text (not a checkbox or link) switches to editing.
	preview.addEventListener("dblclick", (e) => {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLAnchorElement) return;
		showPreview(false);
	});

	const editButtons: HTMLButtonElement[] = [];
	const button = (iconNames: string[], label: string, run: (e: MouseEvent) => void, edit = true) => {
		const b = toolbar.createEl("button", { cls: "clickable-icon tg-notes-btn", attr: { type: "button", "aria-label": label } });
		icon(b, ...iconNames);
		// Keeps the textarea's selection: the button never takes focus on click.
		b.addEventListener("mousedown", (e) => e.preventDefault());
		b.addEventListener("click", run);
		if (edit) editButtons.push(b);
		return b;
	};
	const sep = () => toolbar.createDiv({ cls: "tg-notes-sep" });

	button(["square-check", "check-square"], `Checkbox (${mod}+L)`, () => toggleList("check"));
	button(["list"], "Bulleted list", () => toggleList("bullet"));
	button(["list-ordered"], "Numbered list", () => toggleList("number"));
	sep();
	button(["bold"], `Bold (${mod}+B)`, () => wrap("**", "**", "bold"));
	button(["italic"], `Italic (${mod}+I)`, () => wrap("*", "*", "italic"));
	button(["strikethrough"], "Strikethrough", () => wrap("~~", "~~", "text"));
	button(["highlighter"], "Highlight", () => wrap("==", "==", "text"));
	button(["code"], "Code", () => wrap("`", "`", "code"));
	button(["link"], `Link (${mod}+K)`, addLink);
	button(["heading"], "Heading", toggleHeading);
	sep();
	button(["indent-decrease", "outdent"], "Outdent (Shift+Tab)", () => shift(true));
	button(["indent-increase", "indent"], "Indent (Tab)", () => shift(false));
	button(["list-restart", "rotate-ccw"], "Uncheck all", () => {
		const next = uncheckAll(area.value);
		if (next !== area.value) replace(0, area.value.length, next, area.selectionStart, area.selectionEnd);
	});
	button(["copy"], "Copy description", () => copyDescription(area.value), false);
	const spacer = toolbar.createDiv({ cls: "tg-spacer" });
	const previewBtn = button(["eye"], "Preview (tick checkboxes)", () => showPreview(preview.isShown() === false), false);
	if (startInPreview) showPreview(true);

	area.addEventListener("input", changed);
	area.addEventListener("keydown", (e) => {
		if (e.isComposing) return;
		const key = e.key.toLowerCase();
		if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
			const run = { b: () => wrap("**", "**", "bold"), i: () => wrap("*", "*", "italic"), k: addLink, l: () => toggleList("check") }[key];
			if (run) {
				e.preventDefault();
				e.stopPropagation();
				run();
			}
			return;
		}
		if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
			const [start, end] = lineRange();
			// Only list lines (or several lines) take Tab; elsewhere it keeps moving focus.
			if (!splitLine(area.value.slice(start, end)).kind && !area.value.slice(start, end).includes("\n")) return;
			e.preventDefault();
			shift(e.shiftKey);
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && area.selectionStart === area.selectionEnd) {
			const v = area.value;
			const caret = area.selectionStart;
			const start = v.lastIndexOf("\n", caret - 1) + 1;
			const p = splitLine(v.slice(start, caret));
			if (!p.kind) return;
			e.preventDefault();
			if (!p.text.trim() && !v.slice(caret, (v.indexOf("\n", caret) + 1 || v.length + 1) - 1).trim()) {
				// Enter on an empty list item ends the list.
				replace(start, caret, p.indent, start + p.indent.length, start + p.indent.length);
				return;
			}
			const n = p.kind === "number" ? Number(NUMBER_LINE_RE.exec(v.slice(start, caret))?.[2] ?? 0) + 1 : 0;
			const insert = `\n${p.indent}${marker(p.kind, n)}`;
			replace(caret, caret, insert, caret + insert.length, caret + insert.length);
		}
	});

	return {
		addButton: (iconNames, label, run) => {
			const b = button(iconNames, label, run, false);
			spacer.before(b);
			return b;
		},
		insert: (text) => {
			const wasPreview = preview.isShown();
			if (wasPreview) showPreview(false);
			const v = area.value;
			const at = wasPreview ? v.length : area.selectionEnd;
			const before = v.slice(0, at).replace(/[ \t]+$/, "");
			const after = v.slice(at);
			const lead = !before.trim() ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
			const trail = !after.trim() ? "" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
			const caret = before.length + lead.length + text.length;
			replace(before.length, at, lead + text + trail, caret, caret);
		},
	};
}
