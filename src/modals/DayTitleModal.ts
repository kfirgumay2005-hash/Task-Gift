import { App, Modal, Setting, setIcon } from "obsidian";
import { TASK_COLORS, taskColorCss } from "../defaults";
import type { DayTitle, DayTitleEndNote, DayTitleEndPosition, DayTitlePart, DayTitleSize, DayTitleStyle, NamedTaskColor, TaskColor } from "../types";
import { addDays, shortDate } from "../util/dates";

const SIZE_LABELS: Record<DayTitleSize, string> = { small: "Small", normal: "Normal", large: "Large", huge: "Huge" };

type DayTitleEnd = "day" | "date" | "never";
const END_LABELS: Record<DayTitleEnd, string> = { day: "At the end of the day", date: "On a date", never: "Never" };

const POSITION_LABELS: Record<DayTitleEndPosition, string> = { below: "Below", above: "Above", right: "Right", left: "Left" };

export type DayTitleFields = Omit<DayTitle, "updated">;

export const DEFAULT_DAY_TITLE: DayTitleFields = { text: "", color: null, size: "large", bold: true, italic: false, highlight: false };

const DEFAULT_END_NOTE: DayTitleEndNote = { shown: false, text: "", color: null, size: "small", bold: false, italic: false, highlight: false, position: "below" };

const HEBREW = /[֐-׿]/;

/** Text whose letters can have their own colors: the heading and the end date's words. */
interface ColoredText {
	text: string;
	/** Set when some letters have their own color; their texts joined equal `text`. */
	parts?: DayTitlePart[];
	color: TaskColor | null;
}

/** The end date as DD/MM/YYYY ("2026-11-05" → "05/11/2026"), with its time if any; the same after Hebrew or English words. */
function endDateText(date: string, time?: string): string {
	const [y, m, d] = date.split("-");
	return time ? `${d}/${m}/${y} ${time}` : `${d}/${m}/${y}`;
}

/** Gives `el` the pill classes of a heading style. */
function applyStyle(el: HTMLElement, cls: string, s: DayTitleStyle): void {
	el.empty();
	el.className = `${cls} is-${s.size}`;
	el.toggleClass("is-bold", s.bold);
	el.toggleClass("is-italic", s.italic);
	el.toggleClass("is-highlight", s.highlight);
	el.toggleClass("has-color", !!s.color);
	if (s.color) el.style.setProperty("--tg-task-color", taskColorCss(s.color));
	else el.style.removeProperty("--tg-task-color");
}

/** The text in runs of one color; plain text when there are no (or outdated) letter colors. */
function partsOf(t: ColoredText): DayTitlePart[] {
	if (t.parts?.length && t.parts.map((p) => p.text).join("") === t.text) return t.parts;
	return [{ text: t.text, color: null }];
}

/** Draws text runs into `el`, a colored run as a span with its own color. */
function renderParts(el: HTMLElement, parts: DayTitlePart[]): void {
	for (const p of parts) {
		if (!p.color) {
			el.appendText(p.text);
			continue;
		}
		const span = el.createSpan({ text: p.text, attr: { "data-color": p.color } });
		span.style.color = taskColorCss(p.color);
	}
}

/** Draws a day heading with its style into `el` (the header and the modal's preview). */
export function renderDayTitle(el: HTMLElement, t: DayTitleFields, placeholder = ""): void {
	applyStyle(el, "tg-day-title", t);
	el.toggleClass("is-empty", !t.text);
	const text = el.createSpan({ cls: "tg-day-title-text", attr: { dir: "auto" } });
	if (t.text) renderParts(text, partsOf(t));
	else text.setText(placeholder);
}

/**
 * Draws the heading's end date with its words into `el`, or hides `el` when the heading has none to show.
 * Its direction follows the words: Hebrew reads right to left with the date on the left, English the other way.
 * `group` holds the heading and `el`; it stacks them when the end date goes below or above.
 */
