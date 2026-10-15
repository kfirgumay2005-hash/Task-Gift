import { ApiError, GoogleTask, NetworkError, TasksApi, TaskWrite } from "../api/client";
import { AuthError } from "../auth/oauth";
import { KEEP_FOREVER } from "../defaults";
import type { Task, TaskGiftSettings } from "../types";
import { fromGoogleDue, toGoogleDue } from "../util/dates";
import { isLocalId, newLocalId, TaskStore } from "./store";

export type SyncState = "disconnected" | "idle" | "syncing" | "offline" | "error";

export interface SyncStatus {
	state: SyncState;
	message: string;
	lastSync: string | null;
	pending: number;
}

export interface SyncHooks {
	/** Always called at the end, e.g. to save the data note. */
	afterSync(): Promise<void>;
	onStatus(status: SyncStatus): void;
	onError(message: string): void;
}

const FULL_SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const UPDATED_MIN_MARGIN_MS = 2 * 60 * 1000;

function warn(...args: unknown[]): void {
	console.warn("[Task Gift]", ...args);
}

/** Two-way sync between the local TaskStore and Google Tasks. */
export class SyncEngine {
	private running: Promise<void> | null = null;
	private rerun = false;
	private rerunFull = false;
	private failedTasks = new Set<string>();
	status: SyncStatus = { state: "disconnected", message: "Not connected", lastSync: null, pending: 0 };

	constructor(
		private readonly api: TasksApi,
		private readonly store: TaskStore,
		private readonly settings: () => TaskGiftSettings,
		private readonly isConnected: () => boolean,
		private readonly hooks: SyncHooks,
	) {
		this.status.lastSync = store.data.lastSyncAt;
	}

	pendingCount(): number {
		return Object.values(this.store.data.tasks).filter((t) => t.dirty).length;
	}

	setStatus(state: SyncState, message: string): void {
		this.status = { state, message, lastSync: this.store.data.lastSyncAt, pending: this.pendingCount() };
		this.hooks.onStatus(this.status);
	}

	isRunning(): boolean {
		return this.running !== null;
	}

	/** Runs a sync; concurrent calls are coalesced into one follow-up run. */
	sync(full = false): Promise<void> {
		if (this.running) {
			this.rerun = true;
			this.rerunFull = this.rerunFull || full;
			return this.running;
		}
		this.running = this.run(full).finally(() => {
			this.running = null;
			if (this.rerun) {
				const f = this.rerunFull;
				this.rerun = false;
				this.rerunFull = false;
				void this.sync(f);
			}
		});
		return this.running;
	}

	private async run(full: boolean): Promise<void> {
		try {
			if (!this.isConnected()) {
				this.setStatus("disconnected", "Not connected");
				return;
			}
			this.setStatus("syncing", "Syncing…");
			// Pull first so conflicts are detected before anything local is pushed.
			await this.pull(full);
			await this.push();
			if (this.settings().keepCompletedDays !== KEEP_FOREVER) this.store.prune(this.settings().keepCompletedDays);
			this.setStatus("idle", "Synced");
		} catch (e) {
			if (e instanceof NetworkError) {
				this.setStatus("offline", "Offline — changes will sync when the connection is back");
			} else if (e instanceof AuthError) {
				this.setStatus(e.revoked ? "disconnected" : "error", e.message);
				this.hooks.onError(e.message);
			} else {
				const msg = e instanceof Error ? e.message : String(e);
				console.error("[Task Gift] Sync failed", e);
				this.setStatus("error", msg);
				this.hooks.onError(`Sync failed: ${msg}`);
			}
		} finally {
			this.store.notify("remote");
			try {
				await this.hooks.afterSync();
			} catch (e) {
				console.error("[Task Gift] Post-sync step failed", e);
			}
		}
	}

	// ---------------------------------------------------------------- pull

