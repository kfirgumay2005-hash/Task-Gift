import { Notice, setIcon, TFile } from "obsidian";
import type TaskGiftPlugin from "../main";
import type { Task } from "../types";
import { filterFor, isExcludedFromGift, isListIncluded, matchesDateFilter } from "../filters/dates";
import { today } from "../util/dates";
import { playGiftSound, playVictorySound } from "../audio/sounds";
import { activeMode } from "../modes";
import { isVideo } from "../util/media";
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

const CONFETTI_COLORS = ["var(--color-red)", "var(--color-orange)", "var(--color-yellow)", "var(--color-green)", "var(--color-cyan)", "var(--color-purple)", "var(--color-pink)", "var(--interactive-accent)"];
const CONFETTI_SHAPES = ["", "is-round", "is-star", "is-streamer"];
const FLOATERS = ["🎉", "✨", "⭐", "🎊", "💫", "🌟"];

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Gift mode: draws tasks at random and reveals them one gift at a time. */
export class GiftController {
	private animating = false;
	private renderQueued = false;
	private justFinished = false;
	/** The gift was just re-wrapped by "Draw again". */
	private rewrapped = false;
	/** Background image currently shown; re-rolled for every new gift when the pick is "random". */
	private background: string | null = null;
	/** Kept across re-renders so a video background doesn't restart on every refresh. */
	private video: HTMLVideoElement | null = null;
	private container: HTMLElement | null = null;
	/** Every task of the gift was just done: celebrate on the next render. */
	private celebrate = false;

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
					isListIncluded(s, t.listId, "gift") &&
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
		const before = JSON.stringify([g.drawn, g.done, g.opened, g.pendingRedraw]);
		if (!g.opened) g.pendingRedraw = 0;
		g.drawn = g.drawn.map((id) => store.resolveAlias(id)).filter((id) => store.get(id));
		g.done = g.done.map((id) => store.resolveAlias(id)).filter((id) => g.drawn.includes(id));
		for (const id of g.drawn) {
			const t = store.get(id);
			const isDone = t?.status === "completed";
			if (isDone && !g.done.includes(id)) g.done.push(id);
			if (!isDone && g.done.includes(id)) g.done = g.done.filter((x) => x !== id);
		}
		if (g.opened && !g.pendingRedraw && g.drawn.length > 0 && g.drawn.every((id) => g.done.includes(id))) {
			g.opened = false;
			g.drawn = [];
			g.done = [];
			this.justFinished = true;
			this.celebrate = true;
			this.nextBackground();
		}
		if (g.opened && g.drawn.length === 0 && !g.pendingRedraw) g.opened = false;
		if (!g.opened && g.drawn.length) {
			g.drawn = [];
			g.done = [];
		}
		if (JSON.stringify([g.drawn, g.done, g.opened, g.pendingRedraw]) !== before) this.plugin.touch();
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
		// Keep confetti that is still flying across the re-render.
		const flying = Array.from(container.querySelectorAll<HTMLElement>(".tg-confetti, .tg-victory"));
		container.empty();
		const stage = container.createDiv({ cls: "tg-gift-stage" });
		stage.toggleClass("is-no-motion", this.motion() === "none");
		this.applyBackground(stage);
		for (const layer of flying) stage.appendChild(layer);
		this.renderControls(stage);
		if (this.celebrate) {
			this.celebrate = false;
			this.victory(stage);
		}

		if (this.plugin.settings.showGiftCounter) {
			const counter = stage.createDiv({ cls: "tg-gift-counter" });
			setIcon(counter.createSpan(), "gift");
			counter.createSpan({ text: `Gifts opened today: ${this.openedToday()}` });
		}

