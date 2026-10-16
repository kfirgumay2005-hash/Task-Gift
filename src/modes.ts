import { DEFAULT_MODE_FILTER } from "./defaults";
import type { DateFilter, TaskGiftSettings, TaskMode } from "./types";

export function newModeId(): string {
	return `mode-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newMode(name: string, from?: Partial<TaskMode>): TaskMode {
	return {
		id: newModeId(),
		name,
		filter: { ...DEFAULT_MODE_FILTER },
		includedLists: null,
		excludeKeywords: [],
		backgrounds: [],
		backgroundPick: "random",
		backgroundDim: 40,
		applyToBoard: false,
		...from,
	};
}

/** The active mode. Settings are normalized on load so there is always one. */
export function activeMode(s: TaskGiftSettings): TaskMode {
	return s.modes.find((m) => m.id === s.activeModeId) ?? s.modes[0];
}

/** Fills missing fields of a stored mode. */
function normalizeMode(raw: Partial<TaskMode>): TaskMode {
	const m = newMode(typeof raw.name === "string" && raw.name.trim() ? raw.name : "Mode", raw);
	if (typeof raw.id === "string" && raw.id) m.id = raw.id;
	m.filter = Object.assign({}, DEFAULT_MODE_FILTER, raw.filter ?? {});
	m.includedLists = Array.isArray(raw.includedLists) ? [...raw.includedLists] : null;
	m.excludeKeywords = Array.isArray(raw.excludeKeywords) ? [...raw.excludeKeywords] : [];
	m.backgrounds = Array.isArray(raw.backgrounds) ? [...raw.backgrounds] : [];
	return m;
}

/** Settings from before modes existed (1.1.x). */
interface LegacySettings {
	boardFilter?: DateFilter;
	giftFilter?: DateFilter;
	separateGiftFilter?: boolean;
	includedLists?: string[] | null;
	giftExcludeKeywords?: string[];
	giftBackground?: string;
	giftBackgrounds?: string[];
	giftBackgroundPick?: string;
	giftBackgroundDim?: number;
}

const LEGACY_KEYS: (keyof LegacySettings)[] = [
	"boardFilter",
	"giftFilter",
	"separateGiftFilter",
	"includedLists",
	"giftExcludeKeywords",
	"giftBackground",
	"giftBackgrounds",
	"giftBackgroundPick",
	"giftBackgroundDim",
];

/** Makes sure there is at least one mode and a valid active mode; turns old filter settings into the first mode. */
export function normalizeModes(s: TaskGiftSettings): void {
	const legacy = s as unknown as LegacySettings;
	const modes = Array.isArray(s.modes) ? s.modes.map(normalizeMode) : [];
	if (!modes.length) {
		const separate = legacy.separateGiftFilter === true;
		const filter = (separate ? legacy.giftFilter : legacy.boardFilter) ?? DEFAULT_MODE_FILTER;
		const backgrounds = Array.isArray(legacy.giftBackgrounds) ? [...legacy.giftBackgrounds] : [];
		let pick = legacy.giftBackgroundPick ?? "random";
		// Even older versions had a single background image.
		if (legacy.giftBackground && !backgrounds.includes(legacy.giftBackground)) {
			backgrounds.push(legacy.giftBackground);
			pick = legacy.giftBackground;
		}
		modes.push(
			normalizeMode({
				name: "Default",
				filter: { ...DEFAULT_MODE_FILTER, ...filter },
				includedLists: legacy.includedLists ?? null,
				excludeKeywords: legacy.giftExcludeKeywords ?? [],
				backgrounds,
				backgroundPick: pick,
				backgroundDim: legacy.giftBackgroundDim ?? 40,
				// One shared filter used to apply to the board as well.
				applyToBoard: !separate,
			}),
		);
	}
	for (const key of LEGACY_KEYS) delete legacy[key];
	s.modes = modes;
	if (!modes.some((m) => m.id === s.activeModeId)) s.activeModeId = modes[0].id;
}
