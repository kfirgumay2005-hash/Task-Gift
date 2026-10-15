import { App, normalizePath, TFile } from "obsidian";
import type { Task, TaskGiftSettings } from "../types";
import { describeRule } from "../recurrence/rule";
import { isDateString } from "../util/dates";
import type { TaskEdit, TaskStore } from "./store";

const TASK_RE = /^(\s*)[-*+] \[([ xX])\](?: (.*))?$/;
const ID_RE = /\s*<!--\s*gt:([\w-]+)\s*-->\s*$/;
const LIST_RE = /^##\s+(.*?)\s*(?:<!--\s*gtl:([^\s>]+)\s*-->)?\s*$/;
const NOTE_RE = /^(\s+)>\s?(.*)$/;
const DUE_RE = /\s*📅\s*(\d{4}-\d{2}-\d{2})/;
const TIME_RE = /\s*⏰\s*(\d{1,2}:\d{2})/;
const REC_RE = /\s*🔄.*$/;

export interface ParsedTask {
	id: string | null;
	title: string;
	done: boolean;
	due: string | null;
	time: string | null;
	notes: string[];
	indent: number;
	parent: ParsedTask | null;
	listId: string | null;
	listTitle: string;
	/** Filled during ingestion. */
	resolvedId?: string;
}

function indentWidth(ws: string): number {
	let w = 0;
	for (const ch of ws) w += ch === "\t" ? 4 : 1;
	return w;
}

export function parseNote(content: string): ParsedTask[] {
	const out: ParsedTask[] = [];
	let listId: string | null = null;
	let listTitle = "";
	let stack: ParsedTask[] = [];
	let last: ParsedTask | null = null;

	for (const line of content.split(/\r?\n/)) {
		const lm = LIST_RE.exec(line);
		if (lm && !line.startsWith("###")) {
			listTitle = lm[1];
			listId = lm[2] ?? null;
			stack = [];
			last = null;
			continue;
		}
		const tm = TASK_RE.exec(line);
		if (tm) {
			const indent = indentWidth(tm[1]);
			let text = tm[3] ?? "";
			let id: string | null = null;
			const idm = ID_RE.exec(text);
			if (idm) {
				id = idm[1];
				text = text.slice(0, idm.index);
			}
			text = text.replace(REC_RE, "");
			let time: string | null = null;
			const timem = TIME_RE.exec(text);
			if (timem) {
				time = timem[1].padStart(5, "0");
				text = text.replace(TIME_RE, "");
			}
			let due: string | null = null;
			const duem = DUE_RE.exec(text);
			if (duem && isDateString(duem[1])) {
				due = duem[1];
				text = text.replace(DUE_RE, "");
			}
			while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
			const task: ParsedTask = {
				id,
				title: text.trim(),
				done: tm[2] !== " ",
				due,
				time,
				notes: [],
				indent,
				parent: stack.length ? stack[stack.length - 1] : null,
				listId,
				listTitle,
			};
			out.push(task);
			stack.push(task);
			last = task;
			continue;
		}
		const nm = NOTE_RE.exec(line);
		if (nm && last && indentWidth(nm[1]) > last.indent) {
			last.notes.push(nm[2]);
			continue;
		}
		if (line.trim() !== "") last = null;
	}
	return out;
}

function sortTasks(a: Task, b: Task): number {
	if (a.status !== b.status) return a.status === "completed" ? 1 : -1;
	return a.position.localeCompare(b.position);
}

interface Baseline {
	title: string;
	due: string | null;
	time: string | null;
	notes: string;
	done: boolean;
	listId: string;
	parent: string | null;
}

/**
 * Mirrors the store into a markdown note and reads edits back.
 * Edits are detected against what was last rendered (a 3-way diff), so a note that is
 * slightly stale never reverts changes made in Google or in the board meanwhile.
 */
export class NoteMirror {
	private lastWritten: string | null = null;
	private writing = false;
	private baseline = new Map<string, Baseline>();

