import type { DateFilter, GiftState, ModeAudio, NamedTaskColor, StoreData, TaskColor, TaskGiftSettings } from "./types";

export const VIEW_TYPE = "task-gift-view";

export const DEFAULT_MODE_FILTER: DateFilter = {
	presets: ["today"],
	customFrom: 1,
	customTo: 7,
	includeOverdue: true,
	includeNoDate: true,
};

export const DEFAULT_MODE_AUDIO: ModeAudio = {
	giftSoundEnabled: true,
	giftSound: "birthday",
	giftSoundFile: "",
	giftSoundVolume: 70,
	victoryAnimation: true,
	victorySoundEnabled: false,
	victorySoundFile: "",
	giftMusicEnabled: false,
	giftMusicFile: "",
	giftMusicVolume: 40,
	giftVideoSound: false,
};

/** Board zoom steps in percent. */
export const BOARD_ZOOM_MIN = 50;
export const BOARD_ZOOM_MAX = 150;
export const BOARD_ZOOM_STEP = 10;

/** Task colors in picker order, with their names. */
export const TASK_COLORS: Record<NamedTaskColor, string> = {
	red: "Red",
	orange: "Orange",
	yellow: "Yellow",
	green: "Green",
	cyan: "Cyan",
	blue: "Blue",
	purple: "Purple",
	pink: "Pink",
};

/** CSS value for a task color: the theme's color for built-in names, otherwise the custom color itself. */
export function taskColorCss(color: TaskColor): string {
	return color in TASK_COLORS ? `var(--color-${color})` : color;
}

/** "Keep completed tasks" value meaning no time limit. */
export const KEEP_FOREVER = -1;
/** The shortest sync interval: all devices share one Google quota (~50,000 requests a day; 3 devices × 2 requests every 15 s ≈ 35,000). */
export const MIN_SYNC_SECONDS = 15;

/** Allowed values for "Keep completed tasks" (0 = never, KEEP_FOREVER = no limit). */
export const KEEP_COMPLETED_OPTIONS = [0, 1, 3, 7, 30, 90, 365, KEEP_FOREVER];

export const DEFAULT_SETTINGS: TaskGiftSettings = {
	clientId: "",
	clientSecret: "",
	syncIntervalMinutes: 5,
	syncIntervalSeconds: 300,
	keepCompletedDays: 30,
	giftMode: false,
	tasksPerGift: 1,
	showGiftCounter: true,
	animations: true,
	grouping: "list",
	collapsedColumns: ["completed"],
	columnSort: {},
	weekStart: 0,
	// Filled with one default mode on load.
	modes: [],
	activeModeId: "",
	boardZoom: 100,
	boardView: "board",
	calendarRange: "month",
	taskColorScope: "both",
	customTaskColors: [],
	dayColumns: [],
	dailyNoteEnabled: false,
	dailyNoteHeading: "## Tasks",
	dailyNoteIncludeOverdue: true,
	dailyNoteInsertedOn: "",
};

export function emptyGiftState(): GiftState {
	return { drawn: [], done: [], opened: false, recent: [], pendingRedraw: 0, openedTodayDate: "", openedTodayCount: 0 };
}

export function emptyStore(): StoreData {
	return {
		lists: {},
		tasks: {},
		snapshots: {},
		recurrence: {},
		times: {},
		colors: {},
		taskModes: {},
		spawned: {},
		aliases: {},
		dayTitles: {},
		lastSyncAt: null,
		lastFullSyncAt: null,
		gift: emptyGiftState(),
	};
}
