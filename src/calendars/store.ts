import { App, normalizePath, TFile } from "obsidian";
import type { TaskColor } from "../types";
import { CalendarEntry, compareEntries, formatEntry, parseEntries } from "./format";

/** Folder (next to the data note) holding one note per extra calendar. */
export const CALENDARS_FOLDER = "Calendars";
const MARKER = "task-gift-calendar";
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * A calendar apart from the Google tasks (e.g. work shifts). Each one is a note in the vault, in the same text
 * format the import reads, so it syncs on its own and can also be edited by hand.
 */
export interface ExtraCalendar {
	path: string;
	/** The note's name. */
	name: string;
	color: TaskColor | null;
	entries: CalendarEntry[];
}

export function calendarsFolderFor(dataPath: string): string {
	const slash = dataPath.lastIndexOf("/");
	return slash === -1 ? CALENDARS_FOLDER : `${dataPath.slice(0, slash)}/${CALENDARS_FOLDER}`;
}

function parseNote(path: string, content: string): ExtraCalendar {
	const fm = FRONTMATTER_RE.exec(content);
	const color = fm ? /^color:\s*["']?([#\w]+)["']?\s*$/m.exec(fm[1])?.[1] ?? null : null;
	const body = fm ? content.slice(fm[0].length) : content;
	const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
	return { path, name, color: color as TaskColor | null, entries: parseEntries(body).entries.sort(compareEntries) };
}

function serializeNote(cal: ExtraCalendar): string {
	const fm = ["---", `${MARKER}: 1`, ...(cal.color ? [`color: "${cal.color}"`] : []), "---", ""];
	return [...fm, ...cal.entries.map(formatEntry), ""].join("\n");
}

/** Characters not allowed in a note name. */
export function safeCalendarName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Reads the calendar notes and keeps them current. Checked on the same timer as the data note (mtime + size
 * only), since a sync tool may write the notes straight to disk without a vault event.
 */
export class CalendarStore {
	private cache = new Map<string, { stamp: string; cal: ExtraCalendar }>();
	private checking: Promise<void> | null = null;

	constructor(
		private readonly app: App,
		private readonly folder: () => string,
		private readonly onChange: () => void,
	) {}

	/** Sorted by name. */
	all(): ExtraCalendar[] {
		return [...this.cache.values()].map((c) => c.cal).sort((a, b) => a.name.localeCompare(b.name));
	}

	get(path: string | null): ExtraCalendar | null {
		return path ? this.cache.get(path)?.cal ?? null : null;
	}

	isCalendarPath(path: string): boolean {
		return path.startsWith(`${this.folder()}/`) && path.toLowerCase().endsWith(".md");
	}

	/** Picks up notes added, changed or removed (by hand or by another device). */
	refresh(): Promise<void> {
		if (!this.checking) this.checking = this.check().finally(() => (this.checking = null));
		return this.checking;
	}

	private async check(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const folder = this.folder();
		const files = (await adapter.exists(folder)) ? (await adapter.list(folder)).files.filter((f) => f.toLowerCase().endsWith(".md")) : [];
		let changed = false;
		for (const path of [...this.cache.keys()]) {
			if (!files.includes(path)) {
				this.cache.delete(path);
				changed = true;
			}
		}
		for (const path of files) {
			const stat = await adapter.stat(path);
			if (!stat) continue;
			const stamp = `${stat.mtime}:${stat.size}`;
			if (this.cache.get(path)?.stamp === stamp) continue;
			this.cache.set(path, { stamp, cal: parseNote(path, await adapter.read(path)) });
			changed = true;
		}
		if (changed) this.onChange();
	}

	async create(name: string, color: TaskColor | null): Promise<ExtraCalendar> {
		const clean = safeCalendarName(name) || "Calendar";
		const folder = this.folder();
		const adapter = this.app.vault.adapter;
		await this.ensureFolder(folder);
		let path = normalizePath(`${folder}/${clean}.md`);
		for (let i = 2; await adapter.exists(path); i++) path = normalizePath(`${folder}/${clean} ${i}.md`);
		const cal: ExtraCalendar = { path, name: path.slice(path.lastIndexOf("/") + 1, -3), color, entries: [] };
		await this.save(cal);
		return cal;
	}

	/** Writes the calendar's note. */
	async save(cal: ExtraCalendar): Promise<void> {
		cal.entries.sort(compareEntries);
		const content = serializeNote(cal);
		const file = this.app.vault.getAbstractFileByPath(cal.path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.adapter.write(cal.path, content);
		const stat = await this.app.vault.adapter.stat(cal.path);
		this.cache.set(cal.path, { stamp: stat ? `${stat.mtime}:${stat.size}` : "", cal });
		this.onChange();
	}

	async rename(cal: ExtraCalendar, name: string): Promise<void> {
		const clean = safeCalendarName(name);
		if (!clean || clean === cal.name) return;
		const target = normalizePath(`${this.folder()}/${clean}.md`);
		if (await this.app.vault.adapter.exists(target)) throw new Error(`A calendar named "${clean}" already exists.`);
		const file = this.app.vault.getAbstractFileByPath(cal.path);
		if (file instanceof TFile) await this.app.fileManager.renameFile(file, target);
		else await this.app.vault.adapter.rename(cal.path, target);
		this.cache.delete(cal.path);
		cal.path = target;
		cal.name = clean;
		await this.save(cal);
	}

	/** Moves the calendar's note to the trash. */
	async remove(cal: ExtraCalendar): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(cal.path);
		if (file instanceof TFile) await this.app.fileManager.trashFile(file);
		else await this.app.vault.adapter.remove(cal.path);
		this.cache.delete(cal.path);
		this.onChange();
	}

	private async ensureFolder(path: string): Promise<void> {
		let cur = "";
		for (const part of path.split("/")) {
			cur = cur ? `${cur}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(cur))) await this.app.vault.adapter.mkdir(cur);
		}
	}
}
