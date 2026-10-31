import { debounce, Notice, Platform, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { TasksApi } from "./api/client";
import { GiftMusic } from "./audio/music";
import { AuthError, refresh, revoke } from "./auth/oauth";
import { DEFAULT_SETTINGS, DEFAULT_STICKY_COMMANDS, emptyGiftState, emptyStore, KEEP_COMPLETED_OPTIONS, KEEP_FOREVER, MIN_SYNC_SECONDS, VIEW_TYPE } from "./defaults";
import { ConfirmModal } from "./modals/ConfirmModal";
import { ConnectModal } from "./modals/ConnectModal";
import { useWeekStart } from "./modals/dateFields";
import { LoginModal } from "./modals/LoginModal";
import { TaskModal, TaskModalOptions } from "./modals/TaskModal";
import { TaskGiftSettingTab } from "./settings";
import { calendarsFolderFor, CalendarStore } from "./calendars/store";
import { templatesFolderFor, TemplateStore } from "./calendars/templates";
import { CalendarImportModal } from "./modals/CalendarModals";
import { SyncEngine, SyncStatus } from "./sync/engine";
import { ChangeSource, DUPLICATE_CHECK_MONTHS, TaskStore } from "./sync/store";
import { activeMode, normalizeModes } from "./modes";
import { normalizeDayColumns, pruneDayColumns } from "./dayColumns";
import { appendToNote, hasHeading, isDailyNotesEnabled, tasksMarkdown, todayNote, todayNotePath } from "./dailyNote";
import { nowTime, today } from "./util/dates";
import {
	DATA_NOTE,
	DataFile,
	DEFAULT_DATA_PATH,
	normalizeDataPath,
	SETTINGS_NOTE,
	settingsPathFor,
	StoredData,
	StoredSettings,
	StoredTopics,
	topicsData,
	TOPICS_NOTE,
	topicsPathFor,
} from "./storage/dataFile";
import type { AuthData, BoardView, PluginData, StoreData, Task, TaskGiftSettings } from "./types";

/** The only thing kept in the device-local data.json. */
interface LocalPointer {
	dataFilePath: string;
}
import { TaskView } from "./views/TaskView";

const LOCAL_SYNC_DEBOUNCE_MS = 1500;
const OFFLINE_RETRY_MS = 60 * 1000;
/** Lets a template / Templater finish writing a new daily note before tasks are added below it. */
const DAILY_NOTE_CREATE_DELAY_MS = 2000;
/**
 * How often the data and settings notes (and the plugin's own files) are checked for changes made by a sync
 * tool. Only their mtime and size are read, unless they changed.
 */
const FILE_CHECK_MS = 2000;
/** How long a sync that changed nothing else may leave the data note's lastSyncAt behind. */
const SYNC_STAMP_WRITE_MS = 10 * 60 * 1000;
/** The plugin's files whose change (an update arriving through sync) reloads the plugin. */
const CODE_FILES = ["main.js", "styles.css", "manifest.json"];

function duplicatesMessage(titles: string[]): string {
	const names = [...new Set(titles)].map((t) => `"${t}"`).join(", ");
	return `Task Gift removed ${titles.length} duplicate task(s): ${names}`;
}

export default class TaskGiftPlugin extends Plugin {
	settings!: TaskGiftSettings;
	auth: AuthData | null = null;
	store!: TaskStore;
	api!: TasksApi;
	engine!: SyncEngine;
	/** Extra calendars (e.g. shifts), one note each in a folder next to the data note. */
	calendars!: CalendarStore;
	/** Description templates for calendar entries, one note each in a folder next to the data note. */
	templates!: TemplateStore;
	private dataFile!: DataFile<StoredData>;
	private settingsFile!: DataFile<StoredSettings>;
	private topicsFile!: DataFile<StoredTopics>;
	/** Topics read from their note at startup, merged into the store once it exists. */
	private loadedTopics: StoredTopics | null = null;
	/** The topic the views last showed, to re-draw when it ends at a time of day. */
	private shownTopic = "";
	private settingTab!: TaskGiftSettingTab;
	private music!: GiftMusic;

	private intervalId: number | null = null;
	private retryTimer: number | null = null;
	private refreshPromise: Promise<string> | null = null;
	private lastErrorNotice = "";
	private statusListeners = new Set<(s: SyncStatus) => void>();
	/** The day the views were last drawn for; a new day re-draws them (Today column, calendar). */
	private renderedDay = today();
	private dailyNoteBusy = false;
	/** mtime and size of the plugin's own files when loaded; null until first read. */
	private codeStamp: string | null = null;
	/** A changed code stamp waiting to stay the same for one more check before reloading. */
	private pendingCodeStamp: string | null = null;
	private checkingFiles = false;

	private saveSoon = debounce(() => void this.persist(), 1000, true);
	private refreshViewsSoon = debounce(() => this.refreshViews(), 100, true);
	private syncSoon = debounce(() => void this.engine.sync(), LOCAL_SYNC_DEBOUNCE_MS, true);

	async onload(): Promise<void> {
		await this.loadPluginData();
		useWeekStart(() => this.settings.weekStart);

		this.store = new TaskStore(this.loadedStore, (source) => this.onStoreChange(source));
		this.store.migratePauses();
		if (this.loadedTopics) this.mergeTopics(this.loadedTopics);
		this.shownTopic = this.topicKey();
		this.api = new TasksApi(() => this.accessToken());
		this.engine = new SyncEngine(this.api, this.store, () => this.settings, () => this.auth !== null, {
			afterSync: () => this.persist(),
			onStatus: (s) => this.onSyncStatus(s),
			onError: (msg) => this.showError(msg),
			onDuplicatesRemoved: (titles) => new Notice(duplicatesMessage(titles)),
		});

		this.calendars = new CalendarStore(this.app, () => calendarsFolderFor(this.dataFile.path), () => this.refreshViewsSoon());
		this.templates = new TemplateStore(this.app, () => templatesFolderFor(this.dataFile.path));

		this.music = new GiftMusic(this.app);
		// Gift music plays only while a gift view is on screen.
		const updateMusic = () => this.updateMusic();
		this.registerEvent(this.app.workspace.on("active-leaf-change", updateMusic));
		this.registerEvent(this.app.workspace.on("layout-change", updateMusic));

		this.registerView(VIEW_TYPE, (leaf) => new TaskView(leaf, this));

		this.addRibbonIcon("gift", "Open Task Gift", () => void this.activateView());
		this.addRibbonIcon("clipboard-plus", "New Google task", () => this.openTaskModal());

		this.addCommand({ id: "open-task-gift", name: "Open", callback: () => void this.activateView() });
		this.addCommand({ id: "open-view", name: "Open board", callback: () => void this.activateView() });
		this.addCommand({
			id: "open-calendar",
			name: "Open calendar",
			callback: async () => {
				await this.setBoardView("calendar");
				await this.activateView();
			},
		});
		this.addCommand({
			id: "insert-daily-note",
			name: "Insert today's tasks into daily note",
			callback: () => void this.insertIntoDailyNote(),
		});
		this.addCommand({ id: "new-task", name: "New task", callback: () => this.openTaskModal() });
		this.addCommand({
			id: "import-calendar-text",
			name: "Import text into a calendar",
			callback: () => new CalendarImportModal(this.app, this.calendars, null, () => void this.setBoardView("calendar")).open(),
		});
		this.addCommand({ id: "edit-modes", name: "Edit modes", callback: () => void this.openModes() });
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
		this.addCommand({ id: "full-resync", name: "Full resync with Google", callback: () => void this.syncNow(true) });
		this.addCommand({ id: "remove-duplicates", name: "Remove duplicate tasks", callback: () => this.removeDuplicates() });
		this.addCommand({ id: "sync-all-completed", name: "Download all completed tasks from Google", callback: () => void this.syncAllCompleted() });
		this.addCommand({
			id: "toggle-gift-mode",
			name: "Toggle gift mode (hide task board)",
			callback: () => void this.setGiftMode(!this.settings.giftMode),
		});

		this.settingTab = new TaskGiftSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile) this.onVaultFileChanged(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (file instanceof TFile) this.onVaultFileChanged(file);
			}),
		);

		this.app.workspace.onLayoutReady(async () => {
			await this.initDataFile();
			await this.calendars.refresh();
			this.engine.setStatus(this.auth ? "idle" : "disconnected", this.auth ? "Ready" : "Not connected");
			if (this.auth) void this.engine.sync();
			this.restartInterval();
			this.registerDailyNoteHooks();
			this.registerInterval(window.setInterval(() => this.onMinute(), 60 * 1000));
			// Sync tools don't always raise the vault's "modify" event (e.g. Self-hosted LiveSync can write straight
			// to disk), so the notes are also checked on a timer and whenever the window gets focus.
			this.registerInterval(window.setInterval(() => void this.checkFiles(), FILE_CHECK_MS));
			this.registerDomEvent(window, "focus", () => void this.checkFiles());
		});
		void this.checkForUpdate();
	}

	private onVaultFileChanged(file: TFile): void {
		if (this.dataFile.isDataFile(file)) void this.onDataFileChanged(true);
		else if (this.settingsFile.isDataFile(file)) void this.onSettingsFileChanged(true);
		else if (this.topicsFile.isDataFile(file)) void this.onTopicsFileChanged(true);
		else if (this.calendars.isCalendarPath(file.path)) void this.calendars.refresh();
	}

	/** Timer / focus: picks up notes changed by a sync tool, and reloads the plugin when it was updated. */
	private async checkFiles(): Promise<void> {
		if (this.checkingFiles || !this.dataReady) return;
		this.checkingFiles = true;
		try {
			await this.onSettingsFileChanged(false);
			await this.onDataFileChanged(false);
			await this.onTopicsFileChanged(false);
			await this.calendars.refresh();
			await this.checkForUpdate();
		} catch (e) {
			console.error("[Task Gift] Could not check for changes", e);
		} finally {
			this.checkingFiles = false;
		}
	}

	/**
	 * Reloads the plugin when its files changed on disk, e.g. a new version that arrived through sync,
	 * so no device has to turn it off and on. Waits until the files stop changing first.
	 */
	private async checkForUpdate(): Promise<void> {
		const dir = this.manifest.dir;
		if (!dir) return;
		const adapter = this.app.vault.adapter;
		const stats = await Promise.all(CODE_FILES.map((f) => adapter.stat(`${dir}/${f}`)));
		const stamp = stats.map((st) => (st ? `${st.mtime}:${st.size}` : "-")).join("|");
		if (this.codeStamp === null || stamp === this.codeStamp) {
			this.codeStamp = stamp;
			this.pendingCodeStamp = null;
			return;
		}
		// A sync tool may still be writing the files: reload only once they look the same twice in a row.
		if (stamp !== this.pendingCodeStamp) {
			this.pendingCodeStamp = stamp;
			return;
		}
		this.codeStamp = stamp;
		const plugins = (this.app as unknown as { plugins?: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<boolean> } })
			.plugins;
		if (!plugins) return;
		await this.persist();
		new Notice("Task Gift was updated and reloaded.");
		const id = this.manifest.id;
		await plugins.disablePlugin(id);
		await plugins.enablePlugin(id);
	}

	/** Once a minute: at a new day, drop finished day columns and re-draw. */
	private onMinute(): void {
		const day = today();
		const topic = this.topicKey();
		// A topic can end at a time of day.
		if (topic !== this.shownTopic) {
			this.shownTopic = topic;
			if (day === this.renderedDay) this.refreshViews();
		}
		if (day === this.renderedDay) return;
		this.renderedDay = day;
		if (pruneDayColumns(this.settings)) void this.persist();
		this.refreshViews();
	}

	onunload(): void {
		if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
		this.music.stop();
		void this.persist();
	}

	// ------------------------------------------------------------ data

	private loadedStore = emptyStore();
	/** lastSyncAt as last written to the data note. */
	private writtenSyncAt: string | null = null;
	/** True when no data note existed at startup (it is created once the vault is ready). */
	private dataFileMissing = false;
	/** Writes are held back until the vault is ready and the data note location is settled. */
	private dataReady = false;

	private static mergeSettings(raw: Partial<TaskGiftSettings> | undefined): TaskGiftSettings {
		const s = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
		// Also turns the filter and sound settings of older versions into mode settings.
		normalizeModes(s);
		// The interval used to be set in minutes.
		if (!Number.isFinite(raw?.syncIntervalSeconds)) s.syncIntervalSeconds = Math.max(1, Number(raw?.syncIntervalMinutes) || 5) * 60;
		s.syncIntervalSeconds = Math.max(MIN_SYNC_SECONDS, Math.round(s.syncIntervalSeconds));
		if (!Number.isFinite(s.boardZoom)) s.boardZoom = DEFAULT_SETTINGS.boardZoom;
		if (s.boardView !== "board" && s.boardView !== "calendar") s.boardView = DEFAULT_SETTINGS.boardView;
		if (s.calendarRange !== "month" && s.calendarRange !== "week") s.calendarRange = DEFAULT_SETTINGS.calendarRange;
		s.dayColumns = normalizeDayColumns(raw?.dayColumns);
		pruneDayColumns(s);
		if (typeof s.dailyNoteHeading !== "string") s.dailyNoteHeading = DEFAULT_SETTINGS.dailyNoteHeading;
		// Removed settings: the markdown sync note and the board-wide sort.
		for (const key of ["notePath", "mirrorToNote", "boardSort"]) delete (s as unknown as Record<string, unknown>)[key];
		s.columnSort = Object.assign({}, raw?.columnSort ?? {});
		// "Show completed" became the eye button of the Completed column.
		const legacyShowCompleted = (raw as { showCompleted?: boolean } | undefined)?.showCompleted;
		if (!Array.isArray(raw?.collapsedColumns)) s.collapsedColumns = legacyShowCompleted ? [] : [...DEFAULT_SETTINGS.collapsedColumns];
		else s.collapsedColumns = raw.collapsedColumns.filter((k): k is string => typeof k === "string");
		delete (s as unknown as Record<string, unknown>).showCompleted;
		if (!Array.isArray(s.customTaskColors)) s.customTaskColors = [];
		// Missing = never set up: start with the default commands. An empty list means the user deleted them all.
		s.stickyCommands = Array.isArray(raw?.stickyCommands)
			? raw.stickyCommands
					.filter((c) => c && typeof c.id === "string" && typeof c.before === "string" && typeof c.after === "string")
					.map((c) => ({
						id: c.id,
						name: typeof c.name === "string" ? c.name : "",
						before: c.before,
						after: c.after,
						...(typeof c.commandId === "string" && c.commandId ? { commandId: c.commandId } : {}),
					}))
			: DEFAULT_STICKY_COMMANDS.map((c) => ({ ...c }));
		if (!["both", "board", "calendar", "off"].includes(s.taskColorScope)) s.taskColorScope = DEFAULT_SETTINGS.taskColorScope;
		if (!KEEP_COMPLETED_OPTIONS.includes(s.keepCompletedDays)) {
			// Snap older free-form values to the nearest allowed option at or above them.
			s.keepCompletedDays = KEEP_COMPLETED_OPTIONS.find((n) => n >= s.keepCompletedDays) ?? 30;
		}
		return s;
	}

	private static mergeStore(raw: Partial<StoreData> | undefined): StoreData {
		const store = Object.assign(emptyStore(), raw ?? {});
		if (!store.taskModes || typeof store.taskModes !== "object") store.taskModes = {};
		if (!store.reminders || typeof store.reminders !== "object") store.reminders = {};
		if (!store.dayTitles || typeof store.dayTitles !== "object") store.dayTitles = {};
		if (!store.stickies || typeof store.stickies !== "object") store.stickies = {};
		if (!store.paused || typeof store.paused !== "object") store.paused = {};
		store.gift = Object.assign(emptyGiftState(), store.gift ?? {});
		delete (store as unknown as Record<string, unknown>).renderedIds; // left over from the removed sync note
		return store;
	}

	/**
	 * Data lives in two markdown notes in the vault: the settings note and the data note (sync state, sign-in).
	 * The plugin's own data.json only remembers where the data note is (it is device-local and does not sync);
	 * the settings note sits next to it.
	 */
	private async loadPluginData(): Promise<void> {
		const local = ((await this.loadData()) ?? {}) as Partial<PluginData> & Partial<LocalPointer>;
		const dataPath = normalizeDataPath(local.dataFilePath ?? DEFAULT_DATA_PATH);
		this.dataFile = new DataFile(this.app, DATA_NOTE, dataPath);
		this.settingsFile = new DataFile(this.app, SETTINGS_NOTE, settingsPathFor(dataPath));
		this.topicsFile = new DataFile(this.app, TOPICS_NOTE, topicsPathFor(dataPath));

		let data = await this.dataFile.read();
		if (!data && (local.settings || local.store)) {
			// Migrate from the old data.json format.
			data = { settings: local.settings, auth: local.auth, store: local.store };
		}
		this.dataFileMissing = !(await this.dataFile.exists());
		// Before the settings note existed, the settings were part of the data note.
		const noteSettings = await this.settingsFile.read();
		this.settings = TaskGiftPlugin.mergeSettings(noteSettings ?? data?.settings);
		// Only write the settings note after a change made here. Writing back what was just read could put an
		// outdated copy over a newer one (e.g. modes added on another device) that the sync tool hasn't delivered yet.
		if (noteSettings) this.settingsFile.adopt(this.settings);
		this.auth = data?.auth ?? null;
		this.loadedStore = TaskGiftPlugin.mergeStore(data?.store);
		this.writtenSyncAt = this.loadedStore.lastSyncAt;
		this.loadedTopics = await this.readTopics();
	}

	/** Reads the topics note; what it holds counts as written, so only a real change writes it again. */
	private async readTopics(): Promise<StoredTopics | null> {
		const topics = await this.topicsFile.read();
		if (!topics?.dayTitles || typeof topics.dayTitles !== "object") return null;
		this.topicsFile.adopt(topicsData(topics.dayTitles, topics.stickies ?? {}));
		return topics;
	}

	/** Takes over the topics and sticky notes from the topics note. Returns whether anything changed. */
	private mergeTopics(topics: StoredTopics): boolean {
		const titles = this.store.mergeDayTitles(topics.dayTitles);
		const stickies = this.store.mergeStickies(topics.stickies);
		return titles || stickies;
	}

	/** Called on layout ready: adopt a data note found elsewhere, or create the default one. */
	private async initDataFile(): Promise<void> {
		if (this.dataFileMissing) {
			const found = this.dataFile.findInVault();
			if (found) {
				this.dataFile.path = found;
				this.settingsFile.path = settingsPathFor(found);
				this.topicsFile.path = topicsPathFor(found);
				const data = await this.dataFile.read();
				const settings = await this.settingsFile.read();
				if (data || settings) this.applyExternal({ ...data, ...(settings ? { settings } : {}) }, true);
				if (settings) this.settingsFile.adopt(this.settings);
				const topics = await this.readTopics();
				if (topics) this.mergeTopics(topics);
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
		// Each note is only rewritten when its own contents changed.
		await this.settingsFile.write(this.settings);
		await this.topicsFile.write(topicsData(this.store.data.dayTitles, this.store.data.stickies));
		// A sync that found nothing new only moves lastSyncAt. With syncs seconds apart, writing the data note for that
		// would keep the sync tool busy and clash with the other device's writes, so it is only written now and then.
		// An older lastSyncAt on disk only makes the next start fetch a little more.
		let lastSyncAt = this.store.data.lastSyncAt;
		const written = this.writtenSyncAt;
		if (written && lastSyncAt && Date.parse(lastSyncAt) - Date.parse(written) < SYNC_STAMP_WRITE_MS) lastSyncAt = written;
		// The settings stay in the data note too, for devices still on an older Task Gift version.
		const data: PluginData = { settings: this.settings, auth: this.auth, store: { ...this.store.data, lastSyncAt } };
		await this.dataFile.write(data);
		this.writtenSyncAt = lastSyncAt;
	}

	dataFilePath(): string {
		return this.dataFile.path;
	}

	settingsFilePath(): string {
		return this.settingsFile.path;
	}

	/** Moves the data and settings notes (settings "Apply" button). Loads existing notes at the target instead, after confirmation. */
	async changeDataFilePath(input: string): Promise<boolean> {
		const target = normalizeDataPath(input);
		if (target === this.dataFile.path) return true;
		const settingsTarget = settingsPathFor(target);
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
			const settings = await this.settingsFile.read(settingsTarget);
			this.dataFile.path = target;
			this.settingsFile.path = settingsTarget;
			this.topicsFile.path = topicsPathFor(target);
			this.applyExternal({ ...existing, ...(settings ? { settings } : {}) }, true);
			const topics = await this.readTopics();
			if (topics) this.mergeTopics(topics);
		} else {
			try {
				await this.dataFile.moveTo(target);
				if (await this.settingsFile.exists(settingsTarget)) this.settingsFile.path = settingsTarget;
				else await this.settingsFile.moveTo(settingsTarget);
				const topicsTarget = topicsPathFor(target);
				if (await this.topicsFile.exists(topicsTarget)) this.topicsFile.path = topicsTarget;
				else await this.topicsFile.moveTo(topicsTarget);
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
	private applyExternal(incoming: Omit<Partial<PluginData>, "settings"> & { settings?: StoredSettings }, replace: boolean): void {
		if (incoming.settings) {
			const prevInterval = this.settings.syncIntervalSeconds;
			this.settings = TaskGiftPlugin.mergeSettings(incoming.settings);
			if (prevInterval !== this.settings.syncIntervalSeconds && this.intervalId !== null) this.restartInterval();
			// Show the new values if the settings are open on this device.
			if (this.settingTab.containerEl.isShown()) this.settingTab.update();
		}
		const a = incoming.auth;
		if (a && (replace || !this.auth || a.refreshToken !== this.auth.refreshToken || a.expiresAt > this.auth.expiresAt)) this.auth = a;
		if (replace && a === null) this.auth = null;
		if (incoming.store && this.store) {
			const inc = TaskGiftPlugin.mergeStore(incoming.store);
			const d = this.store.data;
			if (replace || Object.keys(d.tasks).length === 0) {
				const topics = d.dayTitles;
				const stickies = d.stickies;
				Object.assign(d, inc);
				// The topics and sticky notes have their own note; keep the ones read from it.
				if (!replace) {
					this.store.mergeDayTitles(topics);
					this.store.mergeStickies(stickies);
				}
			} else {
				d.recurrence = { ...d.recurrence, ...inc.recurrence };
				d.times = { ...d.times, ...inc.times };
				d.colors = { ...d.colors, ...inc.colors };
				d.taskModes = { ...d.taskModes, ...inc.taskModes };
				this.store.mergeReminders(inc.reminders);
				this.store.mergePaused(inc.paused);
				d.spawned = { ...d.spawned, ...inc.spawned };
				d.aliases = { ...d.aliases, ...inc.aliases };
				// Devices on an older version still keep the topics only here.
				this.store.mergeDayTitles(inc.dayTitles);
				this.store.mergeStickies(inc.stickies);
				d.gift = inc.gift;
				for (const l of Object.values(inc.lists)) if (!d.lists[l.id]) d.lists[l.id] = l;
			}
		}
		this.refreshViews();
		// Only sync after an explicit switch; syncing on every remote write would ping-pong between devices.
		if (replace && this.auth && this.engine) this.syncSoon();
	}

	/** The data note changed on another device: take over sign-in and gift state (settings come from their own note). */
	private async onDataFileChanged(force: boolean): Promise<void> {
		const raw = await this.dataFile.readChanged(force);
		if (raw === null || this.dataFile.isOwnWrite(raw)) return;
		const data = this.dataFile.parse(raw);
		if (!data) return;
		this.applyExternal({ auth: data.auth, store: data.store }, false);
	}

	/** The topics note changed on another device: take over the newer topics, and write back any it lacks. */
	private async onTopicsFileChanged(force: boolean): Promise<void> {
		const raw = await this.topicsFile.readChanged(force);
		if (raw === null || this.topicsFile.isOwnWrite(raw)) return;
		const topics = this.topicsFile.parse(raw);
		if (!topics?.dayTitles || typeof topics.dayTitles !== "object") return;
		// Written again only when this device holds a topic the note lacks (or a newer one), so the devices settle.
		this.topicsFile.adopt(topicsData(topics.dayTitles, topics.stickies ?? {}));
		if (this.mergeTopics(topics)) this.refreshViews();
		this.saveSoon();
	}

	/** Which topic shows right now; changes when one ends at a time of day. */
	private topicKey(): string {
		const active = this.store.activeDayTitle(today(), nowTime());
		return active ? `${active.start}|${active.title.updated}` : "";
	}

	/** The settings note changed on another device: apply the settings right away. */
	private async onSettingsFileChanged(force: boolean): Promise<void> {
		const raw = await this.settingsFile.readChanged(force);
		if (raw === null || this.settingsFile.isOwnWrite(raw)) return;
		const settings = this.settingsFile.parse(raw);
		if (!settings) return;
		this.applyExternal({ settings }, false);
		// Already in the note: don't write it back unless something changes here.
		this.settingsFile.adopt(this.settings);
		new Notice("Task Gift: settings updated from another device.");
	}

	async saveSettings(): Promise<void> {
		await this.persist();
		this.refreshViews();
	}

	/** Persist soon without redrawing, e.g. while typing in a sticky note. */
	saveLater(): void {
		this.saveSoon();
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
						// A Google Cloud app left in "Testing" gets refresh tokens that expire after 7 days.
						throw new AuthError(
							"Google access was revoked or expired. Please reconnect in Task Gift settings. If this happens every week, publish your app in Google Cloud (OAuth consent screen → Publish app): apps in Testing are signed out after 7 days.",
							true,
						);
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

	/** Deletes open tasks with the same title on the same day (also done after every sync). */
	removeDuplicates(): void {
		const removed = this.store.removeDuplicates();
		if (!removed.length) {
			new Notice(`No duplicate tasks in the next ${DUPLICATE_CHECK_MONTHS} months.`);
			return;
		}
		new Notice(duplicatesMessage(removed));
		this.store.notify("local");
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
		const seconds = Math.max(MIN_SYNC_SECONDS, this.settings.syncIntervalSeconds || 300);
		this.intervalId = this.registerInterval(
			window.setInterval(() => {
				if (this.auth) void this.engine.sync();
			}, seconds * 1000),
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
		// A reminder copies its task, so editing it means editing that task.
		if (task) task = this.store.reminderTask(task.id) ?? task;
		const colors =
			this.settings.taskColorScope === "off"
				? undefined
				: {
						custom: this.settings.customTaskColors,
						save: (list: string[]) => {
							this.settings.customTaskColors = list;
							void this.saveSettings();
						},
					};
		const modes = this.settings.modes.map((m) => ({ id: m.id, name: m.name }));
		new TaskModal(this.app, this.store, { task, defaults, colors, modes }).open();
	}

	/** Leaves gift mode and shows the board or the calendar. */
	async setBoardView(view: BoardView): Promise<void> {
		this.settings.giftMode = false;
		this.settings.boardView = view;
		await this.saveSettings();
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
		const onScreen = this.app.workspace.getLeavesOfType(VIEW_TYPE).some((leaf) => leaf.view instanceof TaskView && leaf.view.showsGift());
		this.music.update(activeMode(this.settings), onScreen);
	}

	/** Switches the active mode (header menu). */
	async setActiveMode(id: string): Promise<void> {
		if (id === this.settings.activeModeId || !this.settings.modes.some((m) => m.id === id)) return;
		this.settings.activeModeId = id;
		await this.saveSettings();
	}

	// ------------------------------------------------------------ daily note

	private registerDailyNoteHooks(): void {
		// Registered after layout ready, so the "create" events of the initial vault load are not seen.
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (file instanceof TFile && this.settings.dailyNoteEnabled && file.path === todayNotePath(this.app)) {
					window.setTimeout(() => void this.autoInsertDailyNote(), DAILY_NOTE_CREATE_DELAY_MS);
				}
			}),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file && this.settings.dailyNoteEnabled && file.path === todayNotePath(this.app)) void this.autoInsertDailyNote();
			}),
		);
	}

	/** Adds today's tasks to today's daily note once a day (setting "Insert tasks into the daily note"). */
	private async autoInsertDailyNote(): Promise<void> {
		const s = this.settings;
		const day = today();
		if (!s.dailyNoteEnabled || s.dailyNoteInsertedOn === day || this.dailyNoteBusy) return;
		const file = todayNote(this.app);
		if (!file) return;
		this.dailyNoteBusy = true;
		try {
			const content = await this.app.vault.read(file);
			// Added before (on another device, or by hand with the same heading).
			if (!hasHeading(content, s.dailyNoteHeading)) {
				const { text, count } = tasksMarkdown(this.store, s);
				// Nothing synced yet (or nothing due): try again next time the note is opened.
				if (!count) return;
				await appendToNote(this.app, file, text);
			}
			s.dailyNoteInsertedOn = day;
			await this.persist();
		} finally {
			this.dailyNoteBusy = false;
		}
	}

	/** Command / menu: adds today's tasks below the daily note's content, creating the note if needed. */
	async insertIntoDailyNote(): Promise<void> {
		if (this.dailyNoteBusy) return;
		const { text, count } = tasksMarkdown(this.store, this.settings);
		if (!count) {
			new Notice("No open tasks due today.");
			return;
		}
		this.dailyNoteBusy = true;
		try {
			let file = todayNote(this.app);
			if (!file) file = await this.createDailyNote();
			if (!file) {
				new Notice("Could not create today's daily note.");
				return;
			}
			await appendToNote(this.app, file, text);
			// Don't add them a second time automatically today.
			this.settings.dailyNoteInsertedOn = today();
			await this.persist();
			new Notice(`Added ${count} task${count === 1 ? "" : "s"} to ${file.basename}.`);
		} catch (e) {
			new Notice(`Could not update the daily note: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.dailyNoteBusy = false;
		}
	}

	/** Creates today's note with the Daily notes plugin (so its template applies), or as an empty note. */
	private async createDailyNote(): Promise<TFile | null> {
		const commands = (this.app as unknown as { commands?: { executeCommandById(id: string): boolean } }).commands;
		if (isDailyNotesEnabled(this.app) && commands?.executeCommandById("daily-notes")) {
			for (let i = 0; i < 20; i++) {
				await new Promise((r) => window.setTimeout(r, 150));
				const f = todayNote(this.app);
				if (f) {
					await new Promise((r) => window.setTimeout(r, DAILY_NOTE_CREATE_DELAY_MS));
					return f;
				}
			}
		}
		const path = todayNotePath(this.app);
		const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
		return this.app.vault.create(path, "");
	}

	/** Opens the Modes page of gift mode (modes are edited there, not in the settings tab). */
	async openModes(): Promise<void> {
		(this.app as unknown as { setting?: { close(): void } }).setting?.close();
		if (!this.settings.giftMode) await this.setGiftMode(true);
		await this.activateView();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof TaskView) leaf.view.showModes();
		this.updateMusic();
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
