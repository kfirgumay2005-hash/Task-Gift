import { Notice, setIcon } from "obsidian";
import type TaskGiftPlugin from "../main";
import type { Task } from "../types";
import { filterFor, isExcludedFromGift, isListIncluded, matchesDateFilter } from "../filters/dates";
import { today } from "../util/dates";
import { renderCard } from "./card";

type Motion = "full" | "fade" | "none";

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function shuffle<T>(arr: T[]): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

const CONFETTI_COLORS = ["var(--color-red)", "var(--color-orange)", "var(--color-yellow)", "var(--color-green)", "var(--color-cyan)", "var(--color-purple)", "var(--interactive-accent)"];

/** Gift mode: draws tasks at random and reveals them one gift at a time. */
export class GiftController {
	private animating = false;
	private renderQueued = false;
	private justFinished = false;
	private swapInId: string | null = null;
	private container: HTMLElement | null = null;

	constructor(private readonly plugin: TaskGiftPlugin) {}

	private motion(): Motion {
		if (!this.plugin.settings.animations) return "none";
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "fade";
		return "full";
	}

	private get state() {
		return this.plugin.store.data.gift;
	}

	/** Tasks that may be drawn. */
	candidates(): Task[] {
		const s = this.plugin.settings;
		const filter = filterFor(s, "gift");
		return this.plugin.store
			.all()
			.filter(
				(t) =>
					t.status !== "completed" &&
					isListIncluded(s, t.listId) &&
					matchesDateFilter(t, filter, s.weekStart) &&
					!isExcludedFromGift(s, t),
			);
	}

	private openedToday(): number {
		return this.state.openedTodayDate === today() ? this.state.openedTodayCount : 0;
	}

	/** Syncs gift state with the store (tasks deleted or completed elsewhere). */
	private reconcile(): void {
		const g = this.state;
		const store = this.plugin.store;
		const before = JSON.stringify([g.drawn, g.done, g.opened]);
		g.drawn = g.drawn.map((id) => store.resolveAlias(id)).filter((id) => store.get(id));
		g.done = g.done.map((id) => store.resolveAlias(id)).filter((id) => g.drawn.includes(id));
		for (const id of g.drawn) {
			const t = store.get(id);
			const isDone = t?.status === "completed";
			if (isDone && !g.done.includes(id)) g.done.push(id);
			if (!isDone && g.done.includes(id)) g.done = g.done.filter((x) => x !== id);
		}
		if (g.opened && g.drawn.length > 0 && g.drawn.every((id) => g.done.includes(id))) {
			g.opened = false;
			g.drawn = [];
			g.done = [];
			this.justFinished = true;
		}
		if (g.opened && g.drawn.length === 0) g.opened = false;
		if (!g.opened && g.drawn.length) {
			g.drawn = [];
			g.done = [];
		}
		if (JSON.stringify([g.drawn, g.done, g.opened]) !== before) this.plugin.touch();
	}

	private pick(n: number, exclude: Set<string>, avoid: Set<string>): Task[] {
		const pool = this.candidates().filter((t) => !exclude.has(t.id));
		const preferred = shuffle(pool.filter((t) => !avoid.has(t.id)));
		const rest = shuffle(pool.filter((t) => avoid.has(t.id)));
		return [...preferred, ...rest].slice(0, n);
	}

	render(container: HTMLElement): void {
		this.container = container;
		if (this.animating) {
			this.renderQueued = true;
			return;
		}
		this.reconcile();
		container.empty();
		const stage = container.createDiv({ cls: "tg-gift-stage" });
		stage.toggleClass("is-no-motion", this.motion() === "none");

		if (this.plugin.settings.showGiftCounter) {
			const counter = stage.createDiv({ cls: "tg-gift-counter" });
			setIcon(counter.createSpan(), "gift");
			counter.createSpan({ text: `Gifts opened today: ${this.openedToday()}` });
		}

		const g = this.state;
		if (g.opened && g.drawn.length) {
			this.renderRevealed(stage, false);
			return;
		}
		if (!this.plugin.isConnected() && this.plugin.store.all().length === 0) {
			this.renderEmpty(stage, "🔌", "Not connected yet", "Connect your Google account in Task Gift settings.");
			return;
		}
		if (!this.candidates().length) {
			this.renderEmpty(stage, "🌿", "All done for now", "No tasks match your gift filter. Enjoy the break.");
			this.justFinished = false;
			return;
		}
		this.renderWrapped(stage);
	}

