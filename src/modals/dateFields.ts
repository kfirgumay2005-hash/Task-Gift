import { setIcon } from "obsidian";
import { addDays, addMonths, parseDate, parseTime, startOfWeek, today, WEEKDAY_SHORT } from "../util/dates";

let weekStartOf: () => number = () => 0;

/** Where the calendars get the first day of the week; read each time one is drawn, so a change from another device counts. */
export function useWeekStart(get: () => number): void {
	weekStartOf = get;
}

export interface DateFieldOptions {
	value: string;
	/** What the field is, for screen readers. */
	label: string;
	/** Extra class of the field. */
	cls?: string;
	/** Text shown while empty. */
	placeholder?: string;
	/** The earliest day that can be picked; read each time the calendar is drawn. */
	min?: () => string;
	/** The calendar opens as a full-width line of this element (the field's row, or a Setting's `settingEl`). */
	panelParent: HTMLElement;
	onChange: (value: string) => void;
}

/** A date field that opens a month calendar in the form, in place of the browser's date popup. Divs, not buttons: Obsidian's button styles would paint over their colors. */
export class DateField {
	readonly el: HTMLElement;
	private readonly labelEl: HTMLElement;
	private readonly panel: HTMLElement;
	private readonly monthEl: HTMLElement;
	private readonly daysEl: HTMLElement;
	private readonly quickEl: HTMLElement;
	private current: string;
	/** The first day of the month on screen. */
	private shownMonth = "";

	private readonly onPointerDown = (e: PointerEvent) => {
		const target = e.target as Node;
		if (!this.panel.isConnected || !(this.panel.contains(target) || this.el.contains(target))) this.close();
	};

	constructor(parent: HTMLElement, private readonly opts: DateFieldOptions) {
		this.current = opts.value;
		this.el = parent.createDiv({
			cls: ["tg-date-field", ...(opts.cls ? [opts.cls] : [])],
			attr: { role: "button", tabindex: "0", "aria-label": opts.label, "aria-expanded": "false" },
		});
		setIcon(this.el.createSpan({ cls: "tg-date-field-icon" }), "calendar");
		this.labelEl = this.el.createSpan();
		this.el.addEventListener("click", () => this.toggle());
		this.el.addEventListener("keydown", (e) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			this.toggle();
		});

