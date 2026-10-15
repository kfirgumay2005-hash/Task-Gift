import type { DateFilter, GiftState, StoreData, TaskGiftSettings } from "./types";

export const VIEW_TYPE = "task-gift-view";

export const DEFAULT_BOARD_FILTER: DateFilter = {
	presets: ["all"],
	customFrom: 1,
	customTo: 7,
	includeOverdue: true,
	includeNoDate: true,
};

export const DEFAULT_GIFT_FILTER: DateFilter = {
	presets: ["today"],
	customFrom: 1,
	customTo: 7,
	includeOverdue: true,
	includeNoDate: true,
};

/** "Keep completed tasks" value meaning no time limit. */
export const KEEP_FOREVER = -1;

/** Allowed values for "Keep completed tasks" (0 = never, KEEP_FOREVER = no limit). */
export const KEEP_COMPLETED_OPTIONS = [0, 1, 3, 7, 30, 90, 365, KEEP_FOREVER];

export const DEFAULT_SETTINGS: TaskGiftSettings = {
	clientId: "",
	clientSecret: "",
	syncIntervalMinutes: 5,
	keepCompletedDays: 30,
	giftMode: false,
	tasksPerGift: 1,
	showGiftCounter: true,
	animations: true,
	giftSoundEnabled: true,
	giftSound: "birthday",
	giftSoundFile: "",
	giftSoundVolume: 70,
	giftBackgrounds: [],
	giftBackgroundPick: "random",
	giftBackgroundDim: 40,
	grouping: "list",
	showCompleted: false,
	columnSort: {},
	weekStart: 0,
	boardFilter: DEFAULT_BOARD_FILTER,
	separateGiftFilter: false,
	giftFilter: DEFAULT_GIFT_FILTER,
	includedLists: null,
	giftExcludeKeywords: [],
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
		spawned: {},
		aliases: {},
		lastSyncAt: null,
		lastFullSyncAt: null,
		gift: emptyGiftState(),
	};
}
