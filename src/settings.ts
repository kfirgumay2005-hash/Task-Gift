import { App, Notice, Platform, PluginSettingTab, SettingDefinitionItem, SettingGroupItem, TFile, TFolder } from "obsidian";
import type TaskGiftPlugin from "./main";
import type { DateFilter, DatePreset, GiftSound, Grouping, TaskGiftSettings, TaskMode } from "./types";
import { describeFilter, PRESET_LABELS, QUICK_COMBOS } from "./filters/dates";
import { KEEP_COMPLETED_OPTIONS, KEEP_FOREVER } from "./defaults";
import { newMode } from "./modes";
import { AUDIO_EXTENSIONS, playGiftSound, playVictorySound, SOUND_LABELS } from "./audio/sounds";
import { BACKGROUND_EXTENSIONS, isBackgroundFile, isVideo } from "./util/media";

const PRESET_ORDER: DatePreset[] = ["all", "overdue", "yesterday", "today", "tomorrow", "thisWeek", "next7", "noDate", "custom"];

/** Control keys of a mode's settings: `mode:<id>:<field>`, `mode:<id>:filter.<field>` or `mode:<id>:list:<listId>`. */
const MODE_PREFIX = "mode:";

/** Keys whose change alters which settings are shown. */
const STRUCTURAL_KEYS = new Set(["giftSound", "giftSoundEnabled", "victorySoundEnabled", "giftMusicEnabled"]);

