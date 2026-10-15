import { App, Platform, PluginSettingTab, Setting, TFolder } from "obsidian";
import type TaskGiftPlugin from "./main";
import type { DateFilter, DatePreset, Grouping } from "./types";
import { PRESET_LABELS, QUICK_COMBOS } from "./filters/dates";
import { KEEP_COMPLETED_OPTIONS } from "./defaults";

const PRESET_ORDER: DatePreset[] = ["all", "overdue", "yesterday", "today", "tomorrow", "thisWeek", "next7", "noDate", "custom"];

export class TaskGiftSettingTab extends PluginSettingTab {
	private unsubscribe: (() => void) | null = null;

	constructor(app: App, private readonly plugin: TaskGiftPlugin) {
		super(app, plugin);
	}

	hide(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	display(): void {
		const { containerEl } = this;
		const p = this.plugin;
		const s = p.settings;
		containerEl.empty();
		containerEl.addClass("tg-settings");

		// ----------------------------------------------------------- Google
		new Setting(containerEl).setName("Google account").setHeading();

		const statusSetting = new Setting(containerEl).setName("Connection status");
		const renderStatus = () => {
			const st = p.engine.status;
			statusSetting.descEl.empty();
			const line = statusSetting.descEl.createDiv({ cls: "tg-status-line" });
			line.createSpan({ cls: `tg-status-dot is-${p.isConnected() ? st.state : "disconnected"}` });
			if (p.isConnected()) {
				line.createSpan({ text: `Connected${p.auth?.email ? ` as ${p.auth.email}` : ""} · ${st.message}` });
				if (st.lastSync) statusSetting.descEl.createDiv({ text: `Last sync: ${new Date(st.lastSync).toLocaleString()}` });
				if (st.pending) statusSetting.descEl.createDiv({ text: `${st.pending} local change(s) waiting to sync` });
			} else {
				line.createSpan({ text: "Not connected" });
			}
		};
		renderStatus();
		this.unsubscribe?.();
		this.unsubscribe = p.onStatus(() => renderStatus());

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("OAuth client ID of your own Google Cloud project (application type: Desktop app).")
			.addText((t) =>
				t
					.setPlaceholder("xxxxxxxx.apps.googleusercontent.com")
					.setValue(s.clientId)
					.onChange(async (v) => {
						s.clientId = v.trim();
						await p.persist();
					}),
			);

		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("Stored in the Task Gift data file (see Sync → Data file location).")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("GOCSPX-…")
					.setValue(s.clientSecret)
					.onChange(async (v) => {
						s.clientSecret = v.trim();
						await p.persist();
					});
			});

		const connect = new Setting(containerEl).setName(p.isConnected() ? "Disconnect Google account" : "Connect Google account");
		if (p.isConnected()) {
			connect.addButton((b) =>
				b.setButtonText("Disconnect").setWarning().onClick(async () => {
					await p.disconnect();
					this.display();
				}),
			);
		} else if (Platform.isDesktopApp) {
			connect.setDesc("Opens Google sign-in in your browser. If the automatic sign-in doesn't come back, use \"Manual sign-in\".");
			connect.addButton((b) =>
				b
					.setButtonText("Connect")
					.setCta()
					.onClick(async () => {
						await p.connect();
						this.display();
					}),
			);
			connect.addButton((b) => b.setButtonText("Manual sign-in").onClick(() => p.connectManually(() => this.display())));
		} else {
			connect.setDesc("Sign in with Google in your browser, then paste the resulting address back here.");
			connect.addButton((b) =>
				b
					.setButtonText("Connect")
					.setCta()
					.onClick(() => p.connectManually(() => this.display())),
			);
		}

