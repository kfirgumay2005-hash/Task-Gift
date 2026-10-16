import { App, Notice, TFile } from "obsidian";
import type { GiftSound, TaskGiftSettings } from "../types";
import birthdayMp3 from "../../sounds/happy-birthday.mp3";

type BuiltInSound = Exclude<GiftSound, "random" | "custom">;
type SynthSound = Exclude<BuiltInSound, "birthday">;

export const BUILT_IN_SOUNDS: BuiltInSound[] = ["birthday", "chime", "magic"];

export const SOUND_LABELS: Record<GiftSound, string> = {
	birthday: "Happy Birthday",
	chime: "Chime",
	magic: "Magic wand",
	random: "Random (one of the three)",
	custom: "My own audio file",
};

/** Built-in sounds that are recordings embedded in main.js rather than synthesized. */
const EMBEDDED: Partial<Record<BuiltInSound, string>> = { birthday: birthdayMp3 };

export const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "m4a", "flac", "webm"];

let ctx: AudioContext | null = null;

function audioContext(): AudioContext {
	if (!ctx) ctx = new AudioContext();
	if (ctx.state === "suspended") void ctx.resume();
	return ctx;
}

/** One enveloped oscillator note. */
function note(
	ac: AudioContext,
	out: AudioNode,
	freq: number,
	start: number,
	duration: number,
	opts: { type?: OscillatorType; gain?: number; attack?: number; slideTo?: number } = {},
): void {
	const osc = ac.createOscillator();
	const g = ac.createGain();
	osc.type = opts.type ?? "sine";
	osc.frequency.setValueAtTime(freq, start);
	if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, start + duration);
	const peak = opts.gain ?? 0.3;
	const attack = opts.attack ?? 0.01;
	g.gain.setValueAtTime(0.0001, start);
	g.gain.exponentialRampToValueAtTime(peak, start + attack);
	g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
	osc.connect(g).connect(out);
	osc.start(start);
	osc.stop(start + duration + 0.05);
}


const SYNTHS: Record<SynthSound, (ac: AudioContext, out: AudioNode, t: number) => void> = {
	/** Bright bell arpeggio. */
	chime: (ac, out, t) => {
		[1046.5, 1318.5, 1568, 2093].forEach((f, i) => {
			note(ac, out, f, t + i * 0.09, 1.2, { gain: 0.22 });
			note(ac, out, f * 2.01, t + i * 0.09, 0.5, { gain: 0.05 });
		});
	},
	/** Rising magical sweep with shimmer. */
	magic: (ac, out, t) => {
		note(ac, out, 300, t, 0.7, { gain: 0.18, attack: 0.05, slideTo: 1600 });
		note(ac, out, 450, t + 0.05, 0.7, { type: "triangle", gain: 0.08, attack: 0.05, slideTo: 2400 });
		[2637, 3136, 3951, 4699].forEach((f, i) => note(ac, out, f, t + 0.55 + i * 0.07, 0.6, { gain: 0.07 }));
	},
};

function playUrl(url: string, volume: number, name: string): void {
	const audio = new Audio(url);
	audio.volume = volume;
	audio.play().catch(() => new Notice(`Task Gift: could not play "${name}".`));
}

function playBuiltIn(sound: BuiltInSound, volume: number): void {
	const embedded = EMBEDDED[sound];
	if (embedded) {
		playUrl(embedded, volume, SOUND_LABELS[sound]);
		return;
	}
	const ac = audioContext();
	const master = ac.createGain();
	master.gain.value = volume;
	master.connect(ac.destination);
	SYNTHS[sound as SynthSound](ac, master, ac.currentTime + 0.02);
}

function playFile(app: App, path: string, volume: number): void {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		new Notice(`Task Gift: sound file "${path}" was not found.`);
		return;
	}
	playUrl(app.vault.getResourcePath(file), volume, file.name);
}

/** Plays the configured gift sound. `force` plays even when sounds are turned off (settings preview). */
export function playGiftSound(app: App, s: TaskGiftSettings, force = false): void {
	if (!s.giftSoundEnabled && !force) return;
	const volume = Math.min(1, Math.max(0, s.giftSoundVolume / 100));
	if (volume === 0) return;
	try {
		if (s.giftSound === "custom") {
			if (s.giftSoundFile) playFile(app, s.giftSoundFile, volume);
			else if (force) new Notice("Choose an audio file first.");
			return;
		}
		const sound = s.giftSound === "random" ? BUILT_IN_SOUNDS[Math.floor(Math.random() * BUILT_IN_SOUNDS.length)] : s.giftSound;
		playBuiltIn(sound, volume);
	} catch {
		/* Audio unavailable; opening a gift must never fail because of sound. */
	}
}

/** Plays the victory music (an audio file from the vault) when a gift is finished. */
export function playVictorySound(app: App, s: TaskGiftSettings, force = false): void {
	if (!s.victorySoundEnabled && !force) return;
	if (!s.victorySoundFile) {
		if (force) new Notice("Choose an audio file first.");
		return;
	}
	const volume = Math.min(1, Math.max(0, s.giftSoundVolume / 100));
	if (volume === 0) return;
	try {
		playFile(app, s.victorySoundFile, volume);
	} catch {
		/* Audio unavailable. */
	}
}
