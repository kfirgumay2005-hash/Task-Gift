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

/** Allowed values for "Keep completed tasks" (0 = never). */
export const KEEP_COMPLETED_OPTIONS = [0, 1, 3, 7, 30];

export const DEFAULT_SETTINGS: TaskGiftSettings = {
	clientId: "",
	clientSecret: "",
	notePath: "Tasks/Google Tasks.md",
	mirrorToNote: true,
	syncIntervalMinutes: 5,
	keepCompletedDays: 30,
	giftMode: false,
	tasksPerGift: 1,
	showGiftCounter: true,
	animations: true,
	grouping: "list",
	showCompleted: false,
	weekStart: 0,
	boardFilter: DEFAULT_BOARD_FILTER,
	separateGiftFilter: false,
	giftFilter: DEFAULT_GIFT_FILTER,
	includedLists: null,
	giftExcludeKeywords: [],
};

export function emptyGiftState(): GiftState {
	return { drawn: [], done: [], opened: false, recent: [], openedTodayDate: "", openedTodayCount: 0 };
}

export function emptyStore(): StoreData {
	return {
		lists: {},
		tasks: {},
		snapshots: {},
		recurrence: {},
		times: {},
		spawned: {},
		renderedIds: [],
		aliases: {},
		lastSyncAt: null,
		lastFullSyncAt: null,
		gift: emptyGiftState(),
	};
}
