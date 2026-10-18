import { App, Modal, Notice, Setting } from "obsidian";
import type { DayColumn } from "../types";
import { addDays, isDateString, today } from "../util/dates";

/** Creates or edits a board column for one chosen day. */
export class DayColumnModal extends Modal {
	private date: string;
	private name: string;
	private autoRemove: boolean;

	constructor(
		app: App,
		private readonly existing: DayColumn | null,
		/** Dates that already have a column (other than the one being edited). */
		private readonly takenDates: string[],
		private readonly onSave: (fields: Omit<DayColumn, "id">) => void,
	) {
		super(app);
		this.date = existing?.date ?? addDays(today(), 2);
		this.name = existing?.title ?? "";
		this.autoRemove = existing?.autoRemove ?? true;
	}

	onOpen(): void {
		this.modalEl.addClass("tg-modal");
		this.setTitle(this.existing ? "Edit day column" : "New day column");
		const { contentEl } = this;

		new Setting(contentEl)
			.setName("Day")
			.setDesc("The column shows the tasks due on this day.")
			.addText((t) => {
				t.inputEl.type = "date";
				t.setValue(this.date).onChange((v) => (this.date = v));
			});
		new Setting(contentEl)
			.setName("Name")
			.setDesc("Optional. Without a name the column shows the date.")
			.addText((t) => t.setPlaceholder("e.g. Trip day").setValue(this.name).onChange((v) => (this.name = v)));
		new Setting(contentEl)
			.setName("Remove when the day ends")
			.setDesc("The column disappears automatically after its day.")
			.addToggle((t) => t.setValue(this.autoRemove).onChange((v) => (this.autoRemove = v)));

		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: this.existing ? "Save" : "Add column", cls: "mod-cta" }).addEventListener("click", () => this.save());
	}

	private save(): void {
		if (!isDateString(this.date)) {
			new Notice("Pick a day.");
			return;
		}
		if (this.takenDates.includes(this.date)) {
			new Notice("There is already a column for this day.");
			return;
		}
		this.onSave({ date: this.date, title: this.name.trim(), autoRemove: this.autoRemove });
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
