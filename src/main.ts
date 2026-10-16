import { debounce, Notice, Platform, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { TasksApi } from "./api/client";
import { GiftMusic } from "./audio/music";
import { SOUND_LABELS } from "./audio/sounds";
import { AuthError, refresh, revoke } from "./auth/oauth";
import { DEFAULT_SETTINGS, emptyGiftState, emptyStore, KEEP_COMPLETED_OPTIONS, KEEP_FOREVER, VIEW_TYPE } from "./defaults";
import { ConfirmModal } from "./modals/ConfirmModal";
import { ConnectModal } from "./modals/ConnectModal";
import { LoginModal } from "./modals/LoginModal";
import { TaskModal, TaskModalOptions } from "./modals/TaskModal";
import { TaskGiftSettingTab } from "./settings";
import { SyncEngine, SyncStatus } from "./sync/engine";
import { ChangeSource, TaskStore } from "./sync/store";
import { normalizeModes } from "./modes";
import { DataFile, DEFAULT_DATA_PATH, normalizeDataPath, parse as parseDataFile } from "./storage/dataFile";
import type { AuthData, PluginData, StoreData, Task, TaskGiftSettings } from "./types";

/** The only thing kept in the device-local data.json. */
interface LocalPointer {
	dataFilePath: string;
}
import { TaskView } from "./views/TaskView";

const LOCAL_SYNC_DEBOUNCE_MS = 1500;
const OFFLINE_RETRY_MS = 60 * 1000;

export default class TaskGiftPlugin extends Plugin {
	settings!: TaskGiftSettings;
	auth: AuthData | null = null;
	store!: TaskStore;
	api!: TasksApi;
	engine!: SyncEngine;
	private dataFile!: DataFile;
	private music!: GiftMusic;

	private intervalId: number | null = null;
	private retryTimer: number | null = null;
	private refreshPromise: Promise<string> | null = null;
	private lastErrorNotice = "";
	private statusListeners = new Set<(s: SyncStatus) => void>();

	private saveSoon = debounce(() => void this.persist(), 1000, true);
	private refreshViewsSoon = debounce(() => this.refreshViews(), 100, true);
	private syncSoon = debounce(() => void this.engine.sync(), LOCAL_SYNC_DEBOUNCE_MS, true);

	async onload(): Promise<void> {
		await this.loadPluginData();

		this.store = new TaskStore(this.loadedStore, (source) => this.onStoreChange(source));
		this.api = new TasksApi(() => this.accessToken());
		this.engine = new SyncEngine(this.api, this.store, () => this.settings, () => this.auth !== null, {
			afterSync: () => this.persist(),
			onStatus: (s) => this.onSyncStatus(s),
			onError: (msg) => this.showError(msg),
		});

		this.music = new GiftMusic(this.app);
		// Gift music plays only while a gift view is on screen.
		const updateMusic = () => this.updateMusic();
		this.registerEvent(this.app.workspace.on("active-leaf-change", updateMusic));
		this.registerEvent(this.app.workspace.on("layout-change", updateMusic));

		this.registerView(VIEW_TYPE, (leaf) => new TaskView(leaf, this));

		this.addRibbonIcon("gift", "Open Task Gift", () => void this.activateView());
		this.addRibbonIcon("clipboard-plus", "New Google task", () => this.openTaskModal());

		this.addCommand({ id: "open-view", name: "Open board", callback: () => void this.activateView() });
		this.addCommand({ id: "new-task", name: "New task", callback: () => this.openTaskModal() });
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
		this.addCommand({ id: "full-resync", name: "Full resync with Google", callback: () => void this.syncNow(true) });
		this.addCommand({ id: "sync-all-completed", name: "Download all completed tasks from Google", callback: () => void this.syncAllCompleted() });
		this.addCommand({
			id: "toggle-gift-mode",
			name: "Toggle gift mode (hide task board)",
			callback: () => void this.setGiftMode(!this.settings.giftMode),
		});

		this.addSettingTab(new TaskGiftSettingTab(this.app, this));

		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile && this.dataFile.isDataFile(file)) void this.onDataFileChanged();
			}),
		);
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (file instanceof TFile && this.dataFile.isDataFile(file)) void this.onDataFileChanged();
			}),
		);

		this.app.workspace.onLayoutReady(async () => {
			await this.initDataFile();
			this.engine.setStatus(this.auth ? "idle" : "disconnected", this.auth ? "Ready" : "Not connected");
			if (this.auth) void this.engine.sync();
			this.restartInterval();
		});
	}

	onunload(): void {
		if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
		this.music.stop();
		void this.persist();
	}

	// ------------------------------------------------------------ data

	private loadedStore = emptyStore();
	/** True when no data note existed at startup (it is created once the vault is ready). */
	private dataFileMissing = false;
	/** Writes are held back until the vault is ready and the data note location is settled. */
	private dataReady = false;

	private static mergeSettings(raw: Partial<TaskGiftSettings> | undefined): TaskGiftSettings {
		const s = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
		if (!(s.giftSound in SOUND_LABELS)) s.giftSound = DEFAULT_SETTINGS.giftSound;
		// Also turns the filter settings of older versions into the first mode.
		normalizeModes(s);
		if (!Number.isFinite(s.boardZoom)) s.boardZoom = DEFAULT_SETTINGS.boardZoom;
		// Removed settings: the markdown sync note and the board-wide sort.
		for (const key of ["notePath", "mirrorToNote", "boardSort"]) delete (s as unknown as Record<string, unknown>)[key];
		s.columnSort = Object.assign({}, raw?.columnSort ?? {});
		if (!KEEP_COMPLETED_OPTIONS.includes(s.keepCompletedDays)) {
			// Snap older free-form values to the nearest allowed option at or above them.
			s.keepCompletedDays = KEEP_COMPLETED_OPTIONS.find((n) => n >= s.keepCompletedDays) ?? 30;
		}
		return s;
	}

	private static mergeStore(raw: Partial<StoreData> | undefined): StoreData {
		const store = Object.assign(emptyStore(), raw ?? {});
		store.gift = Object.assign(emptyGiftState(), store.gift ?? {});
		delete (store as unknown as Record<string, unknown>).renderedIds; // left over from the removed sync note
		return store;
	}

	/**
	 * Data lives in a markdown note in the vault. The plugin's own data.json only remembers
	 * where that note is (it is device-local and does not sync).
	 */
	private async loadPluginData(): Promise<void> {
		const local = ((await this.loadData()) ?? {}) as Partial<PluginData> & Partial<LocalPointer>;
		this.dataFile = new DataFile(this.app, normalizeDataPath(local.dataFilePath ?? DEFAULT_DATA_PATH));

		let data = await this.dataFile.read();
		if (!data && (local.settings || local.store)) {
			// Migrate from the old data.json format.
			data = { settings: local.settings, auth: local.auth, store: local.store };
		}
		this.dataFileMissing = !(await this.dataFile.exists());
		this.settings = TaskGiftPlugin.mergeSettings(data?.settings);
		this.auth = data?.auth ?? null;
		this.loadedStore = TaskGiftPlugin.mergeStore(data?.store);
	}

	/** Called on layout ready: adopt a data note found elsewhere, or create the default one. */
	private async initDataFile(): Promise<void> {
		if (this.dataFileMissing) {
			const found = this.dataFile.findInVault();
			if (found) {
				this.dataFile.path = found;
				const data = await this.dataFile.read();
				if (data) this.applyExternal(data, true);
			}
			await this.savePointer();
		}
		this.dataReady = true;
		await this.persist();
	}

	private async savePointer(): Promise<void> {
		const pointer: LocalPointer = { dataFilePath: this.dataFile.path };
		await this.saveData(pointer);
	}

	async persist(): Promise<void> {
		if (!this.store || !this.dataReady) return;
		const data: PluginData = { settings: this.settings, auth: this.auth, store: this.store.data };
		await this.dataFile.write(data);
	}

	dataFilePath(): string {
		return this.dataFile.path;
	}

	/** Moves the data note (settings "Apply" button). Loads an existing data note at the target instead, after confirmation. */
	async changeDataFilePath(input: string): Promise<boolean> {
		const target = normalizeDataPath(input);
		if (target === this.dataFile.path) return true;
		if (await this.dataFile.exists(target)) {
			const existing = await this.dataFile.read(target);
			if (!existing) {
				new Notice(`"${target}" already exists and isn't a Task Gift data file. Pick another path.`);
				return false;
			}
			const ok = await new Promise<boolean>((resolve) =>
				new ConfirmModal(
					this.app,
					"Use existing data file?",
					`A Task Gift data file already exists at "${target}". Switch to it? Its settings and sign-in replace the current ones.`,
					"Switch",
					() => resolve(true),
					() => resolve(false),
				).open(),
			);
			if (!ok) return false;
			this.dataFile.path = target;
			this.applyExternal(existing, true);
		} else {
			try {
				await this.dataFile.moveTo(target);
			} catch (e) {
				new Notice(`Could not move the data file: ${e instanceof Error ? e.message : String(e)}`);
				return false;
			}
		}
		await this.savePointer();
		await this.persist();
		new Notice(`Task Gift data file: ${target}`);
		return true;
	}

	/**
	 * Applies data written by another device (or a data note we switched to).
	 * Settings, sign-in and gift state are taken over; repeat rules and times are merged;
	 * tasks are reconciled through the next Google sync.
	 */
	private applyExternal(incoming: Partial<PluginData>, replace: boolean): void {
		if (incoming.settings) {
			const prevInterval = this.settings.syncIntervalMinutes;
			this.settings = TaskGiftPlugin.mergeSettings(incoming.settings);
			if (prevInterval !== this.settings.syncIntervalMinutes && this.intervalId !== null) this.restartInterval();
		}
		const a = incoming.auth;
		if (a && (replace || !this.auth || a.refreshToken !== this.auth.refreshToken || a.expiresAt > this.auth.expiresAt)) this.auth = a;
		if (replace && a === null) this.auth = null;
		if (incoming.store && this.store) {
			const inc = TaskGiftPlugin.mergeStore(incoming.store);
			const d = this.store.data;
			if (replace || Object.keys(d.tasks).length === 0) {
				Object.assign(d, inc);
			} else {
				d.recurrence = { ...d.recurrence, ...inc.recurrence };
				d.times = { ...d.times, ...inc.times };
				d.spawned = { ...d.spawned, ...inc.spawned };
				d.aliases = { ...d.aliases, ...inc.aliases };
				d.gift = inc.gift;
				for (const l of Object.values(inc.lists)) if (!d.lists[l.id]) d.lists[l.id] = l;
			}
		}
		this.refreshViews();
		// Only sync after an explicit switch; syncing on every remote write would ping-pong between devices.
		if (replace && this.auth && this.engine) this.syncSoon();
	}

	private async onDataFileChanged(): Promise<void> {
		const raw = await this.dataFile.readRaw();
		if (raw === null || this.dataFile.isOwnWrite(raw)) return;
		const data = parseDataFile(raw);
		if (!data) return;
		this.applyExternal(data, false);
	}

	async saveSettings(): Promise<void> {
		await this.persist();
		this.refreshViews();
	}

	/** Persist + refresh soon, used by views for UI state (e.g. gift state). */
	touch(): void {
		this.saveSoon();
		this.refreshViewsSoon();
	}

	private onStoreChange(source: ChangeSource): void {
		this.saveSoon();
		this.refreshViewsSoon();
		if (source === "local") this.syncSoon();
	}

	// ------------------------------------------------------------ auth

	isConnected(): boolean {
		return this.auth !== null;
	}

	private async accessToken(): Promise<string> {
		const auth = this.auth;
		if (!auth) throw new AuthError("Not connected to Google.", true);
		if (Date.now() < auth.expiresAt - 60000) return auth.accessToken;
		if (!this.refreshPromise) {
			this.refreshPromise = refresh(auth, this.settings.clientId, this.settings.clientSecret)
				.then(async (next) => {
					this.auth = next;
					await this.persist();
					return next.accessToken;
				})
				.catch(async (e: unknown) => {
					if (e instanceof AuthError && e.revoked) {
						this.auth = null;
						await this.persist();
						throw new AuthError("Google access was revoked or expired. Please reconnect in Task Gift settings.", true);
					}
					throw e;
				})
				.finally(() => (this.refreshPromise = null));
		}
		return this.refreshPromise;
	}

	/** Automatic sign-in on desktop; opens the copy-paste flow on mobile. */
	async connect(): Promise<void> {
		if (!Platform.isDesktopApp) {
			this.connectManually();
			return;
		}
		const clientId = this.settings.clientId.trim();
		const clientSecret = this.settings.clientSecret.trim();
		if (!clientId || !clientSecret) {
			new Notice("Enter your Client ID and Client Secret first.");
			return;
		}
		await new Promise<void>((resolve) => {
			const modal = new ConnectModal(
				this.app,
				clientId,
				clientSecret,
				async (auth) => {
					await this.onConnected(auth);
					resolve();
				},
				() => {
					this.connectManually();
					resolve();
				},
			);
			const close = modal.onClose.bind(modal);
			modal.onClose = () => {
				close();
				resolve();
			};
			modal.open();
		});
	}

	/** Copy-paste sign-in that works on every platform. */
	connectManually(onDone?: () => void): void {
		new LoginModal(this.app, this.settings.clientId.trim(), this.settings.clientSecret.trim(), async (auth) => {
			await this.onConnected(auth);
			onDone?.();
		}).open();
	}

	private async onConnected(auth: AuthData): Promise<void> {
		this.auth = auth;
		await this.persist();
		new Notice(`Connected to Google${auth.email ? ` as ${auth.email}` : ""}.`);
		this.engine.setStatus("idle", "Connected");
		this.refreshViews();
		// Don't block the sign-in UI on the first (full) sync.
		void this.engine.sync(true);
	}

	async disconnect(): Promise<void> {
		if (this.auth) await revoke(this.auth);
		this.auth = null;
		await this.persist();
		this.engine.setStatus("disconnected", "Not connected");
		new Notice("Disconnected from Google. Local task data was kept.");
		this.refreshViews();
	}

	/** Clears all synced task data (used when switching accounts). */
	async clearLocalData(): Promise<void> {
		const gift = emptyGiftState();
		Object.assign(this.store.data, emptyStore(), { gift });
		await this.persist();
		this.refreshViews();
	}

	// ------------------------------------------------------------ sync

	async syncNow(full = false): Promise<void> {
		if (!this.auth) {
			new Notice("Connect your Google account in Task Gift settings first.");
			return;
		}
		this.lastErrorNotice = "";
		await this.engine.sync(full);
		if (this.engine.status.state === "idle") new Notice("Google Tasks synced.");
	}

	/** Keeps completed tasks forever and downloads every completed task from Google. */
	async syncAllCompleted(): Promise<void> {
		if (!this.auth) {
			new Notice("Connect your Google account in Task Gift settings first.");
			return;
		}
		this.settings.keepCompletedDays = KEEP_FOREVER;
		await this.saveSettings();
		new Notice("Downloading all completed tasks from Google…");
		this.lastErrorNotice = "";
		await this.engine.sync(true);
		if (this.engine.status.state === "idle") {
			const count = this.store.all().filter((t) => t.status === "completed").length;
			new Notice(`Done: ${count} completed task(s) are now kept locally.`);
		}
	}

	restartInterval(): void {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		const minutes = Math.max(1, this.settings.syncIntervalMinutes || 5);
		this.intervalId = this.registerInterval(
			window.setInterval(() => {
				if (this.auth) void this.engine.sync();
			}, minutes * 60 * 1000),
		);
	}

	private onSyncStatus(s: SyncStatus): void {
		if (s.state === "idle") this.lastErrorNotice = "";
		if (s.state === "offline") {
			if (this.retryTimer === null) {
				this.retryTimer = window.setTimeout(() => {
					this.retryTimer = null;
					if (this.auth) void this.engine.sync();
				}, OFFLINE_RETRY_MS);
			}
		}
		for (const l of this.statusListeners) l(s);
	}

	onStatus(listener: (s: SyncStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	private showError(msg: string): void {
		if (msg === this.lastErrorNotice) return;
		this.lastErrorNotice = msg;
		new Notice(`Task Gift: ${msg}`, 8000);
	}

	// ------------------------------------------------------------ UI

	openTaskModal(task?: Task, defaults?: TaskModalOptions["defaults"]): void {
		new TaskModal(this.app, this.store, { task, defaults }).open();
	}

	async setGiftMode(on: boolean): Promise<void> {
		this.settings.giftMode = on;
		await this.saveSettings();
	}

	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof TaskView) view.refresh();
		}
		this.updateMusic();
	}

	updateMusic(): void {
		const onScreen =
			this.settings.giftMode &&
			this.app.workspace.getLeavesOfType(VIEW_TYPE).some((leaf) => leaf.view instanceof TaskView && leaf.view.containerEl.isShown());
		this.music.update(this.settings, onScreen);
	}

	/** Switches the active mode (header menu). */
	async setActiveMode(id: string): Promise<void> {
		if (id === this.settings.activeModeId || !this.settings.modes.some((m) => m.id === id)) return;
		this.settings.activeModeId = id;
		await this.saveSettings();
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}
}