export function renderDayTitleEnd(group: HTMLElement, el: HTMLElement, t: DayTitleFields): void {
	const note = t.endNote;
	const until = t.until;
	const position = note?.position ?? "below";
	if (!t.text || typeof until !== "string" || !note?.shown) {
		el.empty();
		el.className = "tg-day-title-end is-hidden";
		group.removeClass("is-stacked");
		return;
	}
	applyStyle(el, `tg-day-title tg-day-title-end is-${position}`, note);
	group.toggleClass("is-stacked", position === "below" || position === "above");
	const lead = note.text.length - note.text.trimStart().length;
	const words = note.text.trim();
	el.setAttribute("dir", HEBREW.test(words) ? "rtl" : "ltr");
	const text = el.createSpan({ cls: "tg-day-title-text" });
	if (words) {
		renderParts(text, trimRuns(partsOf(note), lead, words.length));
		text.appendText(" ");
	}
	text.appendText(endDateText(until, t.untilTime));
}

/**
 * A text field whose letters are colored by selecting them and picking a color from its row; without a selection the
 * row colors the whole text. Edits `target` in place and calls `changed` after every change.
 */
class LetterColorField {
	/** One color per character of the text (UTF-16 units, like the field's selection offsets). */
	private colors: (TaskColor | null)[] = [];
	/**
	 * A plain text field, not a rich-text box: its selection offsets belong to the field itself and stay as they are
	 * when a color is clicked, without depending on how the browser (or Obsidian) handles the page's selection.
	 */
	input!: HTMLInputElement;
	/** Shows what the color row will color. */
	private hint!: HTMLElement;
	private readonly onSelectionChange = () => this.updateHint();
	/** Also checks the field now and then, so the preview follows typing even if its events never arrive. */
	private poll = 0;

	constructor(
		private readonly target: ColoredText,
		/** What the whole text is called in the hint ("title", "words"). */
		private readonly noun: string,
		private readonly changed: () => void,
	) {
		for (const p of partsOf(target)) for (let i = 0; i < p.text.length; i++) this.colors.push(p.color);
	}

	/** Adds the field's row and its color row to `parent`. */
	build(parent: HTMLElement, o: { name: string; desc: string; placeholder: string; cls: string; onEnter: () => void }): void {
		const field = new Setting(parent).setName(o.name).setDesc(o.desc);
		this.input = field.controlEl.createEl("input", {
			cls: `tg-day-title-input ${o.cls}`,
			attr: { type: "text", dir: "auto", "aria-label": o.name, placeholder: o.placeholder },
		});
		this.input.value = this.target.text;
		const edited = () => this.sync();
		this.input.addEventListener("input", edited);
		this.input.addEventListener("change", edited);
		this.input.addEventListener("keyup", () => {
			edited();
			this.updateHint();
		});
		this.input.addEventListener("keydown", (e) => {
			if (e.key !== "Enter" || e.isComposing) return;
			e.preventDefault();
			this.sync();
			o.onEnter();
		});
		this.input.addEventListener("select", () => this.updateHint());
		this.input.addEventListener("mouseup", () => this.input.win.setTimeout(() => this.updateHint(), 0));
		this.input.doc.addEventListener("selectionchange", this.onSelectionChange);
		this.poll = this.input.win.setInterval(() => this.sync(), 200);

		const color = new Setting(parent).setName("Color");
		this.hint = color.descEl.createSpan({ cls: "tg-day-title-hint" });
		this.updateHint();
		const row = color.controlEl.createDiv({ cls: "tg-color-swatches", attr: { role: "group", "aria-label": `${o.name} color` } });
		const swatches: { el: HTMLElement; value: TaskColor | null }[] = [];
		const markActive = () => {
			const whole = !this.colors.some((c) => c);
			for (const w of swatches) w.el.toggleClass("is-active", whole && w.value === this.target.color);
		};
		const swatch = (value: TaskColor | null, label: string) => {
			const el = row.createDiv({ cls: "tg-color-swatch", attr: { role: "button", tabindex: "0", "aria-label": label } });
			swatches.push({ el, value });
			if (value) el.style.setProperty("--tg-task-color", taskColorCss(value));
			else {
				el.addClass("is-none");
				setIcon(el, "ban");
			}
			// Keeps the field focused so its selection stays visible (the offsets stay either way).
			el.addEventListener("mousedown", (e) => e.preventDefault());
			const apply = () => {
				this.sync();
				this.applyColor(value);
				markActive();
				this.changed();
			};
			el.addEventListener("click", apply);
			el.addEventListener("keydown", (e) => {
				if (e.key !== "Enter" && e.key !== " ") return;
				e.preventDefault();
				apply();
			});
		};
		swatch(null, "No color");
		for (const [value, label] of Object.entries(TASK_COLORS)) swatch(value as NamedTaskColor, label);
		markActive();
	}

