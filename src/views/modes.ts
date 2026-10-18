import { Setting, setIcon, TFile } from "obsidian";
import type TaskGiftPlugin from "../main";
import type { DateFilter, DatePreset, GiftSound, TaskGiftSettings, TaskMode } from "../types";
import { describeFilter, PRESET_LABELS, QUICK_COMBOS } from "../filters/dates";
import { activeMode, newMode } from "../modes";
import { AUDIO_EXTENSIONS, playGiftSound, playVictorySound, SOUND_LABELS } from "../audio/sounds";
import { BACKGROUND_EXTENSIONS, isBackgroundFile, isVideo } from "../util/media";
import { importFiles } from "../util/importFiles";
import { ConfirmModal } from "../modals/ConfirmModal";

const PRESET_ORDER: DatePreset[] = ["all", "overdue", "yesterday", "today", "tomorrow", "thisWeek", "next7", "noDate", "custom"];

const AUDIO_DESC = "An mp3 (or wav, ogg, m4a) from your vault. \"Import…\" copies one from this device into your attachments folder.";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The Modes page of the Task Gift view: add, edit, reorder and delete modes.
 * Lives in the view rather than in the settings tab so that changes arriving from another device
 * (through the settings note) show up right away: the view is redrawn whenever the settings change.
 */
export class ModesEditor {
	/** Settings object the page was drawn from. Settings from another device replace the object, which redraws the page. */
	private renderedFor: TaskGiftSettings | null = null;
	private container: HTMLElement | null = null;
	/** Mode shown in the editor; view-local. */
	private selectedId: string | null = null;

	constructor(private readonly plugin: TaskGiftPlugin) {}

	/**
	 * Draws the page, unless it already shows the current settings. Edits made on this page change the settings
	 * in place and don't redraw it, so typing keeps its focus; edits that change which rows are shown redraw explicitly.
	 */
	render(container: HTMLElement, force = false): void {
		const s = this.plugin.settings;
		const existing = container.querySelector<HTMLElement>(".tg-modes-page");
		if (!force && existing && this.container === container && this.renderedFor === s) return;
		const scroll = existing?.scrollTop ?? 0;
		this.container = container;
		this.renderedFor = s;
		container.empty();

		const page = container.createDiv({ cls: "tg-modes-page" });
		const inner = page.createDiv({ cls: "tg-modes-inner" });
		inner.createEl("h2", { cls: "tg-modes-heading", text: "Modes" });
		inner.createDiv({
			cls: "tg-modes-intro",
			text: "Each mode decides which tasks gifts are drawn from, and how gift mode looks and sounds. The board always shows every task. Switch the active mode with the mode button in the header.",
		});

		if (!s.modes.some((m) => m.id === this.selectedId)) this.selectedId = activeMode(s).id;
		const mode = s.modes.find((m) => m.id === this.selectedId) ?? s.modes[0];
		const tabs = inner.createDiv({ cls: "tg-modes-tabs", attr: { role: "tablist" } });
		const nameEls = new Map<string, HTMLElement>();
		for (const m of s.modes) {
			const tab = tabs.createEl("button", { cls: "tg-chip tg-chip-wide tg-modes-tab", attr: { role: "tab", "aria-selected": String(m.id === mode.id) } });
			tab.toggleClass("is-active", m.id === mode.id);
			nameEls.set(m.id, tab.createSpan({ text: m.name, attr: { dir: "auto" } }));
			if (m.id === s.activeModeId) tab.createSpan({ cls: "tg-modes-badge", text: "active" });
			tab.addEventListener("click", () => {
				this.selectedId = m.id;
				this.redraw();
			});
		}
		const add = tabs.createEl("button", { cls: "tg-chip tg-chip-wide tg-modes-add", attr: { "aria-label": "Add mode" } });
		setIcon(add.createSpan({ cls: "tg-modes-add-icon" }), "plus");
		add.createSpan({ text: "New mode" });
		add.addEventListener("click", () => {
			const created = newMode(this.uniqueName("New mode"));
			this.plugin.settings.modes.push(created);
			this.selectedId = created.id;
			this.save(true);
		});

		this.renderMode(inner, mode, nameEls);
		page.scrollTop = scroll;
	}

	private redraw(): void {
		if (this.container) this.render(this.container, true);
	}

	/** Saves the settings (written to the settings note); `redraw` when the change shows or hides rows. */
	private save(redraw = false): void {
		void this.plugin.saveSettings();
		if (redraw) this.redraw();
	}

	/** The mode as it is in the settings now (they are replaced when another device changes them). */
	private live(id: string): TaskMode | null {
		return this.plugin.settings.modes.find((m) => m.id === id) ?? null;
	}

	private uniqueName(base: string): string {
		const names = new Set(this.plugin.settings.modes.map((m) => m.name));
		if (!names.has(base)) return base;
		let n = 2;
		while (names.has(`${base} ${n}`)) n++;
		return `${base} ${n}`;
	}