	constructor(
		private readonly app: App,
		private readonly store: TaskStore,
		private readonly settings: () => TaskGiftSettings,
		private readonly confirmDeletes: (titles: string[]) => Promise<boolean>,
	) {}

	path(): string {
		return normalizePath(this.settings().notePath || "Tasks/Google Tasks.md");
	}

	isMirrorFile(file: TFile): boolean {
		return file.path === this.path();
	}

	/** True if the content is exactly what we last wrote (our own modify event). */
	isOwnWrite(content: string): boolean {
		return this.writing || content === this.lastWritten;
	}

	private snapshot(t: Task): Baseline {
		return {
			title: t.title.replace(/\r?\n/g, " ").trim(),
			due: t.due,
			time: this.store.time(t.id),
			notes: t.notes.replace(/\s+$/, ""),
			done: t.status === "completed",
			listId: t.listId,
			parent: t.parent,
		};
	}

	private renderTask(t: Task, depth: number, lines: string[], ids: string[], baseline: Map<string, Baseline>): void {
		baseline.set(t.id, this.snapshot(t));
		const indent = "\t".repeat(depth);
		let line = `${indent}- [${t.status === "completed" ? "x" : " "}] ${t.title.replace(/\r?\n/g, " ")}`;
		if (t.due) line += ` 📅 ${t.due}`;
		const time = this.store.time(t.id);
		if (time) line += ` ⏰ ${time}`;
		const rule = this.store.rule(t.id);
		if (rule) line += ` 🔄 ${describeRule(rule)}`;
		line += ` <!-- gt:${t.id} -->`;
		lines.push(line);
		ids.push(t.id);
		if (t.notes) for (const n of t.notes.split(/\r?\n/)) lines.push(`${indent}\t> ${n}`.trimEnd());
		for (const c of this.store.children(t.id).sort(sortTasks)) this.renderTask(c, depth + 1, lines, ids, baseline);
	}