		opts.panelParent.addClass("tg-date-host");
		this.panel = opts.panelParent.createDiv({ cls: "tg-date-panel is-hidden", attr: { dir: "ltr" } });
		const head = this.panel.createDiv({ cls: "tg-date-head" });
		this.navButton(head, "chevrons-left", "Previous year", -12);
		this.navButton(head, "chevron-left", "Previous month", -1);
		this.monthEl = head.createDiv({ cls: "tg-date-month" });
		this.navButton(head, "chevron-right", "Next month", 1);
		this.navButton(head, "chevrons-right", "Next year", 12);
		const weekdays = this.panel.createDiv({ cls: "tg-date-grid tg-date-weekdays" });
		for (let i = 0; i < 7; i++) weekdays.createDiv();
		this.daysEl = this.panel.createDiv({ cls: "tg-date-grid" });
		this.quickEl = this.panel.createDiv({ cls: "tg-date-quick" });
		this.showLabel();
	}

	get value(): string {
		return this.current;
	}

	set value(v: string) {
		this.current = v;
		this.showLabel();
		if (this.isOpen()) {
			this.shownMonth = this.monthOf(v || today());
			this.draw();
		}
	}

	close(): void {
		this.panel.addClass("is-hidden");
		this.el.setAttribute("aria-expanded", "false");
		this.el.ownerDocument.removeEventListener("pointerdown", this.onPointerDown);
	}

	private isOpen(): boolean {
		return !this.panel.hasClass("is-hidden");
	}

	private toggle(): void {
		if (this.isOpen()) {
			this.close();
			return;
		}
		this.shownMonth = this.monthOf(this.current || today());
		this.draw();
		this.panel.removeClass("is-hidden");
		this.el.setAttribute("aria-expanded", "true");
		this.el.ownerDocument.addEventListener("pointerdown", this.onPointerDown);
	}

	private monthOf(date: string): string {
		return `${date.slice(0, 7)}-01`;
	}

	private showLabel(): void {
		this.el.dataset.value = this.current;
		this.el.toggleClass("is-empty", !this.current);
		this.labelEl.setText(
			this.current
				? parseDate(this.current).toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
				: (this.opts.placeholder ?? "Pick a date"),
		);
	}

	private pick(date: string): void {
		this.value = date;
		this.close();
		this.opts.onChange(date);
	}

	private pressable(el: HTMLElement, onPress: () => void): void {
		el.setAttribute("role", "button");
		el.setAttribute("tabindex", "0");
		el.addEventListener("click", onPress);
		el.addEventListener("keydown", (e) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			onPress();
		});
	}

	private navButton(parent: HTMLElement, icon: string, label: string, months: number): void {
		const el = parent.createDiv({ cls: "tg-date-nav", attr: { "aria-label": label } });
		setIcon(el, icon);
		this.pressable(el, () => {
			this.shownMonth = addMonths(this.shownMonth, months);
			this.draw();
		});
	}

	private draw(): void {
		const t0 = today();
		const min = this.opts.min?.() ?? "";
		const weekStart = weekStartOf();
		this.monthEl.setText(parseDate(this.shownMonth).toLocaleDateString("en", { month: "long", year: "numeric" }));
		this.panel.querySelectorAll<HTMLElement>(".tg-date-weekdays > div").forEach((el, i) => el.setText(WEEKDAY_SHORT[(i + weekStart) % 7].slice(0, 2)));

		this.daysEl.empty();
		// Always six weeks, so the panel doesn't change height from month to month.
		const first = startOfWeek(this.shownMonth, weekStart);
		for (let i = 0; i < 42; i++) {
			const date = addDays(first, i);
			const cell = this.daysEl.createDiv({ cls: "tg-date-day", text: String(parseDate(date).getDate()), attr: { "data-date": date, "aria-label": date } });
			cell.toggleClass("is-outside", !date.startsWith(this.shownMonth.slice(0, 7)));
			cell.toggleClass("is-today", date === t0);
			cell.toggleClass("is-selected", date === this.current);
			if (date < min) {
				cell.addClass("is-disabled");
				cell.setAttribute("aria-disabled", "true");
			} else this.pressable(cell, () => this.pick(date));
		}

		this.quickEl.empty();
		for (const [label, date] of [
			["Today", t0],
			["Tomorrow", addDays(t0, 1)],
			["Next week", addDays(t0, 7)],
		]) {
			if (date < min) continue;
			this.pressable(this.quickEl.createDiv({ cls: "tg-date-quick-item", text: label }), () => this.pick(date));
		}
	}
}

export interface TimeFieldOptions {
	value: string;
	label: string;
	cls?: string;
	onChange: (value: string) => void;
}

/**
 * A time typed in 24 hours ("14:30", also "1430", "9", "2:30pm"), in place of the browser's time field. That one follows
 * the computer's language: with a 12-hour clock it stays empty until AM/PM is set, while looking filled in, so a typed
 * "09:30" was silently not saved.
 */
export class TimeField {
	readonly el: HTMLInputElement;
	private parsed: string;

	constructor(parent: HTMLElement, private readonly opts: TimeFieldOptions) {
		this.parsed = opts.value;
		this.el = parent.createEl("input", {
			cls: ["tg-input", "tg-time-field", ...(opts.cls ? [opts.cls] : [])],
			attr: { type: "text", placeholder: "HH:MM", maxlength: "8", inputmode: "numeric", dir: "ltr", "aria-label": opts.label },
		});
		this.el.value = opts.value;
		this.el.addEventListener("input", () => {
			this.el.removeClass("is-invalid");
			const next = parseTime(this.el.value) ?? "";
			if (next === this.parsed) return;
			this.parsed = next;
			this.opts.onChange(next);
		});
		this.el.addEventListener("blur", () => {
			if (this.parsed) this.el.value = this.parsed;
			this.el.toggleClass("is-invalid", !this.isValid);
		});
	}

	/** HH:MM, or empty when nothing (or nothing valid) was typed. */
	get value(): string {
		return this.parsed;
	}

	set value(v: string) {
		this.parsed = v;
		this.el.value = v;
		this.el.removeClass("is-invalid");
	}

	/** False when something was typed that isn't a time; saving must stop then, not drop it. */
	get isValid(): boolean {
		return !this.el.value.trim() || parseTime(this.el.value) !== null;
	}

	set disabled(off: boolean) {
		this.el.disabled = off;
	}
}

export const INVALID_TIME = "That time isn't valid. Enter it as HH:MM, e.g. 14:30.";