	/**
	 * Takes the field's text into the target. Letter colors follow the edit: the unchanged start and end keep theirs,
	 * typed letters take the color of the letter before them.
	 */
	sync(): void {
		if (!this.input) return;
		const text = this.input.value;
		const old = this.target.text;
		if (text === old) return;
		let pre = 0;
		while (pre < old.length && pre < text.length && old[pre] === text[pre]) pre++;
		let suf = 0;
		while (suf < old.length - pre && suf < text.length - pre && old[old.length - 1 - suf] === text[text.length - 1 - suf]) suf++;
		const typed = new Array<TaskColor | null>(text.length - pre - suf).fill(pre > 0 ? (this.colors[pre - 1] ?? null) : null);
		this.colors = [...this.colors.slice(0, pre), ...typed, ...this.colors.slice(old.length - suf)];
		this.target.text = text;
		this.target.parts = this.colors.some((c) => c) ? this.runs(text) : undefined;
		this.changed();
		this.updateHint();
	}

	/** The text without leading and trailing spaces, with their letter colors gone too. */
	trimmed(): Pick<ColoredText, "text" | "parts"> {
		this.sync();
		const t = this.target;
		const lead = t.text.length - t.text.trimStart().length;
		const text = t.text.trim();
		const parts = t.parts ? trimRuns(this.runs(t.text), lead, text.length) : [];
		return { text, parts: parts.some((p) => p.color) ? parts : undefined };
	}

	/** Runs of one color from the per-character colors. */
	private runs(text: string): DayTitlePart[] {
		const parts: DayTitlePart[] = [];
		for (let i = 0; i < text.length; i++) {
			const c = this.colors[i] ?? null;
			const last = parts[parts.length - 1];
			if (last && last.color === c) last.text += text[i];
			else parts.push({ text: text[i], color: c });
		}
		return parts;
	}

	/** The letters selected in the field (start, end), null when only the caret is placed. */
	private selectedRange(): [number, number] | null {
		const start = this.input.selectionStart ?? 0;
		const end = this.input.selectionEnd ?? 0;
		return start === end ? null : [Math.min(start, end), Math.max(start, end)];
	}

	private updateHint(): void {
		if (!this.hint || !this.input) return;
		const sel = this.selectedRange();
		const text = sel ? this.input.value.slice(sel[0], sel[1]) : "";
		this.hint.setText(sel ? `Colors the selected letters: “${text}”` : `Colors the whole ${this.noun}. Select letters to color only them.`);
		this.hint.toggleClass("is-selection", !!sel);
	}

	/** Colors the selected letters; without a selection, the whole text (and drops the letter colors). */
	private applyColor(color: TaskColor | null): void {
		const sel = this.selectedRange();
		if (!sel) {
			this.target.color = color;
			this.colors = this.colors.map(() => null);
			this.target.parts = undefined;
			return;
		}
		const [start, end] = sel;
		for (let i = start; i < end; i++) this.colors[i] = color;
		this.target.parts = this.colors.some((c) => c) ? this.runs(this.target.text) : undefined;
		this.input.focus();
		this.input.setSelectionRange(start, end);
		this.updateHint();
	}

