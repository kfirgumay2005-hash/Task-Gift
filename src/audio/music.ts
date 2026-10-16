import { App, TFile } from "obsidian";
import type { TaskGiftSettings } from "../types";

/** Background music that loops while the gift view is on screen. One player for the whole plugin. */
export class GiftMusic {
	private audio: HTMLAudioElement | null = null;

	constructor(private readonly app: App) {}

	/** Starts, adjusts or stops the music. `onScreen` = a Task Gift view is showing gift mode. */
	update(s: TaskGiftSettings, onScreen: boolean): void {
		const file = s.giftMusicEnabled && s.giftMusicFile ? this.app.vault.getAbstractFileByPath(s.giftMusicFile) : null;
		if (!onScreen || !(file instanceof TFile)) {
			this.audio?.pause();
			return;
		}
		if (!this.audio || this.audio.dataset.path !== file.path) {
			this.stop();
			this.audio = new Audio(this.app.vault.getResourcePath(file));
			this.audio.dataset.path = file.path;
			this.audio.loop = true;
		}
		this.audio.volume = Math.min(1, Math.max(0, s.giftMusicVolume / 100));
		if (this.audio.paused) {
			void this.audio.play().catch(() => {
				/* Blocked until the first click (mobile); the next update retries. */
			});
		}
	}

	stop(): void {
		if (!this.audio) return;
		this.audio.pause();
		this.audio.removeAttribute("src");
		this.audio = null;
	}
}
