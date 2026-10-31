// Opens a page module (bundled with the "obsidian" shim and the plugin's styles.css) in headless Chrome and
// returns helpers that send real input over the DevTools protocol. Proves browser behavior, not Obsidian's.
import { spawn } from "child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openPage(pageFile, { port = 9334 } = {}) {
	const out = join(here, "out");
	// Retries: the previous test's Chrome may still hold the folder for a moment.
	rmSync(out, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	mkdirSync(out, { recursive: true });
	await esbuild.build({ entryPoints: [pageFile], bundle: true, format: "iife", outfile: join(out, "page.js"), alias: { obsidian: join(here, "obsidian-shim.js") }, loader: { ".mp3": "empty" }, logLevel: "error" });
	// Obsidian's color variables, which the plugin's CSS uses.
	const vars = ":root{--color-red:#e93147;--color-orange:#ec7500;--color-yellow:#e0ac00;--color-green:#08b94e;--color-cyan:#00bfbc;--color-blue:#086ddd;--color-purple:#7852ee;--color-pink:#d53984}";
	writeFileSync(join(out, "index.html"), `<!doctype html><meta charset=utf-8><style>${vars}\n${readFileSync(join(root, "styles.css"), "utf8")}</style><body><script src="page.js"></script>`);

	const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${join(out, "profile")}`, "--window-size=900,900", "file:///" + join(out, "index.html").replace(/\\/g, "/")]);
	let targets = [];
	for (let i = 0; i < 40 && !targets.some((t) => t.type === "page"); i++) {
		await sleep(250);
		targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
	}
	const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
	await new Promise((r) => (ws.onopen = r));
	let id = 0;
	const pending = {};
	ws.onmessage = (m) => {
		const d = JSON.parse(m.data);
		if (d.id && pending[d.id]) pending[d.id](d), delete pending[d.id];
	};
	const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
	await sleep(500);

	/** Evaluates an expression in the page; a thrown page error is reported, not swallowed. */
	const ev = async (expr) => {
		const res = (await cmd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result;
		if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
		return res.result.value;
	};
	const mouse = (type, x, y, clickCount = 1) => cmd("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount, buttons: type === "mouseReleased" ? 0 : 1 });
	const page = {
		ev,
		sleep,
		mouse,
		click: async (x, y) => { await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); },
		drag: async (x0, y0, x1, y1) => {
			await mouse("mousePressed", x0, y0);
			await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: (x0 + x1) / 2, y: (y0 + y1) / 2, button: "left", buttons: 1 });
			await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1, button: "left", buttons: 1 });
			await mouse("mouseReleased", x1, y1);
		},
		/** Center of the first element matching `selector` (or the n-th with `n`). */
		center: (selector, n = 0) => ev(`(()=>{const b=document.querySelectorAll(${JSON.stringify(selector)})[${n}].getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`),
		type: async (text) => { for (const ch of text) await cmd("Input.insertText", { text: ch }); },
		/** Real key presses, for fields that ignore inserted text (native date and time inputs). */
		keys: async (text) => {
			for (const ch of text) {
				await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch });
				await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
			}
		},
		/** A key press; modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
		key: async (key, vk, modifiers = 0) => {
			await cmd("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: vk, modifiers });
			await cmd("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk, modifiers });
		},
		/** Saves what the page looks like as a PNG. */
		screenshot: async (file) => writeFileSync(file, Buffer.from((await cmd("Page.captureScreenshot", { format: "png" })).result.data, "base64")),
		/** Uncaught errors the page reported (the page module should collect them in window.errors). */
		errors: () => ev("window.errors ?? []"),
		close: () => { ws.close(); chrome.kill(); },
	};
	return page;
}
