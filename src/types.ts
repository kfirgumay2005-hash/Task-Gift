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

/** Built-in gift sounds, "random" (one of them each time) or "custom" (an audio file from the vault). */
export type GiftSound = "birthday" | "chime" | "magic" | "random" | "custom";

export interface TaskGiftSettings {
	clientId: string;
	clientSecret: string;
	syncIntervalMinutes: number;
	keepCompletedDays: number;
	giftMode: boolean;
	tasksPerGift: number;
	showGiftCounter: boolean;
	animations: boolean;
	giftSoundEnabled: boolean;
	giftSound: GiftSound;
	/** Vault path of the audio file used when giftSound is "custom". */
	giftSoundFile: string;
	/** 0..100 */
	giftSoundVolume: number;
	/** Vault paths of images that can be shown behind gift mode. */
	giftBackgrounds: string[];
	/** "random" (a different image per gift) or one path from giftBackgrounds. */
	giftBackgroundPick: string;
	/** How much the background image is faded towards the theme background, 0..90. */
	giftBackgroundDim: number;
	grouping: Grouping;
	showCompleted: boolean;
	/** Card order per board column, keyed by column (list ID, "today", "completed", …). Missing = default. */
	columnSort: Record<string, BoardSort>;
	weekStart: 0 | 1;
	boardFilter: DateFilter;
	separateGiftFilter: boolean;
	giftFilter: DateFilter;
	/** null = all lists. */
	includedLists: string[] | null;
	/** Tasks whose description contains any of these words are never drawn from a gift. */
	giftExcludeKeywords: string[];
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