	private requeue(): void {
		this.animating = false;
		if (this.renderQueued && this.container) {
			this.renderQueued = false;
			this.render(this.container);
		}
	}

	private renderEmpty(stage: HTMLElement, emoji: string, title: string, sub: string): void {
		const empty = stage.createDiv({ cls: "tg-empty tg-gift-empty" });
		empty.createDiv({ cls: "tg-empty-emoji", text: emoji });
		empty.createDiv({ cls: "tg-empty-title", text: title });
		empty.createDiv({ cls: "tg-empty-sub", text: sub });
	}

	private buildBox(parent: HTMLElement): HTMLElement {
		const box = parent.createDiv({ cls: "tg-giftbox", attr: { "aria-hidden": "true" } });
		box.createDiv({ cls: "tg-gift-burst" });
		box.createDiv({ cls: "tg-gift-shadow" });
		const body = box.createDiv({ cls: "tg-gift-body" });
		body.createDiv({ cls: "tg-ribbon-v" });
		const lid = box.createDiv({ cls: "tg-gift-lid" });
		lid.createDiv({ cls: "tg-ribbon-v" });
		const bow = lid.createDiv({ cls: "tg-bow" });
		bow.createDiv({ cls: "tg-bow-loop is-left" });
		bow.createDiv({ cls: "tg-bow-loop is-right" });
		bow.createDiv({ cls: "tg-bow-tail is-left" });
		bow.createDiv({ cls: "tg-bow-tail is-right" });
		bow.createDiv({ cls: "tg-bow-knot" });
		return box;
	}