	private async pull(forceFull: boolean): Promise<void> {
		const data = this.store.data;
		const startedAt = new Date().toISOString();
		const lastFull = data.lastFullSyncAt ? Date.parse(data.lastFullSyncAt) : 0;
		const full = forceFull || !data.lastSyncAt || Date.now() - lastFull > FULL_SYNC_EVERY_MS;

		const remoteLists = await this.api.listTaskLists();
		const remoteIds = new Set(remoteLists.map((l) => l.id));
		const newLists = new Set<string>();
		for (const l of remoteLists) {
			if (!data.lists[l.id]) newLists.add(l.id);
			data.lists[l.id] = { id: l.id, title: l.title, updated: l.updated };
		}
		for (const id of Object.keys(data.lists)) {
			if (remoteIds.has(id)) continue;
			delete data.lists[id];
			for (const t of Object.values(data.tasks)) {
				if (t.listId !== id && t.remoteListId !== id) continue;
				if (t.dirty && !t.pendingDelete) warn(`List ${id} was deleted in Google; dropping locally edited task "${t.title}".`);
				this.store.forget(t.id);
			}
		}

		// No cutoff when completed tasks are kept forever: every completed task in Google is downloaded.
		const keep = this.settings().keepCompletedDays;
		const cutoff = keep === KEEP_FOREVER ? undefined : new Date(Date.now() - keep * 86400000).toISOString();
		for (const list of remoteLists) {
			if (full || newLists.has(list.id)) {
				const open = await this.api.listTasks(list.id, { showCompleted: false, showHidden: false });
				const done = await this.api.listTasks(list.id, { showCompleted: true, showHidden: true, completedMin: cutoff });
				const seen = new Set<string>();
				for (const r of [...open, ...done]) {
					if (seen.has(r.id)) continue;
					seen.add(r.id);
					this.merge(r, list.id);
				}
				// Anything we know in this list that Google no longer returned was deleted remotely.
				for (const t of Object.values(data.tasks)) {
					if (isLocalId(t.id) || seen.has(t.id) || (t.remoteListId ?? t.listId) !== list.id) continue;
					if (cutoff && t.status === "completed" && t.completed && t.completed < cutoff && !t.dirty) continue;
					this.handleRemoteDeletion(t);
				}
			} else {
				const since = new Date(Date.parse(data.lastSyncAt as string) - UPDATED_MIN_MARGIN_MS).toISOString();
				const changed = await this.api.listTasks(list.id, {
					updatedMin: since,
					showCompleted: true,
					showHidden: true,
					showDeleted: true,
				});
				for (const r of changed) this.merge(r, list.id);
			}
		}
		data.lastSyncAt = startedAt;
		if (full) data.lastFullSyncAt = startedAt;
	}

	private handleRemoteDeletion(t: Task): void {
		if (t.dirty && !t.pendingDelete) {
			// Conflict: deleted in Google but edited here. Never drop it: re-create it.
			warn(`Conflict: "${t.title}" was deleted in Google but edited locally. Re-creating it.`);
			const id = newLocalId();
			this.store.remap(t.id, id);
			t.remoteListId = null;
			t.remoteParent = null;
			t.updated = "";
			delete this.store.data.snapshots[id];
		} else {
			this.store.forget(t.id);
		}
	}

	private merge(r: GoogleTask, listId: string): void {
		const data = this.store.data;
		const local = data.tasks[r.id];
		if (r.deleted) {
			if (!local) return;
			if (local.remoteListId && local.remoteListId !== listId) return; // moved, not deleted
			this.handleRemoteDeletion(local);
			return;
		}
		if (!local) {
			data.tasks[r.id] = this.fromRemote(r, listId);
			data.snapshots[r.id] = r.updated;
			return;
		}
		const remoteChanged = data.snapshots[r.id] !== r.updated;
		if (!remoteChanged) {
			local.remoteListId = listId;
			return;
		}
		if (local.dirty) {
			const remoteTime = Date.parse(r.updated);
			if (remoteTime > local.localUpdated) {
				warn(`Conflict on "${local.title}": Google version is newer, it wins.`, { local: { ...local }, remote: r });
				this.overwrite(local, r, listId);
			} else {
				warn(`Conflict on "${local.title}": local version is newer, it wins.`, { local: { ...local }, remote: r });
				data.snapshots[r.id] = r.updated;
				local.remoteListId = listId;
				local.remoteParent = r.parent ?? null;
				local.updated = r.updated;
			}
			return;
		}
		this.overwrite(local, r, listId);
	}

	private fromRemote(r: GoogleTask, listId: string): Task {
		return {
			id: r.id,
			listId,
			title: r.title ?? "",
			notes: r.notes ?? "",
			due: fromGoogleDue(r.due),
			status: r.status ?? "needsAction",
			completed: r.completed ?? null,
			parent: r.parent ?? null,
			position: r.position ?? "",
			updated: r.updated,
			remoteListId: listId,
			remoteParent: r.parent ?? null,
			dirty: false,
			localUpdated: 0,
			pendingDelete: false,
		};
	}

	private overwrite(local: Task, r: GoogleTask, listId: string): void {
		const wasCompleted = local.status === "completed";
		Object.assign(local, this.fromRemote(r, listId));
		this.store.data.snapshots[r.id] = r.updated;
		if (!wasCompleted && local.status === "completed") this.store.maybeSpawnNext(local);
	}

	// ---------------------------------------------------------------- push