	build(): { content: string; ids: string[]; baseline: Map<string, Baseline> } {
		const baseline = new Map<string, Baseline>();
		const lines = [
			"# Google Tasks",
			"",
			"> [!info] Synced with Google Tasks by Task Gift",
			"> Edit, add (`- [ ] title 📅 2025-01-31 ⏰ 09:00`), check off or delete tasks here. Indent a task to make it a subtask and add notes as indented `> ` lines. Keep the hidden `gt:` markers intact. Recurrence is edited in the Task Gift modal.",
			"",
		];
		const ids: string[] = [];
		const all = this.store.all();
		const known = new Set(all.map((t) => t.id));
		for (const list of this.store.lists()) {
			lines.push(`## ${list.title} <!-- gtl:${list.id} -->`, "");
			const top = all.filter((t) => t.listId === list.id && (!t.parent || !known.has(t.parent))).sort(sortTasks);
			for (const t of top) this.renderTask(t, 0, lines, ids, baseline);
			lines.push("");
		}
		return { content: lines.join("\n"), ids, baseline };
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split("/").slice(0, -1);
		let cur = "";
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			if (!this.app.vault.getAbstractFileByPath(cur)) await this.app.vault.createFolder(cur).catch(() => undefined);
		}
	}

	async render(): Promise<void> {
		if (!this.settings().mirrorToNote) return;
		if (!this.store.lists().length) return;
		const { content, ids, baseline } = this.build();
		const path = this.path();
		this.writing = true;
		try {
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				const current = await this.app.vault.read(existing);
				this.lastWritten = content;
				if (current !== content) await this.app.vault.modify(existing, content);
			} else {
				await this.ensureFolder(path);
				this.lastWritten = content;
				await this.app.vault.create(path, content);
			}
			this.store.data.renderedIds = ids;
			this.baseline = baseline;
		} finally {
			this.writing = false;
		}
	}

	private resolveList(pt: ParsedTask): string | null {
		const lists = this.store.data.lists;
		if (pt.listId && lists[pt.listId]) return pt.listId;
		const byTitle = this.store.lists().find((l) => l.title.trim().toLowerCase() === pt.listTitle.trim().toLowerCase());
		return byTitle?.id ?? null;
	}

	/** Reads the note and applies differences to the store. Returns true if anything changed. */
	async ingest(): Promise<boolean> {
		if (!this.settings().mirrorToNote) return false;
		const file = this.app.vault.getAbstractFileByPath(this.path());
		if (!(file instanceof TFile)) return false;
		const content = await this.app.vault.read(file);
		if (this.lastWritten !== null && content === this.lastWritten) return false;
		if (!this.store.lists().length) return false;

		const parsed = parseNote(content);
		const store = this.store;
		const seen = new Set<string>();
		let changed = false;
		let created = 0;
		const unknownLists = new Set<string>();

		for (const pt of parsed) {
			const listId = this.resolveList(pt);
			if (!listId) {
				if (pt.listTitle) unknownLists.add(pt.listTitle);
				continue;
			}
			const parentId = pt.parent?.resolvedId ?? null;
			const id = pt.id ? store.resolveAlias(pt.id) : null;
			const existing = id ? store.get(id) : undefined;
			const notes = pt.notes.join("\n").replace(/\s+$/, "");

			if (existing) {
				pt.resolvedId = existing.id;
				seen.add(existing.id);
				const base = this.baseline.get(existing.id) ?? this.snapshot(existing);
				const edit: TaskEdit = {};
				if (pt.title !== base.title) edit.title = pt.title;
				if (pt.due !== base.due) edit.due = pt.due;
				if (notes !== base.notes) edit.notes = notes;
				if (pt.time !== base.time) edit.time = pt.time;
				if (listId !== base.listId) {
					edit.listId = listId;
					edit.parent = parentId;
				} else if (parentId !== base.parent && !(pt.parent && !pt.parent.resolvedId)) {
					edit.parent = parentId;
				}
				if (Object.keys(edit).length) {
					store.update(existing.id, edit, "note");
					changed = true;
				}
				if (pt.done !== base.done) {
					store.setCompleted(existing.id, pt.done, "note");
					changed = true;
				}
				this.baseline.set(existing.id, {
					title: pt.title,
					due: pt.due,
					time: pt.time,
					notes,
					done: pt.done,
					listId,
					parent: edit.parent !== undefined ? edit.parent : base.parent,
				});
			} else if (!pt.id) {
				if (!pt.title) continue;
				const t = store.create(
					{ title: pt.title, notes, listId, due: pt.due, parent: parentId, status: pt.done ? "completed" : "needsAction" },
					"note",
				);
				if (pt.time) store.update(t.id, { time: pt.time }, "note");
				pt.resolvedId = t.id;
				changed = true;
				created++;
			}
			// A line with an unknown ID belongs to a task removed elsewhere; it disappears on the next render.
		}

		if (unknownLists.size) {
			console.warn(`[Task Gift] Ignored tasks under unknown list heading(s): ${[...unknownLists].join(", ")}`);
		}

		const missing = store.data.renderedIds
			.map((id) => store.resolveAlias(id))
			.filter((id) => !seen.has(id) && store.get(id));
		let forceRender = created > 0;
		if (missing.length) {
			const titles = missing.map((id) => store.get(id)?.title ?? id);
			const massDelete = missing.length >= 5 && missing.length > store.data.renderedIds.length * 0.5;
			const ok = massDelete ? await this.confirmDeletes(titles) : true;
			if (ok) {
				for (const id of missing) store.delete(id, "note");
				changed = true;
			} else {
				forceRender = true;
			}
		}
		this.lastWritten = content;
		// New lines need their ID markers right away so they are not created twice.
		if (forceRender) await this.render();
		return changed;
	}
}