	private heading(parent: HTMLElement, text: string): void {
		new Setting(parent).setName(text).setHeading();
	}

	private renderMode(parent: HTMLElement, mode: TaskMode, nameEls: Map<string, HTMLElement>): void {
		const id = mode.id;
		/** Applies a change to the live mode and saves. */
		const edit = (fn: (m: TaskMode) => void, redraw = false) => {
			const m = this.live(id);
			if (!m) return;
			fn(m);
			this.save(redraw);
		};
		const el = parent.createDiv({ cls: "tg-modes-editor" });
		el.createDiv({ cls: "tg-modes-summary", text: describeFilter(mode.filter) });

		// --- general
		new Setting(el).setName("Name").addText((t) => {
			t.inputEl.setAttr("dir", "auto");
			t.setValue(mode.name).onChange((v) =>
				edit((m) => {
					m.name = v.trim() || "Mode";
					nameEls.get(id)?.setText(m.name);
				}),
			);
		});
		const modes = this.plugin.settings.modes;
		const index = modes.findIndex((m) => m.id === id);
		const move = (dir: number) => {
			const list = this.plugin.settings.modes;
			const from = list.findIndex((m) => m.id === id);
			const to = from + dir;
			if (from < 0 || to < 0 || to >= list.length) return;
			const [moved] = list.splice(from, 1);
			list.splice(to, 0, moved);
			this.save(true);
		};
		new Setting(el)
			.setName("Order and removal")
			.setDesc(modes.length > 1 ? "Move this mode in the list, or delete it." : "There is always at least one mode, so the last one can't be deleted.")
			.addExtraButton((b) => b.setIcon("arrow-left").setTooltip("Move earlier").setDisabled(index <= 0).onClick(() => move(-1)))
			.addExtraButton((b) => b.setIcon("arrow-right").setTooltip("Move later").setDisabled(index >= modes.length - 1).onClick(() => move(1)))
			.addButton((b) =>
				b
					.setButtonText("Delete mode")
					.setWarning()
					.setDisabled(modes.length <= 1)
					.onClick(() =>
						new ConfirmModal(this.plugin.app, "Delete mode?", `"${mode.name}" and its settings will be deleted.`, "Delete", () => {
							const s = this.plugin.settings;
							if (s.modes.length <= 1) return;
							s.modes = s.modes.filter((m) => m.id !== id);
							if (s.activeModeId === id) s.activeModeId = s.modes[0].id;
							this.selectedId = s.activeModeId;
							this.save(true);
						}).open(),
					),
			);

		this.renderDates(el, mode, edit);

		// --- excluded words
		this.heading(el, "Excluded words");
		new Setting(el)
			.setName("Exclude by words in description")
			.setDesc("One word or phrase per line (or comma-separated). Tasks whose description contains any of them are never drawn in this mode. Case-insensitive. A task's own window can also limit it to some modes.")
			.addTextArea((t) => {
				t.inputEl.rows = 4;
				t.inputEl.setAttr("dir", "auto");
				t.setPlaceholder("XYZ\nsomeday")
					.setValue(mode.excludeKeywords.join("\n"))
					.onChange((v) =>
						edit((m) => {
							m.excludeKeywords = v
								.split(/[\n,]/)
								.map((x) => x.trim())
								.filter(Boolean);
						}),
					);
			});

		// --- task lists
		this.heading(el, "Task lists");
		const lists = this.plugin.store.lists();
		if (!lists.length) el.createDiv({ cls: "tg-modes-empty", text: "Lists appear here after the first sync." });
		for (const l of lists) {
			new Setting(el).setName(l.title).addToggle((t) =>
				t.setValue(mode.includedLists === null || mode.includedLists.includes(l.id)).onChange((on) =>
					edit((m) => {
						const all = this.plugin.store.lists();
						const current = new Set(m.includedLists ?? all.map((x) => x.id));
						if (on) current.add(l.id);
						else current.delete(l.id);
						m.includedLists = all.every((x) => current.has(x.id)) ? null : [...current];
					}),
				),
			);
		}

		this.renderBackgrounds(el, mode, edit);
		this.renderSound(el, mode, edit);
	}