	private body(t: Task, forInsert: boolean): TaskWrite {
		const b: TaskWrite = {
			title: t.title,
			notes: t.notes || (forInsert ? undefined : null),
			due: toGoogleDue(t.due) ?? (forInsert ? undefined : null),
			status: t.status,
		};
		if (t.status === "completed") b.completed = t.completed ?? new Date().toISOString();
		else if (!forInsert) b.completed = null;
		return b;
	}

	private applyResponse(t: Task, r: GoogleTask, listId: string, editStamp: number): void {
		t.updated = r.updated;
		t.position = r.position ?? t.position;
		t.remoteListId = listId;
		t.remoteParent = r.parent ?? null;
		this.store.data.snapshots[t.id] = r.updated;
		// Only clear dirty if no newer local edit happened during the request.
		if (t.localUpdated === editStamp) t.dirty = false;
		this.failedTasks.delete(t.id);
	}

	private reportTaskFailure(t: Task, e: unknown): void {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(`[Task Gift] Could not sync "${t.title}"`, e);
		if (!this.failedTasks.has(t.id)) {
			this.failedTasks.add(t.id);
			this.hooks.onError(`Could not sync "${t.title}": ${msg}`);
		}
	}

	private async push(): Promise<void> {
		const data = this.store.data;
		const dirty = Object.values(data.tasks).filter((t) => t.dirty);
		if (!dirty.length) return;
		// 1. Deletions
		for (const t of dirty.filter((x) => x.pendingDelete)) {
			try {
				if (!isLocalId(t.id) && data.lists[t.remoteListId ?? t.listId]) {
					await this.api.deleteTask(t.remoteListId ?? t.listId, t.id);
				}
				this.store.forget(t.id);
			} catch (e) {
				if (e instanceof ApiError && (e.status === 404 || e.status === 410)) this.store.forget(t.id);
				else if (e instanceof NetworkError || e instanceof AuthError) throw e;
				else this.reportTaskFailure(t, e);
			}
		}

		// 2. Updates to existing tasks
		for (const t of dirty.filter((x) => !x.pendingDelete && !isLocalId(x.id) && data.tasks[x.id])) {
			try {
				await this.pushUpdate(t);
			} catch (e) {
				if (e instanceof NetworkError || e instanceof AuthError) throw e;
				if (e instanceof ApiError && e.status === 404) {
					warn(`"${t.title}" no longer exists in Google; re-creating it.`);
					this.handleRemoteDeletion(t);
				} else this.reportTaskFailure(t, e);
			}
		}

		// 3. Inserts, parents before children
		for (let pass = 0; pass < 5; pass++) {
			const inserts = Object.values(data.tasks).filter((x) => x.dirty && !x.pendingDelete && isLocalId(x.id));
			if (!inserts.length) break;
			for (const t of inserts) {
				if (t.parent && isLocalId(t.parent) && data.tasks[t.parent]) continue;
				if (!data.lists[t.listId]) {
					const fallback = this.store.defaultListId();
					if (!fallback) continue;
					t.listId = fallback;
				}
				try {
					const stamp = t.localUpdated;
					const oldId = t.id;
					const r = await this.api.insertTask(t.listId, this.body(t, true), t.parent ?? undefined);
					this.store.remap(oldId, r.id);
					this.applyResponse(t, r, t.listId, stamp);
				} catch (e) {
					if (e instanceof NetworkError || e instanceof AuthError) throw e;
					this.reportTaskFailure(t, e);
				}
			}
		}
	}

	private async pushUpdate(t: Task): Promise<void> {
		const stamp = t.localUpdated;
		const srcList = t.remoteListId ?? t.listId;
		if (t.listId !== srcList) {
			try {
				await this.api.moveTask(srcList, t.id, {
					destinationTasklist: t.listId,
					parent: t.parent && !isLocalId(t.parent) ? t.parent : undefined,
				});
				t.remoteListId = t.listId;
			} catch (e) {
				if (!(e instanceof ApiError) || e.status === 404) throw e;
				// Fallback for tasks that cannot be moved: copy to the new list, then delete the original.
				warn(`Moving "${t.title}" between lists failed (${e.message}); copying instead.`);
				const r = await this.api.insertTask(t.listId, this.body(t, true), t.parent && !isLocalId(t.parent) ? t.parent : undefined);
				await this.api.deleteTask(srcList, t.id).catch((err) => warn("Could not delete original after copy", err));
				this.store.remap(t.id, r.id);
				this.applyResponse(t, r, t.listId, stamp);
				return;
			}
		} else if ((t.parent ?? null) !== (t.remoteParent ?? null) && !(t.parent && isLocalId(t.parent))) {
			await this.api.moveTask(t.listId, t.id, { parent: t.parent ?? undefined });
		}
		const r = await this.api.patchTask(t.listId, t.id, this.body(t, false));
		this.applyResponse(t, r, t.listId, stamp);
	}
}