		// ----------------------------------------------------------- Sync
		new Setting(containerEl).setName("Sync").setHeading();

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
		new Setting(containerEl)
			.setName("Data file location")
			.setDesc(
				"Folder and file name of the note holding Task Gift's settings, sync state, repeat rules and Google sign-in. It lives in the vault so all your devices share it. It contains your client secret and tokens, so don't publish it.",
			)
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
					.onClick(async () => {
						const name = pendingName.trim().replace(/[\\/]/g, "") || "Task Gift Data.md";
						const path = pendingFolder === "/" ? name : `${pendingFolder}/${name}`;
						if (await p.changeDataFilePath(path)) this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Mirror tasks to a note")
			.setDesc("Keep a markdown note with all tasks that syncs both ways.")
			.addToggle((t) =>
				t.setValue(s.mirrorToNote).onChange(async (v) => {
					s.mirrorToNote = v;
					await p.persist();
					if (v) await p.mirror.render();
				}),
			);

		new Setting(containerEl)
			.setName("Sync note path")
			.setDesc("Vault path of the mirrored note.")
			.addText((t) =>
				t
					.setPlaceholder("Tasks/Google Tasks.md")
					.setValue(s.notePath)
					.onChange(async (v) => {
						let path = v.trim() || "Tasks/Google Tasks.md";
						if (!path.endsWith(".md")) path += ".md";
						s.notePath = path;
						p.store.data.renderedIds = [];
						await p.persist();
					}),
			);

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc("Also syncs on startup and shortly after local edits.")
			.addText((t) => {
				t.inputEl.type = "number";
				t.inputEl.min = "1";
				t.setValue(String(s.syncIntervalMinutes)).onChange(async (v) => {
					const n = parseInt(v);
					if (!Number.isFinite(n) || n < 1) return;
					s.syncIntervalMinutes = n;
					await p.persist();
					p.restartInterval();
				});
			});

		new Setting(containerEl)
			.setName("Keep completed tasks")
			.setDesc("Completed tasks older than this are only kept in Google, not locally.")
			.addDropdown((d) => {
				for (const n of KEEP_COMPLETED_OPTIONS) d.addOption(String(n), n === 0 ? "Never" : n === 1 ? "1 day" : `${n} days`);
				d.setValue(String(s.keepCompletedDays)).onChange(async (v) => {
					s.keepCompletedDays = parseInt(v);
					await p.persist();
				});
			});

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Syncs right away instead of waiting for the next interval.")
			.addButton((b) => b.setButtonText("Sync now").onClick(() => void p.syncNow()));

		// ----------------------------------------------------------- View
		new Setting(containerEl).setName("View").setHeading();

		new Setting(containerEl)
			.setName("Tasks per gift")
			.setDesc("How many tasks are drawn when you open a gift.")
			.addSlider((sl) =>
				sl
					.setLimits(1, 5, 1)
					.setValue(s.tasksPerGift)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.tasksPerGift = v;
						await p.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Show \"Gifts opened today\" counter").addToggle((t) =>
			t.setValue(s.showGiftCounter).onChange(async (v) => {
				s.showGiftCounter = v;
				await p.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName("Animations")
			.setDesc("Gift opening animations. With reduced motion enabled in your OS, a simple fade is used.")
			.addToggle((t) =>
				t.setValue(s.animations).onChange(async (v) => {
					s.animations = v;
					await p.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Board columns").addDropdown((d) =>
			d
				.addOptions({ list: "By task list", date: "By due date", status: "By status" })
				.setValue(s.grouping)
				.onChange(async (v) => {
					s.grouping = v as Grouping;
					await p.saveSettings();
				}),
		);

		new Setting(containerEl).setName("Show completed tasks on the board").addToggle((t) =>
			t.setValue(s.showCompleted).onChange(async (v) => {
				s.showCompleted = v;
				await p.saveSettings();
			}),
		);

		new Setting(containerEl).setName("Week starts on").addDropdown((d) =>
			d
				.addOptions({ "0": "Sunday", "1": "Monday" })
				.setValue(String(s.weekStart))
				.onChange(async (v) => {
					s.weekStart = v === "1" ? 1 : 0;
					await p.saveSettings();
				}),
		);

		// ----------------------------------------------------------- Filters
		new Setting(containerEl).setName("Date filter").setHeading();
		this.renderFilter(containerEl, s.boardFilter, s.separateGiftFilter ? "Board filter" : "Applies to the board and gift mode");

		new Setting(containerEl)
			.setName("Use a different filter for gift mode")
			.addToggle((t) =>
				t.setValue(s.separateGiftFilter).onChange(async (v) => {
					s.separateGiftFilter = v;
					await p.saveSettings();
					this.display();
				}),
			);
		if (s.separateGiftFilter) {
			new Setting(containerEl).setName("Gift mode filter").setHeading();
			this.renderFilter(containerEl, s.giftFilter, "Which tasks can be drawn from a gift");
		}

		// ----------------------------------------------------------- Gift exclusions
		new Setting(containerEl).setName("Gift exclusions").setHeading();
		new Setting(containerEl)
			.setName("Exclude by words in description")
			.setDesc(
				"One word or phrase per line (or comma-separated). Tasks whose description contains any of them still sync and show on the board, but are never drawn from a gift. Case-insensitive.",
			)
			.addTextArea((t) => {
				t.inputEl.rows = 4;
				t.setPlaceholder("XYZ\nsomeday")
					.setValue(s.giftExcludeKeywords.join("\n"))
					.onChange(async (v) => {
						s.giftExcludeKeywords = v
							.split(/[\n,]/)
							.map((x) => x.trim())
							.filter(Boolean);
						await p.saveSettings();
					});
			});

		// ----------------------------------------------------------- Lists
		new Setting(containerEl).setName("Included task lists").setHeading();
		const lists = p.store.lists();
		if (!lists.length) {
			containerEl.createEl("p", { cls: "setting-item-description", text: "Lists appear here after the first sync." });
		}
		for (const l of lists) {
			new Setting(containerEl).setName(l.title).addToggle((t) =>
				t.setValue(s.includedLists === null || s.includedLists.includes(l.id)).onChange(async (v) => {
					const current = new Set(s.includedLists ?? lists.map((x) => x.id));
					if (v) current.add(l.id);
					else current.delete(l.id);
					s.includedLists = lists.every((x) => current.has(x.id)) ? null : [...current];
					await p.saveSettings();
				}),
			);
		}
	}

	private renderFilter(containerEl: HTMLElement, filter: DateFilter, desc: string): void {
		const p = this.plugin;
		const wrap = containerEl.createDiv({ cls: "tg-filter-settings" });
		wrap.createDiv({ cls: "setting-item-description", text: `${desc}. Select one or more ranges; they are combined.` });

		const chips = wrap.createDiv({ cls: "tg-filter-chips" });
		const save = async () => {
			await p.saveSettings();
			this.display();
		};
		for (const preset of PRESET_ORDER) {
			const chip = chips.createEl("button", { cls: "tg-chip tg-chip-wide", text: PRESET_LABELS[preset] });
			chip.toggleClass("is-active", filter.presets.includes(preset));
			chip.addEventListener("click", async () => {
				if (preset === "all") filter.presets = ["all"];
				else {
					const set = new Set(filter.presets.filter((x) => x !== "all"));
					if (set.has(preset)) set.delete(preset);
					else set.add(preset);
					filter.presets = set.size ? [...set] : ["all"];
				}
				await save();
			});
		}

		const combos = wrap.createDiv({ cls: "tg-filter-combos" });
		combos.createSpan({ cls: "setting-item-description", text: "Quick picks: " });
		for (const c of QUICK_COMBOS) {
			combos.createEl("button", { cls: "tg-link-btn", text: c.label }).addEventListener("click", async () => {
				filter.presets = [...c.presets];
				await save();
			});
		}

		if (filter.presets.includes("custom")) {
			new Setting(wrap)
				.setName("Custom range")
				.setDesc("From N days ago to N days ahead.")
				.addText((t) => {
					t.inputEl.type = "number";
					t.inputEl.min = "0";
					t.inputEl.addClass("tg-num");
					t.setValue(String(filter.customFrom)).onChange(async (v) => {
						filter.customFrom = Math.max(0, parseInt(v) || 0);
						await p.saveSettings();
					});
				})
				.addText((t) => {
					t.inputEl.type = "number";
					t.inputEl.min = "0";
					t.inputEl.addClass("tg-num");
					t.setValue(String(filter.customTo)).onChange(async (v) => {
						filter.customTo = Math.max(0, parseInt(v) || 0);
						await p.saveSettings();
					});
				});
		}

		new Setting(wrap).setName("Include overdue").addToggle((t) =>
			t.setValue(filter.includeOverdue).onChange(async (v) => {
				filter.includeOverdue = v;
				await p.saveSettings();
			}),
		);
		new Setting(wrap).setName("Include tasks without a due date").addToggle((t) =>
			t.setValue(filter.includeNoDate).onChange(async (v) => {
				filter.includeNoDate = v;
				await p.saveSettings();
			}),
		);
	}
}
