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
	/**
	 * Monthly: on a fixed day of month, on the Nth weekday, or on the Nth weekday after a day of the month
	 * ("the first Monday after the 10th"; that can spill into the next month).
	 */
	monthlyMode: "day" | "nth" | "after";
	monthDay: number;
	/** 1..4, or -1 for "last" (not with "after"). */
	nth: number;
	nthWeekday: Weekday;
	/** "after": the day of the month (1..31, clamped to the month's length) the weekday is counted from. */
	afterDay?: number;
	/** "after": true = that day itself counts ("on or after"). */
	afterInclusive?: boolean;
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
export type TaskColor = NamedTaskColor | `#${string}`;

export type DayTitleSize = "small" | "normal" | "large" | "huge";

/** A run of a day heading's text with its own color (null = the heading's color). */
export interface DayTitlePart {
	text: string;
	color: TaskColor | null;
}

/** How a day heading (or its end date) looks. */
export interface DayTitleStyle {
	color: TaskColor | null;
	size: DayTitleSize;
	bold: boolean;
	italic: boolean;
	/** Drawn on a tinted pill. */
	highlight: boolean;
}

/** The heading's end date shown next to it, after the user's own words (e.g. "Ends" or "עד"). */
export interface DayTitleEndNote extends DayTitleStyle {
	shown: boolean;
	text: string;
	/** Set when some letters of `text` have their own color; their texts joined equal `text`. */
	parts?: DayTitlePart[];
	/** Where it sits next to the heading; missing = below. */
	position?: DayTitleEndPosition;
}

export type DayTitleEndPosition = "below" | "above" | "right" | "left";

/** The heading of a day ("what today is about"), shown in the view's header. */
export interface DayTitle extends DayTitleStyle {
	text: string;
	/** Set when some letters have their own color; their texts joined equal `text`. */
	parts?: DayTitlePart[];
	/**
	 * The last day the heading is shown (YYYY-MM-DD); null = it never ends; missing = only the day it was written for.
	 * A heading written on a later day takes over while it lasts.
	 */
	until?: string | null;
	/** HH:MM on the `until` date when the heading ends; missing = at the end of that day. */
	untilTime?: string;
	/** Shown only while `until` is a date. */
	endNote?: DayTitleEndNote;
	/** Date.now() of the last edit; the newer one wins when two devices edited the same day. */
	updated: number;
}

/**
 * A command in a sticky note's menu: an Obsidian command (`commandId`), or text markers that wrap the selected
 * text in `before` … `after` (Markdown or HTML), or unwrap it.
 */
export interface StickyCommand {
	id: string;
	name: string;
	before: string;
	after: string;
	/** An Obsidian command from the command palette; `before`/`after` are unused then. */
	commandId?: string;
}

export type StickyColor = NamedTaskColor | "default";

/** A note stuck on the empty part of the board, placed freely. Local only: it never reaches Google. */
export interface StickyNote {
	text: string;
	/** "default" = Obsidian's own neutral background. */
	color: StickyColor;
	/** Position and size in px inside the sticky-note area (at 100% board zoom). */
	x: number;
	y: number;
	w: number;
	h: number;
	/** Date.now() of the last edit; the newer one wins when two devices edited the same note. Newest is drawn on top. */
	updated: number;
	/** Kept for a while after deleting, so the deletion syncs. */
	deleted?: boolean;
}

/** A paused task as it was when it was deleted from Google, to be created again when it is resumed. */
export interface PausedTask {
	title: string;
	notes: string;
	listId: string;
	due: string | null;
	parent: string | null;
	rule?: RecurrenceRule;
	time?: string;
	color?: TaskColor;
	modes?: string[];
	subtasks?: { title: string; notes: string; due: string | null; done: boolean }[];
}

/**
 * A task on a break: deleted from Google (so it leaves every Google Tasks app) and kept here, shown in the board's
 * Paused column until it is resumed as a new task.
 */
export interface PauseState {
	/** false = resumed or deleted; kept a while without `task` so that syncs. */
	on: boolean;
	/** Date.now() of the last change; the newer one wins when two devices changed it. */
	updated: number;
	task?: PausedTask;
}

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
	/** Kept for devices on an older version; `syncIntervalSeconds` is what counts. */
	syncIntervalMinutes: number;
	syncIntervalSeconds: number;
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
	/** Format commands in a sticky note's menu, in menu order. */
	stickyCommands: StickyCommand[];
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
	/** Day headings, keyed by date (YYYY-MM-DD). A cleared one stays with empty text so the clearing syncs. */
	dayTitles: Record<string, DayTitle>;
	/** Sticky notes on the board, keyed by their own ID. A deleted one stays a while so the deletion syncs. */
	stickies: Record<string, StickyNote>;
	/** Paused tasks (the board's Paused column), keyed by the ID the task had. Resumed = kept a while with `on: false` so it syncs. */
	paused: Record<string, PauseState>;
	lastSyncAt: string | null;
	lastFullSyncAt: string | null;
	gift: GiftState;
}

export interface PluginData {
	settings: TaskGiftSettings;
	auth: AuthData | null;
	store: StoreData;
}
