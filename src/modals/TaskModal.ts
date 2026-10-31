import { App, Menu, Modal, Notice, setIcon } from "obsidian";
import type { NamedTaskColor, RecurrenceEnd, RecurrenceFreq, RecurrencePreset, RecurrenceRule, ReminderOffset, ReminderUnit, Task, TaskColor, Weekday } from "../types";
import type { TaskStore } from "../sync/store";
import { firstMatchOnOrAfter, isLastWeekdayOfMonth, nthOfMonth, occurrencesBetween, reminderDate, ruleFromPreset } from "../recurrence/rule";
import { addDays, addMonths, MONTH_SHORT, ordinal, parseDate, today, WEEKDAY_LONG, WEEKDAY_SHORT, weekday } from "../util/dates";
import { MAX_REMINDERS, TASK_COLORS, taskColorCss } from "../defaults";
import { ConfirmModal } from "./ConfirmModal";
import { DateField, INVALID_TIME, TimeField } from "./dateFields";
import { copyDescription } from "./NotesEditor";

type RepeatChoice = "none" | RecurrencePreset;

export interface TaskModalOptions {
	task?: Task;
	defaults?: { listId?: string; due?: string | null };
	/** Custom colors for the color picker; unset hides the picker (task colors turned off). */
	colors?: { custom: string[]; save: (custom: string[]) => void };
	/** The modes, for choosing which of them the task may be drawn in. */
	modes?: { id: string; name: string }[];
}

/** Create / edit modal with Google-Calendar-style recurrence. */
export class TaskModal extends Modal {
	private title = "";
	private notes = "";
	private listId = "";
	private due = "";
	private time = "";
	private color: TaskColor | null = null;
	/** Modes the task may be drawn in; empty = every mode. */
	private modes = new Set<string>();
	private repeat: RepeatChoice = "none";
	// Custom recurrence state
	private interval = 1;
	private freq: RecurrenceFreq = "weekly";
	private weekdays = new Set<Weekday>();
	private monthlyMode: "day" | "nth" | "last" | "after" = "day";
	// "after" mode: the Nth weekday after a day of the month ("the first Monday after the 10th").
	private afterNth = 1;
	private afterWeekday: Weekday = 1;
	private afterDay = 10;
	private afterInclusive = false;
	private endType: RecurrenceEnd["type"] = "never";
	private endCount = 10;
	private endDate = "";
	private existingRule: RecurrenceRule | null = null;
	/** Date last picked by hand; choosing weekdays moves the due date to the first matching day from here. */
	private dateBase = "";
	private reminderOffsets: ReminderOffset[] = [];

	private remindersEl!: HTMLElement;
	/** The date shown next to each reminder, in `reminderOffsets` order. */
	private reminderDateEls: HTMLElement[] = [];
	private repeatSelect!: HTMLSelectElement;
	private dateInput!: DateField;
	private customEl!: HTMLElement;
	private timeInput!: TimeField;

	constructor(app: App, private readonly store: TaskStore, private readonly opts: TaskModalOptions = {}) {
		super(app);
		const t = opts.task;
		if (t) {
			this.title = t.title;
			this.notes = t.notes;
			this.listId = t.listId;
			this.due = t.due ?? "";
			this.time = store.time(t.id) ?? "";
			this.color = store.color(t.id);
			// Modes deleted since are dropped.
			const known = new Set((opts.modes ?? []).map((m) => m.id));
			this.modes = new Set((store.modes(t.id) ?? []).filter((id) => known.has(id)));
			const rule = store.rule(t.id);
			if (rule) this.loadRule(rule);
			this.reminderOffsets = store.reminders(t.id).map((r) => ({ amount: r.amount, unit: r.unit, text: r.text }));
		} else {
			this.listId = opts.defaults?.listId ?? store.defaultListId() ?? "";
			this.due = opts.defaults?.due ?? "";
		}
		this.dateBase = this.due;
	}

