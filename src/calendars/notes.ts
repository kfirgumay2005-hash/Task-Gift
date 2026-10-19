/**
 * Entry descriptions are a small Markdown subset: checkboxes ("- [ ] "), bullets, numbered lists, headings, and
 * **bold**, *italic*, ~~strike~~, ==highlight==, `code` and links inside a line. Rendered here by hand (cheap, no
 * Markdown component to keep alive in a view that redraws often).
 */

/** "- [ ] text" (also "* [x]", "1. [ ]"): indent, list marker, check mark, text. */
export const CHECK_LINE_RE = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\](?:\s+|$)(.*)$/;
/** "- text": indent, marker, text. */
export const BULLET_LINE_RE = /^(\s*)([-*+])\s+(.*)$/;
/** "1. text": indent, number, text. */
export const NUMBER_LINE_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const HEADING_LINE_RE = /^(#{1,6})\s+(.*)$/;

/** Width of a line's indentation, a tab counting as 4. */
export function indentWidth(line: string): number {
	let w = 0;
	for (const ch of line) {
		if (ch === " ") w++;
		else if (ch === "\t") w += 4;
		else break;
	}
	return w;
}

/** Checked and total checkboxes in a description. */
export function checklistCount(notes: string): { done: number; total: number } {
	let done = 0;
	let total = 0;
	for (const line of notes.split("\n")) {
		const m = CHECK_LINE_RE.exec(line);
		if (!m) continue;
		total++;
		if (m[3] !== " ") done++;
	}
	return { done, total };
}

/** The description with the checkbox on line `index` flipped. */
export function toggleCheck(notes: string, index: number): string {
	const lines = notes.split("\n");
	const m = CHECK_LINE_RE.exec(lines[index] ?? "");
	if (!m) return notes;
	lines[index] = `${m[1]}${m[2]} [${m[3] === " " ? "x" : " "}] ${m[4]}`.replace(/\s+$/, "");
	return lines.join("\n");
}

/** The description with every checkbox cleared. */
export function uncheckAll(notes: string): string {
	return notes
		.split("\n")
		.map((l) => {
			const m = CHECK_LINE_RE.exec(l);
			return m && m[3] !== " " ? `${m[1]}${m[2]} [ ] ${m[4]}`.replace(/\s+$/, "") : l;
		})
		.join("\n");
}

/**
 * Renders a description. With `onToggle`, checkboxes can be ticked (it gets the line index; the caller saves);
 * clicks on checkboxes and links don't reach the parent (which opens the entry).
 */
export function renderNotes(parent: HTMLElement, notes: string, onToggle?: (line: number) => void): void {
	const lines = notes.split("\n");
	lines.forEach((line, i) => {
		if (!line.trim()) {
			parent.createDiv({ cls: "tg-note-gap" });
			return;
		}
		const row = parent.createDiv({ cls: "tg-note-line", attr: { dir: "auto" } });
		const level = Math.ceil(indentWidth(line) / 4);
		if (level) row.style.setProperty("--tg-note-indent", String(level));

		const check = CHECK_LINE_RE.exec(line);
		if (check) {
			const done = check[3] !== " ";
			row.addClass("is-check");
			row.toggleClass("is-checked", done);
			const box = row.createEl("input", { cls: "task-list-item-checkbox", attr: { type: "checkbox" } });
			box.checked = done;
			if (onToggle) {
				box.addEventListener("click", (e) => {
					e.stopPropagation();
					onToggle(i);
				});
			} else box.disabled = true;
			renderInline(row.createSpan({ cls: "tg-note-text" }), check[4]);
			return;
		}
		const bullet = BULLET_LINE_RE.exec(line);
		if (bullet) {
			row.addClass("is-list");
			row.createSpan({ cls: "tg-note-marker", text: "•" });
			renderInline(row.createSpan({ cls: "tg-note-text" }), bullet[3]);
			return;
		}
		const num = NUMBER_LINE_RE.exec(line);
		if (num) {
			row.addClass("is-list");
			row.createSpan({ cls: "tg-note-marker", text: `${num[2]}.` });
			renderInline(row.createSpan({ cls: "tg-note-text" }), num[3]);
			return;
		}
		const heading = HEADING_LINE_RE.exec(line.trim());
		if (heading) {
			row.addClass("is-heading");
			renderInline(row, heading[2]);
			return;
		}
		renderInline(row, line.trim());
	});
}

/** Inline marks, earliest match first. Groups: 1-2 bold, 3 strike, 4 highlight, 5 code, 6-7 link, 8-9 italic, 10 url. */
const INLINE_RE =
	/(\*\*|__)(.+?)\1|~~(.+?)~~|==(.+?)==|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])(\*|_)(?!\s)(.+?)(?<!\s)\8(?![\w*])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/;

function renderInline(parent: HTMLElement, text: string): void {
	let rest = text;
	while (rest) {
		const m = INLINE_RE.exec(rest);
		if (!m) {
			parent.appendText(rest);
			return;
		}
		if (m.index) parent.appendText(rest.slice(0, m.index));
		if (m[2] !== undefined) renderInline(parent.createEl("strong"), m[2]);
		else if (m[3] !== undefined) renderInline(parent.createEl("del"), m[3]);
		else if (m[4] !== undefined) renderInline(parent.createEl("mark"), m[4]);
		else if (m[5] !== undefined) parent.createEl("code", { text: m[5] });
		else if (m[6] !== undefined) link(parent, m[6], m[7]);
		else if (m[9] !== undefined) renderInline(parent.createEl("em"), m[9]);
		else link(parent, m[10], m[10]);
		rest = rest.slice(m.index + m[0].length);
	}
}

function link(parent: HTMLElement, text: string, href: string): void {
	if (!/^(https?:|mailto:|tel:|obsidian:)/i.test(href)) {
		parent.appendText(text);
		return;
	}
	const a = parent.createEl("a", { cls: "external-link", text, href, attr: { target: "_blank", rel: "noopener" } });
	a.addEventListener("click", (e) => e.stopPropagation());
}
