import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import { isMediaFile } from "../stickyImages";
import type { TimeCapsule } from "../types";
import { addDays, today } from "../util/dates";
import { isVideo } from "../util/media";
import { ConfirmModal } from "./ConfirmModal";
import { DateField } from "./dateFields";

/** How the capsule windows reach the vault for the capsules' pictures and videos. */
export interface CapsuleMedia {
	/** Copies a picked file into the vault; resolves with its path. */
	save(file: File): Promise<string>;
	/** A URL that shows the file, null while it's missing (e.g. not synced yet). */
	url(path: string): string | null;
	/** Opens the file in a tab. */
	open(path: string): void;
}

/** What the topic's window needs for the time capsules section. */
export interface TopicCapsules {
	/** Capsules still sealed (or opening today), soonest first. */
	pending(): [string, TimeCapsule][];
	add(fields: Omit<TimeCapsule, "updated" | "deleted">): void;
	remove(id: string): void;
	media: CapsuleMedia;
}

/** "2026-12-07" → "07/12/2026". */
export function capsuleDate(date: string): string {
	const [y, m, d] = date.split("-");
	return `${d}/${m}/${y}`;
}

/** Draws one picture or video of a capsule; a file that isn't in the vault (yet) shows a placeholder. */
function renderCapsuleMedia(parent: HTMLElement, path: string, url: string | null, cls: string, controls: boolean): HTMLElement {
	const name = path.split("/").pop() ?? path;
	if (!url) return parent.createDiv({ cls: `${cls} is-missing`, text: `Not here yet: ${name}` });
	if (isVideo(path)) {
		const v = parent.createEl("video", { cls, attr: { src: url, preload: "metadata" } });
		v.controls = controls;
		v.muted = !controls;
		return v;
	}
	return parent.createEl("img", { cls, attr: { src: url, alt: name } });
}

/**
 * The time capsules section of the topic's window: the sealed capsules (only their day, never their contents),
 * deleting one, and writing a new one.
 */
export function renderCapsulesSection(app: App, parent: HTMLElement, capsules: TopicCapsules): void {
	new Setting(parent)
		.setName("Time capsules")
		.setDesc("Sealed notes to a day of your choice, with pictures or videos. Each one can be opened only on its day, from the capsule button next to the topic.")
		.setHeading();
	const list = parent.createDiv({ cls: "tg-capsule-list" });
	const draw = () => {
		list.empty();
		const now = today();
		for (const [id, c] of capsules.pending()) {
			const row = list.createDiv({ cls: "tg-capsule-row" });
			setIcon(row.createSpan({ cls: "tg-capsule-row-icon" }), c.opens === now ? "package-open" : "lock");
			row.createSpan({
				cls: "tg-capsule-row-text",
				text: c.opens === now ? "Opens today: use the button next to the topic" : `Sealed until ${capsuleDate(c.opens)}`,
			});
			row.createSpan({ cls: "tg-capsule-row-written", text: `written ${capsuleDate(c.written)}` });
			const del = row.createDiv({ cls: "clickable-icon tg-capsule-row-delete", attr: { role: "button", tabindex: "0", "aria-label": "Delete this capsule" } });
			setIcon(del, "trash-2");
			const ask = () =>
				new ConfirmModal(app, "Delete time capsule", `The capsule for ${capsuleDate(c.opens)} is deleted without being opened.`, "Delete", () => {
					capsules.remove(id);
					draw();
				}).open();
			del.addEventListener("click", ask);
			del.addEventListener("keydown", (e) => {
				if (e.key !== "Enter" && e.key !== " ") return;
				e.preventDefault();
				ask();
			});
		}
	};
	draw();
	new Setting(parent).addButton((b) =>
		b.setButtonText("New time capsule").onClick(() =>
			new CapsuleEditModal(app, capsules.media, (fields) => {
				capsules.add(fields);
				draw();
			}).open(),
		),
	);
}

/** Writes a new time capsule: its day, words and pictures / videos. Once saved it is sealed until that day. */
export class CapsuleEditModal extends Modal {
	private capsuleText = "";
	/** Picked files, copied into the vault on save. */
	private picked: { file: File; preview: string }[] = [];
	private saving = false;
	private opensField: DateField | null = null;

