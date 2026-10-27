import type { App } from "obsidian";

/** A text change on a sticky note: new text and the selection to keep. */
export interface TextEdit {
	value: string;
	start: number;
	end: number;
}

type EditFn = (value: string, start: number, end: number) => TextEdit;

/** Obsidian's command registry (`app.commands`), which obsidian.d.ts doesn't declare. */
export interface ObsidianCommand {
	id: string;
	name: string;
	icon?: string;
}
interface CommandRegistry {
	commands: Record<string, ObsidianCommand>;
	executeCommandById(id: string): boolean;
}

export function commandRegistry(app: App): CommandRegistry {
	return (app as unknown as { commands: CommandRegistry }).commands;
}

/** Every Obsidian command, by name (also editor commands, which `listCommands` hides without an open note). */
export function allCommands(app: App): ObsidianCommand[] {
	return Object.values(commandRegistry(app).commands).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Wraps the selection in `before` … `after`, or unwraps it when it is already wrapped (markers just outside
 * or at the edges of the selection).
 */
export function wrapSelection(value: string, start: number, end: number, b: string, a: string): TextEdit {
	if (b || a) {
		if (start >= b.length && value.slice(start - b.length, start) === b && value.slice(end, end + a.length) === a) {
			return { value: value.slice(0, start - b.length) + value.slice(start, end) + value.slice(end + a.length), start: start - b.length, end: end - b.length };
		}
		const sel = value.slice(start, end);
		if (sel.length >= b.length + a.length && sel.startsWith(b) && sel.endsWith(a)) {
			const inner = sel.slice(b.length, sel.length - a.length);
			return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
		}
	}
	return { value: value.slice(0, start) + b + value.slice(start, end) + a + value.slice(end), start: start + b.length, end: end + b.length };
}

/**
 * Gives every line touched by the selection the prefix `add` (after removing any prefix matching `strip`),
 * or removes it when all of them already start with it. The selection then covers those whole lines.
 */
function prefixLines(value: string, start: number, end: number, add: string, strip: RegExp): TextEdit {
	const from = value.lastIndexOf("\n", start - 1) + 1;
	let to = value.indexOf("\n", end > start && value[end - 1] === "\n" ? end - 1 : end);
	if (to === -1) to = value.length;
	const lines = value.slice(from, to).split("\n");
	const all = add !== "" && lines.every((l) => l.startsWith(add));
	const next = lines.map((l) => (all ? l.slice(add.length) : add + l.replace(strip, ""))).join("\n");
	return { value: value.slice(0, from) + next + value.slice(to), start: from, end: from + next.length };
}

function insertText(value: string, start: number, end: number, text: string): TextEdit {
	const at = end;
	return { value: value.slice(0, at) + text + value.slice(at), start: at + text.length, end: at + text.length };
}

const LIST_PREFIX = /^(\s*)([-*+] \[.\] |[-*+] |\d+[.)] |> )/;
const HEADING_PREFIX = /^#{1,6} /;
/** Obsidian's highlight colors: `==🔴text==`. */
const HIGHLIGHT_COLORS: Record<string, string> = { red: "🔴", orange: "🟠", yellow: "🟡", green: "🟢", blue: "🔵", purple: "🟣" };

const wrap = (b: string, a: string): EditFn => (v, s, e) => wrapSelection(v, s, e, b, a);
const prefix = (add: string, strip: RegExp): EditFn => (v, s, e) => prefixLines(v, s, e, add, strip);

/**
 * Obsidian's editor commands only work in a note's editor, never in a sticky note's text box, so the formatting
 * ones are done here on the note's Markdown instead.
 */
const EDITOR_EDITS: Record<string, EditFn> = {
	"editor:toggle-bold": wrap("**", "**"),
	"editor:toggle-italics": wrap("*", "*"),
	"editor:toggle-strikethrough": wrap("~~", "~~"),
	"editor:toggle-highlight": wrap("==", "=="),
	"editor:toggle-code": wrap("`", "`"),
	"editor:toggle-inline-math": wrap("$", "$"),
	"editor:toggle-comments": wrap("%%", "%%"),
	"editor:insert-wikilink": wrap("[[", "]]"),
	"editor:insert-embed": wrap("![[", "]]"),
	"editor:insert-link": wrap("[", "]()"),
	"editor:insert-tag": wrap("#", ""),
	"editor:insert-footnote": wrap("", "[^1]"),
	"editor:toggle-bullet-list": prefix("- ", LIST_PREFIX),
	"editor:toggle-numbered-list": prefix("1. ", LIST_PREFIX),
	"editor:toggle-checklist-status": prefix("- [ ] ", LIST_PREFIX),
	"editor:cycle-list-checklist": prefix("- [ ] ", LIST_PREFIX),
	"editor:toggle-blockquote": prefix("> ", LIST_PREFIX),
	"editor:set-heading-0": prefix("", HEADING_PREFIX),
	"editor:insert-horizontal-rule": (v, s, e) => insertText(v, s, e, "\n---\n"),
	"editor:insert-codeblock": wrap("```\n", "\n```"),
	"editor:insert-mathblock": wrap("$$\n", "\n$$"),
	"editor:clear-formatting": (v, s, e) => {
		const inner = v.slice(s, e).replace(/==[🔴🟠🟡🟢🔵🟣]?|\*\*|~~|%%|<\/?u>|`|(?<!\*)\*(?!\*)/gu, "");
		return { value: v.slice(0, s) + inner + v.slice(e), start: s, end: s + inner.length };
	},
};
for (let level = 1; level <= 6; level++) EDITOR_EDITS[`editor:set-heading-${level}`] = prefix("#".repeat(level) + " ", HEADING_PREFIX);
for (const [color, mark] of Object.entries(HIGHLIGHT_COLORS)) EDITOR_EDITS[`editor:toggle-highlight-${color}`] = wrap(`==${mark}`, "==");

/** The edit a sticky note does for this Obsidian command, or null when the command runs in Obsidian as usual. */
export function stickyEditFor(commandId: string): EditFn | null {
	return EDITOR_EDITS[commandId] ?? null;
}

/** Editor commands without a sticky-note version: they only work in a note's editor. */
export function isEditorOnly(commandId: string): boolean {
	return commandId.startsWith("editor:") && !EDITOR_EDITS[commandId];
}