function modeKey(mode: TaskMode, field: string): string {
	return `${MODE_PREFIX}${mode.id}:${field}`;
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export class TaskGiftSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: TaskGiftPlugin) {
		super(app, plugin);
	}

	// ----------------------------------------------------------- storage

	/** Splits a mode control key into the mode and the field. */
	private parseModeKey(key: string): { mode: TaskMode; field: string } | null {
		if (!key.startsWith(MODE_PREFIX)) return null;
		const rest = key.slice(MODE_PREFIX.length);
		const colon = rest.indexOf(":");
		const mode = this.plugin.settings.modes.find((m) => m.id === rest.slice(0, colon));
		return mode ? { mode, field: rest.slice(colon + 1) } : null;
	}

	/** Settings live in the vault data note, not data.json, so controls read and write here. */
	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		const mk = this.parseModeKey(key);
		if (mk) {
			const { mode, field } = mk;
			if (field.startsWith("list:")) {
				const id = field.slice("list:".length);
				return mode.includedLists === null || mode.includedLists.includes(id);
			}
			if (field.startsWith("filter.")) return (mode.filter as unknown as Record<string, unknown>)[field.slice("filter.".length)];
			if (field === "excludeKeywords") return mode.excludeKeywords.join("\n");
			return (mode as unknown as Record<string, unknown>)[field];
		}
		switch (key) {
			case "keepCompletedDays":
			case "weekStart":
				return String(s[key]);
			default:
				return (s as unknown as Record<string, unknown>)[key];
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const p = this.plugin;
		const s = p.settings;
		const mk = this.parseModeKey(key);
		if (mk) {
			this.setModeValue(mk.mode, mk.field, value);
		} else {
			switch (key) {
				case "clientId":
				case "clientSecret":
					s[key] = String(value).trim();
					break;
				case "syncIntervalMinutes":
					s.syncIntervalMinutes = Math.max(1, Math.round(Number(value)) || 5);
					p.restartInterval();
					break;
				case "keepCompletedDays":
					s.keepCompletedDays = parseInt(String(value));
					break;
				case "weekStart":
					s.weekStart = value === "1" ? 1 : 0;
					break;
				default:
					(s as unknown as Record<string, unknown>)[key] = value;
			}
		}
		await p.saveSettings();
		if (STRUCTURAL_KEYS.has(key)) this.update();
	}

	private setModeValue(mode: TaskMode, field: string, value: unknown): void {
		if (field.startsWith("list:")) {
			const id = field.slice("list:".length);
			const lists = this.plugin.store.lists();
			const current = new Set(mode.includedLists ?? lists.map((x) => x.id));
			if (value) current.add(id);
			else current.delete(id);
			mode.includedLists = lists.every((x) => current.has(x.id)) ? null : [...current];
		} else if (field.startsWith("filter.")) {
			const sub = field.slice("filter.".length) as keyof DateFilter;
			(mode.filter as unknown as Record<string, unknown>)[sub] = typeof value === "number" ? Math.max(0, Math.round(value)) : value;
		} else if (field === "excludeKeywords") {
			mode.excludeKeywords = String(value)
				.split(/[\n,]/)
				.map((x) => x.trim())
				.filter(Boolean);
		} else if (field === "name") {
			mode.name = String(value).trim() || "Mode";
		} else {
			(mode as unknown as Record<string, unknown>)[field] = value;
		}
	}

	// ----------------------------------------------------------- definitions

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ type: "group", heading: "Google account", items: this.accountItems() },
			{ type: "group", heading: "Sync", items: this.syncItems() },
			this.modesList(),
			{ type: "group", heading: "View", items: this.viewItems() },
			{ type: "group", heading: "Gift sounds", items: this.soundItems() },
			{ type: "group", heading: "Victory", items: this.victoryItems() },
			{ type: "group", heading: "Music and video sound", items: this.musicItems() },
		];
	}

	private accountItems(): SettingGroupItem[] {
		const p = this.plugin;
		return [
			{
				name: "Connection status",
				searchable: false,
				render: (setting) => {
					const renderStatus = () => {
						const st = p.engine.status;
						setting.descEl.empty();
						const line = setting.descEl.createDiv({ cls: "tg-status-line" });
						line.createSpan({ cls: `tg-status-dot is-${p.isConnected() ? st.state : "disconnected"}` });
						if (p.isConnected()) {
							line.createSpan({ text: `Connected${p.auth?.email ? ` as ${p.auth.email}` : ""} · ${st.message}` });
							if (st.lastSync) setting.descEl.createDiv({ text: `Last sync: ${new Date(st.lastSync).toLocaleString()}` });
							if (st.pending) setting.descEl.createDiv({ text: `${st.pending} local change(s) waiting to sync` });
						} else {
							line.createSpan({ text: "Not connected" });
						}
					};
					renderStatus();
					return p.onStatus(() => renderStatus());
				},
			},
			{
				name: "Client ID",
				desc: "OAuth client ID of your own Google Cloud project (application type: Desktop app).",
				control: { type: "text", key: "clientId", placeholder: "xxxxxxxx.apps.googleusercontent.com" },
			},
			{
				name: "Client secret",
				desc: "Stored in the Task Gift data file (see Sync → Data file location).",
				render: (setting) => {
					setting.addText((t) => {
						t.inputEl.type = "password";
						t.setPlaceholder("GOCSPX-…")
							.setValue(p.settings.clientSecret)
							.onChange((v) => void this.setControlValue("clientSecret", v));
					});
				},
			},
			{
				name: p.isConnected() ? "Disconnect Google account" : "Connect Google account",
				render: (setting) => {
					if (p.isConnected()) {
						setting.addButton((b) =>
							b
								.setButtonText("Disconnect")
								.setDestructive()
								.onClick(() => void p.disconnect().then(() => this.update())),
						);
					} else if (Platform.isDesktopApp) {
						setting.setDesc("Opens Google sign-in in your browser. If the automatic sign-in doesn't come back, use \"Manual sign-in\".");
						setting.addButton((b) =>
							b
								.setButtonText("Connect")
								.setCta()
								.onClick(() => void p.connect().then(() => this.update())),
						);
						setting.addButton((b) => b.setButtonText("Manual sign-in").onClick(() => p.connectManually(() => this.update())));
					} else {
						setting.setDesc("Sign in with Google in your browser, then paste the resulting address back here.");
						setting.addButton((b) =>
							b
								.setButtonText("Connect")
								.setCta()
								.onClick(() => p.connectManually(() => this.update())),
						);
					}
				},
			},
		];
	}

	private syncItems(): SettingGroupItem[] {
		const p = this.plugin;
		return [
			{
				name: "Data file location",
				desc: "Folder and file name of the note holding Task Gift's settings, sync state, repeat rules and Google sign-in. It lives in the vault so all your devices share it. It contains your client secret and tokens, so don't publish it.",
				render: (setting) => {
					const currentPath = p.dataFilePath();
					const slash = currentPath.lastIndexOf("/");
					let pendingFolder = slash === -1 ? "/" : currentPath.slice(0, slash);
					let pendingName = slash === -1 ? currentPath : currentPath.slice(slash + 1);
					const folders = this.app.vault
						.getAllLoadedFiles()
						.filter((f): f is TFolder => f instanceof TFolder)
						.map((f) => f.path)
						.sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
					if (!folders.includes(pendingFolder)) folders.push(pendingFolder);
					setting
						.addDropdown((d) => {
							for (const f of folders) d.addOption(f, f === "/" ? "/ (vault root)" : f);
							d.setValue(pendingFolder).onChange((v) => (pendingFolder = v));
						})
						.addText((t) =>
							t
								.setPlaceholder("Task Gift Data.md")
								.setValue(pendingName)
								.onChange((v) => (pendingName = v)),
						)
						.addButton((b) =>
							b
								.setButtonText("Apply")
								.setCta()
								.onClick(() => {
									const name = pendingName.trim().replace(/[\\/]/g, "") || "Task Gift Data.md";
									const path = pendingFolder === "/" ? name : `${pendingFolder}/${name}`;
									void p.changeDataFilePath(path).then((ok) => ok && this.update());
								}),
						);
				},
			},
			{
				name: "Sync interval (minutes)",
				desc: "Also syncs on startup and shortly after local edits.",
				control: {
					type: "number",
					key: "syncIntervalMinutes",
					min: 1,
					step: 1,
					validate: (v) => (Number.isFinite(v) && v >= 1 ? undefined : "Enter at least 1 minute."),
				},
			},
			{
				name: "Keep completed tasks",
				desc: "Completed tasks older than this are only kept in Google, not locally.",
				control: {
					type: "dropdown",
					key: "keepCompletedDays",
					options: Object.fromEntries(
						KEEP_COMPLETED_OPTIONS.map((n) => [
							String(n),
							n === KEEP_FOREVER ? "Forever (no limit)" : n === 0 ? "Never" : n === 1 ? "1 day" : `${n} days`,
						]),
					),
				},
			},
			{
				name: "Download all completed tasks",
				desc: "Sets \"Keep completed tasks\" to Forever and runs a full sync that downloads every completed task you have in Google Tasks, however old.",
				render: (setting) => {
					setting.addButton((b) => b.setButtonText("Download all").onClick(() => void p.syncAllCompleted().then(() => this.update())));
				},
			},
			{
				name: "Sync now",
				desc: "Syncs right away instead of waiting for the next interval.",
				render: (setting) => {
					setting.addButton((b) => b.setButtonText("Sync now").onClick(() => void p.syncNow()));
				},
			},
		];
	}

	// ----------------------------------------------------------- modes

	private modesList(): SettingDefinitionItem {
		const p = this.plugin;
		const s = p.settings;
		return {
			type: "list",
			heading: "Modes",
			// At least one mode must exist, so the last one can't be deleted.
			onDelete:
				s.modes.length > 1
					? (index) => {
							const [removed] = s.modes.splice(index, 1);
							if (removed && removed.id === s.activeModeId) s.activeModeId = s.modes[0].id;
							void p.saveSettings().then(() => this.update());
						}
					: undefined,
			onReorder: (from, to) => {
				const [moved] = s.modes.splice(from, 1);
				s.modes.splice(to, 0, moved);
				void p.saveSettings().then(() => this.update());
			},
			addItem: {
				name: "Add mode",
				action: () => {
					s.modes.push(newMode(this.uniqueModeName("New mode")));
					void p.saveSettings().then(() => this.update());
				},
			},
			items: s.modes.map((mode) => ({
				type: "page" as const,
				name: mode.name,
				desc: this.describeMode(mode),
				displayValue: () => (mode.id === p.settings.activeModeId ? "Active" : ""),
				items: this.modeItems(mode),
			})),
		};
	}

	private describeMode(mode: TaskMode): string {
		const parts = [describeFilter(mode.filter)];
		if (mode.excludeKeywords.length) parts.push(`${mode.excludeKeywords.length} excluded word(s)`);
		if (mode.backgrounds.length) parts.push(`${mode.backgrounds.length} background(s)`);
		return parts.join(" · ");
	}

	private uniqueModeName(base: string): string {
		const names = new Set(this.plugin.settings.modes.map((m) => m.name));
		if (!names.has(base)) return base;
		let n = 2;
		while (names.has(`${base} ${n}`)) n++;
		return `${base} ${n}`;
	}

	private modeItems(mode: TaskMode): SettingDefinitionItem[] {
		const p = this.plugin;
		return [
			{
				type: "group",
				items: [
					{
						name: "Name",
						render: (setting) => {
							setting.addText((t) => {
								t.setValue(mode.name).onChange((v) => {
									this.setModeValue(mode, "name", v);
									void p.saveSettings();
								});
								// Refresh the modes list once, when done typing.
								t.inputEl.addEventListener("blur", () => this.update());
							});
						},
					},
					{
						name: "Active mode",
						desc: "Only one mode is active at a time. Switch quickly with the mode button in the Task Gift header.",
						render: (setting) => {
							const active = mode.id === p.settings.activeModeId;
							setting.addButton((b) => {
								b.setButtonText(active ? "Active" : "Make active").setDisabled(active);
								if (!active) b.setCta();
								b.onClick(() => void p.setActiveMode(mode.id).then(() => this.update()));
							});
						},
					},
					{
						name: "Use on the board too",
						desc: "Off: this mode only decides which tasks gifts are drawn from, and the board shows every task. On: the board shows only this mode's dates and lists.",
						control: { type: "toggle", key: modeKey(mode, "applyToBoard") },
					},
				],
			},
			{ type: "group", heading: "Dates", items: this.filterItems(mode) },
			{
				type: "group",
				heading: "Excluded words",
				items: [
					{
						name: "Exclude by words in description",
						desc: "One word or phrase per line (or comma-separated). Tasks whose description contains any of them are never drawn from a gift in this mode. Case-insensitive.",
						control: { type: "textarea", key: modeKey(mode, "excludeKeywords"), rows: 4, placeholder: "XYZ\nsomeday" },
					},
				],
			},
			{
				type: "list",
				heading: "Task lists",
				emptyState: "Lists appear here after the first sync.",
				items: p.store.lists().map((l) => ({ name: l.title, control: { type: "toggle" as const, key: modeKey(mode, `list:${l.id}`) } })),
			},
			...this.backgroundItems(mode),
		];
	}

	private filterItems(mode: TaskMode): SettingGroupItem[] {
		const p = this.plugin;
		const filter = () => mode.filter;
		return [
			{
				name: "Date ranges",
				desc: "Which due dates gifts are drawn from in this mode. Select one or more ranges; they are combined.",
				render: (setting) => {
					setting.settingEl.addClass("tg-filter-setting");
					setting.descEl.querySelectorAll(".tg-filter-settings").forEach((el) => el.remove());
					const wrap = setting.descEl.createDiv({ cls: "tg-filter-settings" });
					const chips = wrap.createDiv({ cls: "tg-filter-chips" });
					const save = () => {
						void p.saveSettings().then(() => this.update());
					};
					for (const preset of PRESET_ORDER) {
						const chip = chips.createEl("button", { cls: "tg-chip tg-chip-wide", text: PRESET_LABELS[preset] });
						chip.toggleClass("is-active", filter().presets.includes(preset));
						chip.addEventListener("click", () => {
							const f = filter();
							if (preset === "all") f.presets = ["all"];
							else {
								const set = new Set(f.presets.filter((x) => x !== "all"));
								if (set.has(preset)) set.delete(preset);
								else set.add(preset);
								f.presets = set.size ? [...set] : ["all"];
							}
							save();
						});
					}
					const combos = wrap.createDiv({ cls: "tg-filter-combos" });
					combos.createSpan({ text: "Quick picks: " });
					for (const c of QUICK_COMBOS) {
						combos.createEl("button", { cls: "tg-link-btn", text: c.label }).addEventListener("click", () => {
							filter().presets = [...c.presets];
							save();
						});
					}
				},
			},
			{
				name: "Custom range: days ago",
				visible: () => filter().presets.includes("custom"),
				control: { type: "number", key: modeKey(mode, "filter.customFrom"), min: 0, step: 1 },
			},
			{
				name: "Custom range: days ahead",
				visible: () => filter().presets.includes("custom"),
				control: { type: "number", key: modeKey(mode, "filter.customTo"), min: 0, step: 1 },
			},
			{ name: "Include overdue", control: { type: "toggle", key: modeKey(mode, "filter.includeOverdue") } },
			{ name: "Include tasks without a due date", control: { type: "toggle", key: modeKey(mode, "filter.includeNoDate") } },
		];
	}

	private backgroundItems(mode: TaskMode): SettingDefinitionItem[] {
		const p = this.plugin;
		const has = () => mode.backgrounds.length > 0;
		return [
			{
				type: "list",
				heading: "Backgrounds",
				emptyState: "No backgrounds yet. Add as many images, GIFs or videos (mp4) as you like for this mode; imported files are copied into your attachments folder.",
				onDelete: (index) => {
					const removed = mode.backgrounds.splice(index, 1)[0];
					if (mode.backgroundPick === removed) mode.backgroundPick = "random";
					void p.saveSettings().then(() => this.update());
				},
				addItem: {
					name: "Add images or videos from this device",
					action: () =>
						this.importFiles(BACKGROUND_EXTENSIONS, true, (paths) => {
							for (const path of paths) if (!mode.backgrounds.includes(path)) mode.backgrounds.push(path);
						}),
				},
				items: mode.backgrounds.map((path) => ({
					name: fileName(path),
					desc: path,
					render: (setting) => {
						// Rows are reused across re-renders: drop the thumbnail added last time before adding a new one.
						setting.settingEl.querySelectorAll(".tg-bg-thumb").forEach((el) => el.remove());
						const file = this.app.vault.getAbstractFileByPath(path);
						if (file instanceof TFile) {
							const src = this.app.vault.getResourcePath(file);
							const thumb = isVideo(path)
								? createEl("video", { cls: "tg-bg-thumb", attr: { src, muted: "", preload: "metadata", playsinline: "" } })
								: createEl("img", { cls: "tg-bg-thumb", attr: { src, alt: "" } });
							setting.settingEl.prepend(thumb);
						} else {
							setting.setDesc(`${path} (missing)`);
						}
					},
				})),
			},
			{
				type: "group",
				items: [
					{
						name: "Add an image or video already in the vault",
						render: (setting) => {
							setting.addDropdown((d) => {
								const files = this.app.vault
									.getFiles()
									.filter((f) => isBackgroundFile(f.path) && !mode.backgrounds.includes(f.path))
									.map((f) => f.path)
									.sort();
								d.addOption("", files.length ? "Choose a file…" : "No other images or videos in the vault");
								for (const f of files) d.addOption(f, f);
								d.onChange((v) => {
									if (!v) return;
									mode.backgrounds.push(v);
									void p.saveSettings().then(() => this.update());
								});
							});
						},
					},
					{
						name: "Which background to show",
						visible: has,
						render: (setting) => {
							setting.addDropdown((d) => {
								d.addOption("random", "A random one for every gift");
								for (const path of mode.backgrounds) d.addOption(path, `Always: ${fileName(path)}`);
								d.setValue(mode.backgrounds.includes(mode.backgroundPick) ? mode.backgroundPick : "random");
								d.onChange((v) => void this.setControlValue(modeKey(mode, "backgroundPick"), v));
							});
						},
					},
					{
						name: "Fade the background",
						desc: "Blends the image or video into your theme so the gift and cards stay readable.",
						visible: has,
						control: { type: "slider", key: modeKey(mode, "backgroundDim"), min: 0, max: 90, step: 5, displayFormat: (v) => `${v}%` },
					},
				],
			},
		];
	}

	// ----------------------------------------------------------- view & sound

	private viewItems(): SettingGroupItem[] {
		const groupingOptions: Record<Grouping, string> = { list: "By task list", date: "By due date", status: "By status" };
		return [
			{
				name: "Tasks per gift",
				desc: "How many tasks are drawn when you open a gift.",
				control: { type: "slider", key: "tasksPerGift", min: 1, max: 5, step: 1 },
			},
			{ name: "Show \"Gifts opened today\" counter", control: { type: "toggle", key: "showGiftCounter" } },
			{
				name: "Animations",
				desc: "Gift opening animations. With reduced motion enabled in your OS, a simple fade is used.",
				control: { type: "toggle", key: "animations" },
			},
			{ name: "Board columns", control: { type: "dropdown", key: "grouping", options: groupingOptions } },
			{ name: "Show completed tasks on the board", control: { type: "toggle", key: "showCompleted" } },
			{ name: "Week starts on", control: { type: "dropdown", key: "weekStart", options: { "0": "Sunday", "1": "Monday" } } },
		];
	}

	private soundItems(): SettingGroupItem[] {
		const p = this.plugin;
		const on = () => p.settings.giftSoundEnabled;
		const options = Object.fromEntries((Object.keys(SOUND_LABELS) as GiftSound[]).map((k) => [k, SOUND_LABELS[k]]));
		return [
			{
				name: "Play a sound when opening a gift",
				control: { type: "toggle", key: "giftSoundEnabled" },
			},
			{
				name: "Sound",
				desc: "Three built-in sounds, a random one each time, or your own audio file.",
				visible: on,
				render: (setting) => {
					setting
						.addDropdown((d) =>
							d
								.addOptions(options)
								.setValue(p.settings.giftSound)
								.onChange((v) => void this.setControlValue("giftSound", v)),
						)
						.addExtraButton((b) =>
							b
								.setIcon("play")
								.setTooltip("Preview")
								.onClick(() => playGiftSound(this.app, p.settings, true)),
						);
				},
			},
			this.audioFileItem(
				"Audio file",
				"An mp3 (or wav, ogg, m4a) from your vault. \"Import…\" copies one from this device into your attachments folder.",
				() => on() && p.settings.giftSound === "custom",
				(st) => st.giftSoundFile,
				(st, path) => {
					st.giftSoundFile = path;
					st.giftSound = "custom";
				},
			),
			{
				name: "Volume",
				desc: "Gift sound and victory music.",
				control: { type: "slider", key: "giftSoundVolume", min: 0, max: 100, step: 5, displayFormat: (v) => `${v}%` },
			},
		];
	}

	private victoryItems(): SettingGroupItem[] {
		const p = this.plugin;
		return [
			{
				name: "Victory animation",
				desc: "A small celebration when every task of a gift is done.",
				control: { type: "toggle", key: "victoryAnimation" },
			},
			{
				name: "Victory music",
				desc: "Plays your own mp3 when every task of a gift is done.",
				render: (setting) => {
					setting
						.addToggle((t) => t.setValue(p.settings.victorySoundEnabled).onChange((v) => void this.setControlValue("victorySoundEnabled", v)))
						.addExtraButton((b) =>
							b
								.setIcon("play")
								.setTooltip("Preview")
								.onClick(() => playVictorySound(this.app, p.settings, true)),
						);
				},
			},
			this.audioFileItem(
				"Victory music file",
				"An mp3 (or wav, ogg, m4a) from your vault. \"Import…\" copies one from this device into your attachments folder.",
				() => p.settings.victorySoundEnabled,
				(st) => st.victorySoundFile,
				(st, path) => (st.victorySoundFile = path),
			),
		];
	}

	private musicItems(): SettingGroupItem[] {
		const p = this.plugin;
		const on = () => p.settings.giftMusicEnabled;
		return [
			{
				name: "Play music in gift mode",
				desc: "Your own melody loops while the gift view is on screen. The music button in the gift view turns it on and off.",
				control: { type: "toggle", key: "giftMusicEnabled" },
			},
			this.audioFileItem(
				"Music file",
				"An mp3 (or wav, ogg, m4a) from your vault. \"Import…\" copies one from this device into your attachments folder.",
				on,
				(st) => st.giftMusicFile,
				(st, path) => (st.giftMusicFile = path),
			),
			{
				name: "Music volume",
				visible: on,
				control: { type: "slider", key: "giftMusicVolume", min: 0, max: 100, step: 5, displayFormat: (v) => `${v}%` },
			},
			{
				name: "Sound of video backgrounds",
				desc: "Plays the sound track of an mp4 background. Also switchable with the speaker button in the gift view.",
				control: { type: "toggle", key: "giftVideoSound" },
			},
		];
	}

	/** A row to pick an audio file from the vault, or import one from this device. */
	private audioFileItem(
		name: string,
		desc: string,
		visible: () => boolean,
		get: (s: TaskGiftSettings) => string,
		set: (s: TaskGiftSettings, path: string) => void,
	): SettingGroupItem {
		const p = this.plugin;
		return {
			name,
			desc,
			visible,
			render: (setting) => {
				setting
					.addDropdown((d) => {
						const files = this.app.vault
							.getFiles()
							.filter((f) => AUDIO_EXTENSIONS.includes(f.extension.toLowerCase()))
							.map((f) => f.path)
							.sort();
						const current = get(p.settings);
						if (current && !files.includes(current)) files.unshift(current);
						d.addOption("", files.length ? "Choose a file…" : "No audio files in the vault");
						for (const f of files) d.addOption(f, f);
						d.setValue(current).onChange((v) => {
							set(p.settings, v);
							void p.saveSettings();
						});
					})
					.addButton((b) => b.setButtonText("Import…").onClick(() => this.importFiles(AUDIO_EXTENSIONS, false, ([path]) => set(p.settings, path))));
			},
		};
	}

	// ----------------------------------------------------------- import

	/**
	 * Opens the system file picker (computer or phone), copies the chosen files into the vault's
	 * attachments folder and hands their vault paths to `apply`.
	 */
	private importFiles(extensions: string[], multiple: boolean, apply: (paths: string[]) => void): void {
		// The input has to be in the document: a detached one may never open or report the selection (notably on mobile).
		const input = activeDocument.body.createEl("input", {
			cls: "tg-hidden-file-input",
			attr: { type: "file", accept: extensions.map((e) => `.${e}`).join(",") },
		});
		input.multiple = multiple;
		input.addEventListener("change", () => {
			const files = Array.from(input.files ?? []);
			input.remove();
			if (files.length) void this.saveImportedFiles(files, apply);
		});
		input.addEventListener("cancel", () => input.remove());
		input.click();
	}

	private async saveImportedFiles(files: File[], apply: (paths: string[]) => void): Promise<void> {
		const paths: string[] = [];
		for (const file of files) {
			try {
				// Respects Obsidian's "Default location for new attachments" setting.
				const path = await this.app.fileManager.getAvailablePathForAttachment(file.name);
				await this.app.vault.createBinary(path, await file.arrayBuffer());
				paths.push(path);
			} catch (e) {
				new Notice(`Could not import "${file.name}": ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (!paths.length) return;
		apply(paths);
		await this.plugin.saveSettings();
		new Notice(paths.length === 1 ? `Imported: ${paths[0]}` : `Imported ${paths.length} files`);
		this.update();
	}
}
