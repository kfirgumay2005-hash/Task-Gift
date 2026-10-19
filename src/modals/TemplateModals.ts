import { App, Menu, Modal, Notice, Setting } from "obsidian";
import { DescriptionTemplate, fillTemplate, hasFields, templateLines, TemplateStore } from "../calendars/templates";
import { ConfirmModal } from "./ConfirmModal";
import { attachNotesToolbar } from "./NotesEditor";

const FIELDS_HELP = 'Lines ending with ":" and every "___" become fields: inserting the template then opens a form to fill them in. A template without them is inserted as is.';

/** Grows a textarea with its text. */
function autoFit(area: HTMLTextAreaElement): () => void {
	const fit = () => {
		area.setCssStyles({ height: "auto" });
		area.setCssStyles({ height: `${area.scrollHeight + 2}px` });
	};
	area.addEventListener("input", fit);
	return fit;
}

/**
 * The templates menu of a description: insert one (via the form when it has fields), save the description as a
 * new template, or manage them.
 */
export async function showTemplatesMenu(app: App, store: TemplateStore, e: MouseEvent, description: () => string, insert: (text: string) => void): Promise<void> {
	let templates: DescriptionTemplate[] = [];
	try {
		templates = await store.all();
	} catch (err) {
		new Notice(`Could not read the templates: ${err instanceof Error ? err.message : String(err)}`);
	}
	const menu = new Menu();
	if (!templates.length) menu.addItem((i) => i.setTitle("No templates yet").setDisabled(true));
	for (const t of templates) {
		const form = hasFields(t.text);
		menu.addItem((i) =>
			i
				.setTitle(form ? `${t.name}…` : t.name)
				.setIcon(form ? "form-input" : "file-text")
				.onClick(() => {
					if (form) new TemplateFillModal(app, t, insert).open();
					else insert(t.text);
				}),
		);
	}
	menu.addSeparator();
	menu.addItem((i) =>
		i
			.setTitle("Save description as template…")
			.setIcon("save")
			.onClick(() => {
				if (!description().trim()) {
					new Notice("Write a description first, or create the template under Manage templates.");
					return;
				}
				new TemplateEditModal(app, store, null, description(), () => new Notice("Template saved.")).open();
			}),
	);
	menu.addItem((i) => i.setTitle("Manage templates…").setIcon("settings").onClick(() => new TemplatesModal(app, store).open()));
	menu.showAtMouseEvent(e);
}

/** Creates or edits a template: a name and its text. */
export class TemplateEditModal extends Modal {
	private name: string;
	private text: string;

	constructor(
		app: App,
		private readonly store: TemplateStore,
		private readonly existing: DescriptionTemplate | null,
		text: string,
		private readonly onDone: () => void,
	) {
		super(app);
		this.name = existing?.name ?? "";
		this.text = existing?.text ?? text;
	}

