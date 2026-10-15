import { App, normalizePath, TFile } from "obsidian";
import type { PluginData } from "../types";

export const DEFAULT_DATA_PATH = "Task Gift Data.md";
const MARKER = "task-gift-data";
const JSON_BLOCK_RE = /```json\r?\n([\s\S]*?)\r?\n```/;

export function normalizeDataPath(input: string): string {
	let p = normalizePath(input.trim() || DEFAULT_DATA_PATH);
	if (!p.toLowerCase().endsWith(".md")) p += ".md";
	return p;
}

export function serialize(data: PluginData): string {
	// Escape backticks so task notes can never close the code fence.
	const json = JSON.stringify(data, null, 1).replace(/`/g, "\\u0060");
	return [
		"---",
		`${MARKER}: 1`,
		"---",
		"",
		"# Task Gift data",
		"",
		"> [!warning] Managed by Task Gift",
		"> This note stores Task Gift's settings, sync state, repeat rules and Google sign-in. It syncs with your vault, so every device shares the same setup.",
		"> Don't edit it by hand, and don't share or publish it: it contains your Google client secret and access tokens.",
		"",
		"```json",
		json,
		"```",
		"",
	].join("\n");
}

export function parse(content: string): Partial<PluginData> | null {
	if (!content.includes(MARKER)) return null;
	const m = JSON_BLOCK_RE.exec(content);
	if (!m) return null;
	try {
		return JSON.parse(m[1]) as Partial<PluginData>;
	} catch (e) {
		console.error("[Task Gift] Data file is not valid JSON", e);
		return null;
	}
}

/**
 * Reads and writes Task Gift's data as a markdown note inside the vault
 * (instead of .obsidian/plugins/…/data.json), so it syncs to every device.
 * Uses the vault adapter so it works before the vault index is ready.
 */
export class DataFile {
	private lastWritten: string | null = null;
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly app: App, public path: string) {}

	isDataFile(file: TFile): boolean {
		return file.path === this.path;
	}

	isOwnWrite(content: string): boolean {
		return content === this.lastWritten;
	}

	async exists(path = this.path): Promise<boolean> {
		return this.app.vault.adapter.exists(path);
	}

	async readRaw(path = this.path): Promise<string | null> {
		if (!(await this.exists(path))) return null;
		return this.app.vault.adapter.read(path);
	}

	async read(path = this.path): Promise<Partial<PluginData> | null> {
		const raw = await this.readRaw(path);
		return raw === null ? null : parse(raw);
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split("/").slice(0, -1);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(cur))) await this.app.vault.adapter.mkdir(cur);
		}
	}

	write(data: PluginData): Promise<void> {
		const content = serialize(data);
		const run = this.queue.then(async () => {
			if (content === this.lastWritten) return;
			this.lastWritten = content;
			await this.ensureFolder(this.path);
			const file = this.app.vault.getAbstractFileByPath(this.path);
			if (file instanceof TFile) await this.app.vault.modify(file, content);
			else await this.app.vault.adapter.write(this.path, content);
		});
		this.queue = run.catch((e) => console.error("[Task Gift] Could not write data file", e));
		return run;
	}

	/** Moves the data file to a new path (keeps the current one if the move fails). */
	async moveTo(newPath: string): Promise<void> {
		const old = this.app.vault.getAbstractFileByPath(this.path);
		await this.ensureFolder(newPath);
		if (old instanceof TFile) await this.app.fileManager.renameFile(old, newPath);
		this.path = newPath;
	}

	/** Looks for a Task Gift data note anywhere in the vault (e.g. moved on another device). */
	findInVault(): string | null {
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (fm && fm[MARKER] !== undefined) return f.path;
		}
		return null;
	}
}
