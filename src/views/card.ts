import { Menu, setIcon } from "obsidian";
import { ConfirmModal } from "../modals/ConfirmModal";
import type TaskGiftPlugin from "../main";
import type { Task } from "../types";
import { describeRule } from "../recurrence/rule";
import { addDays, friendlyDate, today } from "../util/dates";
import { taskColorCss } from "../defaults";

export interface CardOptions {
	showList: boolean;
	draggable: boolean;
	/** Show the completion checkbox. */
	checkbox: boolean;
	notesLines?: number;
	/** Show the actions menu (⋯ button, right-click, long-press). Default true. */
	menu?: boolean;
	/** Which view the card is in, for the "Show task colors" setting. Unset = never colored. */
	colorIn?: "board" | "calendar";
	/**
	 * Shows the card as an upcoming repeat of the task on this date (computed, not a task yet):
	 * no checkbox or menu; clicking it edits the real task.
	 */
	upcoming?: string;
}

/** Tints an element with the task's color when the settings show colors in this view. */
export function applyTaskColor(el: HTMLElement, plugin: TaskGiftPlugin, task: Task, where: "board" | "calendar"): void {
	const scope = plugin.settings.taskColorScope;
	if (scope !== "both" && scope !== where) return;
	const color = plugin.store.color(task.id);
	if (!color) return;
	el.addClass("has-color");
	el.style.setProperty("--tg-task-color", taskColorCss(color));
}

/** Touch-friendly alternative to drag & drop: complete, reschedule, move list, delete. */
export function openCardMenu(e: MouseEvent, plugin: TaskGiftPlugin, task: Task): void {
	const store = plugin.store;
	const done = task.status === "completed";
	const t0 = today();
	const menu = new Menu();
	menu.addItem((i) =>
		i
			.setTitle(done ? "Mark as not done" : "Mark as done")
			.setIcon(done ? "circle" : "check-circle-2")
			.onClick(() => store.setCompleted(task.id, !done)),
	);
	menu.addItem((i) => i.setTitle("Edit…").setIcon("pencil").onClick(() => plugin.openTaskModal(task)));
	menu.addSeparator();
	const due = (title: string, icon: string, value: string | null) =>
		menu.addItem((i) =>
			i
				.setTitle(title)
				.setIcon(icon)
				.setChecked(task.due === value)
				.onClick(() => store.update(task.id, { due: value, time: value ? undefined : null })),
		);
	due("Due today", "sun", t0);
	due("Due tomorrow", "sunrise", addDays(t0, 1));
	due("Due next week", "calendar-range", addDays(t0, 7));
	due("No due date", "calendar-off", null);
	const lists = store.lists().filter((l) => l.id !== task.listId);
	if (lists.length) {
		menu.addSeparator();
		for (const l of lists) {
			menu.addItem((i) =>
				i
					.setTitle(`Move to “${l.title}”`)
					.setIcon("folder-input")
					.onClick(() => store.update(task.id, { listId: l.id })),
			);
		}
	}
	menu.addSeparator();
	menu.addItem((i) =>
		i
			.setTitle("Delete")
			.setIcon("trash-2")
			.setWarning(true)
			.onClick(() =>
				new ConfirmModal(plugin.app, "Delete task?", `"${task.title}" will be deleted from Google Tasks too.`, "Delete", () =>
					store.delete(task.id),
				).open(),
			),
	);
	menu.showAtMouseEvent(e);
}

