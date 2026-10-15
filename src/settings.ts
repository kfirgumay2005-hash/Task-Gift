import { App, Notice, Platform, PluginSettingTab, SettingDefinitionItem, SettingGroupItem, TFile, TFolder } from "obsidian";
import type TaskGiftPlugin from "./main";
import type { DateFilter, DatePreset, GiftSound, Grouping } from "./types";
import { PRESET_LABELS, QUICK_COMBOS } from "./filters/dates";
import { KEEP_COMPLETED_OPTIONS, KEEP_FOREVER } from "./defaults";
import { AUDIO_EXTENSIONS, playGiftSound, SOUND_LABELS } from "./audio/sounds";
import { BACKGROUND_EXTENSIONS, isBackgroundFile, isVideo } from "./util/media";

const PRESET_ORDER: DatePreset[] = ["all", "overdue", "yesterday", "today", "tomorrow", "thisWeek", "next7", "noDate", "custom"];

type FilterKey = "boardFilter" | "giftFilter";

const LIST_PREFIX = "list:";

/** Keys whose change alters which settings are shown. */
const STRUCTURAL_KEYS = new Set(["separateGiftFilter", "giftSound", "giftSoundEnabled"]);



export class TaskGiftSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: TaskGiftPlugin) {
		super(app, plugin);
	}

	// ----------------------------------------------------------- storage

	/** Settings live in the vault data note, not data.json, so controls read and write here. */
	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		if (key.startsWith(LIST_PREFIX)) {
			const id = key.slice(LIST_PREFIX.length);
			return s.includedLists === null || s.includedLists.includes(id);
		}
		const [head, sub] = key.split(".") as [string, string | undefined];
		if (sub) return (s[head as FilterKey] as unknown as Record<string, unknown>)[sub];
		switch (key) {
			case "keepCompletedDays":
			case "weekStart":
				return String(s[key]);
			case "giftExcludeKeywords":
				return s.giftExcludeKeywords.join("\n");
			default:
				return (s as unknown as Record<string, unknown>)[key];
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const p = this.plugin;
		const s = p.settings;
		if (key.startsWith(LIST_PREFIX)) {
			const id = key.slice(LIST_PREFIX.length);
			const lists = p.store.lists();
			const current = new Set(s.includedLists ?? lists.map((x) => x.id));
			if (value) current.add(id);
			else current.delete(id);
			s.includedLists = lists.every((x) => current.has(x.id)) ? null : [...current];
		} else if (key.includes(".")) {
			const [head, sub] = key.split(".") as [FilterKey, keyof DateFilter];
			const filter = s[head] as unknown as Record<string, unknown>;
			filter[sub] = typeof value === "number" ? Math.max(0, Math.round(value)) : value;
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
				case "giftExcludeKeywords":
					s.giftExcludeKeywords = String(value)
						.split(/[\n,]/)
						.map((x) => x.trim())
						.filter(Boolean);
					break;
				default:
					(s as unknown as Record<string, unknown>)[key] = value;
			}
		}
		await p.saveSettings();
		if (STRUCTURAL_KEYS.has(key)) this.update();
	}

	// ----------------------------------------------------------- definitions

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		return [
			{ type: "group", heading: "Google account", items: this.accountItems() },
			{ type: "group", heading: "Sync", items: this.syncItems() },
			{ type: "group", heading: "View", items: this.viewItems() },
			{ type: "group", heading: "Gift sounds", items: this.soundItems() },
			...this.backgroundItems(),
			{
				type: "group",
				heading: "Date filter",
				items: this.filterItems("boardFilter", s.separateGiftFilter ? "Board filter" : "Applies to the board and gift mode"),
			},
			{
				type: "group",
				items: [{ name: "Use a different filter for gift mode", control: { type: "toggle", key: "separateGiftFilter" } }],
			},
			{
				type: "group",
				heading: "Gift mode filter",
				visible: () => this.plugin.settings.separateGiftFilter,
				items: this.filterItems("giftFilter", "Which tasks can be drawn from a gift"),
			},
			{
				type: "group",
				heading: "Gift exclusions",
				items: [
					{
						name: "Exclude by words in description",
						desc: "One word or phrase per line (or comma-separated). Tasks whose description contains any of them still sync and show on the board, but are never drawn from a gift. Case-insensitive.",
						control: { type: "textarea", key: "giftExcludeKeywords", rows: 4, placeholder: "XYZ\nsomeday" },
					},
				],
			},
			{
				type: "list",
				heading: "Included task lists",
				emptyState: "Lists appear here after the first sync.",
				items: this.plugin.store.lists().map((l) => ({ name: l.title, control: { type: "toggle" as const, key: `${LIST_PREFIX}${l.id}` } })),
			},
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
			{
				name: "Audio file",
				desc: "An mp3 (or wav, ogg, m4a) from your vault. \"Import…\" copies one from this device into your attachments folder.",
				visible: () => on() && p.settings.giftSound === "custom",
				render: (setting) => {
					setting
						.addDropdown((d) => {
							const files = this.app.vault
								.getFiles()
								.filter((f) => AUDIO_EXTENSIONS.includes(f.extension.toLowerCase()))
								.map((f) => f.path)
								.sort();
							const current = p.settings.giftSoundFile;
							if (current && !files.includes(current)) files.unshift(current);
							d.addOption("", files.length ? "Choose a file…" : "No audio files in the vault");
							for (const f of files) d.addOption(f, f);
							d.setValue(current).onChange((v) => void this.setControlValue("giftSoundFile", v));
						})
						.addButton((b) =>
							b.setButtonText("Import…").onClick(() =>
								this.importFiles(AUDIO_EXTENSIONS, false, ([path]) => {
									p.settings.giftSoundFile = path;
									p.settings.giftSound = "custom";
								}),
							),
						);
				},
			},
			{
				name: "Volume",
				visible: on,
				control: { type: "slider", key: "giftSoundVolume", min: 0, max: 100, step: 5, displayFormat: (v) => `${v}%` },
			},
		];
	}

	private backgroundItems(): SettingDefinitionItem[] {
		const p = this.plugin;
		const s = () => p.settings;
		const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
		const has = () => s().giftBackgrounds.length > 0;
		return [
			{
				type: "list",
				heading: "Gift backgrounds",
				emptyState: "No backgrounds yet. Add as many images, GIFs or videos (mp4) as you like; they are copied into your attachments folder.",
				onDelete: (index) => {
					const removed = s().giftBackgrounds.splice(index, 1)[0];
					if (s().giftBackgroundPick === removed) s().giftBackgroundPick = "random";
					void p.saveSettings().then(() => this.update());
				},
				addItem: {
					name: "Add images or videos from this device",
					action: () =>
						this.importFiles(BACKGROUND_EXTENSIONS, true, (paths) => {
							for (const path of paths) if (!s().giftBackgrounds.includes(path)) s().giftBackgrounds.push(path);
						}),
				},
				items: s().giftBackgrounds.map((path) => ({
					name: name(path),
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
									.filter((f) => isBackgroundFile(f.path) && !s().giftBackgrounds.includes(f.path))
									.map((f) => f.path)
									.sort();
								d.addOption("", files.length ? "Choose a file…" : "No other images or videos in the vault");
								for (const f of files) d.addOption(f, f);
								d.onChange((v) => {
									if (!v) return;
									s().giftBackgrounds.push(v);
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
								for (const path of s().giftBackgrounds) d.addOption(path, `Always: ${name(path)}`);
								d.setValue(s().giftBackgrounds.includes(s().giftBackgroundPick) ? s().giftBackgroundPick : "random");
								d.onChange((v) => void this.setControlValue("giftBackgroundPick", v));
							});
						},
					},
					{
						name: "Fade the background",
						desc: "Blends the image or video into your theme so the gift and cards stay readable.",
						visible: has,
						control: { type: "slider", key: "giftBackgroundDim", min: 0, max: 90, step: 5, displayFormat: (v) => `${v}%` },
					},
				],
			},
		];
	}

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

	private filterItems(key: FilterKey, desc: string): SettingGroupItem[] {
		const p = this.plugin;
		const filter = () => p.settings[key];
		return [
			{
				name: "Date ranges",
				desc: `${desc}. Select one or more ranges; they are combined.`,
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
				control: { type: "number", key: `${key}.customFrom`, min: 0, step: 1 },
			},
			{
				name: "Custom range: days ahead",
				visible: () => filter().presets.includes("custom"),
				control: { type: "number", key: `${key}.customTo`, min: 0, step: 1 },
			},
			{ name: "Include overdue", control: { type: "toggle", key: `${key}.includeOverdue` } },
			{ name: "Include tasks without a due date", control: { type: "toggle", key: `${key}.includeNoDate` } },
		];
	}
}
