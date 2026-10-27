import { App, normalizePath, TFile } from "obsidian";
import type { DayTitle, PluginData, StickyNote, TaskGiftSettings } from "../types";

export const DEFAULT_DATA_PATH = "Task Gift Data.md";
/** The settings note sits next to the data note. */
export const SETTINGS_FILE_NAME = "Task Gift Settings.md";
/** The day topics sit next to the data note too. */
export const TOPICS_FILE_NAME = "Task Gift Topics.md";
/** How many of our own recent writes are recognized when their "modify" event arrives late. */
const OWN_WRITES_KEPT = 10;
const JSON_BLOCK_RE = /```json\r?\n([\s\S]*?)\r?\n```/;

/** What a note holds: its frontmatter marker and the text shown above the JSON. */
interface NoteKind {
	marker: string;
	title: string;
	description: string;
}

/**
 * Sync state, repeat rules and sign-in. Rewritten on every sync, so it is kept apart from the settings:
 * two devices writing one big note all the time make sync tools (e.g. Self-hosted LiveSync) hold back or
 * conflict, and changed settings would not reach the other device.
 */
export const DATA_NOTE: NoteKind = {
	marker: "task-gift-data",
	title: "Task Gift data",
	description:
		"This note stores Task Gift's sync state, repeat rules and Google sign-in. It syncs with your vault, so every device shares the same tasks. Don't edit it by hand, and don't share or publish it: it contains your Google access tokens.",
};

/** Settings only: changes just when a setting changes, so other devices pick it up right away. */
export const SETTINGS_NOTE: NoteKind = {
	marker: "task-gift-settings",
	title: "Task Gift settings",
	description:
		"This note stores Task Gift's settings. It syncs with your vault, so every device shares the same setup, and changes apply on the other devices as soon as the note arrives. Don't edit it by hand, and don't share or publish it: it contains your Google client secret.",
};

/**
 * The day topics only. They used to live in the data note, but that note is rewritten by every device on every
 * sync, so a topic written on one device was often replaced by the other device's copy before it arrived.
 */
export const TOPICS_NOTE: NoteKind = {
	marker: "task-gift-topics",
	title: "Task Gift topics",
	description: "This note stores Task Gift's day topics and the board's sticky notes, so every device shows the same ones. Don't edit it by hand.",
};

/** The note's contents apart from the settings (those have their own note). */
export type StoredData = Partial<PluginData>;

export function normalizeDataPath(input: string): string {
	let p = normalizePath(input.trim() || DEFAULT_DATA_PATH);
	if (!p.toLowerCase().endsWith(".md")) p += ".md";
	return p;
}

/** Path of the settings note that belongs to a data note. */
export function settingsPathFor(dataPath: string): string {
	const slash = dataPath.lastIndexOf("/");
	return slash === -1 ? SETTINGS_FILE_NAME : `${dataPath.slice(0, slash)}/${SETTINGS_FILE_NAME}`;
}

/** Path of the topics note that belongs to a data note. */
export function topicsPathFor(dataPath: string): string {
	const slash = dataPath.lastIndexOf("/");
	return slash === -1 ? TOPICS_FILE_NAME : `${dataPath.slice(0, slash)}/${TOPICS_FILE_NAME}`;
}

export function serialize(kind: NoteKind, data: unknown): string {
	// Escape backticks so task notes can never close the code fence.
	const json = JSON.stringify(data, null, 1).replace(/`/g, "\\u0060");
	return [
		"---",
		`${kind.marker}: 1`,
		"---",
		"",
		`# ${kind.title}`,
		"",
		"> [!warning] Managed by Task Gift",
		`> ${kind.description}`,
		"",
		"```json",
		json,
		"```",
		"",
	].join("\n");
}

export function parse<T>(kind: NoteKind, content: string): T | null {
	if (!content.includes(kind.marker)) return null;
	const m = JSON_BLOCK_RE.exec(content);
	if (!m) return null;
	try {
		return JSON.parse(m[1]) as T;
	} catch (e) {
		console.error(`[Task Gift] ${kind.title} note is not valid JSON`, e);
		return null;
	}
}

/**
 * Reads and writes Task Gift's data as a markdown note inside the vault
 * (instead of .obsidian/plugins/…/data.json), so it syncs to every device.
 * Uses the vault adapter so it works before the vault index is ready.
 */