	private loadRule(rule: RecurrenceRule): void {
		this.existingRule = rule;
		this.repeat = rule.preset;
		this.interval = rule.interval;
		this.freq = rule.freq;
		this.weekdays = new Set(rule.byWeekday);
		this.monthlyMode = rule.monthlyMode === "day" ? "day" : rule.monthlyMode === "after" ? "after" : rule.nth === -1 ? "last" : "nth";
		if (rule.monthlyMode === "after") {
			this.afterNth = Math.max(1, rule.nth);
			this.afterWeekday = rule.nthWeekday;
			this.afterDay = rule.afterDay ?? 1;
			this.afterInclusive = !!rule.afterInclusive;
		}
		this.endType = rule.end.type;
		if (rule.end.type === "count") this.endCount = rule.end.count;
		if (rule.end.type === "until") this.endDate = rule.end.date;
	}

	private refDate(): string {
		return this.due || today();
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass("tg-modal");
		contentEl.empty();
		this.setTitle(this.opts.task ? "Edit task" : "New task");

		if (!this.store.lists().length) {
			contentEl.createEl("p", { text: "No task lists yet. Connect your Google account and sync first." });
			return;
		}

		const form = contentEl.createDiv({ cls: "tg-form" });

		const titleInput = form.createEl("input", { cls: "tg-input tg-title-input", attr: { type: "text", placeholder: "Add a title", dir: "auto" } });
		titleInput.value = this.title;
		titleInput.addEventListener("input", () => (this.title = titleInput.value));
		titleInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				void this.save();
			}
		});

		const notesRow = this.row(form, "align-left", "Notes");
		const notesWrap = notesRow.createDiv({ cls: "tg-notes-wrap" });
		const notesInput = notesWrap.createEl("textarea", { cls: "tg-input tg-notes-input", attr: { rows: "3", placeholder: "Add details", dir: "auto" } });
		notesInput.value = this.notes;
		notesInput.addEventListener("input", () => (this.notes = notesInput.value));
		const copy = notesWrap.createEl("button", { cls: "clickable-icon tg-notes-copy", attr: { type: "button", "aria-label": "Copy description" } });
		setIcon(copy, "copy");
		copy.addEventListener("click", () => copyDescription(this.notes));

		const listRow = this.row(form, "list", "List");
		const listSelect = listRow.createEl("select", { cls: "dropdown" });
		for (const l of this.store.lists()) listSelect.createEl("option", { text: l.title, value: l.id });
		listSelect.value = this.listId;
		listSelect.addEventListener("change", () => (this.listId = listSelect.value));

		const dateRow = this.row(form, "calendar", "Due");
		const dateInput = (this.dateInput = new DateField(dateRow, {
			value: this.due,
			label: "Due date",
			placeholder: "No date",
			panelParent: dateRow,
			onChange: (value) => {
				this.due = value;
				this.dateBase = this.due;
				this.timeInput.disabled = !this.due;
				if (!this.due) {
					this.timeInput.value = "";
					this.time = "";
				}
				this.syncWeekdaysToDate();
				this.refreshRepeatOptions();
				this.snapDueToAfter();
			},
		}));
		this.timeInput = new TimeField(dateRow, { value: this.time, label: "Due time", onChange: (value) => (this.time = value) });
		this.timeInput.disabled = !this.due;
		const clearBtn = dateRow.createEl("button", { cls: "clickable-icon tg-clear", attr: { "aria-label": "Clear date" } });
		setIcon(clearBtn, "x");
		clearBtn.addEventListener("click", () => {
			dateInput.value = "";
			this.timeInput.value = "";
			this.due = "";
			this.dateBase = "";
			this.time = "";
			this.timeInput.disabled = true;
			this.refreshRepeatOptions();
		});

		const repeatRow = this.row(form, "repeat", "Repeat");
		this.repeatSelect = repeatRow.createEl("select", { cls: "dropdown" });
		this.repeatSelect.addEventListener("change", () => {
			this.repeat = this.repeatSelect.value as RepeatChoice;
			if (this.repeat === "custom" && this.weekdays.size === 0) this.weekdays.add(parseDate(this.refDate()).getDay() as Weekday);
			this.renderCustom();
		});
		this.customEl = form.createDiv({ cls: "tg-custom" });
		this.refreshRepeatOptions();

		this.remindersEl = this.row(form, "bell", "Reminders");
		this.remindersEl.addClass("tg-reminders");
		this.renderReminders();

		if (this.opts.colors) this.renderColorRow(this.row(form, "palette", "Color"), this.opts.colors);
		if (this.opts.modes?.length) this.renderModesRow(this.row(form, "layers", "Gift modes"), this.opts.modes);

		const hint = form.createDiv({ cls: "tg-hint" });
		setIcon(hint.createSpan({ cls: "tg-hint-icon" }), "info");
		hint.createSpan({
			text: "Google Tasks doesn't support recurring tasks or due times. Task Gift keeps the time and repeat rule in this vault and creates the next task in Google when you complete one.",
		});

		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		if (this.opts.task) {
			const del = buttons.createEl("button", { text: "Delete", cls: "mod-warning" });
			del.addEventListener("click", () => this.confirmDelete());
		}
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: this.opts.task ? "Save" : "Create", cls: "mod-cta" }).addEventListener("click", () => void this.save());

		window.setTimeout(() => titleInput.focus(), 10);
	}

	private row(parent: HTMLElement, icon: string, label: string): HTMLElement {
		const row = parent.createDiv({ cls: "tg-form-row" });
		const ic = row.createSpan({ cls: "tg-form-icon", attr: { "aria-label": label } });
		setIcon(ic, icon);
		return row.createDiv({ cls: "tg-form-field" });
	}

	/** Swatches are divs, not buttons: Obsidian's button styles would paint over their color. */
	private renderColorRow(row: HTMLElement, colors: NonNullable<TaskModalOptions["colors"]>): void {
		row.empty();
		const swatches = row.createDiv({ cls: "tg-color-swatches", attr: { role: "radiogroup", "aria-label": "Color" } });
		const swatch = (label: string, onClick: () => void): HTMLElement => {
			const el = swatches.createDiv({ cls: "tg-color-swatch", attr: { role: "radio", tabindex: "0", "aria-label": label } });
			el.addEventListener("click", onClick);
			el.addEventListener("keydown", (e) => {
				if (e.key !== "Enter" && e.key !== " ") return;
				e.preventDefault();
				onClick();
			});
			return el;
		};
		const pick = (value: TaskColor | null, label: string): HTMLElement => {
			const el = swatch(label, () => {
				this.color = value;
				this.renderColorRow(row, colors);
			});
			el.toggleClass("is-active", value === this.color);
			el.setAttr("aria-checked", String(value === this.color));
			if (value) el.style.setProperty("--tg-task-color", taskColorCss(value));
			else {
				el.addClass("is-none");
				setIcon(el, "ban");
			}
			return el;
		};

		pick(null, "No color");
		for (const [value, label] of Object.entries(TASK_COLORS)) pick(value as NamedTaskColor, label);
		const custom = [...colors.custom] as TaskColor[];
		// A custom color removed from the palette stays on tasks that use it.
		if (this.color && !(this.color in TASK_COLORS) && !custom.includes(this.color)) custom.push(this.color);
		for (const hex of custom) {
			const el = pick(hex, `${hex} (right-click to remove)`);
			el.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				new Menu()
					.addItem((i) =>
						i
							.setTitle("Remove color")
							.setIcon("trash-2")
							.onClick(() => {
								colors.custom = colors.custom.filter((c) => c !== hex);
								colors.save(colors.custom);
								this.renderColorRow(row, colors);
							}),
					)
					.showAtMouseEvent(e);
			});
		}

		const input = row.createEl("input", { cls: "tg-color-input", attr: { type: "color", tabindex: "-1", "aria-hidden": "true" } });
		const plus = swatch("Add a color", () => input.click());
		plus.addClass("is-add");
		setIcon(plus, "plus");
		input.addEventListener("change", () => {
			// A color input always gives "#rrggbb".
			const hex = input.value.toLowerCase() as TaskColor;
			if (!colors.custom.includes(hex)) {
				colors.custom = [...colors.custom, hex];
				colors.save(colors.custom);
			}
			this.color = hex;
			this.renderColorRow(row, colors);
		});
	}

	/** Chips choosing the modes whose gifts may draw this task: "All modes", or any number of single modes. */
	private renderModesRow(row: HTMLElement, modes: NonNullable<TaskModalOptions["modes"]>): void {
		row.empty();
		row.addClass("tg-modes-field");
		const chips = row.createDiv({ cls: "tg-filter-chips tg-task-modes", attr: { role: "group", "aria-label": "Drawn in modes" } });
		const chip = (label: string, active: boolean, onClick: () => void) => {
			const el = chips.createEl("button", { cls: "tg-chip tg-chip-wide", text: label, attr: { "aria-pressed": String(active), dir: "auto" } });
			el.toggleClass("is-active", active);
			el.addEventListener("click", (e) => {
				e.preventDefault();
				onClick();
				this.renderModesRow(row, modes);
			});
		};
		chip("All modes", this.modes.size === 0, () => this.modes.clear());
		for (const m of modes) {
			chip(m.name, this.modes.has(m.id), () => {
				if (this.modes.has(m.id)) this.modes.delete(m.id);
				else this.modes.add(m.id);
				// Every mode picked one by one is the same as "All modes".
				if (this.modes.size === modes.length) this.modes.clear();
			});
		}
		row.createDiv({
			cls: "tg-subhint",
			text: this.modes.size === 0 ? "Gifts in every mode can draw this task." : "Only gifts in the selected modes can draw this task.",
		});
	}

	/** One line per reminder ("[1] [week(s)] before") and its own description, each a separate task that long before this one. */
	private renderReminders(): void {
		const el = this.remindersEl;
		el.empty();
		this.reminderDateEls = this.reminderOffsets.map((offset, i) => {
			const reminder = el.createDiv({ cls: "tg-reminder" });
			const line = reminder.createDiv({ cls: "tg-custom-line tg-reminder-line" });
			const n = line.createEl("input", { cls: "tg-input tg-num", attr: { type: "number", min: "1", max: "999", "aria-label": "How long before" } });
			n.value = String(offset.amount);
			n.addEventListener("input", () => {
				offset.amount = Math.max(1, parseInt(n.value) || 1);
				this.refreshReminderDates();
			});
			const unit = line.createEl("select", { cls: "dropdown", attr: { "aria-label": "Unit" } });
			for (const [v, label] of [
				["days", "day(s)"],
				["weeks", "week(s)"],
				["months", "month(s)"],
			] as [ReminderUnit, string][]) {
				unit.createEl("option", { value: v, text: label });
			}
			unit.value = offset.unit;
			unit.addEventListener("change", () => {
				offset.unit = unit.value as ReminderUnit;
				this.refreshReminderDates();
			});
			line.createSpan({ text: "before" });
			const date = line.createSpan({ cls: "tg-subhint tg-reminder-date" });
			const remove = line.createEl("button", { cls: "clickable-icon tg-clear", attr: { type: "button", "aria-label": "Remove reminder" } });
			setIcon(remove, "x");
			remove.addEventListener("click", () => {
				this.reminderOffsets.splice(i, 1);
				this.renderReminders();
			});
			const text = reminder.createEl("textarea", {
				cls: "tg-input tg-reminder-text",
				attr: { rows: "2", placeholder: "Description of this reminder (optional)", dir: "auto", "aria-label": "Reminder description" },
			});
			text.value = offset.text ?? "";
			text.addEventListener("input", () => (offset.text = text.value));
			return date;
		});
		if (this.reminderOffsets.length < MAX_REMINDERS) {
			const add = el.createEl("button", { cls: "tg-reminder-add", text: "Add reminder", attr: { type: "button" } });
			add.addEventListener("click", () => {
				const used = (o: ReminderOffset) => this.reminderOffsets.some((r) => r.amount === o.amount && r.unit === o.unit);
				const suggested: ReminderOffset[] = [
					{ amount: 1, unit: "days" },
					{ amount: 1, unit: "weeks" },
					{ amount: 1, unit: "months" },
				];
				this.reminderOffsets.push(suggested.find((o) => !used(o)) ?? suggested[0]);
				this.renderReminders();
			});
		}
		this.refreshReminderDates();
	}

	private refreshReminderDates(): void {
		this.reminderDateEls.forEach((el, i) => {
			if (!this.due) {
				el.setText("Needs a due date");
				return;
			}
			const date = reminderDate(this.due, this.reminderOffsets[i]);
			const label = parseDate(date).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
			el.setText(date < today() ? `${label} (passed, no reminder)` : label);
		});
	}

	/** The reminders to save; two that fall on the same day would be the same task. */
	private distinctReminders(due: string | null): ReminderOffset[] {
		const seen = new Set<string>();
		return this.reminderOffsets
			.filter((o) => {
				const key = due ? reminderDate(due, o) : `${o.amount} ${o.unit}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			})
			.map((o) => ({ amount: o.amount, unit: o.unit, text: o.text?.trim() || undefined }));
	}

	/** Makes the weekday circles include the due date's weekday (replacing a single selected day). */
	private syncWeekdaysToDate(): void {
		if (!this.due) return;
		const wd = weekday(this.due) as Weekday;
		if (this.weekdays.has(wd)) return;
		if (this.weekdays.size <= 1) this.weekdays.clear();
		this.weekdays.add(wd);
	}

	/** Moves the due date to the first selected weekday on or after the date picked by hand (or today). */
	private moveDueToWeekdays(): void {
		if (!this.weekdays.size) return;
		const base = this.dateBase || today();
		for (let i = 0; i < 7; i++) {
			const cand = addDays(base, i);
			if (!this.weekdays.has(weekday(cand) as Weekday)) continue;
			if (cand !== this.due) {
				this.due = cand;
				this.dateInput.value = cand;
				this.timeInput.disabled = false;
				// Rebuilds the repeat labels ("Weekly on …") and the custom section.
				this.refreshRepeatOptions();
			}
			return;
		}
	}

	private isAfterMode(): boolean {
		return this.repeat === "custom" && this.freq === "monthly" && this.monthlyMode === "after";
	}

	/** The "after" pattern as a rule (for computing dates in the modal). */
	private afterRule(due: string): RecurrenceRule {
		return {
			...ruleFromPreset("monthly", due),
			preset: "custom",
			interval: this.interval,
			monthlyMode: "after",
			nth: this.afterNth,
			nthWeekday: this.afterWeekday,
			afterDay: this.afterDay,
			afterInclusive: this.afterInclusive,
		};
	}

	/** In "after" mode, moves the due date to the first matching day on or after the date picked by hand (or today). */
	private snapDueToAfter(): void {
		if (!this.isAfterMode()) return;
		const base = this.dateBase || today();
		const due = firstMatchOnOrAfter(this.afterRule(base), base);
		if (due !== this.due) {
			this.due = due;
			this.dateInput.value = due;
			this.timeInput.disabled = false;
			this.refreshRepeatLabels();
		}
		this.renderAfterPreview();
	}

	private afterPreviewEl: HTMLElement | null = null;

	/** The next few dates of the "after" pattern, so the rule can be checked before saving. */
	private renderAfterPreview(): void {
		const el = this.afterPreviewEl;
		if (!el || !this.due) return;
		const dates = [this.due, ...occurrencesBetween(this.afterRule(this.due), this.due, this.due, "9999-12-31", 3)];
		const fmt = (d: string) => parseDate(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
		el.setText(`Next: ${dates.map(fmt).join(" · ")}`);
	}

	private refreshRepeatOptions(): void {
		this.refreshRepeatLabels();
		this.renderCustom();
	}

	/** Rebuilds the repeat choices, whose labels depend on the due date ("Weekly on …"). */
	private refreshRepeatLabels(): void {
		this.refreshReminderDates();
		const d = parseDate(this.refDate());
		const sel = this.repeatSelect;
		sel.empty();
		const opts: [RepeatChoice, string][] = [
			["none", "Does not repeat"],
			["daily", "Daily"],
			["weekly", `Weekly on ${WEEKDAY_LONG[d.getDay()]}`],
			["monthly", `Monthly on day ${d.getDate()}`],
			["yearly", `Annually on ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`],
			["custom", "Custom…"],
		];
		for (const [v, label] of opts) sel.createEl("option", { value: v, text: label });
		sel.value = this.repeat;
	}

	private renderCustom(): void {
		const el = this.customEl;
		el.empty();
		this.afterPreviewEl = null;
		el.toggleClass("is-hidden", this.repeat !== "custom");
		if (this.repeat !== "custom") return;

		const every = el.createDiv({ cls: "tg-custom-line" });
		every.createSpan({ text: "Repeat every" });
		const n = every.createEl("input", { cls: "tg-input tg-num", attr: { type: "number", min: "1", max: "999" } });
		n.value = String(this.interval);
		n.addEventListener("input", () => (this.interval = Math.max(1, parseInt(n.value) || 1)));
		const unit = every.createEl("select", { cls: "dropdown" });
		for (const [v, label] of [
			["daily", "day(s)"],
			["weekly", "week(s)"],
			["monthly", "month(s)"],
			["yearly", "year(s)"],
		] as [RecurrenceFreq, string][]) {
			unit.createEl("option", { value: v, text: label });
		}
		unit.value = this.freq;
		unit.addEventListener("change", () => {
			this.freq = unit.value as RecurrenceFreq;
			if (this.freq === "weekly" && this.weekdays.size === 0) this.weekdays.add(weekday(this.refDate()) as Weekday);
			this.renderCustom();
			this.snapDueToAfter();
		});

		if (this.freq === "weekly") {
			const days = el.createDiv({ cls: "tg-custom-line" });
			days.createSpan({ text: "Repeat on" });
			const chips = days.createDiv({ cls: "tg-weekday-chips" });
			for (let i = 0; i < 7; i++) {
				const wd = i as Weekday;
				const chip = chips.createEl("button", { cls: "tg-chip", text: WEEKDAY_SHORT[i].charAt(0), attr: { "aria-label": WEEKDAY_LONG[i] } });
				chip.toggleClass("is-active", this.weekdays.has(wd));
				chip.addEventListener("click", (e) => {
					e.preventDefault();
					if (this.weekdays.has(wd)) {
						if (this.weekdays.size > 1) this.weekdays.delete(wd);
					} else this.weekdays.add(wd);
					chip.toggleClass("is-active", this.weekdays.has(wd));
					this.moveDueToWeekdays();
				});
			}
		}

		if (this.freq === "monthly") {
			const ref = this.refDate();
			const d = parseDate(ref);
			const line = el.createDiv({ cls: "tg-custom-line" });
			const sel = line.createEl("select", { cls: "dropdown" });
			sel.createEl("option", { value: "day", text: `Monthly on day ${d.getDate()}` });
			const nth = nthOfMonth(ref);
			if (nth <= 4) sel.createEl("option", { value: "nth", text: `Monthly on the ${ordinal(nth)} ${WEEKDAY_LONG[d.getDay()]}` });
			if (isLastWeekdayOfMonth(ref)) sel.createEl("option", { value: "last", text: `Monthly on the last ${WEEKDAY_LONG[d.getDay()]}` });
			sel.createEl("option", { value: "after", text: "Monthly on a weekday after a day of the month…" });
			if (this.monthlyMode === "nth" && nth > 4) this.monthlyMode = "last";
			if (this.monthlyMode === "last" && !isLastWeekdayOfMonth(ref)) this.monthlyMode = "nth";
			sel.value = this.monthlyMode;
			sel.addEventListener("change", () => {
				const wasAfter = this.monthlyMode === "after";
				this.monthlyMode = sel.value as "day" | "nth" | "last" | "after";
				if (this.monthlyMode === "after" && !wasAfter && !this.existingRule?.afterDay) {
					// Start from the due date: its weekday, counted from its own day, so it stays put.
					this.afterWeekday = d.getDay() as Weekday;
					this.afterDay = d.getDate();
					this.afterNth = 1;
					this.afterInclusive = true;
				}
				if (wasAfter !== (this.monthlyMode === "after")) this.renderCustom();
				this.snapDueToAfter();
			});
			if (this.monthlyMode === "after") this.renderAfterControls(el);
			else line.createDiv({ cls: "tg-subhint", text: "Based on the due date." });
		}

		const ends = el.createDiv({ cls: "tg-ends" });
		ends.createDiv({ cls: "tg-ends-label", text: "Ends" });
		const name = `tg-end-${Math.random().toString(36).slice(2)}`;
		const option = (type: RecurrenceEnd["type"], label: string, extra?: (row: HTMLElement) => void) => {
			const row = ends.createEl("label", { cls: "tg-radio-row" });
			const r = row.createEl("input", { attr: { type: "radio", name } });
			r.checked = this.endType === type;
			r.addEventListener("change", () => {
				if (r.checked) this.endType = type;
			});
			row.createSpan({ text: label });
			extra?.(row);
		};
		option("never", "Never");
		option("until", "On", (row) => {
			this.endDate ||= addMonths(this.refDate(), 3);
			new DateField(row, { value: this.endDate, label: "Last date", panelParent: ends, onChange: (value) => (this.endDate = value) });
		});
		option("count", "After", (row) => {
			const input = row.createEl("input", { cls: "tg-input tg-num", attr: { type: "number", min: "1", max: "999" } });
			input.value = String(this.endCount);
			input.addEventListener("input", () => (this.endCount = Math.max(1, parseInt(input.value) || 1)));
			row.createSpan({ text: "occurrences" });
		});
	}

	/** "The [1st] [Monday] [after] day [10]": the controls of the "after" mode, and a preview of its dates. */
	private renderAfterControls(el: HTMLElement): void {
		const line = el.createDiv({ cls: "tg-custom-line tg-after-line" });
		const changed = () => this.snapDueToAfter();
		line.createSpan({ text: "The" });
		const nth = line.createEl("select", { cls: "dropdown", attr: { "aria-label": "Which one" } });
		for (let i = 1; i <= 4; i++) nth.createEl("option", { value: String(i), text: ordinal(i) });
		nth.value = String(this.afterNth);
		nth.addEventListener("change", () => {
			this.afterNth = parseInt(nth.value) || 1;
			changed();
		});
		const wd = line.createEl("select", { cls: "dropdown", attr: { "aria-label": "Weekday" } });
		for (let i = 0; i < 7; i++) wd.createEl("option", { value: String(i), text: WEEKDAY_LONG[i] });
		wd.value = String(this.afterWeekday);
		wd.addEventListener("change", () => {
			this.afterWeekday = (parseInt(wd.value) || 0) as Weekday;
			changed();
		});
		const incl = line.createEl("select", { cls: "dropdown", attr: { "aria-label": "After, or on or after" } });
		incl.createEl("option", { value: "after", text: "after" });
		incl.createEl("option", { value: "onOrAfter", text: "on or after" });
		incl.value = this.afterInclusive ? "onOrAfter" : "after";
		incl.addEventListener("change", () => {
			this.afterInclusive = incl.value === "onOrAfter";
			changed();
		});
		line.createSpan({ text: "day" });
		const day = line.createEl("input", { cls: "tg-input tg-num", attr: { type: "number", min: "1", max: "31", "aria-label": "Day of the month" } });
		day.value = String(this.afterDay);
		day.addEventListener("input", () => {
			const n = parseInt(day.value);
			if (!(n >= 1 && n <= 31)) return;
			this.afterDay = n;
			changed();
		});
		this.afterPreviewEl = el.createDiv({ cls: "tg-subhint" });
		this.renderAfterPreview();
	}

	private buildRule(due: string): RecurrenceRule | null {
		if (this.repeat === "none") return null;
		const prev = this.existingRule;
		let rule: RecurrenceRule;
		if (this.repeat !== "custom") {
			rule = ruleFromPreset(this.repeat, due);
		} else {
			const d = parseDate(due);
			const end: RecurrenceEnd =
				this.endType === "count"
					? { type: "count", count: this.endCount }
					: this.endType === "until" && this.endDate
						? { type: "until", date: this.endDate }
						: { type: "never" };
			rule = {
				preset: "custom",
				freq: this.freq,
				interval: this.interval,
				byWeekday: this.freq === "weekly" ? [...this.weekdays].sort() : [d.getDay() as Weekday],
				monthlyMode: this.monthlyMode === "day" ? "day" : this.monthlyMode === "after" ? "after" : "nth",
				monthDay: d.getDate(),
				nth: this.monthlyMode === "last" ? -1 : this.monthlyMode === "after" ? this.afterNth : Math.min(4, nthOfMonth(due)),
				nthWeekday: this.monthlyMode === "after" ? this.afterWeekday : (d.getDay() as Weekday),
				end,
				occurrence: 1,
				anchor: due,
			};
			if (rule.monthlyMode === "after") {
				rule.afterDay = this.afterDay;
				rule.afterInclusive = this.afterInclusive;
			}
		}
		if (prev) {
			rule.occurrence = prev.occurrence;
			rule.anchor = prev.anchor && prev.preset === rule.preset && prev.freq === rule.freq ? prev.anchor : due;
		}
		return rule;
	}

	private async save(): Promise<void> {
		const title = this.title.trim();
		if (!title) {
			new Notice("Please enter a title.");
			return;
		}
		if (!this.timeInput.isValid) {
			new Notice(INVALID_TIME);
			return;
		}
		let due = this.due || null;
		if (this.repeat !== "none" && !due) {
			due = today();
			new Notice("Repeating tasks need a due date; using today.");
		}
		// An "after" rule needs a due date that fits it.
		if (due && this.isAfterMode()) due = firstMatchOnOrAfter(this.afterRule(due), due);
		const rule = due ? this.buildRule(due) : null;
		const time = due && this.time ? this.time : null;
		const task = this.opts.task;
		const color = this.opts.colors ? this.color : undefined;
		const modes = this.opts.modes?.length ? [...this.modes] : undefined;
		const reminders = this.distinctReminders(due);
		if (task) {
			this.store.update(task.id, { title, notes: this.notes, due, listId: this.listId, time, recurrence: rule, color, modes, reminders });
		} else {
			const created = this.store.create({ title, notes: this.notes, listId: this.listId, due }, "local", true);
			this.store.update(created.id, { time, recurrence: rule, color, modes, reminders });
			this.store.notify("local");
		}
		this.close();
	}

	private confirmDelete(): void {
		const task = this.opts.task;
		if (!task) return;
		new ConfirmModal(this.app, "Delete task?", `"${task.title}" will be deleted from Google Tasks too.`, "Delete", () => {
			this.store.delete(task.id);
			this.close();
		}).open();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