	onOpen(): void {
		this.modalEl.addClass("tg-modal", "tg-entry-modal");
		this.setTitle(this.existing ? "Edit template" : "New template");
		const { contentEl } = this;
		contentEl.createEl("p", { cls: "setting-item-description", text: FIELDS_HELP });
		new Setting(contentEl).setName("Name").addText((t) => {
			t.setPlaceholder("e.g. Bag check").setValue(this.name).onChange((v) => (this.name = v));
			t.inputEl.setAttr("dir", "auto");
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		const area = contentEl.createEl("textarea", { cls: "tg-import-text tg-entry-notes", attr: { placeholder: "The template's text", dir: "auto", rows: "12" } });
		area.value = this.text;
		const fit = autoFit(area);
		attachNotesToolbar(area, (v) => (this.text = v), fit);
		window.setTimeout(fit, 0);

		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => void this.save());
	}

	private async save(): Promise<void> {
		if (!this.text.trim()) {
			new Notice("The template is empty.");
			return;
		}
		try {
			await this.store.save(this.existing, this.name, this.text);
			this.close();
			this.onDone();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Lists the templates to add, edit or delete them. */
export class TemplatesModal extends Modal {
	constructor(
		app: App,
		private readonly store: TemplateStore,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("tg-modal");
		this.setTitle("Description templates");
		void this.draw();
	}

	private async draw(): Promise<void> {
		const { contentEl } = this;
		const templates = await this.store.all();
		contentEl.empty();
		contentEl.createEl("p", { cls: "setting-item-description", text: `${FIELDS_HELP} Each template is a note in the Templates folder next to the data note.` });
		if (!templates.length) contentEl.createDiv({ cls: "tg-notes-empty", text: "No templates yet." });
		for (const t of templates) {
			const row = new Setting(contentEl).setName(t.name).setDesc(hasFields(t.text) ? "Form" : "Text");
			row.nameEl.setAttr("dir", "auto");
			row.addExtraButton((b) =>
				b
					.setIcon("pencil")
					.setTooltip("Edit")
					.onClick(() => new TemplateEditModal(this.app, this.store, t, "", () => void this.draw()).open()),
			);
			row.addExtraButton((b) =>
				b
					.setIcon("trash-2")
					.setTooltip("Delete")
					.onClick(() =>
						new ConfirmModal(this.app, "Delete template?", `"${t.name}" goes to the trash (its note can be restored from there).`, "Delete", () =>
							void this.store.remove(t).then(() => this.draw()),
						).open(),
					),
			);
		}
		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		buttons.createDiv({ cls: "tg-spacer" });
		buttons
			.createEl("button", { text: "New template", cls: "mod-cta" })
			.addEventListener("click", () => new TemplateEditModal(this.app, this.store, null, "", () => void this.draw()).open());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Shows a template with an input for each field; "Insert" puts the filled template into the description. */
export class TemplateFillModal extends Modal {
	constructor(
		app: App,
		private readonly template: DescriptionTemplate,
		private readonly insert: (text: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("tg-modal", "tg-template-fill-modal");
		this.setTitle(this.template.name);
		const { contentEl } = this;
		const lines = templateLines(this.template.text);
		const blanks: string[][] = lines.map(() => []);
		const answers: string[] = lines.map(() => "");
		const inputs: HTMLElement[] = [];

		const form = contentEl.createDiv({ cls: "tg-template-form", attr: { dir: "auto" } });
		lines.forEach((l, i) => {
			if (!l.raw.trim()) {
				form.createDiv({ cls: "tg-note-gap" });
				return;
			}
			const row = form.createDiv({ cls: "tg-template-line", attr: { dir: "auto" } });
			const indent = /^\s*/.exec(l.raw)?.[0].length ?? 0;
			if (indent) row.style.setProperty("--tg-note-indent", String(Math.ceil(indent / 4)));
			if (l.pieces.length === 1 && !l.answer) {
				row.addClass("is-text");
				row.setText(l.raw.trim());
				return;
			}
			l.pieces.forEach((piece, j) => {
				const text = j === 0 ? piece.trimStart() : piece;
				if (text) row.createSpan({ text });
				if (j === l.pieces.length - 1) return;
				const blank = row.createEl("input", { cls: "tg-template-blank", attr: { type: "text", dir: "auto", "aria-label": `Blank ${j + 1}` } });
				blank.addEventListener("input", () => (blanks[i][j] = blank.value));
				inputs.push(blank);
			});
			if (!l.answer) return;
			const answer = row.createEl("textarea", { cls: "tg-template-answer", attr: { rows: "1", dir: "auto", "aria-label": l.raw.trim() } });
			autoFit(answer);
			answer.addEventListener("input", () => (answers[i] = answer.value));
			inputs.push(answer);
		});
		contentEl.createDiv({ cls: "tg-notes-hint", text: "Enter: next field · Shift+Enter: new line · Ctrl+Enter: insert. Empty fields stay as they are." });

		const done = () => {
			this.insert(fillTemplate(lines, blanks, answers));
			this.close();
		};
		inputs.forEach((input, k) => {
			input.addEventListener("keydown", (e) => {
				if (e.key !== "Enter" || e.isComposing || e.shiftKey || e.altKey) return;
				e.preventDefault();
				if (e.ctrlKey || e.metaKey || k === inputs.length - 1) done();
				else inputs[k + 1].focus();
			});
		});
		window.setTimeout(() => inputs[0]?.focus(), 0);

		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: "Insert", cls: "mod-cta" }).addEventListener("click", done);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