	private renderDates(el: HTMLElement, mode: TaskMode, edit: (fn: (m: TaskMode) => void, redraw?: boolean) => void): void {
		this.heading(el, "Dates");
		const ranges = new Setting(el).setName("Date ranges").setDesc("Which due dates gifts are drawn from in this mode. Select one or more ranges; they are combined.");
		ranges.settingEl.addClass("tg-filter-setting");
		const wrap = ranges.descEl.createDiv({ cls: "tg-filter-settings" });
		const chips = wrap.createDiv({ cls: "tg-filter-chips" });
		for (const preset of PRESET_ORDER) {
			const chip = chips.createEl("button", { cls: "tg-chip tg-chip-wide", text: PRESET_LABELS[preset] });
			chip.toggleClass("is-active", mode.filter.presets.includes(preset));
			chip.addEventListener("click", () =>
				edit((m) => {
					const f = m.filter;
					if (preset === "all") f.presets = ["all"];
					else {
						const set = new Set(f.presets.filter((x) => x !== "all"));
						if (set.has(preset)) set.delete(preset);
						else set.add(preset);
						f.presets = set.size ? [...set] : ["all"];
					}
				}, true),
			);
		}
		const combos = wrap.createDiv({ cls: "tg-filter-combos" });
		combos.createSpan({ text: "Quick picks: " });
		for (const c of QUICK_COMBOS) {
			combos.createEl("button", { cls: "tg-link-btn", text: c.label }).addEventListener("click", () => edit((m) => (m.filter.presets = [...c.presets]), true));
		}
		const number = (name: string, key: "customFrom" | "customTo") =>
			new Setting(el).setName(name).addText((t) => {
				t.inputEl.type = "number";
				t.inputEl.min = "0";
				t.setValue(String(mode.filter[key])).onChange((v) => edit((m) => (m.filter[key] = Math.max(0, Math.round(Number(v)) || 0))));
			});
		if (mode.filter.presets.includes("custom")) {
			number("Custom range: days ago", "customFrom");
			number("Custom range: days ahead", "customTo");
		}
		const toggle = (name: string, key: keyof Pick<DateFilter, "includeOverdue" | "includeNoDate">) =>
			new Setting(el).setName(name).addToggle((t) => t.setValue(mode.filter[key]).onChange((v) => edit((m) => (m.filter[key] = v), true)));
		toggle("Include overdue", "includeOverdue");
		toggle("Include tasks without a due date", "includeNoDate");
	}

