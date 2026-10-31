import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import { TASK_COLORS, taskColorCss } from "../defaults";
import { CalendarEntry, insertEntry, isValidEntry, mergeEntries, parseEntries, replacedEntries, ReplaceMode, timeLabel } from "../calendars/format";
import type { CalendarStore, ExtraCalendar } from "../calendars/store";
import type { NamedTaskColor, TaskColor } from "../types";
import { isDateString, shortDate } from "../util/dates";
import { renderNotes } from "../calendars/notes";
import { ConfirmModal } from "./ConfirmModal";
import { DateField, INVALID_TIME, TimeField } from "./dateFields";
import { attachNotesToolbar } from "./NotesEditor";
import type { TemplateStore } from "../calendars/templates";
import { showTemplatesMenu } from "./TemplateModals";

/** Color swatches (no color + the built-in colors) for a calendar. */
function renderSwatches(parent: HTMLElement, current: () => TaskColor | null, onPick: (c: TaskColor | null) => void): void {
	const draw = () => {
		parent.empty();
		const row = parent.createDiv({ cls: "tg-color-swatches", attr: { role: "radiogroup", "aria-label": "Color" } });
		const pick = (value: TaskColor | null, label: string) => {
			const el = row.createDiv({ cls: "tg-color-swatch", attr: { role: "radio", tabindex: "0", "aria-label": label } });
			el.toggleClass("is-active", value === current());
			el.setAttr("aria-checked", String(value === current()));
			if (value) el.style.setProperty("--tg-task-color", taskColorCss(value));
			else {
				el.addClass("is-none");
				setIcon(el, "ban");
			}
			const choose = () => {
				onPick(value);
				draw();
			};
			el.addEventListener("click", choose);
			el.addEventListener("keydown", (e) => {
				if (e.key !== "Enter" && e.key !== " ") return;
				e.preventDefault();
				choose();
			});
		};
		pick(null, "No color");
		for (const [value, label] of Object.entries(TASK_COLORS)) pick(value as NamedTaskColor, label);
	};
	draw();
}

/** Creates a calendar, or renames / recolors / deletes one. */
export class CalendarEditModal extends Modal {
	private name: string;
	private color: TaskColor | null;

	constructor(
		app: App,
		private readonly calendars: CalendarStore,
		private readonly existing: ExtraCalendar | null,
		private readonly onDone: (cal: ExtraCalendar | null) => void,
	) {
		super(app);
		this.name = existing?.name ?? "";
		this.color = existing?.color ?? "blue";
	}

