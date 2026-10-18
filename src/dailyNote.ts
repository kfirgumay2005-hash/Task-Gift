import { App, moment as obsidianMoment, normalizePath, TFile } from "obsidian";
import type { TaskStore } from "./sync/store";
import type { Task, TaskGiftSettings } from "./types";
import { today } from "./util/dates";

/** Obsidian's bundled moment, typed for the one call used here (its own typings can resolve to `any`). */
const moment = obsidianMoment as unknown as () => { format(format: string): string };

interface DailyNotesOptions {
	folder?: string;
	format?: string;
}

interface InternalPlugins {
	getPluginById(id: string): { enabled: boolean; instance?: { options?: DailyNotesOptions } } | null;
}

/** Folder and file name format from the core "Daily notes" plugin. */
function dailyNotesOptions(app: App): { folder: string; format: string; enabled: boolean } {
	const internal = (app as unknown as { internalPlugins?: InternalPlugins }).internalPlugins;
	const plugin = internal?.getPluginById("daily-notes");
	const opts = plugin?.instance?.options ?? {};
	return {
		folder: (opts.folder ?? "").trim().replace(/^\/+|\/+$/g, ""),
		format: (opts.format ?? "").trim() || "YYYY-MM-DD",
		enabled: !!plugin?.enabled,
	};
}

export function isDailyNotesEnabled(app: App): boolean {
	return dailyNotesOptions(app).enabled;
}

/** Vault path of today's daily note (it may not exist yet). */
export function todayNotePath(app: App): string {
	const { folder, format } = dailyNotesOptions(app);
	const name = moment().format(format);
	return normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
}

export function todayNote(app: App): TFile | null {
	const f = app.vault.getAbstractFileByPath(todayNotePath(app));
	return f instanceof TFile ? f : null;
}

/** Open tasks due today (and overdue ones, if set), subtasks under their parent. */
function tasksForToday(store: TaskStore, includeOverdue: boolean): Task[] {
	const t0 = today();
	const picked = store
		.all()
		.filter((t) => t.status !== "completed" && t.due && (t.due === t0 || (includeOverdue && t.due < t0)))
		.sort((a, b) => {
			const ad = a.due ?? "";
			const bd = b.due ?? "";
			if (ad !== bd) return ad < bd ? -1 : 1;
			const at = store.time(a.id) ?? "99:99";
			const bt = store.time(b.id) ?? "99:99";
			if (at !== bt) return at < bt ? -1 : 1;
			return a.position.localeCompare(b.position);
		});
	const ids = new Set(picked.map((t) => t.id));
	const out: Task[] = [];
	for (const t of picked) {
		if (t.parent && ids.has(t.parent)) continue;
		out.push(t);
		for (const c of picked) if (c.parent === t.id) out.push(c);
	}
	return out;
}

/** Markdown checklist: one checkbox per task, its description indented below it. */
export function tasksMarkdown(store: TaskStore, settings: TaskGiftSettings): { text: string; count: number } {
	const tasks = tasksForToday(store, settings.dailyNoteIncludeOverdue);
	const ids = new Set(tasks.map((t) => t.id));
	const t0 = today();
	const lines: string[] = [];
	const heading = settings.dailyNoteHeading.trim();
	if (heading) lines.push(heading);
	for (const t of tasks) {
		const indent = t.parent && ids.has(t.parent) ? "\t" : "";
		const time = store.time(t.id);
		let line = `${indent}- [ ] ${(t.title || "(untitled)").replace(/\s*\n\s*/g, " ")}`;
		if (time) line += ` (${time})`;
		if (t.due && t.due < t0) line += ` (overdue since ${t.due})`;
		lines.push(line);
		for (const n of t.notes.split(/\r?\n/)) if (n.trim()) lines.push(`${indent}\t${n.trimEnd()}`);
	}
	return { text: lines.join("\n"), count: tasks.length };
}

/** Appends the block below whatever the note already contains; nothing existing is changed. */
export async function appendToNote(app: App, file: TFile, block: string): Promise<void> {
	await app.vault.process(file, (content) => {
		const kept = content.replace(/\s+$/, "");
		return `${kept ? `${kept}\n\n` : ""}${block}\n`;
	});
}

/** True when the note already has the heading line (tasks were added before). */
export function hasHeading(content: string, heading: string): boolean {
	const h = heading.trim();
	return !!h && content.split(/\r?\n/).some((l) => l.trim() === h);
}