function formatTime(hhmm: string): string {
	const [h, m] = hhmm.split(":").map(Number);
	const d = new Date();
	d.setHours(h, m, 0, 0);
	return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function dueLabel(plugin: TaskGiftPlugin, task: Task): string | null {
	if (!task.due) return null;
	const time = plugin.store.time(task.id);
	return time ? `${friendlyDate(task.due)}, ${formatTime(time)}` : friendlyDate(task.due);
}

/** Renders a task card. Clicking the body opens the edit modal. */
export function renderCard(parent: HTMLElement, plugin: TaskGiftPlugin, task: Task, opts: CardOptions): HTMLElement {
	const store = plugin.store;
	const done = task.status === "completed";
	const upcoming = opts.upcoming;
	const card = parent.createDiv({ cls: "tg-card" });
	card.toggleClass("is-ghost", !!upcoming);
	card.dataset.taskId = task.id;
	card.toggleClass("is-done", done);
	if (task.parent) card.addClass("is-subtask");
	if (opts.colorIn) applyTaskColor(card, plugin, task, opts.colorIn);

	if (opts.checkbox && !upcoming) {
		const cb = card.createEl("button", {
			cls: "tg-check",
			attr: { "aria-label": done ? "Mark as not done" : "Mark as done", role: "checkbox", "aria-checked": String(done) },
		});
		setIcon(cb, done ? "check-circle-2" : "circle");
		cb.addEventListener("click", (e) => {
			e.stopPropagation();
			card.addClass("is-completing");
			window.setTimeout(() => store.setCompleted(task.id, !done), done ? 0 : 250);
		});
	}

	const body = card.createDiv({ cls: "tg-card-body" });
	// dir="auto": a Hebrew / Arabic title starting with a number ("50 מילים") keeps its word order.
	body.createDiv({ cls: "tg-card-title", text: task.title || "(untitled)", attr: { dir: "auto" } });

	if (task.parent) {
		const parentTask = store.get(task.parent);
		if (parentTask) {
			const sub = body.createDiv({ cls: "tg-card-parent" });
			setIcon(sub.createSpan({ cls: "tg-meta-icon" }), "corner-down-right");
			sub.createSpan({ text: parentTask.title, attr: { dir: "auto" } });
		}
	}

	if (task.notes) {
		const notes = body.createDiv({ cls: "tg-card-notes", text: task.notes, attr: { dir: "auto" } });
		notes.style.setProperty("--tg-lines", String(opts.notesLines ?? 2));
	}

	const meta = body.createDiv({ cls: "tg-card-meta" });
	const due = upcoming ?? task.due;
	const label = dueLabel(plugin, { ...task, due });
	if (label && due) {
		const chip = meta.createSpan({ cls: "tg-meta" });
		if (!done && !upcoming && due < today()) chip.addClass("is-overdue");
		else if (due === today()) chip.addClass("is-today");
		setIcon(chip.createSpan({ cls: "tg-meta-icon" }), "calendar");
		chip.createSpan({ text: label });
	}
	const rule = store.rule(task.id);
	if (rule) {
		const chip = meta.createSpan({
			cls: "tg-meta",
			attr: { "aria-label": upcoming ? `Upcoming repeat (${describeRule(rule)}). It is created when the current one is done.` : `Repeats ${describeRule(rule)}` },
		});
		setIcon(chip.createSpan({ cls: "tg-meta-icon" }), "repeat");
		if (upcoming) chip.createSpan({ text: "Upcoming repeat" });
	}
	const kids = store.children(task.id);
	if (kids.length) {
		const doneKids = kids.filter((k) => k.status === "completed").length;
		const chip = meta.createSpan({ cls: "tg-meta" });
		setIcon(chip.createSpan({ cls: "tg-meta-icon" }), "list-checks");
		chip.createSpan({ text: `${doneKids}/${kids.length}` });
	}
	if (opts.showList) {
		const chip = meta.createSpan({ cls: "tg-meta tg-meta-list" });
		setIcon(chip.createSpan({ cls: "tg-meta-icon" }), "list");
		chip.createSpan({ text: store.listTitle(task.listId), attr: { dir: "auto" } });
	}
	if (task.dirty) {
		const chip = meta.createSpan({ cls: "tg-meta tg-meta-pending", attr: { "aria-label": "Waiting to sync" } });
		setIcon(chip.createSpan({ cls: "tg-meta-icon" }), "cloud-upload");
	}
	if (!meta.childElementCount) meta.remove();

	body.addEventListener("click", () => plugin.openTaskModal(task));

	if (opts.menu !== false && !upcoming) {
		const moreBtn = card.createEl("button", { cls: "clickable-icon tg-card-more", attr: { "aria-label": "Task actions" } });
		setIcon(moreBtn, "more-horizontal");
		moreBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			openCardMenu(e, plugin, task);
		});
		// Right-click on desktop, long-press on mobile.
		card.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			openCardMenu(e, plugin, task);
		});
	}

	if (opts.draggable) {
		card.draggable = true;
		card.addEventListener("dragstart", (e) => {
			e.dataTransfer?.setData("text/x-task-gift", task.id);
			e.dataTransfer?.setData("text/plain", task.title);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
			card.addClass("is-dragging");
		});
		card.addEventListener("dragend", () => card.removeClass("is-dragging"));
	}
	return card;
}