	onOpen(): void {
		this.modalEl.addClass("tg-modal");
		this.setTitle(this.existing ? "Edit calendar" : "New calendar");
		const { contentEl } = this;
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "A separate calendar for specific things (e.g. work shifts). It shows only its own entries, not your Google tasks, and is filled by pasting text.",
		});
		new Setting(contentEl).setName("Name").addText((t) => {
			t.setPlaceholder("e.g. Shifts").setValue(this.name).onChange((v) => (this.name = v));
			t.inputEl.setAttr("dir", "auto");
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		const colorSetting = new Setting(contentEl).setName("Color");
		renderSwatches(colorSetting.controlEl, () => this.color, (c) => (this.color = c));

		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		if (this.existing) {
			const del = buttons.createEl("button", { text: "Delete calendar", cls: "mod-warning" });
			del.addEventListener("click", () => this.remove());
		}
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: this.existing ? "Save" : "Create", cls: "mod-cta" }).addEventListener("click", () => void this.save());
	}

	private async save(): Promise<void> {
		if (!this.name.trim()) {
			new Notice("Give the calendar a name.");
			return;
		}
		try {
			let cal = this.existing;
			if (cal) {
				await this.calendars.rename(cal, this.name);
				if (cal.color !== this.color) {
					cal.color = this.color;
					await this.calendars.save(cal);
				}
			} else cal = await this.calendars.create(this.name, this.color);
			this.close();
			this.onDone(cal);
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
		}
	}

	private remove(): void {
		const cal = this.existing;
		if (!cal) return;
		new ConfirmModal(
			this.app,
			"Delete calendar?",
			`"${cal.name}" and its ${cal.entries.length} entr${cal.entries.length === 1 ? "y" : "ies"} go to the trash (its note can be restored from there).`,
			"Delete",
			() =>
				void this.calendars.remove(cal).then(() => {
					this.close();
					this.onDone(null);
				}),
		).open();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Pastes text (e.g. a shift schedule an AI read from a picture) into a calendar. */
export class CalendarImportModal extends Modal {
	private text = "";
	private replace: ReplaceMode = "matching";
	/** Path of the target calendar; "" = create a new one named `newName`. */
	private target: string;
	private newName = "";
	private previewEl!: HTMLElement;

	constructor(
		app: App,
		private readonly calendars: CalendarStore,
		target: ExtraCalendar | null,
		private readonly onDone: (cal: ExtraCalendar) => void,
	) {
		super(app);
		this.target = target?.path ?? calendars.all()[0]?.path ?? "";
	}

	onOpen(): void {
		this.modalEl.addClass("tg-modal", "tg-import-modal");
		this.setTitle("Import into a calendar");
		const { contentEl } = this;

		const help = contentEl.createDiv({ cls: "tg-import-help" });
		help.createEl("p", { text: "One entry per line: a date, optionally a time or time range, then the title. Indented lines below an entry are its description; \"- [ ] \" lines there become checkboxes." });
		help.createEl("pre", {
			text: "2026-03-02 09:00-11:30 Dentist\n    Bring the referral\n03/03 07:00-15:00 Morning shift\n    - [ ] Keys\n    - [ ] Water bottle\n2026-03-06 Trip to the north | pack the night before",
			attr: { dir: "ltr" },
		});
		help.createEl("p", { text: "Dates: 2026-10-18, 18/10/2026 or 18/10 (day first). Bullets, checkboxes, weekday names and other text around the list are ignored." });

		const area = contentEl.createEl("textarea", {
			cls: "tg-import-text",
			attr: { placeholder: "Paste the entries here…", dir: "auto", rows: "12", spellcheck: "false" },
		});
		area.addEventListener("input", () => {
			this.text = area.value;
			this.renderPreview();
		});
		window.setTimeout(() => area.focus(), 0);

		new Setting(contentEl).setName("Calendar").addDropdown((d) => {
			for (const cal of this.calendars.all()) d.addOption(cal.path, cal.name);
			d.addOption("", "New calendar…");
			d.setValue(this.target).onChange((v) => {
				this.target = v;
				newRow.settingEl.toggle(v === "");
				this.renderPreview();
			});
		});
		const newRow = new Setting(contentEl).setName("New calendar name").addText((t) => {
			t.setPlaceholder("e.g. Shifts").onChange((v) => (this.newName = v));
			t.inputEl.setAttr("dir", "auto");
		});
		newRow.settingEl.toggle(this.target === "");
		new Setting(contentEl)
			.setName("Existing entries on these days")
			.setDesc("Replace matching: entries with the same title as an imported one (or the same start time) are updated, so a new schedule replaces the old shifts but keeps anything else on those days.")
			.addDropdown((d) =>
				d
					.addOption("matching", "Replace matching")
					.addOption("days", "Replace all")
					.addOption("none", "Keep all")
					.setValue(this.replace)
					.onChange((v) => {
						this.replace = v as ReplaceMode;
						this.renderPreview();
					}),
			);

		this.previewEl = contentEl.createDiv({ cls: "tg-import-preview" });
		this.renderPreview();

		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: "Import", cls: "mod-cta" }).addEventListener("click", () => void this.import());
	}

	private parsed(): CalendarEntry[] {
		return parseEntries(this.text).entries.filter(isValidEntry);
	}

	private renderPreview(): void {
		const el = this.previewEl;
		el.empty();
		const { entries, skipped } = parseEntries(this.text);
		const valid = entries.filter(isValidEntry);
		if (!this.text.trim()) return;
		if (!valid.length) {
			el.createDiv({ cls: "tg-import-summary is-empty", text: "No entries found yet. Each entry must start with a date." });
			return;
		}
		const dates = valid.map((e) => e.date).sort();
		const days = new Set(dates).size;
		const target = this.calendars.get(this.target);
		const replaced = target ? replacedEntries(target.entries, valid, this.replace).length : 0;
		el.createDiv({
			cls: "tg-import-summary",
			text:
				`${valid.length} entr${valid.length === 1 ? "y" : "ies"} on ${days} day${days === 1 ? "" : "s"} (${shortDate(dates[0])} – ${shortDate(dates[dates.length - 1])})` +
				(replaced ? ` · replaces ${replaced} existing` : ""),
		});
		const list = el.createDiv({ cls: "tg-import-list" });
		for (const e of valid) {
			const row = list.createDiv({ cls: "tg-import-row" });
			row.createSpan({ cls: "tg-import-date", text: shortDate(e.date) });
			row.createSpan({ cls: "tg-import-time", text: timeLabel(e) });
			const main = row.createDiv({ cls: "tg-import-main" });
			main.createDiv({ text: e.title, attr: { dir: "auto" } });
			if (e.notes) renderNotes(main.createDiv({ cls: "tg-import-notes" }), e.notes);
		}
		const untitled = entries.length - valid.length;
		const ignored = skipped.length + untitled;
		if (ignored) {
			const skip = el.createEl("details", { cls: "tg-import-skipped" });
			skip.createEl("summary", { text: `${ignored} line${ignored === 1 ? "" : "s"} ignored` });
			for (const line of skipped) skip.createDiv({ text: line, attr: { dir: "auto" } });
			if (untitled) skip.createDiv({ text: `${untitled} entr${untitled === 1 ? "y" : "ies"} without a title` });
		}
	}

	private async import(): Promise<void> {
		const entries = this.parsed();
		if (!entries.length) {
			new Notice("Nothing to import: no line starts with a date.");
			return;
		}
		try {
			let cal = this.calendars.get(this.target);
			if (!cal) {
				if (!this.newName.trim()) {
					new Notice("Name the new calendar.");
					return;
				}
				cal = await this.calendars.create(this.newName, "blue");
			}
			cal.entries = mergeEntries(cal.entries, entries, this.replace);
			await this.calendars.save(cal);
			new Notice(`Imported ${entries.length} entr${entries.length === 1 ? "y" : "ies"} into ${cal.name}.`);
			this.close();
			this.onDone(cal);
		} catch (e) {
			new Notice(`Could not import: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Adds or edits one entry of a calendar. */
export class CalendarEntryModal extends Modal {
	private draft: CalendarEntry;

	private timeFields: TimeField[] = [];

	constructor(
		app: App,
		private readonly calendars: CalendarStore,
		private readonly templates: TemplateStore,
		private readonly cal: ExtraCalendar,
		/** null = a new entry. */
		private readonly entry: CalendarEntry | null,
		date: string,
	) {
		super(app);
		this.draft = entry ? { ...entry } : { date, start: null, end: null, title: "", notes: "", done: false };
	}

	onOpen(): void {
		this.modalEl.addClass("tg-modal", "tg-entry-modal");
		this.setTitle(`${this.entry ? "Edit entry" : "New entry"} · ${this.cal.name}`);
		const { contentEl } = this;
		const d = this.draft;

		const title = contentEl.createEl("input", { cls: "tg-title-input", attr: { type: "text", placeholder: "Title", dir: "auto" } });
		title.value = d.title;
		title.addEventListener("input", () => (d.title = title.value));
		title.addEventListener("keydown", (e) => {
			if (e.key === "Enter") void this.save();
		});
		window.setTimeout(() => title.focus(), 0);

		const day = new Setting(contentEl).setName("Day");
		new DateField(day.controlEl, { value: d.date, label: "Day", panelParent: day.settingEl, onChange: (v) => (d.date = v) });
		const time = new Setting(contentEl).setName("Time").setDesc("Leave empty for all day. An end before the start means the next day.");
		this.timeFields = [
			new TimeField(time.controlEl, { value: d.start ?? "", label: "Start time", onChange: (v) => (d.start = v || null) }),
			new TimeField(time.controlEl, { value: d.end ?? "", label: "End time", onChange: (v) => (d.end = v || null) }),
		];
		const notes = contentEl.createEl("textarea", { cls: "tg-import-text tg-entry-notes", attr: { placeholder: "Description. Use the toolbar for checkboxes, lists and formatting.", dir: "auto", rows: "10" } });
		notes.value = d.notes;
		// Grows with the text, so a long description is shown whole (up to most of the screen, then it scrolls).
		const fit = () => {
			notes.setCssStyles({ height: "auto" });
			notes.setCssStyles({ height: `${notes.scrollHeight + 2}px` });
		};
		// An existing entry opens on the preview, so its checkboxes can be ticked right away.
		const toolbar = attachNotesToolbar(notes, (v) => (d.notes = v), fit, !!this.entry && d.notes.trim() !== "");
		toolbar.addButton(["layout-template", "file-text"], "Templates", (e) => void showTemplatesMenu(this.app, this.templates, e, () => d.notes, (text) => toolbar.insert(text)));
		window.setTimeout(fit, 0);
		new Setting(contentEl).setName("Done").addToggle((t) => t.setValue(d.done).onChange((v) => (d.done = v)));

		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		if (this.entry) {
			buttons.createEl("button", { text: "Delete", cls: "mod-warning" }).addEventListener("click", () => void this.remove());
		}
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: this.entry ? "Save" : "Add", cls: "mod-cta" }).addEventListener("click", () => void this.save());
	}

	/** The calendar as it is now (the note may have been re-read since the modal opened). */
	private current(): ExtraCalendar | null {
		const cal = this.calendars.get(this.cal.path);
		if (cal && this.entry && !cal.entries.includes(this.entry)) {
			new Notice("This calendar changed in the meantime (another device or its note). Open the entry again.");
			return null;
		}
		return cal;
	}

	private async save(): Promise<void> {
		if (this.timeFields.some((f) => !f.isValid)) {
			new Notice(INVALID_TIME);
			return;
		}
		const d = this.draft;
		d.title = d.title.trim();
		// Only blank lines and trailing spaces go: the first line's indent may be a nested list.
		d.notes = d.notes.replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, "");
		if (!isDateString(d.date) || !d.title) {
			new Notice("An entry needs a title and a day.");
			return;
		}
		if (!d.start) d.end = null;
		const cal = this.current();
		if (!cal) return;
		if (this.entry) {
			// Keeps its place in the day unless its day or start time changed.
			const moved = this.entry.date !== d.date || this.entry.start !== d.start;
			Object.assign(this.entry, d);
			if (moved) {
				cal.entries = cal.entries.filter((e) => e !== this.entry);
				insertEntry(cal.entries, this.entry);
			}
		} else insertEntry(cal.entries, d);
		await this.calendars.save(cal);
		this.close();
	}

	private async remove(): Promise<void> {
		const cal = this.current();
		if (!cal || !this.entry) return;
		cal.entries = cal.entries.filter((e) => e !== this.entry);
		await this.calendars.save(cal);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
