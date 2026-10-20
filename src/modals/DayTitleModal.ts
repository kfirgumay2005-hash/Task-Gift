import { App, Modal, Setting, setIcon } from "obsidian";
import { TASK_COLORS, taskColorCss } from "../defaults";
import type { DayTitle, DayTitlePart, DayTitleSize, NamedTaskColor, TaskColor } from "../types";
import { shortDate } from "../util/dates";

const SIZE_LABELS: Record<DayTitleSize, string> = { small: "Small", normal: "Normal", large: "Large", huge: "Huge" };

export type DayTitleFields = Omit<DayTitle, "updated">;

export const DEFAULT_DAY_TITLE: DayTitleFields = { text: "", color: null, size: "large", bold: true, italic: false, highlight: false };

/** The heading's text in runs of one color; plain text when there are no (or outdated) letter colors. */
function partsOf(t: DayTitleFields): DayTitlePart[] {
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
	el.empty();
	el.className = `tg-day-title is-${t.size}`;
	el.toggleClass("is-bold", t.bold);
	el.toggleClass("is-italic", t.italic);
	el.toggleClass("is-highlight", t.highlight);
	el.toggleClass("has-color", !!t.color);
	el.toggleClass("is-empty", !t.text);
	if (t.color) el.style.setProperty("--tg-task-color", taskColorCss(t.color));
	else el.style.removeProperty("--tg-task-color");
	const text = el.createSpan({ cls: "tg-day-title-text", attr: { dir: "auto" } });
	if (t.text) renderParts(text, partsOf(t));
	else text.setText(placeholder);
}

/** Writes or restyles the heading of one day. */
export class DayTitleModal extends Modal {
	private draft: DayTitleFields;
	/** One color per character of the text (UTF-16 units, like the field's selection offsets). */
	private colors: (TaskColor | null)[] = [];
	/**
	 * A plain text field, not a rich-text box: its selection offsets belong to the field itself and stay as they are
	 * when a color is clicked, without depending on how the browser (or Obsidian) handles the page's selection.
	 */
	private input!: HTMLInputElement;
	/** Shows what the color row will color. */
	private hint!: HTMLElement;
	private redraw: () => void = () => {};
	private readonly onSelectionChange = () => this.updateHint();
	/** Also checks the field now and then, so the preview follows typing even if its events never arrive. */
	private poll = 0;

	constructor(
		app: App,
		private readonly date: string,
		current: DayTitleFields,
		private readonly onSave: (t: DayTitleFields) => void,
	) {
		super(app);
		this.draft = { ...current };
		for (const p of partsOf(current)) for (let i = 0; i < p.text.length; i++) this.colors.push(p.color);
	}