	destroy(): void {
		this.input?.win.clearInterval(this.poll);
		this.input?.doc.removeEventListener("selectionchange", this.onSelectionChange);
	}
}

/** Writes or restyles the heading of one day, and sets until when it is shown. */
export class DayTitleModal extends Modal {
	private draft: DayTitleFields;
	private note: DayTitleEndNote;
	private titleField: LetterColorField;
	private noteField: LetterColorField;
	private redraw: () => void = () => {};

	constructor(
		app: App,
		private readonly date: string,
		current: DayTitleFields,
		private readonly onSave: (t: DayTitleFields) => void,
		/** Given when the heading was written on an earlier day: starts a separate one for today instead. */
		private readonly onNewToday?: () => void,
	) {
		super(app);
		this.note = { ...DEFAULT_END_NOTE, ...(current.endNote ?? {}) };
		this.draft = { ...current, endNote: this.note };
		this.titleField = new LetterColorField(this.draft, "title", () => this.redraw());
		this.noteField = new LetterColorField(this.note, "words", () => this.redraw());
	}

	onOpen(): void {
		this.modalEl.addClass("tg-modal");
		this.setTitle(this.onNewToday ? `Topic · since ${shortDate(this.date)}` : `Topic of the day · ${shortDate(this.date)}`);
		const { contentEl } = this;
		const preview = contentEl.createDiv({ cls: "tg-day-title-preview" });
		// Like the header: left and right are on screen, whatever the language of the texts.
		const group = preview.createDiv({ cls: "tg-day-title-group", attr: { dir: "ltr" } });
		const previewText = group.createDiv();
		const previewEnd = group.createDiv();
		const redraw = (this.redraw = () => {
			renderDayTitle(previewText, this.draft, "What is today about?");
			renderDayTitleEnd(group, previewEnd, this.draft);
		});
		redraw();

		// Letters are colored by selecting them in the field and picking a color; the preview shows the result.
		this.titleField.build(contentEl, {
			name: "Title",
			desc: "To color only some letters, select them here and pick a color.",
			placeholder: "e.g. Exam prep 📚",
			cls: "tg-day-title-main-input",
			onEnter: () => this.save(),
		});
		const input = this.titleField.input;
		input.win.setTimeout(() => input.focus(), 0);
		this.styleRows(contentEl, this.draft);

		// Until when the header shows it. A date before the start counts as "at the end of the day" when saved.
		const ends = new Setting(contentEl)
			.setName("Ends")
			.setDesc("After that the header shows no topic (or an earlier one that still lasts). Without a time it ends at the end of that day.");
		const until = ends.controlEl.createEl("input", { cls: "tg-input tg-day-title-until", attr: { type: "date", min: this.date, "aria-label": "Last day" } });
		until.value = typeof this.draft.until === "string" ? this.draft.until : addDays(this.date, 7);
		// Empty = at the end of that day.
		const untilTime = ends.controlEl.createEl("input", { cls: "tg-input tg-day-title-until-time", attr: { type: "time", "aria-label": "End time" } });
		untilTime.value = this.draft.untilTime ?? "";
		const end: DayTitleEnd = this.draft.until === null ? "never" : this.draft.until ? "date" : "day";
		const note = this.note;
		const showUntil = (e: DayTitleEnd) => {
			until.toggleClass("tg-day-title-off", e !== "date");
			untilTime.toggleClass("tg-day-title-off", e !== "date");
			showNote.settingEl.toggleClass("tg-day-title-off", e !== "date");
			noteBox.toggleClass("tg-day-title-off", e !== "date" || !note.shown);
		};
		const readEnd = (e: DayTitleEnd) => {
			this.draft.until = e === "never" ? null : e === "date" && until.value ? until.value : undefined;
			this.draft.untilTime = typeof this.draft.until === "string" && untilTime.value ? untilTime.value : undefined;
			showUntil(e);
			redraw();
		};

		// The end date next to the heading, with the user's words and a style of its own.
		const showNote = new Setting(contentEl)
			.setName("Show the end date")
			.setDesc("Next to the topic, after words of your own.")
			.addToggle((t) =>
				t.setValue(note.shown).onChange((v) => {
					note.shown = v;
					showUntil(endChoice);
					redraw();
				}),
			);
		const noteBox = contentEl.createDiv({ cls: "tg-day-title-end-settings" });
		this.noteField.build(noteBox, {
			name: "Words before the date",
			desc: "Hebrew words put the date on their left, English ones on their right. Select letters to color only them.",
			placeholder: "e.g. Ends / עד",
			cls: "tg-day-title-end-input",
			onEnter: () => this.save(),
		});
		new Setting(noteBox).setName("Position").addDropdown((d) => {
			d.selectEl.setAttribute("aria-label", "End date position");
			for (const [k, label] of Object.entries(POSITION_LABELS)) d.addOption(k, label);
			d.setValue(note.position ?? "below").onChange((v) => {
				note.position = v as DayTitleEndPosition;
				redraw();
			});
		});
		this.styleRows(noteBox, note, "End date ");
		let endChoice = end;
		ends.addDropdown((d) => {
			for (const [k, label] of Object.entries(END_LABELS)) d.addOption(k, label);
			d.setValue(end).onChange((v) => readEnd((endChoice = v as DayTitleEnd)));
		});
		ends.controlEl.appendChild(until);
		ends.controlEl.appendChild(untilTime);
		until.addEventListener("change", () => readEnd(endChoice));
		untilTime.addEventListener("change", () => readEnd(endChoice));
		showUntil(end);
		redraw();

		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		buttons.createEl("button", { text: "Clear", cls: "mod-warning" }).addEventListener("click", () => this.save(true));
		if (this.onNewToday) {
			const fresh = this.onNewToday;
			buttons.createEl("button", { text: "New topic for today" }).addEventListener("click", () => {
				this.close();
				fresh();
			});
		}
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => this.save());
	}

	/** Size, bold, italic and background rows for one style. */
	private styleRows(parent: HTMLElement, s: DayTitleStyle, ariaPrefix = ""): void {
		new Setting(parent).setName("Size").addDropdown((d) => {
			d.selectEl.setAttribute("aria-label", `${ariaPrefix}size`);
			for (const [k, l] of Object.entries(SIZE_LABELS)) d.addOption(k, l);
			d.setValue(s.size).onChange((v) => {
				s.size = v as DayTitleSize;
				this.redraw();
			});
		});
		const toggle = (name: string, key: "bold" | "italic" | "highlight") =>
			new Setting(parent).setName(name).addToggle((t) =>
				t.setValue(s[key]).onChange((v) => {
					s[key] = v;
					this.redraw();
				}),
			);
		toggle("Bold", "bold");
		toggle("Italic", "italic");
		toggle("Background", "highlight");
	}

	private save(clear = false): void {
		const title = clear ? { text: "", parts: undefined } : this.titleField.trimmed();
		// An end before the start, or at the end of the start day itself, is the same as "At the end of the day".
		const d = this.draft.until;
		const until = typeof d === "string" && (d < this.date || (d === this.date && !this.draft.untilTime)) ? undefined : d;
		const untilTime = typeof until === "string" ? this.draft.untilTime : undefined;
		this.onSave({ ...this.draft, ...title, until, untilTime, endNote: { ...this.note, ...this.noteField.trimmed() } });
		this.close();
	}

	onClose(): void {
		this.titleField.destroy();
		this.noteField.destroy();
		this.contentEl.empty();
	}
}

/** The runs cut to `length` characters starting at `from`. */
function trimRuns(parts: DayTitlePart[], from: number, length: number): DayTitlePart[] {
	const out: DayTitlePart[] = [];
	let pos = 0;
	for (const p of parts) {
		const s = Math.max(from - pos, 0);
		const e = Math.min(from + length - pos, p.text.length);
		if (e > s) out.push({ text: p.text.slice(s, e), color: p.color });
		pos += p.text.length;
	}
	return out;
}
