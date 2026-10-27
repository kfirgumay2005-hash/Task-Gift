import { App, Menu, Platform, PluginSettingTab, SettingDefinitionItem, SettingGroupItem, TFolder } from "obsidian";
import type TaskGiftPlugin from "./main";
import type { Grouping, StickyCommand, TaskColorScope } from "./types";
import { DEFAULT_STICKY_COMMANDS, KEEP_COMPLETED_OPTIONS, KEEP_FOREVER, MIN_SYNC_SECONDS, newStickyCommandId } from "./defaults";
import { isDailyNotesEnabled, todayNotePath } from "./dailyNote";
import { SETTINGS_FILE_NAME } from "./storage/dataFile";
import { CommandSuggestModal } from "./modals/CommandSuggestModal";
import { commandRegistry, isEditorOnly, stickyEditFor } from "./stickyCommands";

export class TaskGiftSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: TaskGiftPlugin) {
		super(app, plugin);
	}

	// ----------------------------------------------------------- storage

	/** Settings live in the vault settings note, not data.json, so controls read and write here. */
	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
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
		switch (key) {
			case "clientId":
			case "clientSecret":
				s[key] = String(value).trim();
				break;
			case "syncIntervalSeconds":
				s.syncIntervalSeconds = Math.max(MIN_SYNC_SECONDS, Math.round(Number(value)) || 300);
				s.syncIntervalMinutes = Math.max(1, Math.round(s.syncIntervalSeconds / 60));
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
		await p.saveSettings();
	}

	// ----------------------------------------------------------- definitions

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ type: "group", heading: "Google account", items: this.accountItems() },
			{ type: "group", heading: "Sync", items: this.syncItems() },
			{ type: "group", heading: "Modes", items: this.modesItems() },
			{ type: "group", heading: "View", items: this.viewItems() },
			{
				type: "list",
				heading: "Sticky note commands",
				items: this.stickyCommandItems(),
				emptyState: "No commands. Add one with +, or restore the default ones below.",
				addItem: { name: "Add command", action: (el) => this.addStickyCommand(el) },
				onDelete: (index) => this.changeStickyCommands((list) => list.splice(index, 1), true),
				onReorder: (from, to) => this.changeStickyCommands((list) => list.splice(to, 0, ...list.splice(from, 1)), true),
			},
			{ type: "group", items: this.stickyCommandsFooter() },
			{ type: "group", heading: "Daily note", items: this.dailyNoteItems() },
		];
	}

	/** Modes are edited on the Modes page of the Task Gift view, which shows changes from other devices right away. */
	private modesItems(): SettingGroupItem[] {
		const p = this.plugin;
		return [
			{
				name: "Edit modes",
				desc: "Modes (dates, lists, excluded words, backgrounds, gift sound, victory and music) are edited on the Modes page of gift mode. Changes made on another device appear there as soon as they sync.",
				render: (setting) => {
					setting.addButton((b) =>
						b
							.setButtonText("Open modes")
							.setCta()
							.onClick(() => void p.openModes()),
					);
				},
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
				desc: `Folder and file name of the note holding Task Gift's sync state, repeat rules and Google sign-in. The settings are kept in "${SETTINGS_FILE_NAME}" in the same folder, which only changes when you change a setting, so other devices pick up new settings as soon as the note syncs. Both live in the vault so all your devices share them. They contain your client secret and tokens, so don't publish them.`,
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
				name: "Sync interval (seconds)",
				desc: `Also syncs on startup and shortly after local edits. At least ${MIN_SYNC_SECONDS} seconds: every device uses the same Google quota (about 50,000 requests a day).`,
				control: {
					type: "number",
					key: "syncIntervalSeconds",
					min: MIN_SYNC_SECONDS,
					step: 1,
					validate: (v) => (Number.isFinite(v) && v >= MIN_SYNC_SECONDS ? undefined : `Enter at least ${MIN_SYNC_SECONDS} seconds.`),
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

	// ----------------------------------------------------------- view

	private viewItems(): SettingGroupItem[] {
		const groupingOptions: Record<Grouping, string> = { list: "By task list", date: "By due date", status: "By status" };
		const colorScopeOptions: Record<TaskColorScope, string> = {
			both: "Board and calendar",
			board: "Board only",
			calendar: "Calendar only",
			off: "Off",
		};
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
			{
				name: "Board columns",
				desc: "Every column has an eye button that folds it, hiding its tasks. Folding the Completed column also hides completed tasks in the calendar.",
				control: { type: "dropdown", key: "grouping", options: groupingOptions },
			},
			{ name: "Week starts on", control: { type: "dropdown", key: "weekStart", options: { "0": "Sunday", "1": "Monday" } } },
			{
				name: "Show task colors",
				desc: "Each task can get its own color in the task window. Choose where the colors are shown, or turn them off (the colors are kept).",
				control: { type: "dropdown", key: "taskColorScope", options: colorScopeOptions },
			},
		];
	}

	// ----------------------------------------------------------- sticky notes

	/**
	 * Changes the sticky-note commands. Always works on the current settings object: settings arriving from another
	 * device replace it, so nothing here may hold on to an older one.
	 */
	private changeStickyCommands(change: (list: StickyCommand[]) => void, redraw: boolean): void {
		change(this.plugin.settings.stickyCommands);
		void this.plugin.saveSettings();
		if (redraw) this.update();
	}

	/** "+": an Obsidian command (picked like in the command palette) or text markers of your own. */
	private addStickyCommand(el: HTMLElement): void {
		const add = (cmd: Omit<StickyCommand, "id">) => this.changeStickyCommands((list) => list.push({ id: newStickyCommandId(), ...cmd }), true);
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle("Obsidian command…")
				.setIcon("terminal-square")
				.onClick(() => new CommandSuggestModal(this.app, (c) => add({ name: c.name, before: "", after: "", commandId: c.id })).open()),
		);
		menu.addItem((i) =>
			i
				.setTitle("Text markers")
				.setIcon("brackets")
				.onClick(() => add({ name: "", before: "", after: "" })),
		);
		const r = el.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom });
	}

	/** One row per command of a sticky note's menu: its name, and either its Obsidian command or its markers. */
	private stickyCommandItems(): SettingGroupItem[] {
		const registry = commandRegistry(this.app);
		return this.plugin.settings.stickyCommands.map((cmd): SettingGroupItem => {
			const commandId = cmd.commandId;
			let desc = "Name, then the text put before and after the selected text.";
			if (commandId) {
				const found = registry.commands[commandId];
				const what = stickyEditFor(commandId)
					? "formats the sticky note's text"
					: isEditorOnly(commandId)
						? "only works in a note's editor, not in a sticky note"
						: "runs in Obsidian";
				desc = found ? `Obsidian command "${found.name}": ${what}.` : `Obsidian command ${commandId}: not available now (is its plugin turned off?).`;
			}
			return {
				name: cmd.name || "Untitled command",
				desc,
				render: (setting) => {
					const id = cmd.id;
					const edit = (fields: Partial<StickyCommand>) =>
						this.changeStickyCommands((list) => {
							const c = list.find((x) => x.id === id);
							if (c) Object.assign(c, fields);
						}, false);
					setting.addText((t) =>
						t
							.setPlaceholder("Name")
							.setValue(cmd.name)
							.onChange((v) => {
								setting.setName(v || "Untitled command");
								edit({ name: v });
							}),
					);
					if (commandId) return;
					setting
						.addText((t) => t.setPlaceholder("Before, e.g. **").setValue(cmd.before).onChange((v) => edit({ before: v })))
						.addText((t) => t.setPlaceholder("After, e.g. **").setValue(cmd.after).onChange((v) => edit({ after: v })));
				},
			};
		});
	}

	private stickyCommandsFooter(): SettingGroupItem[] {
		return [
			{
				name: "About sticky note commands",
				desc: "They show as buttons in the top bar of every sticky note on the board, next to its color button. Add any Obsidian command with +: formatting commands (bold, italic, highlight, lists, headings, links…) format the sticky note's text, other commands run as from the command palette. Or add text markers of your own: they wrap the selected text, or remove themselves when it is already wrapped. Notes are Markdown, so e.g. ==text== is highlighted and <u>text</u> is underlined. Drag a row to change their order.",
				render: (setting) => {
					setting.addButton((b) =>
						b.setButtonText("Restore default commands").onClick(() =>
							this.changeStickyCommands((list) => {
								// Adds the default ones that are missing, keeps the user's own.
								for (const d of DEFAULT_STICKY_COMMANDS) if (!list.some((c) => c.id === d.id)) list.push({ ...d });
							}, true),
						),
					);
				},
			},
		];
	}

	private dailyNoteItems(): SettingGroupItem[] {
		const p = this.plugin;
		return [
			{
				name: "Insert tasks into the daily note",
				desc: "Once a day, when today's daily note is created or opened, adds today's open tasks below its content as a checklist, with each task's description under it. Nothing already in the note is changed. You can also do it any time with the command \"Insert today's tasks into daily note\".",
				control: { type: "toggle", key: "dailyNoteEnabled" },
			},
			{
				name: "Heading",
				desc: "Written above the tasks, e.g. \"## Tasks\". Leave empty for none. If the note already has this heading, the tasks aren't added again.",
				control: { type: "text", key: "dailyNoteHeading", placeholder: "## Tasks" },
			},
			{
				name: "Include overdue tasks",
				control: { type: "toggle", key: "dailyNoteIncludeOverdue" },
			},
			{
				name: "Today's daily note",
				searchable: false,
				render: (setting) => {
					setting.setDesc(
						`${todayNotePath(this.app)}${isDailyNotesEnabled(this.app) ? "" : " — the core Daily notes plugin is off, so its default name is used"}. Folder and name format come from the Daily notes plugin settings.`,
					);
					setting.addButton((b) => b.setButtonText("Insert now").onClick(() => void p.insertIntoDailyNote()));
				},
			},
		];
	}
}