	constructor(
		app: App,
		private readonly media: CapsuleMedia,
		private readonly onSave: (fields: Omit<TimeCapsule, "updated" | "deleted">) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("tg-modal", "tg-capsule-edit-modal");
		this.setTitle("New time capsule");
		const { contentEl } = this;
		const day = new Setting(contentEl).setName("Opens on").setDesc("Only on this day a button next to the topic opens it. Until then it stays sealed, even to you.");
		this.opensField = new DateField(day.controlEl, {
			value: addDays(today(), 7),
			label: "Opens on",
			cls: "tg-capsule-opens",
			min: () => today(),
			panelParent: day.settingEl,
			onChange: () => {},
		});

		const box = contentEl.createDiv({ cls: "tg-capsule-edit" });
		const area = box.createEl("textarea", {
			cls: "tg-capsule-input",
			attr: { dir: "auto", rows: "5", "aria-label": "Time capsule text", placeholder: "Words for that day…" },
		});
		area.addEventListener("input", () => (this.capsuleText = area.value));
		area.win.setTimeout(() => area.focus(), 0);

		const list = box.createDiv({ cls: "tg-capsule-thumbs" });
		const draw = () => {
			list.empty();
			this.picked.forEach((item, i) => {
				const cell = list.createDiv({ cls: "tg-capsule-thumb" });
				renderCapsuleMedia(cell, item.file.name, item.preview, "tg-capsule-thumb-media", false);
				const remove = cell.createDiv({ cls: "tg-capsule-remove", attr: { role: "button", tabindex: "0", "aria-label": "Remove from the capsule" } });
				setIcon(remove, "x");
				const drop = () => {
					const [gone] = this.picked.splice(i, 1);
					if (gone) URL.revokeObjectURL(gone.preview);
					draw();
				};
				remove.addEventListener("click", drop);
				remove.addEventListener("keydown", (e) => {
					if (e.key !== "Enter" && e.key !== " ") return;
					e.preventDefault();
					drop();
				});
			});
		};
		const add = (files: File[]) => {
			const ok = files.filter(isMediaFile);
			if (ok.length < files.length) new Notice("Only pictures and videos go into the capsule.");
			for (const file of ok) this.picked.push({ file, preview: URL.createObjectURL(file) });
			draw();
		};

		const picker = box.createEl("input", { cls: "tg-color-input", attr: { type: "file", accept: "image/*,video/*", multiple: "", tabindex: "-1", "aria-hidden": "true" } });
		picker.addEventListener("change", () => {
			add(Array.from(picker.files ?? []));
			picker.value = "";
		});
		box.createEl("button", { text: "Add picture or video", cls: "tg-capsule-add" }).addEventListener("click", () => picker.click());
		// Files dropped on the capsule's box, or pasted into its text.
		box.addEventListener("dragover", (e) => {
			if (!e.dataTransfer?.types.includes("Files")) return;
			e.preventDefault();
			box.addClass("is-drop");
		});
		box.addEventListener("dragleave", () => box.removeClass("is-drop"));
		box.addEventListener("drop", (e) => {
			box.removeClass("is-drop");
			const files = Array.from(e.dataTransfer?.files ?? []);
			if (!files.length) return;
			e.preventDefault();
			add(files);
		});
		area.addEventListener("paste", (e) => {
			const files = Array.from(e.clipboardData?.files ?? []).filter(isMediaFile);
			if (!files.length) return;
			e.preventDefault();
			add(files);
		});

		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: "Seal", cls: "mod-cta" }).addEventListener("click", () => void this.seal());
	}

	private async seal(): Promise<void> {
		if (this.saving) return;
		const text = this.capsuleText.trim();
		if (!text && !this.picked.length) {
			new Notice("Write something or add a picture or video first.");
			return;
		}
		// A day picked before midnight can be past by now.
		const opens = this.opensField?.value ?? "";
		if (!opens || opens < today()) {
			new Notice("Pick the day it opens (today or later).");
			return;
		}
		this.saving = true;
		const media: string[] = [];
		try {
			for (const item of this.picked) media.push(await this.media.save(item.file));
		} catch (e) {
			console.error("Task Gift: could not save a capsule file", e);
			new Notice("Could not save a picture or video into the vault.");
			this.saving = false;
			return;
		}
		this.onSave({ opens, written: today(), text, media });
		this.close();
	}

	onClose(): void {
		this.opensField?.close();
		for (const item of this.picked) URL.revokeObjectURL(item.preview);
		this.contentEl.empty();
	}
}

/** Opens the capsules whose day is today: their words and pictures / videos. */
export class CapsuleModal extends Modal {
	constructor(
		app: App,
		private readonly capsules: TimeCapsule[],
		private readonly media: CapsuleMedia,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("tg-modal", "tg-capsule-modal");
		this.setTitle(this.capsules.length === 1 ? "Time capsule" : `Time capsules (${this.capsules.length})`);
		const { contentEl } = this;
		for (const c of this.capsules) {
			const section = contentEl.createDiv({ cls: "tg-capsule-section" });
			section.createDiv({ cls: "tg-capsule-written", text: `Written ${capsuleDate(c.written)}` });
			const text = c.text.trim();
			if (text) section.createDiv({ cls: "tg-capsule-text", text, attr: { dir: "auto" } });
			if (!c.media.length) continue;
			const list = section.createDiv({ cls: "tg-capsule-gallery" });
			for (const path of c.media) {
				const el = renderCapsuleMedia(list, path, this.media.url(path), "tg-capsule-item", true);
				if (el instanceof HTMLImageElement) {
					el.setAttribute("title", "Double-click to open");
					el.addEventListener("dblclick", () => {
						this.close();
						this.media.open(path);
					});
				}
			}
		}
		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Close", cls: "mod-cta" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
