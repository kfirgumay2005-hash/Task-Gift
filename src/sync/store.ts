import type { DayTitle, RecurrenceRule, StoreData, Task, TaskColor, TaskList } from "../types";
import { nextOccurrence } from "../recurrence/rule";
import { addDays, today } from "../util/dates";

/** Day headings older than this many days are dropped. */
const KEEP_DAY_TITLES_DAYS = 60;

export const LOCAL_PREFIX = "local-";

export function isLocalId(id: string): boolean {
	return id.startsWith(LOCAL_PREFIX);
}

export function newLocalId(): string {
	return LOCAL_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export interface TaskFields {
	title: string;
	notes?: string;
	listId: string;
	due?: string | null;
	parent?: string | null;
	status?: Task["status"];
}

export interface TaskEdit {
	title?: string;
	notes?: string;
	listId?: string;
	due?: string | null;
	parent?: string | null;
	/** undefined = unchanged, null = clear. */
	time?: string | null;
	recurrence?: RecurrenceRule | null;
	/** undefined = unchanged, null = clear. */
	color?: TaskColor | null;
	/** Mode IDs the task may be drawn in. undefined = unchanged, null or empty = every mode. */
	modes?: string[] | null;
}

export type ChangeSource = "local" | "remote";

/**
 * Holds all task state and is the only place that mutates it.
 * Every local mutation marks the task dirty so the sync engine pushes it.
 */
export class TaskStore {
	constructor(public data: StoreData, private readonly onChange: (source: ChangeSource) => void) {}

	notify(source: ChangeSource): void {
		this.onChange(source);
	}

	get(id: string): Task | undefined {
		const t = this.data.tasks[id] ?? this.data.tasks[this.resolveAlias(id)];
		return t && !t.pendingDelete ? t : undefined;
	}

	resolveAlias(id: string): string {
		let cur = id;
		for (let i = 0; i < 5 && this.data.aliases[cur]; i++) cur = this.data.aliases[cur];
		return cur;
	}

	/** All visible (not pending deletion) tasks. */
	all(): Task[] {
		return Object.values(this.data.tasks).filter((t) => !t.pendingDelete);
	}

	lists(): TaskList[] {
		return Object.values(this.data.lists).sort((a, b) => a.title.localeCompare(b.title));
	}

	listTitle(id: string): string {
		return this.data.lists[id]?.title ?? "Unknown list";
	}

	defaultListId(): string | null {
		return this.lists()[0]?.id ?? null;
	}

	time(id: string): string | null {
		return this.data.times[id] ?? null;
	}

	color(id: string): TaskColor | null {
		return this.data.colors[id] ?? null;
	}

	/** Mode IDs the task may be drawn in, or null for every mode. */
	modes(id: string): string[] | null {
		return this.data.taskModes[id] ?? null;
	}

	rule(id: string): RecurrenceRule | null {
		return this.data.recurrence[id] ?? null;
	}

	/** The day's heading, or null when it has none. */
	dayTitle(date: string): DayTitle | null {
		const t = this.data.dayTitles[date];
		return t?.text ? t : null;
	}

	/** The style of the most recent heading, so a new day starts looking like the last one. */
	lastDayTitle(): DayTitle | null {
		const dates = Object.keys(this.data.dayTitles).filter((d) => this.data.dayTitles[d].text).sort();
		return dates.length ? this.data.dayTitles[dates[dates.length - 1]] : null;
	}

	/** Sets (or, with empty text, clears) a day's heading. Local only: it never reaches Google. */
	setDayTitle(date: string, title: Omit<DayTitle, "updated">): void {
		this.data.dayTitles[date] = { ...title, text: title.text.trim(), updated: Date.now() };
		const cutoff = addDays(today(), -KEEP_DAY_TITLES_DAYS);
		for (const d of Object.keys(this.data.dayTitles)) if (d < cutoff) delete this.data.dayTitles[d];
	}

	children(id: string): Task[] {
		return this.all().filter((t) => t.parent === id);
	}

	create(fields: TaskFields, source: ChangeSource = "local", silent = false): Task {
		const id = newLocalId();
		const status = fields.status ?? "needsAction";
		const task: Task = {
			id,
			listId: fields.listId,
			title: fields.title,
			notes: fields.notes ?? "",
			due: fields.due ?? null,
			status,
			completed: status === "completed" ? new Date().toISOString() : null,
			parent: fields.parent ?? null,
			position: "~",
			updated: "",
			remoteListId: null,
			remoteParent: null,
			dirty: true,
			localUpdated: Date.now(),
			pendingDelete: false,
		};
		this.data.tasks[id] = task;
		if (!silent) this.notify(source);
		return task;
	}

	update(id: string, edit: TaskEdit, source: ChangeSource = "local"): void {
		const task = this.get(id);
		if (!task) return;
		let changed = false;
		const set = <K extends keyof Task>(k: K, v: Task[K]) => {
			if (task[k] !== v) {
				task[k] = v;
				changed = true;
			}
		};
		if (edit.title !== undefined) set("title", edit.title);
		if (edit.notes !== undefined) set("notes", edit.notes);
		if (edit.due !== undefined) set("due", edit.due);
		if (edit.listId !== undefined && edit.listId !== task.listId) {
			set("listId", edit.listId);
			// Subtasks follow their parent; a moved subtask becomes top-level.
			if (edit.parent === undefined) set("parent", null);
			for (const child of this.children(task.id)) {
				child.listId = edit.listId;
			}
		}
		if (edit.parent !== undefined) set("parent", edit.parent);
		if (changed) {
			task.dirty = true;
			task.localUpdated = Date.now();
		}
		if (edit.time !== undefined) {
			if (edit.time) this.data.times[task.id] = edit.time;
			else delete this.data.times[task.id];
			changed = true;
		}
		if (edit.color !== undefined) {
			if (edit.color) this.data.colors[task.id] = edit.color;
			else delete this.data.colors[task.id];
			changed = true;
		}
		if (edit.modes !== undefined) {
			if (edit.modes?.length) this.data.taskModes[task.id] = [...edit.modes];
			else delete this.data.taskModes[task.id];
			changed = true;
		}
		if (edit.recurrence !== undefined) {
			if (edit.recurrence) {
				this.data.recurrence[task.id] = edit.recurrence;
				if (task.status !== "completed") delete this.data.spawned[task.id];
			} else delete this.data.recurrence[task.id];
			changed = true;
		}
		if (changed) this.notify(source);
	}

	setCompleted(id: string, done: boolean, source: ChangeSource = "local"): void {
		const task = this.get(id);
		if (!task) return;
		const status = done ? "completed" : "needsAction";
		if (task.status === status) return;
		task.status = status;
		task.completed = done ? new Date().toISOString() : null;
		task.dirty = true;
		task.localUpdated = Date.now();
		if (done) this.maybeSpawnNext(task);
		this.notify(source);
	}

	delete(id: string, source: ChangeSource = "local"): void {
		const task = this.get(id);
		if (!task) return;
		const ids = [task.id, ...this.children(task.id).map((c) => c.id)];
		for (const tid of ids) {
			const t = this.data.tasks[tid];
			if (isLocalId(tid)) this.forget(tid);
			else {
				t.pendingDelete = true;
				t.dirty = true;
				t.localUpdated = Date.now();
			}
		}
		this.notify(source);
	}

	/** Removes a task and all side data from the store. */
	forget(id: string): void {
		delete this.data.tasks[id];
		delete this.data.snapshots[id];
		delete this.data.recurrence[id];
		delete this.data.times[id];
		delete this.data.colors[id];
		delete this.data.taskModes[id];
		delete this.data.spawned[id];
	}

	/** Replaces a (temporary) ID everywhere. */
	remap(oldId: string, newId: string): void {
		if (oldId === newId) return;
		const task = this.data.tasks[oldId];
		if (task) {
			task.id = newId;
			this.data.tasks[newId] = task;
			delete this.data.tasks[oldId];
		}
		for (const t of Object.values(this.data.tasks)) if (t.parent === oldId) t.parent = newId;
		const moveKey = <T>(rec: Record<string, T>) => {
			if (oldId in rec) {
				rec[newId] = rec[oldId];
				delete rec[oldId];
			}
		};
		moveKey(this.data.recurrence);
		moveKey(this.data.times);
		moveKey(this.data.colors);
		moveKey(this.data.taskModes);
		moveKey(this.data.spawned);
		moveKey(this.data.snapshots);
		for (const [k, v] of Object.entries(this.data.spawned)) if (v === oldId) this.data.spawned[k] = newId;
		const g = this.data.gift;
		g.drawn = g.drawn.map((x) => (x === oldId ? newId : x));
		g.done = g.done.map((x) => (x === oldId ? newId : x));
		g.recent = g.recent.map((x) => (x === oldId ? newId : x));
		this.data.aliases[oldId] = newId;
		const keys = Object.keys(this.data.aliases);
		if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete this.data.aliases[k];
	}

	/** When a recurring task is completed, create its next occurrence (once). */
	maybeSpawnNext(task: Task): void {
		const rule = this.data.recurrence[task.id];
		if (!rule || this.data.spawned[task.id]) return;
		const next = nextOccurrence(rule, task.due ?? today(), today());
		if (!next) {
			this.data.spawned[task.id] = "end";
			return;
		}
		// Another device may already have created the next occurrence (each device sees the completion in Google,
		// but the data note saying it was spawned can arrive later). Adopt that task instead of adding a copy.
		const existing = this.all().find(
			(t) =>
				t.id !== task.id &&
				t.title === task.title &&
				t.listId === task.listId &&
				t.due === next.due &&
				(t.parent ?? null) === (task.parent ?? null),
		);
		const target =
			existing ??
			this.create(
				{ title: task.title, notes: task.notes, listId: task.listId, due: next.due, parent: task.parent },
				"local",
				true,
			);
		this.data.recurrence[target.id] ??= next.rule;
		const time = this.data.times[task.id];
		if (time) this.data.times[target.id] ??= time;
		const color = this.data.colors[task.id];
		if (color) this.data.colors[target.id] ??= color;
		const modes = this.data.taskModes[task.id];
		if (modes) this.data.taskModes[target.id] ??= [...modes];
		this.data.spawned[task.id] = target.id;
	}

	/** Drops old completed tasks from local state (they stay in Google). */
	prune(keepDays: number): void {
		const cutoff = Date.now() - keepDays * 86400000;
		for (const t of Object.values(this.data.tasks)) {
			if (t.dirty || t.status !== "completed" || !t.completed) continue;
			if (Date.parse(t.completed) < cutoff && !this.data.gift.drawn.includes(t.id)) this.forget(t.id);
		}
		for (const [k, v] of Object.entries(this.data.spawned)) {
			if (!this.data.tasks[k] && (v === "end" || !this.data.tasks[v])) delete this.data.spawned[k];
		}
	}
}