	private renderBackgrounds(el: HTMLElement, mode: TaskMode, edit: (fn: (m: TaskMode) => void, redraw?: boolean) => void): void {
		const app = this.plugin.app;
		this.heading(el, "Backgrounds");
		if (!mode.backgrounds.length) {
			el.createDiv({
				cls: "tg-modes-empty",
				text: "No backgrounds yet. Add as many images, GIFs or videos (mp4) as you like; imported files are copied into your attachments folder.",
			});
		}
		for (const path of mode.backgrounds) {
			const row = new Setting(el).setName(fileName(path)).setDesc(path);
			const file = app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const src = app.vault.getResourcePath(file);
				const thumb = isVideo(path)
					? createEl("video", { cls: "tg-bg-thumb", attr: { src, muted: "", preload: "metadata", playsinline: "" } })
					: createEl("img", { cls: "tg-bg-thumb", attr: { src, alt: "" } });
				row.settingEl.prepend(thumb);
			} else {
				row.setDesc(`${path} (missing)`);
			}
			row.addExtraButton((b) =>
				b
					.setIcon("trash-2")
					.setTooltip("Remove background")
					.onClick(() =>
						edit((m) => {
							m.backgrounds = m.backgrounds.filter((p) => p !== path);
							if (m.backgroundPick === path) m.backgroundPick = "random";
						}, true),
					),
			);
		}
		const addPaths = (paths: string[]) =>
			edit((m) => {
				for (const p of paths) if (!m.backgrounds.includes(p)) m.backgrounds.push(p);
			}, true);
		new Setting(el)
			.setName("Add images or videos from this device")
			.addButton((b) => b.setButtonText("Add…").onClick(() => void importFiles(app, BACKGROUND_EXTENSIONS, true).then((paths) => paths.length > 0 && addPaths(paths))));
		new Setting(el).setName("Add an image or video already in the vault").addDropdown((d) => {
			const files = app.vault
				.getFiles()
				.filter((f) => isBackgroundFile(f.path) && !mode.backgrounds.includes(f.path))
				.map((f) => f.path)
				.sort();
			d.addOption("", files.length ? "Choose a file…" : "No other images or videos in the vault");
			for (const f of files) d.addOption(f, f);
			d.onChange((v) => {
				if (v) addPaths([v]);
			});
		});
		if (!mode.backgrounds.length) return;
		new Setting(el).setName("Which background to show").addDropdown((d) => {
			d.addOption("random", "A random one for every gift");
			for (const path of mode.backgrounds) d.addOption(path, `Always: ${fileName(path)}`);
			d.setValue(mode.backgrounds.includes(mode.backgroundPick) ? mode.backgroundPick : "random");
			d.onChange((v) => edit((m) => (m.backgroundPick = v)));
		});
		new Setting(el)
			.setName("Fade the background")
			.setDesc("Blends the image or video into your theme so the gift and cards stay readable.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 90, 5)
					.setValue(mode.backgroundDim)
					.setDynamicTooltip()
					.onChange((v) => edit((m) => (m.backgroundDim = v))),
			);
	}

	private renderSound(el: HTMLElement, mode: TaskMode, edit: (fn: (m: TaskMode) => void, redraw?: boolean) => void): void {
		const app = this.plugin.app;
		const current = () => this.live(mode.id) ?? mode;
		const volume = (name: string, desc: string | null, key: "giftSoundVolume" | "giftMusicVolume") => {
			const row = new Setting(el).setName(name).addSlider((sl) =>
				sl
					.setLimits(0, 100, 5)
					.setValue(mode[key])
					.setDynamicTooltip()
					.onChange((v) => edit((m) => (m[key] = v))),
			);
			if (desc) row.setDesc(desc);
		};

		this.heading(el, "Gift sound");
		new Setting(el).setName("Play a sound when opening a gift").addToggle((t) => t.setValue(mode.giftSoundEnabled).onChange((v) => edit((m) => (m.giftSoundEnabled = v), true)));
		if (mode.giftSoundEnabled) {
			const options = Object.fromEntries((Object.keys(SOUND_LABELS) as GiftSound[]).map((k) => [k, SOUND_LABELS[k]]));
			new Setting(el)
				.setName("Sound")
				.setDesc("Three built-in sounds, a random one each time, or your own audio file.")
				.addDropdown((d) => d.addOptions(options).setValue(mode.giftSound).onChange((v) => edit((m) => (m.giftSound = v as GiftSound), true)))
				.addExtraButton((b) => b.setIcon("play").setTooltip("Preview").onClick(() => playGiftSound(app, current(), true)));
			if (mode.giftSound === "custom") {
				this.audioFile(el, "Audio file", mode.giftSoundFile, (path) =>
					edit((m) => {
						m.giftSoundFile = path;
						m.giftSound = "custom";
					}),
				);
			}
		}
		volume("Volume", "Gift sound and victory music.", "giftSoundVolume");

		this.heading(el, "Victory");
		new Setting(el)
			.setName("Victory animation")
			.setDesc("A small celebration when every task of a gift is done.")
			.addToggle((t) => t.setValue(mode.victoryAnimation).onChange((v) => edit((m) => (m.victoryAnimation = v))));
		new Setting(el)
			.setName("Victory music")
			.setDesc("Plays your own mp3 when every task of a gift is done.")
			.addToggle((t) => t.setValue(mode.victorySoundEnabled).onChange((v) => edit((m) => (m.victorySoundEnabled = v), true)))
			.addExtraButton((b) => b.setIcon("play").setTooltip("Preview").onClick(() => playVictorySound(app, current(), true)));
		if (mode.victorySoundEnabled) this.audioFile(el, "Victory music file", mode.victorySoundFile, (path) => edit((m) => (m.victorySoundFile = path)));

		this.heading(el, "Music and video sound");
		new Setting(el)
			.setName("Play music in gift mode")
			.setDesc("Your own melody loops while the gift view is on screen in this mode. The music button in the gift view turns it on and off.")
			.addToggle((t) => t.setValue(mode.giftMusicEnabled).onChange((v) => edit((m) => (m.giftMusicEnabled = v), true)));
		if (mode.giftMusicEnabled) {
			this.audioFile(el, "Music file", mode.giftMusicFile, (path) => edit((m) => (m.giftMusicFile = path)));
			volume("Music volume", null, "giftMusicVolume");
		}
		new Setting(el)
			.setName("Sound of video backgrounds")
			.setDesc("Plays the sound track of an mp4 background. Also switchable with the speaker button in the gift view.")
			.addToggle((t) => t.setValue(mode.giftVideoSound).onChange((v) => edit((m) => (m.giftVideoSound = v))));
	}

	/** A row to pick an audio file from the vault, or import one from this device. */
	private audioFile(el: HTMLElement, name: string, value: string, set: (path: string) => void): void {
		const app = this.plugin.app;
		new Setting(el)
			.setName(name)
			.setDesc(AUDIO_DESC)
			.addDropdown((d) => {
				const files = app.vault
					.getFiles()
					.filter((f) => AUDIO_EXTENSIONS.includes(f.extension.toLowerCase()))
					.map((f) => f.path)
					.sort();
				if (value && !files.includes(value)) files.unshift(value);
				d.addOption("", files.length ? "Choose a file…" : "No audio files in the vault");
				for (const f of files) d.addOption(f, f);
				d.setValue(value).onChange((v) => set(v));
			})
			.addButton((b) =>
				b.setButtonText("Import…").onClick(
					() =>
						void importFiles(app, AUDIO_EXTENSIONS, false).then(([path]) => {
							if (!path) return;
							set(path);
							this.redraw();
						}),
				),
			);
	}
}
