import { App, Modal } from "obsidian";

export class ConfirmModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private readonly heading: string,
		private readonly message: string | string[],
		private readonly confirmText: string,
		private readonly onConfirm: () => void,
		private readonly onCancel?: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		const msgs = Array.isArray(this.message) ? this.message : [this.message];
		const [first, ...rest] = msgs;
		this.contentEl.createEl("p", { text: first });
		if (rest.length) {
			const ul = this.contentEl.createEl("ul", { cls: "tg-confirm-list" });
			for (const m of rest.slice(0, 15)) ul.createEl("li", { text: m });
			if (rest.length > 15) ul.createEl("li", { text: `…and ${rest.length - 15} more` });
		}
		const buttons = this.contentEl.createDiv({ cls: "tg-modal-buttons" });
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: this.confirmText, cls: "mod-warning" }).addEventListener("click", () => {
			this.confirmed = true;
			this.close();
			this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.confirmed) this.onCancel?.();
	}
}
