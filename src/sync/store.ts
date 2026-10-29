import type { DayTitle, PausedTask, PauseState, RecurrenceRule, StickyNote, StoreData, Task, TaskColor, TaskList } from "../types";
import { nextOccurrence } from "../recurrence/rule";
import { addDays, addMonths, today } from "../util/dates";

/** Day headings older than this many days are dropped. */
const KEEP_DAY_TITLES_DAYS = 60;
/** Deleted sticky notes are forgotten after this many days (long enough for every device to see the deletion). */
const KEEP_DELETED_STICKIES_DAYS = 60;
/** Resumed tasks' pause entries are forgotten after this many days. */
const KEEP_RESUMED_DAYS = 60;
/** How far ahead `removeDuplicates` looks for open tasks with the same title on the same day. */
export const DUPLICATE_CHECK_MONTHS = 3;

/** Whether the heading written for `start` is still shown on `date` (on or after `start`). */
/** Whether a heading still shows on `date`; `time` (HH:MM, today only) also ends it after its `untilTime`. */
function dayTitleLasts(start: string, t: DayTitle, date: string, time?: string): boolean {
	if (t.until === null) return true;
	const last = t.until ?? start;
	if (date === last && time && typeof t.until === "string" && t.untilTime) return time < t.untilTime;
	return date <= last;
}

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

	// Paused tasks are no task any more; their time, color and repeat come from what was kept when they were paused.
	time(id: string): string | null {
		return this.data.times[id] ?? this.pausedTask(id)?.time ?? null;
	}

	color(id: string): TaskColor | null {
		return this.data.colors[id] ?? this.pausedTask(id)?.color ?? null;
	}

	/** Mode IDs the task may be drawn in, or null for every mode. */
	modes(id: string): string[] | null {
		return this.data.taskModes[id] ?? null;
	}

	rule(id: string): RecurrenceRule | null {
		return this.data.recurrence[id] ?? this.pausedTask(id)?.rule ?? null;
	}

	/** Whether `id` is a paused task (in the Paused column). */
	isPaused(id: string): boolean {
		return !!this.data.paused[id]?.on;
	}

	private pausedTask(id: string): PausedTask | undefined {
		const p = this.data.paused[id];
		return p?.on ? p.task : undefined;
	}

	/** Paused tasks as cards for the Paused column; their ID is the key in `paused`, not a task in the store. */
	pausedTasks(): Task[] {
		return Object.entries(this.data.paused)
			.filter(([, p]) => p.on && p.task)
			.sort((a, b) => b[1].updated - a[1].updated)
			.map(([id, p], i): Task => {
				const k = p.task as PausedTask;
				return {
					id,
					listId: k.listId,
					title: k.title,
					notes: k.notes,
					due: k.due,
					status: "needsAction",
					completed: null,
					parent: null,
					position: String(i).padStart(6, "0"),
					updated: "",
					remoteListId: null,
					remoteParent: null,
					dirty: false,
					localUpdated: p.updated,
					pendingDelete: false,
				};
			});
	}

	/**
	 * Pauses an open task: keeps everything about it (subtasks too) and deletes it, so it leaves Google Tasks
	 * until it is resumed.
	 */
	pause(id: string): void {
		const task = this.get(id);
		if (!task || task.status === "completed") return;
		const kept: PausedTask = { title: task.title, notes: task.notes, listId: task.listId, due: task.due, parent: task.parent };
		const rule = this.data.recurrence[task.id];
		if (rule) kept.rule = rule;
		if (this.data.times[task.id]) kept.time = this.data.times[task.id];
		if (this.data.colors[task.id]) kept.color = this.data.colors[task.id];
		if (this.data.taskModes[task.id]) kept.modes = [...this.data.taskModes[task.id]];
		const kids = this.children(task.id);
		if (kids.length) kept.subtasks = kids.map((c) => ({ title: c.title, notes: c.notes, due: c.due, done: c.status === "completed" }));
		this.data.paused[task.id] = { on: true, updated: Date.now(), task: kept };
		this.prunePaused();
		this.delete(task.id);
	}

	/**
	 * Creates a paused task again, as a new task, and returns it. A repeating one that fell behind starts at its
	 * next date from today.
	 */
	resume(id: string): Task | null {
		const kept = this.pausedTask(id);
		if (!kept) return null;
		let due = kept.due;
		let rule = kept.rule;
		const t0 = today();
		if (rule && due && due < t0) {
			const next = nextOccurrence(rule, due, t0);
			if (next) ({ due, rule } = next);
		}
		const parent = kept.parent && this.get(kept.parent) ? kept.parent : null;
		const task = this.create({ title: kept.title, notes: kept.notes, listId: kept.listId, due, parent }, "local", true);
		if (rule) this.data.recurrence[task.id] = rule;
		if (kept.time) this.data.times[task.id] = kept.time;
		if (kept.color) this.data.colors[task.id] = kept.color;
		if (kept.modes?.length) this.data.taskModes[task.id] = [...kept.modes];
		for (const c of kept.subtasks ?? []) {
			this.create(
				{ title: c.title, notes: c.notes, listId: kept.listId, due: c.due, parent: task.id, status: c.done ? "completed" : "needsAction" },
				"local",
				true,
			);
		}
		this.data.paused[id] = { on: false, updated: Date.now() };
		this.notify("local");
		return task;
	}

	/** Deletes a paused task for good. */
	deletePaused(id: string): void {
		if (!this.isPaused(id)) return;
		this.data.paused[id] = { on: false, updated: Date.now() };
		this.notify("local");
	}

	/** Earlier pauses only hid the task; pause those properly (delete them from Google). */
	migratePauses(): void {
		for (const [id, p] of Object.entries(this.data.paused)) {
			if (!p.on || p.task) continue;
			if (this.get(id)) this.pause(id);
			else this.data.paused[id] = { on: false, updated: Date.now() };
		}
	}

	/** Takes over pauses from another device, per task the newer change wins. */
	mergePaused(incoming: Record<string, PauseState> | undefined): void {
		if (!incoming || typeof incoming !== "object") return;
		for (const [id, p] of Object.entries(incoming)) {
			const mine = this.data.paused[id];
			if (!p || typeof p.updated !== "number" || (mine && mine.updated >= p.updated)) continue;
			this.data.paused[id] = p;
		}
		this.prunePaused();
	}

	private prunePaused(): void {
		const cutoff = Date.now() - KEEP_RESUMED_DAYS * 86400000;
		for (const [id, p] of Object.entries(this.data.paused)) if (!p.on && p.updated < cutoff) delete this.data.paused[id];
	}

	/**
	 * The heading shown on `date` and the day it was written for: the newest one written on or before `date` that
	 * still lasts then. Null when there is none.
	 */
	activeDayTitle(date: string, time?: string): { start: string; title: DayTitle } | null {
		const starts = Object.keys(this.data.dayTitles)
			.filter((d) => d <= date && this.data.dayTitles[d].text && dayTitleLasts(d, this.data.dayTitles[d], date, time))
			.sort();
		if (!starts.length) return null;
		const start = starts[starts.length - 1];
		return { start, title: this.data.dayTitles[start] };
	}

	/** The style of the most recent heading, so a new day starts looking like the last one. */
	lastDayTitle(): DayTitle | null {
		const dates = Object.keys(this.data.dayTitles).filter((d) => this.data.dayTitles[d].text).sort();
		return dates.length ? this.data.dayTitles[dates[dates.length - 1]] : null;
	}

	/** Sets (or, with empty text, clears) a day's heading. Local only: it never reaches Google. */
	setDayTitle(date: string, title: Omit<DayTitle, "updated">): void {
		this.data.dayTitles[date] = { ...title, text: title.text.trim(), updated: Date.now() };
		this.pruneDayTitles();
	}

	/** Takes over headings from another device, per day the newer edit wins. Returns whether anything changed. */
	mergeDayTitles(incoming: Record<string, DayTitle>): boolean {
		let changed = false;
		for (const [date, t] of Object.entries(incoming)) {
			const mine = this.data.dayTitles[date];
			if (!t || typeof t.updated !== "number" || (mine && mine.updated >= t.updated)) continue;
			this.data.dayTitles[date] = t;
			changed = true;
		}
		// Headings this device already dropped as old would otherwise come back with every merge.
		this.pruneDayTitles();
		return changed;
	}

	/** Sticky notes still on the board, oldest edit first (so the newest is drawn on top). */
	stickyNotes(): [string, StickyNote][] {
		return Object.entries(this.data.stickies)
			.filter(([, n]) => !n.deleted)
			.sort((a, b) => a[1].updated - b[1].updated);
	}

	addSticky(fields: Omit<StickyNote, "updated" | "deleted">): string {
		const id = "sticky-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
		this.data.stickies[id] = { ...fields, updated: Date.now() };
		return id;
	}

	updateSticky(id: string, patch: Partial<Omit<StickyNote, "updated" | "deleted">>): void {
		const n = this.data.stickies[id];
		if (!n || n.deleted) return;
		this.data.stickies[id] = { ...n, ...patch, updated: Date.now() };
	}

	/** Keeps a deleted note for a while (without its text), so the deletion reaches the other devices. */
	deleteSticky(id: string): void {
		const n = this.data.stickies[id];
		if (!n) return;
		this.data.stickies[id] = { ...n, text: "", deleted: true, updated: Date.now() };
		this.pruneStickies();
	}

	/** Takes over sticky notes from another device, per note the newer edit wins. Returns whether anything changed. */
	mergeStickies(incoming: Record<string, StickyNote> | undefined): boolean {
		if (!incoming || typeof incoming !== "object") return false;
		let changed = false;
		for (const [id, n] of Object.entries(incoming)) {
			const mine = this.data.stickies[id];
			if (!n || typeof n.updated !== "number" || (mine && mine.updated >= n.updated)) continue;
			this.data.stickies[id] = n;
			changed = true;
		}
		this.pruneStickies();
		return changed;
	}

	private pruneStickies(): void {
		const cutoff = Date.now() - KEEP_DELETED_STICKIES_DAYS * 86400000;
		for (const [id, n] of Object.entries(this.data.stickies)) if (n.deleted && n.updated < cutoff) delete this.data.stickies[id];
	}

	private pruneDayTitles(): void {
		const cutoff = addDays(today(), -KEEP_DAY_TITLES_DAYS);
		for (const [d, t] of Object.entries(this.data.dayTitles)) if (d < cutoff && !dayTitleLasts(d, t, cutoff)) delete this.data.dayTitles[d];
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
		moveKey(this.data.paused);
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

	/**
	 * Deletes open tasks that have exactly the same title on the same day, from today up to `months` ahead, and
	 * returns the titles removed. Two devices can each create the next occurrence of a repeating task before either
	 * sees the other's copy; both copies reach Google. Every device must keep the same copy, so the choice only uses
	 * what Google gave all of them (the smallest Google ID); groups with a copy not yet in Google wait for a later sync.
	 */
	removeDuplicates(months = DUPLICATE_CHECK_MONTHS): string[] {
		const from = today();
		const to = addMonths(from, months);
		const groups = new Map<string, Task[]>();
		for (const t of this.all()) {
			if (t.status !== "needsAction" || !t.due || t.due < from || t.due > to) continue;
			const key = `${t.due}\n${t.title}`;
			const group = groups.get(key);
			if (group) group.push(t);
			else groups.set(key, [t]);
		}
		const removed: string[] = [];
		for (const group of groups.values()) {
			if (group.length < 2 || group.some((t) => isLocalId(t.id))) continue;
			// A task with subtasks isn't a spawned copy; leave such groups to the user.
			if (group.some((t) => this.children(t.id).length)) continue;
			group.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			const [keep, ...extra] = group;
			for (const t of extra) {
				// The copy that is kept takes over the repeat rule, time, color and modes if it has none.
				if (this.data.recurrence[t.id]) this.data.recurrence[keep.id] ??= this.data.recurrence[t.id];
				if (this.data.times[t.id]) this.data.times[keep.id] ??= this.data.times[t.id];
				if (this.data.colors[t.id]) this.data.colors[keep.id] ??= this.data.colors[t.id];
				if (this.data.taskModes[t.id]) this.data.taskModes[keep.id] ??= this.data.taskModes[t.id];
				if (!keep.notes && t.notes) this.update(keep.id, { notes: t.notes }, "remote");
				for (const [k, v] of Object.entries(this.data.spawned)) if (v === t.id) this.data.spawned[k] = keep.id;
				const g = this.data.gift;
				g.drawn = [...new Set(g.drawn.map((x) => (x === t.id ? keep.id : x)))];
				this.delete(t.id, "remote");
				removed.push(t.title);
			}
		}
		return removed;
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