	onOpen(): void {
		this.modalEl.addClass("tg-modal");
		this.setTitle(`Topic of the day · ${shortDate(this.date)}`);
		const { contentEl } = this;
		const preview = contentEl.createDiv({ cls: "tg-day-title-preview" });
		const previewText = preview.createDiv();
		const redraw = (this.redraw = () => renderDayTitle(previewText, this.draft, "What is today about?"));
		redraw();

		// Letters are colored by selecting them in the field and picking a color; the preview shows the result.
		const title = new Setting(contentEl).setName("Title").setDesc("To color only some letters, select them here and pick a color.");
		this.input = title.controlEl.createEl("input", {
			cls: "tg-day-title-input",
			attr: { type: "text", dir: "auto", "aria-label": "Title", placeholder: "e.g. Exam prep 📚" },
		});
		this.input.value = this.draft.text;
		const edited = () => this.onEdited();
		this.input.addEventListener("input", edited);
		this.input.addEventListener("change", edited);
		this.input.addEventListener("keyup", () => {
			edited();
			this.updateHint();
		});
		this.input.addEventListener("keydown", (e) => {
			if (e.key !== "Enter" || e.isComposing) return;
			e.preventDefault();
			this.onEdited();
			this.save(this.draft);
		});
		this.input.addEventListener("select", () => this.updateHint());
		this.input.addEventListener("mouseup", () => this.input.win.setTimeout(() => this.updateHint(), 0));
		this.input.doc.addEventListener("selectionchange", this.onSelectionChange);
		this.poll = this.input.win.setInterval(() => this.onEdited(), 200);
		this.input.win.setTimeout(() => this.input.focus(), 0);

		// One color row: with letters selected it colors them, otherwise the whole title.
		const color = new Setting(contentEl).setName("Color");
		this.hint = color.descEl.createSpan({ cls: "tg-day-title-hint" });
		this.updateHint();
		const row = color.controlEl.createDiv({ cls: "tg-color-swatches", attr: { role: "group", "aria-label": "Color" } });
		const swatches: { el: HTMLElement; value: TaskColor | null }[] = [];
		const markActive = () => {
			const whole = !this.colors.some((c) => c);
			for (const w of swatches) w.el.toggleClass("is-active", whole && w.value === this.draft.color);
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
				this.onEdited();
				this.applyColor(value);
				markActive();
				redraw();
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
		new Setting(contentEl).setName("Size").addDropdown((d) => {
			for (const [k, label] of Object.entries(SIZE_LABELS)) d.addOption(k, label);
			d.setValue(this.draft.size).onChange((v) => {
				this.draft.size = v as DayTitleSize;
				redraw();
			});
		});
		const toggle = (name: string, key: "bold" | "italic" | "highlight") =>
			new Setting(contentEl).setName(name).addToggle((t) =>
				t.setValue(this.draft[key]).onChange((v) => {
					this.draft[key] = v;
					redraw();
				}),
			);
		toggle("Bold", "bold");
		toggle("Italic", "italic");
		toggle("Background", "highlight");

		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		buttons.createEl("button", { text: "Clear", cls: "mod-warning" }).addEventListener("click", () => this.save({ ...this.draft, text: "", parts: undefined }));
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => {
			this.onEdited();
			this.save(this.draft);
		});
	}

	/**
	 * Takes the field's text into the draft and the preview. Letter colors follow the edit: the unchanged start and end
	 * keep theirs, typed letters take the color of the letter before them.
	 */
	private onEdited(): void {
		const text = this.input.value;
		const old = this.draft.text;
		if (text === old) return;
		let pre = 0;
		while (pre < old.length && pre < text.length && old[pre] === text[pre]) pre++;
		let suf = 0;
		while (suf < old.length - pre && suf < text.length - pre && old[old.length - 1 - suf] === text[text.length - 1 - suf]) suf++;
		const typed = new Array<TaskColor | null>(text.length - pre - suf).fill(pre > 0 ? (this.colors[pre - 1] ?? null) : null);
		this.colors = [...this.colors.slice(0, pre), ...typed, ...this.colors.slice(old.length - suf)];
		this.draft.text = text;
		this.draft.parts = this.colors.some((c) => c) ? this.runs(text) : undefined;
		this.redraw();
		this.updateHint();
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
		this.hint.setText(sel ? `Colors the selected letters: “${text}”` : "Colors the whole title. Select letters to color only them.");
		this.hint.toggleClass("is-selection", !!sel);
	}

	/** Colors the selected letters; without a selection, the whole title (and drops the letter colors). */
	private applyColor(color: TaskColor | null): void {
		const sel = this.selectedRange();
		if (!sel) {
			this.draft.color = color;
			this.colors = this.colors.map(() => null);
			this.draft.parts = undefined;
			return;
		}
		const [start, end] = sel;
		for (let i = start; i < end; i++) this.colors[i] = color;
		this.draft.parts = this.colors.some((c) => c) ? this.runs(this.draft.text) : undefined;
		this.input.focus();
		this.input.setSelectionRange(start, end);
		this.updateHint();
	}

	private save(t: DayTitleFields): void {
		// Leading and trailing spaces go, with their letter colors.
		const lead = t.text.length - t.text.trimStart().length;
		const text = t.text.trim();
		const parts = t.parts ? trimRuns(this.runs(t.text), lead, text.length) : [];
		this.onSave({ ...t, text, parts: parts.some((p) => p.color) ? parts : undefined });
		this.close();
	}

	onClose(): void {
		this.input?.win.clearInterval(this.poll);
		this.input?.doc.removeEventListener("selectionchange", this.onSelectionChange);
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