export class DataFile<T> {
	private lastWritten: string | null = null;
	/**
	 * Recent contents written by this device. A "modify" event can arrive after a newer write has started;
	 * comparing with the last write only would take our own older content for a change from another device
	 * and roll the settings back.
	 */
	private ownWrites: string[] = [];
	/** mtime and size last seen on disk, to skip reading the note when nothing changed. */
	private seenStamp = "";
	/** Contents last written or handed out by readChanged, so the same contents are never applied twice. */
	private seenContent: string | null = null;
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly app: App, private readonly kind: NoteKind, public path: string) {}

	isDataFile(file: TFile): boolean {
		return file.path === this.path;
	}

	isOwnWrite(content: string): boolean {
		return this.ownWrites.includes(content);
	}

	/** Takes data that arrived from another device as already written, so it isn't written back unchanged. */
	adopt(data: T): void {
		this.lastWritten = serialize(this.kind, data);
	}

	async exists(path = this.path): Promise<boolean> {
		return this.app.vault.adapter.exists(path);
	}

	async readRaw(path = this.path): Promise<string | null> {
		if (!(await this.exists(path))) return null;
		return this.app.vault.adapter.read(path);
	}

	/**
	 * The note's contents when they changed since last seen, otherwise null. Without `force`, the note is only
	 * read when its mtime or size changed. Works however the note was written (a sync tool may write straight
	 * to disk, without the vault's "modify" event).
	 */
	async readChanged(force: boolean): Promise<string | null> {
		const stat = await this.app.vault.adapter.stat(this.path);
		if (!stat) return null;
		const stamp = `${stat.mtime}:${stat.size}`;
		if (!force && stamp === this.seenStamp) return null;
		this.seenStamp = stamp;
		const raw = await this.app.vault.adapter.read(this.path);
		if (raw === this.seenContent) return null;
		this.seenContent = raw;
		return raw;
	}

	parse(content: string): T | null {
		return parse<T>(this.kind, content);
	}

	async read(path = this.path): Promise<T | null> {
		const raw = await this.readRaw(path);
		// Loaded now, so the next check doesn't take it for a change from another device.
		if (raw !== null && path === this.path) this.seenContent = raw;
		return raw === null ? null : this.parse(raw);
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split("/").slice(0, -1);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(cur))) await this.app.vault.adapter.mkdir(cur);
		}
	}

	write(data: T): Promise<void> {
		const content = serialize(this.kind, data);
		const run = this.queue.then(async () => {
			if (content === this.lastWritten) return;
			this.lastWritten = content;
			this.seenContent = content;
			this.ownWrites.push(content);
			if (this.ownWrites.length > OWN_WRITES_KEPT) this.ownWrites.shift();
			await this.ensureFolder(this.path);
			const file = this.app.vault.getAbstractFileByPath(this.path);
			if (file instanceof TFile) await this.app.vault.modify(file, content);
			else await this.app.vault.adapter.write(this.path, content);
		});
		this.queue = run.catch((e) => console.error(`[Task Gift] Could not write the ${this.kind.title} note`, e));
		return run;
	}

	/** Moves the note to a new path (keeps the current one if the move fails). */
	async moveTo(newPath: string): Promise<void> {
		const old = this.app.vault.getAbstractFileByPath(this.path);
		await this.ensureFolder(newPath);
		if (old instanceof TFile) await this.app.fileManager.renameFile(old, newPath);
		this.path = newPath;
	}

	/** Looks for a note of this kind anywhere in the vault (e.g. moved on another device). */
	findInVault(): string | null {
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (fm && fm[this.kind.marker] !== undefined) return f.path;
		}
		return null;
	}
}

/** Settings note contents. */
export type StoredSettings = Partial<TaskGiftSettings>;

/** Topics note contents. */
export interface StoredTopics {
	dayTitles: Record<string, DayTitle>;
	/** The board's sticky notes: edited by hand now and then like the topics, so they share this note. */
	stickies?: Record<string, StickyNote>;
}

/** The topics in date order (sticky notes by ID), so the same contents always give the same note text. */
export function topicsData(dayTitles: Record<string, DayTitle>, stickies: Record<string, StickyNote>): StoredTopics {
	const sorted: Record<string, DayTitle> = {};
	for (const d of Object.keys(dayTitles).sort()) sorted[d] = dayTitles[d];
	const notes: Record<string, StickyNote> = {};
	for (const id of Object.keys(stickies).sort()) notes[id] = stickies[id];
	return { dayTitles: sorted, stickies: notes };
}
