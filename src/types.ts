export type TaskStatus = "needsAction" | "completed";

/** A task as kept in the local store. IDs starting with `local-` are not yet created in Google. */
export interface Task {
	id: string;
	listId: string;
	title: string;
	notes: string;
	/** Local date, YYYY-MM-DD. Google only stores the date part. */
	due: string | null;
	status: TaskStatus;
	/** RFC 3339 timestamp. */
	completed: string | null;
	parent: string | null;
	position: string;
	/** Google's `updated` timestamp at last sync (RFC 3339), empty for local-only tasks. */
	updated: string;
	/** List / parent the task currently has in Google, used to detect moves. */
	remoteListId: string | null;
	remoteParent: string | null;
	/** Local changes not yet pushed. */
	dirty: boolean;
	/** Epoch ms of the last local edit. */
	localUpdated: number;
	pendingDelete: boolean;
}

export interface TaskList {
	id: string;
	title: string;
	updated: string;
}

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type RecurrencePreset = "daily" | "weekly" | "monthly" | "yearly" | "custom";
export type RecurrenceFreq = "daily" | "weekly" | "monthly" | "yearly";

export type RecurrenceEnd =
	| { type: "never" }
	| { type: "count"; count: number }
	| { type: "until"; date: string };

export interface RecurrenceRule {
	preset: RecurrencePreset;
	freq: RecurrenceFreq;
	interval: number;
	/** Weekly: which weekdays (0 = Sunday). */
	byWeekday: Weekday[];
	/** Monthly: on a fixed day of month, or on the Nth weekday. */
	monthlyMode: "day" | "nth";
	monthDay: number;
	/** 1..4, or -1 for "last". */
	nth: number;
	nthWeekday: Weekday;
	end: RecurrenceEnd;
	/** Which occurrence the task carrying this rule is (1 = first). */
	occurrence: number;
	/** Date of the first occurrence; anchors "every N weeks". */
	anchor: string;
}

export type DatePreset =
	| "all"
	| "yesterday"
	| "today"
	| "tomorrow"
	| "thisWeek"
	| "next7"
	| "overdue"
	| "noDate"
	| "custom";

export interface DateFilter {
	presets: DatePreset[];
	customFrom: number;
	customTo: number;
	includeOverdue: boolean;
	includeNoDate: boolean;
}

export type Grouping = "list" | "date" | "status";

/** Card order inside board columns. "date" is the completion date for completed tasks, otherwise the due date. */
export type BoardSort = "default" | "dateAsc" | "dateDesc";

/** What the view shows when gift mode is off. */
export type BoardView = "board" | "calendar";

export type CalendarRange = "month" | "week";

/** Built-in task colors, drawn with the theme's matching color. */
export type NamedTaskColor = "red" | "orange" | "yellow" | "green" | "cyan" | "blue" | "purple" | "pink";

/** A built-in color name or a custom "#rrggbb" color. */
export type TaskColor = NamedTaskColor | string;

/** Where task colors are shown. */
export type TaskColorScope = "both" | "board" | "calendar" | "off";

/** A board column (grouping by due date) for one chosen day. */
export interface DayColumn {
	id: string;
	/** YYYY-MM-DD */
	date: string;
	/** Optional name; empty = the date's friendly label. */
	title: string;
	/** Removed automatically once its day is over. */
	autoRemove: boolean;
}

/** Built-in gift sounds, "random" (one of them each time) or "custom" (an audio file from the vault). */
export type GiftSound = "birthday" | "chime" | "magic" | "random" | "custom";

/** Sounds, victory and music of a mode's gift view. */
export interface ModeAudio {
	giftSoundEnabled: boolean;
	giftSound: GiftSound;
	/** Vault path of the audio file used when giftSound is "custom". */
	giftSoundFile: string;
	/** 0..100 */
	giftSoundVolume: number;
	/** Small celebration when every task of a gift is done. */
	victoryAnimation: boolean;
	victorySoundEnabled: boolean;
	/** Vault path of the audio file played when a gift is finished. */
	victorySoundFile: string;
	/** Music looping while the gift view is shown. */
	giftMusicEnabled: boolean;
	giftMusicFile: string;
	/** 0..100 */
	giftMusicVolume: number;
	/** Play the sound track of a video background. */
	giftVideoSound: boolean;
}

