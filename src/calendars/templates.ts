import { App, normalizePath, TFile } from "obsidian";
import { safeCalendarName } from "./store";

/** Folder (next to the data note) holding one note per description template. */
export const TEMPLATES_FOLDER = "Templates";
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * A description template for calendar entries (e.g. a packing list or an incident report). Each one is a note in
 * the vault whose text is the template itself, so it syncs on its own and can be edited by hand.
 */
export interface DescriptionTemplate {
	path: string;
	/** The note's name. */
	name: string;
	text: string;
}

export function templatesFolderFor(dataPath: string): string {
	const slash = dataPath.lastIndexOf("/");
	return slash === -1 ? TEMPLATES_FOLDER : `${dataPath.slice(0, slash)}/${TEMPLATES_FOLDER}`;
}

/** Blanks to fill in: "___" anywhere in a line. */
const BLANK_RE = /_{3,}/g;
/** A line ending with ":" and nothing after it, e.g. "* Location:"; its answer goes after the colon. */
const ANSWER_RE = /:\s*$/;

/** One template line: text pieces between blanks, and whether it takes an answer after the colon. */
export interface TemplateLine {
	raw: string;
	/** Text around the blanks; a line with n blanks has n + 1 pieces. */
	pieces: string[];
	answer: boolean;
}

export function templateLines(text: string): TemplateLine[] {
	return text.split("\n").map((raw) => ({ raw, pieces: raw.split(BLANK_RE), answer: ANSWER_RE.test(raw) }));
}

/** True when the template has something to fill in (then it opens a form before it is inserted). */
export function hasFields(text: string): boolean {
	return templateLines(text).some((l) => l.answer || l.pieces.length > 1);
}

/**
 * The template with the filled values: `blanks[i][j]` replaces the j-th "___" of line i (left as is when empty),
 * `answers[i]` goes after line i's colon. Further lines of an answer are indented under the list item's text.
 */
export function fillTemplate(lines: TemplateLine[], blanks: string[][], answers: string[]): string {
	return lines
		.map((l, i) => {
			let line = l.pieces.reduce((out, piece, j) => (j === 0 ? piece : out + (blanks[i]?.[j - 1]?.trim() || "___") + piece), "");
			const answer = l.answer ? answers[i]?.replace(/\s+$/, "") ?? "" : "";
			if (!answer.trim()) return line;
			const indent = " ".repeat((/^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/.exec(line)?.[0] ?? "").length);
			const [first, ...rest] = answer.split("\n");
			line = `${line.replace(/\s+$/, "")} ${first.trim()}`;
			return [line, ...rest.map((r) => (r.trim() ? indent + r.trim() : ""))].join("\n");
		})
		.join("\n");
}

/** Reads the template notes when they are needed (they are only used from the entry window). */
export class TemplateStore {
	constructor(
		private readonly app: App,
		private readonly folder: () => string,
	) {}

	/** Sorted by name. */
	async all(): Promise<DescriptionTemplate[]> {
		const adapter = this.app.vault.adapter;
		const folder = this.folder();
		if (!(await adapter.exists(folder))) return [];
		const files = (await adapter.list(folder)).files.filter((f) => f.toLowerCase().endsWith(".md"));
		const out: DescriptionTemplate[] = [];
		for (const path of files) {
			const content = await adapter.read(path);
			const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
			out.push({ path, name, text: content.replace(FRONTMATTER_RE, "").replace(/^\n+|\s+$/g, "") });
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Creates a template, or renames / rewrites `existing`. */
	async save(existing: DescriptionTemplate | null, name: string, text: string): Promise<void> {
		const clean = safeCalendarName(name);
		if (!clean) throw new Error("Give the template a name.");
		const adapter = this.app.vault.adapter;
		const folder = this.folder();
		await this.ensureFolder(folder);
		const target = normalizePath(`${folder}/${clean}.md`);
		let path = existing?.path ?? target;
		if (path !== target) {
			if (await adapter.exists(target)) throw new Error(`A template named "${clean}" already exists.`);
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await this.app.fileManager.renameFile(file, target);
			else if (await adapter.exists(path)) await adapter.rename(path, target);
			path = target;
		} else if (!existing && (await adapter.exists(target))) throw new Error(`A template named "${clean}" already exists.`);
		const content = `${text.replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, "")}\n`;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await adapter.write(path, content);
	}

	/** Moves the template's note to the trash. */
	async remove(t: DescriptionTemplate): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(t.path);
		if (file instanceof TFile) await this.app.fileManager.trashFile(file);
		else await this.app.vault.adapter.remove(t.path);
	}

	private async ensureFolder(path: string): Promise<void> {
		let cur = "";
		for (const part of path.split("/")) {
			cur = cur ? `${cur}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(cur))) await this.app.vault.adapter.mkdir(cur);
		}
	}
}