	private renderWrapped(stage: HTMLElement): void {
		const wrap = stage.createDiv({ cls: "tg-gift-wrap" });
		if (this.justFinished) wrap.addClass("is-new");
		const box = this.buildBox(wrap);
		box.setAttr("role", "button");
		box.setAttr("tabindex", "0");
		box.setAttr("aria-label", "Open gift");

		const caption = wrap.createDiv({ cls: "tg-gift-caption" });
		if (this.justFinished) {
			caption.createDiv({ cls: "tg-gift-caption-title", text: "Nice work! 🎉" });
			caption.createDiv({ text: "Take a breath. A new gift is here whenever you're ready." });
		} else {
			caption.createDiv({ cls: "tg-gift-caption-title", text: "A gift is waiting for you" });
			caption.createDiv({ text: "Open it when you feel ready." });
		}
		const btn = wrap.createEl("button", { cls: "mod-cta tg-open-btn", text: "Open gift" });
		const open = () => void this.openGift(stage, wrap, box, btn);
		btn.addEventListener("click", open);
		box.addEventListener("click", open);
		box.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				open();
			}
		});
	}

	private async openGift(stage: HTMLElement, wrap: HTMLElement, box: HTMLElement, btn: HTMLButtonElement): Promise<void> {
		if (this.animating) return;
		const g = this.state;
		const picks = this.pick(Math.max(1, this.plugin.settings.tasksPerGift), new Set(), new Set(g.recent));
		if (!picks.length) {
			new Notice("No tasks to draw right now.");
			return;
		}
		this.animating = true;
		this.justFinished = false;
		// Persist the draw immediately so a reload never rerolls.
		g.drawn = picks.map((t) => t.id);
		g.done = [];
		g.opened = true;
		g.recent = [];
		if (g.openedTodayDate !== today()) {
			g.openedTodayDate = today();
			g.openedTodayCount = 0;
		}
		g.openedTodayCount++;
		await this.plugin.persist();
		this.plugin.touch();

		btn.disabled = true;
		const counter = stage.querySelector(".tg-gift-counter span:last-child");
		if (counter) counter.textContent = `Gifts opened today: ${this.openedToday()}`;
		const motion = this.motion();
		try {
			if (motion === "full") {
				box.addClass("is-shaking");
				await wait(750);
				box.removeClass("is-shaking");
				box.addClass("is-opening");
				this.confetti(wrap);
				await wait(650);
				wrap.addClass("is-leaving");
				await wait(250);
			} else if (motion === "fade") {
				wrap.addClass("is-fading");
				await wait(300);
			}
			wrap.remove();
			this.renderRevealed(stage, motion !== "none");
			if (motion !== "none") await wait(700);
		} finally {
			this.requeue();
		}
	}

	private confetti(parent: HTMLElement): void {
		const layer = parent.createDiv({ cls: "tg-confetti" });
		for (let i = 0; i < 36; i++) {
			const piece = layer.createSpan({ cls: "tg-confetti-piece" });
			const angle = Math.random() * Math.PI - Math.PI; // upward half
			const dist = 90 + Math.random() * 140;
			piece.style.setProperty("--tg-x", `${Math.cos(angle) * dist}px`);
			piece.style.setProperty("--tg-y", `${Math.sin(angle) * dist}px`);
			piece.style.setProperty("--tg-r", `${Math.random() * 720 - 360}deg`);
			piece.style.setProperty("--tg-delay", `${Math.random() * 120}ms`);
			piece.style.setProperty("--tg-color", CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
			if (i % 3 === 0) piece.addClass("is-round");
		}
		window.setTimeout(() => layer.remove(), 1800);
	}

	private renderRevealed(stage: HTMLElement, animate: boolean): void {
		const g = this.state;
		const store = this.plugin.store;
		const reveal = stage.createDiv({ cls: "tg-reveal" });
		const remaining = g.drawn.filter((id) => !g.done.includes(id));
		if (g.drawn.length > 1) {
			reveal.createDiv({ cls: "tg-reveal-progress", text: `${g.done.length} of ${g.drawn.length} done` });
		}
		const cards = reveal.createDiv({ cls: "tg-reveal-cards" });
		remaining.forEach((id, i) => {
			const task = store.get(id);
			if (!task) return;
			const slot = cards.createDiv({ cls: "tg-gift-card" });
			if (animate) {
				slot.addClass(this.motion() === "full" ? "is-revealing" : "is-fading-in");
				slot.style.setProperty("--tg-stagger", `${i * 110}ms`);
			}
			if (this.swapInId === id) slot.addClass("is-swapping-in");
			renderCard(slot, this.plugin, task, { showList: true, draggable: false, checkbox: false, notesLines: 6, menu: false });
			const actions = slot.createDiv({ cls: "tg-gift-actions" });
			const doneBtn = actions.createEl("button", { cls: "mod-cta tg-done-btn" });
			setIcon(doneBtn.createSpan(), "check");
			doneBtn.createSpan({ text: "Done" });
			doneBtn.addEventListener("click", () => void this.markDone(task, slot));
			const againBtn = actions.createEl("button", { cls: "tg-again-btn" });
			setIcon(againBtn.createSpan(), "shuffle");
			againBtn.createSpan({ text: "Draw again" });
			againBtn.addEventListener("click", () => void this.drawAgain(task, slot));
		});
		this.swapInId = null;
	}

	private async markDone(task: Task, slot: HTMLElement): Promise<void> {
		if (this.animating) return;
		this.animating = true;
		try {
			if (this.motion() !== "none") {
				slot.addClass("is-finishing");
				await wait(this.motion() === "full" ? 550 : 250);
			}
			const g = this.state;
			if (!g.done.includes(task.id)) g.done.push(task.id);
			this.plugin.store.setCompleted(task.id, true);
			this.renderQueued = true;
		} finally {
			this.requeue();
		}
	}

	private async drawAgain(task: Task, slot: HTMLElement): Promise<void> {
		if (this.animating) return;
		const g = this.state;
		const [next] = this.pick(1, new Set([...g.drawn, task.id]), new Set(g.recent));
		if (!next) {
			new Notice("No other task to draw right now. This one is the only option left.");
			slot.addClass("is-nope");
			window.setTimeout(() => slot.removeClass("is-nope"), 450);
			return;
		}
		this.animating = true;
		try {
			if (this.motion() !== "none") {
				slot.addClass("is-swapping-out");
				await wait(this.motion() === "full" ? 320 : 200);
			}
			g.drawn = g.drawn.map((id) => (id === task.id ? next.id : id));
			g.recent = [task.id, ...g.recent.filter((x) => x !== task.id)].slice(0, 5);
			if (this.motion() !== "none") this.swapInId = next.id;
			await this.plugin.persist();
			this.renderQueued = true;
		} finally {
			this.requeue();
		}
	}
}