/**
 * A mode (e.g. "Home", "Work") decides which tasks gifts are drawn from and how gift mode looks and sounds.
 * Switched from the header of the Task Gift view. The board always shows every task.
 */
export interface TaskMode extends ModeAudio {
	id: string;
	name: string;
	filter: DateFilter;
	/** null = all lists. */
	includedLists: string[] | null;
	/** Tasks whose description contains any of these words are never drawn from a gift. */
	excludeKeywords: string[];
	/** Vault paths of images / videos shown behind gift mode. */
	backgrounds: string[];
	/** "random" (a different one per gift) or one path from backgrounds. */
	backgroundPick: string;
	/** How much the background is faded towards the theme background, 0..90. */
	backgroundDim: number;
}

export interface TaskGiftSettings {
	clientId: string;
	clientSecret: string;
	syncIntervalMinutes: number;
	keepCompletedDays: number;
	giftMode: boolean;
	tasksPerGift: number;
	showGiftCounter: boolean;
	animations: boolean;
	grouping: Grouping;
	/** Board columns folded with their eye button, keyed like columnSort. */
	collapsedColumns: string[];
	/** Card order per board column, keyed by column (list ID, "today", "completed", …). Missing = default. */
	columnSort: Record<string, BoardSort>;
	weekStart: 0 | 1;
	/** At least one mode always exists; exactly one is active. */
	modes: TaskMode[];
	activeModeId: string;
	/** Board zoom in percent. */
	boardZoom: number;
	boardView: BoardView;
	calendarRange: CalendarRange;
	taskColorScope: TaskColorScope;
	/** Colors added with "+" in the task window ("#rrggbb"). */
	customTaskColors: string[];
	/** Extra day columns of the board grouped by due date. */
	dayColumns: DayColumn[];
	/** Automatically add today's tasks to the daily note (once a day). */
	dailyNoteEnabled: boolean;
	/** Line written above the tasks, e.g. "## Tasks"; empty = none. */
	dailyNoteHeading: string;
	dailyNoteIncludeOverdue: boolean;
	/** Date the tasks were last added automatically. */
	dailyNoteInsertedOn: string;
}

export interface AuthData {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	email: string;
}

export interface GiftState {
	/** IDs of drawn tasks for the current gift. */
	drawn: string[];
	/** IDs from `drawn` that were completed. */
	done: string[];
	opened: boolean;
	/** Tasks shown just before a redraw, avoided on the next draw. */
	recent: string[];
	/** Slots put back with "Draw again", refilled when the re-wrapped gift is opened. */
	pendingRedraw: number;
	openedTodayDate: string;
	openedTodayCount: number;
}

export interface StoreData {
	lists: Record<string, TaskList>;
	tasks: Record<string, Task>;
	/** Google `updated` value at last sync, keyed by task ID. */
	snapshots: Record<string, string>;
	recurrence: Record<string, RecurrenceRule>;
	/** Local due times (HH:MM), keyed by task ID. */
	times: Record<string, string>;
	/** Local task colors, keyed by task ID. */
	colors: Record<string, TaskColor>;
	/** Modes a task may be drawn in, keyed by task ID. Missing = every mode. */
	taskModes: Record<string, string[]>;
	/** Task IDs that already spawned their next occurrence. */
	spawned: Record<string, string>;
	/** Temporary local IDs that were replaced by Google IDs (old -> new). */
	aliases: Record<string, string>;
	lastSyncAt: string | null;
	lastFullSyncAt: string | null;
	gift: GiftState;
}

export interface PluginData {
	settings: TaskGiftSettings;
	auth: AuthData | null;
	store: StoreData;
}