		const g = this.state;
		if (g.opened && g.pendingRedraw > 0) {
			this.renderWrapped(stage);
			return;
		}
		if (g.opened && g.drawn.length) {
			this.renderRevealed(stage, false);
			return;
		}
		if (!this.plugin.isConnected() && this.plugin.store.all().length === 0) {
			this.renderEmpty(stage, "🔌", "Not connected yet", "Connect your Google account in Task Gift settings.");
			return;
		}
		if (!this.candidates().length) {
			this.renderEmpty(stage, "🌿", "All done for now", `No tasks match the "${activeMode(this.plugin.settings).name}" mode. Enjoy the break.`);
			this.justFinished = false;
			return;
		}
		this.renderWrapped(stage);
	}

	/** Picks the next background of the active mode: the chosen one, or a random one (different from the last when possible). */
	private nextBackground(): void {
		const mode = activeMode(this.plugin.settings);
		const vault = this.plugin.app.vault;
		const existing = mode.backgrounds.filter((path) => vault.getAbstractFileByPath(path) instanceof TFile);
		if (mode.backgroundPick !== "random" && existing.includes(mode.backgroundPick)) {
			this.background = mode.backgroundPick;
			return;
		}
		const pool = existing.length > 1 ? existing.filter((path) => path !== this.background) : existing;
		this.background = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
	}

	private applyBackground(stage: HTMLElement): void {
		const s = this.plugin.settings;
		const mode = activeMode(s);
		const stale =
			this.background === null ||
			!mode.backgrounds.includes(this.background) ||
			(mode.backgroundPick !== "random" && this.background !== mode.backgroundPick);
		if (stale) this.nextBackground();
		const file = this.background ? this.plugin.app.vault.getAbstractFileByPath(this.background) : null;
		if (!(file instanceof TFile)) {
			this.dropVideo();
			return;
		}
		const src = this.plugin.app.vault.getResourcePath(file);
		stage.addClass("has-background");
		stage.style.setProperty("--tg-bg-dim", `${Math.min(90, Math.max(0, mode.backgroundDim))}%`);
		if (!isVideo(file.path)) {
			this.dropVideo();
			stage.style.setProperty("--tg-bg-image", `url("${src}")`);
			return;
		}
		stage.addClass("has-video");
		if (!this.video || this.video.dataset.path !== file.path) {
			this.dropVideo();
			this.video = createEl("video", { cls: "tg-bg-video", attr: { src, "aria-hidden": "true" } });
			this.video.dataset.path = file.path;
			this.video.loop = true;
			this.video.autoplay = true;
			// Required for autoplay on mobile.
			this.video.playsInline = true;
		}
		stage.prepend(this.video);
		stage.createDiv({ cls: "tg-bg-dim" });
		this.playVideo();
	}

	/** (Re)starts the video background, with or without its sound. */
	private playVideo(): void {
		const video = this.video;
		if (!video) return;
		video.muted = !this.plugin.settings.giftVideoSound;
		// Moving the element out of the document pauses it; resume where it was.
		void video.play().catch(() => {
			if (video.muted) return; // autoplay blocked: the first frame stays as a still background
			// Playing with sound needs a click first; play muted until then.
			video.muted = true;
			void video.play().catch(() => undefined);
		});
	}

	private dropVideo(): void {
		this.video?.pause();
		this.video = null;
	}

	/** Pauses or resumes the video background when the view is hidden or shown again. */
	setOnScreen(onScreen: boolean): void {
		if (onScreen) {
			if (this.video?.paused) this.playVideo();
		} else {
			this.video?.pause();
		}
	}

	/** Quick toggles in the corner of the stage: music and the video's sound. */
	private renderControls(stage: HTMLElement): void {
		const p = this.plugin;
		const s = p.settings;
		const bar = stage.createDiv({ cls: "tg-gift-controls" });
		if (s.giftMusicFile) {
			const on = s.giftMusicEnabled;
			const music = bar.createEl("button", {
				cls: "clickable-icon tg-gift-control",
				attr: { "aria-label": on ? "Turn music off" : "Turn music on" },
			});
			music.toggleClass("is-active", on);
			// There is no "music off" icon: a CSS strike-through marks it.
			setIcon(music, "music");
			music.toggleClass("is-off", !on);
			music.addEventListener("click", () => {
				s.giftMusicEnabled = !s.giftMusicEnabled;
				void p.saveSettings();
			});
		}
		if (this.video) {
			const on = s.giftVideoSound;
			const sound = bar.createEl("button", {
				cls: "clickable-icon tg-gift-control",
				attr: { "aria-label": on ? "Mute video" : "Play video sound" },
			});
			sound.toggleClass("is-active", on);
			setIcon(sound, on ? "volume-2" : "volume-x");
			sound.addEventListener("click", () => {
				s.giftVideoSound = !s.giftVideoSound;
				// Unmute right inside the click, so the browser allows sound.
				this.playVideo();
				void p.saveSettings();
			});
		}
		if (!bar.childElementCount) bar.remove();
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
		box.createDiv({ cls: "tg-gift-halo" });
		box.createDiv({ cls: "tg-gift-rays" });
		box.createDiv({ cls: "tg-gift-ring" });
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
		if (this.justFinished || this.rewrapped) wrap.addClass("is-new");
		const box = this.buildBox(wrap);
		box.setAttr("role", "button");
		box.setAttr("tabindex", "0");
		box.setAttr("aria-label", "Open gift");

		const caption = wrap.createDiv({ cls: "tg-gift-caption" });
		if (this.state.pendingRedraw > 0) {
			caption.createDiv({ cls: "tg-gift-caption-title", text: "Back in the box 🔄" });
			caption.createDiv({ text: "A different gift is waiting. Open it when you're ready." });
		} else if (this.justFinished) {
			caption.createDiv({ cls: "tg-gift-caption-title", text: "Nice work! 🎉" });
			caption.createDiv({ text: "Take a breath. A new gift is here whenever you're ready." });
		} else {
			caption.createDiv({ cls: "tg-gift-caption-title", text: "A gift is waiting for you" });
			caption.createDiv({ text: "Open it when you feel ready." });
		}
		this.rewrapped = false;
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
		const redraw = g.opened && g.pendingRedraw > 0;
		const picks = redraw
			? this.pick(g.pendingRedraw, new Set([...g.drawn, ...g.recent.slice(0, 1)]), new Set(g.recent))
			: this.pick(Math.max(1, this.plugin.settings.tasksPerGift), new Set(), new Set(g.recent));
		if (!picks.length) {
			new Notice("No tasks to draw right now.");
			return;
		}
		this.animating = true;
		this.justFinished = false;
		// Persist the draw immediately so a reload never rerolls.
		if (redraw) {
			g.drawn = [...g.drawn, ...picks.map((t) => t.id)];
			g.pendingRedraw = 0;
		} else {
			g.drawn = picks.map((t) => t.id);
			g.done = [];
			g.opened = true;
			g.recent = [];
			if (g.openedTodayDate !== today()) {
				g.openedTodayDate = today();
				g.openedTodayCount = 0;
			}
			g.openedTodayCount++;
		}
		await this.plugin.persist();
		this.plugin.touch();

		btn.disabled = true;
		const counter = stage.querySelector(".tg-gift-counter span:last-child");
		if (counter) counter.textContent = `Gifts opened today: ${this.openedToday()}`;
		const motion = this.motion();
		try {
			if (motion === "full") {
				// 1. Charge up: the box trembles harder and harder while sparkles gather.
				stage.addClass("is-charging");
				box.addClass("is-shaking");
				this.gatherSparkles(stage, box);
				await wait(1100);
				// 2. Burst: lid flies, light rays, shockwave, flash and confetti.
				stage.removeClass("is-charging");
				box.removeClass("is-shaking");
				box.addClass("is-opening");
				playGiftSound(this.plugin.app, this.plugin.settings);
				this.flash(stage);
				this.confetti(stage, box, 80);
				this.floaters(stage, box);
				await wait(850);
				// 3. The box sinks away and the task rises in its place.
				wrap.addClass("is-leaving");
				await wait(320);
			} else {
				playGiftSound(this.plugin.app, this.plugin.settings);
				if (motion === "fade") {
					wrap.addClass("is-fading");
					await wait(300);
				}
			}
			wrap.remove();
			this.renderRevealed(stage, motion !== "none");
			if (motion !== "none") await wait(900);
		} finally {
			this.requeue();
		}
	}

	/** An absolutely positioned layer in `stage`, centred on `anchor`. */
	private layerAt(stage: HTMLElement, anchor: HTMLElement, cls: string): HTMLElement {
		const s = stage.getBoundingClientRect();
		const a = anchor.getBoundingClientRect();
		const layer = stage.createDiv({ cls });
		layer.style.setProperty("--tg-cx", `${a.left - s.left + a.width / 2}px`);
		layer.style.setProperty("--tg-cy", `${a.top - s.top + a.height / 2}px`);
		return layer;
	}

	private confetti(stage: HTMLElement, anchor: HTMLElement, count: number): void {
		const layer = this.layerAt(stage, anchor, "tg-confetti");
		for (let i = 0; i < count; i++) {
			const shape = CONFETTI_SHAPES[i % CONFETTI_SHAPES.length];
			const piece = layer.createSpan({ cls: "tg-confetti-piece" });
			if (shape) piece.addClass(shape);
			if (shape === "is-star") piece.setText("★");
			const angle = rand(-Math.PI * 0.95, -Math.PI * 0.05); // mostly upward
			const dist = rand(110, 300);
			piece.style.setProperty("--tg-x", `${Math.cos(angle) * dist}px`);
			piece.style.setProperty("--tg-y", `${Math.sin(angle) * dist}px`);
			piece.style.setProperty("--tg-fall", `${rand(120, 260)}px`);
			piece.style.setProperty("--tg-r", `${rand(-900, 900)}deg`);
			piece.style.setProperty("--tg-delay", `${rand(0, 180)}ms`);
			piece.style.setProperty("--tg-dur", `${rand(1300, 2100)}ms`);
			piece.style.setProperty("--tg-color", CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
		}
		window.setTimeout(() => layer.remove(), 2600);
	}

	/** Sparkles that drift in towards the box while it charges up. */
	private gatherSparkles(stage: HTMLElement, anchor: HTMLElement): void {
		const layer = this.layerAt(stage, anchor, "tg-sparkles");
		for (let i = 0; i < 18; i++) {
			const sp = layer.createSpan({ cls: "tg-sparkle", text: "✦" });
			const angle = rand(0, Math.PI * 2);
			const dist = rand(110, 190);
			sp.style.setProperty("--tg-x", `${Math.cos(angle) * dist}px`);
			sp.style.setProperty("--tg-y", `${Math.sin(angle) * dist}px`);
			sp.style.setProperty("--tg-delay", `${rand(0, 700)}ms`);
			sp.style.setProperty("--tg-size", `${rand(10, 20)}px`);
			sp.style.setProperty("--tg-color", CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
		}
		window.setTimeout(() => layer.remove(), 1300);
	}

	/** Emoji that float up and fade after the burst. */
	private floaters(stage: HTMLElement, anchor: HTMLElement): void {
		const layer = this.layerAt(stage, anchor, "tg-floaters");
		for (let i = 0; i < 9; i++) {
			const f = layer.createSpan({ cls: "tg-floater", text: FLOATERS[i % FLOATERS.length] });
			f.style.setProperty("--tg-x", `${rand(-170, 170)}px`);
			f.style.setProperty("--tg-y", `${rand(-260, -150)}px`);
			f.style.setProperty("--tg-delay", `${rand(60, 400)}ms`);
			f.style.setProperty("--tg-size", `${rand(18, 32)}px`);
			f.style.setProperty("--tg-r", `${rand(-40, 40)}deg`);
		}
		window.setTimeout(() => layer.remove(), 2400);
	}

	/** Small celebration when the whole gift is done: a trophy pops up and confetti rains down. */
	private victory(stage: HTMLElement): void {
		const s = this.plugin.settings;
		playVictorySound(this.plugin.app, s);
		if (!s.victoryAnimation) return;
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const layer = stage.createDiv({ cls: "tg-victory", attr: { "aria-hidden": "true" } });
		if (reduced) layer.addClass("is-reduced");
		const badge = layer.createDiv({ cls: "tg-victory-badge" });
		badge.createDiv({ cls: "tg-victory-rays" });
		badge.createDiv({ cls: "tg-victory-trophy", text: "🏆" });
		layer.createDiv({ cls: "tg-victory-title", text: "Victory!" });
		if (!reduced) {
			for (let i = 0; i < 40; i++) {
				const piece = layer.createSpan({ cls: "tg-victory-piece" });
				if (i % 3 === 0) piece.addClass("is-round");
				piece.style.setProperty("--tg-left", `${rand(0, 100)}%`);
				piece.style.setProperty("--tg-drift", `${rand(-60, 60)}px`);
				piece.style.setProperty("--tg-r", `${rand(-720, 720)}deg`);
				piece.style.setProperty("--tg-delay", `${rand(0, 700)}ms`);
				piece.style.setProperty("--tg-dur", `${rand(1600, 2400)}ms`);
				piece.style.setProperty("--tg-color", CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
			}
		}
		window.setTimeout(() => layer.remove(), 3200);
	}

	private flash(stage: HTMLElement): void {
		const el = stage.createDiv({ cls: "tg-flash" });
		window.setTimeout(() => el.remove(), 700);
	}

	private renderRevealed(stage: HTMLElement, animate: boolean): void {
		const g = this.state;
		const store = this.plugin.store;
		const reveal = stage.createDiv({ cls: "tg-reveal" });
		if (animate && this.motion() === "full") reveal.addClass("is-entering");
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
	}

	private async markDone(task: Task, slot: HTMLElement): Promise<void> {
		if (this.animating) return;
		this.animating = true;
		try {
			if (this.motion() !== "none") {
				slot.addClass("is-finishing");
				const stage = slot.closest<HTMLElement>(".tg-gift-stage");
				if (this.motion() === "full" && stage) this.confetti(stage, slot, 30);
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
				// The card flips back into the box, and a freshly wrapped gift takes its place.
				slot.addClass("is-swapping-out");
				await wait(this.motion() === "full" ? 320 : 200);
			}
			g.drawn = g.drawn.filter((id) => id !== task.id);
			g.done = g.done.filter((id) => id !== task.id);
			g.pendingRedraw = (g.pendingRedraw || 0) + 1;
			g.recent = [task.id, ...g.recent.filter((x) => x !== task.id)].slice(0, 5);
			this.rewrapped = this.motion() !== "none";
			this.nextBackground();
			await this.plugin.persist();
			this.renderQueued = true;
		} finally {
			this.requeue();
		}
	}
}
