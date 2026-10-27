// Board sticky notes: add, type, move, resize, delete, double-click add, zoomed drag. Run: npm run ui-test
import { join } from "path";
import { fileURLToPath } from "url";
import { openPage } from "./harness.mjs";

const page = await openPage(join(fileURLToPath(new URL(".", import.meta.url)), "stickies.page.js"));
let failed = 0;
const check = (name, ok, got) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
	if (!ok) failed++;
};
const notes = async () => JSON.parse(await page.ev(`JSON.stringify(store.stickyNotes())`));
const box = (sel) => page.ev(`(()=>{const b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return [b.x,b.y,b.width,b.height]})()`);

try {
	check("renders without errors", (await page.errors()).length === 0, await page.errors());
	const [ax, ay, aw] = await box(".tg-stickies");
	check("sticky area fills the empty side", aw > 500, aw);

	await page.click(...(await page.center(".tg-stickies-add")));
	await page.sleep(100);
	let n = await notes();
	check("add button creates a note", n.length === 1 && n[0][1].color === "default" && (await page.ev(`document.querySelector('.tg-sticky').classList.contains('is-neutral')`)), n);
	check("new note's text has focus", await page.ev(`document.activeElement?.classList.contains('tg-sticky-text')`), null);
	await page.type("קניות 3 milk");
	n = await notes();
	check("typing saves the text", n[0][1].text === "קניות 3 milk" && (await page.ev("window.saves")) > 0, n[0][1].text);

	const [bx, by] = await page.center(".tg-sticky-bar");
	await page.drag(bx - 40, by, bx + 60, by + 80);
	await page.sleep(100);
	n = await notes();
	check("dragging the bar moves the note", n[0][1].x === 16 + 100 && n[0][1].y === 8 + 80, n[0][1]);

	const [sx, sy, sw, sh] = await box(".tg-sticky");
	await page.drag(sx + sw - 3, sy + sh - 3, sx + sw + 57, sy + sh + 37);
	await page.sleep(100);
	n = await notes();
	check("resizing from the corner saves the size", Math.abs(n[0][1].w - 260) <= 4 && Math.abs(n[0][1].h - 207) <= 4, [n[0][1].w, n[0][1].h]);

	// Format commands from the palette menu: select a word, run Bold, see it rendered; run again to remove it.
	const textOf = async () => (await notes())[0][1].text;
	const menuFor = async (i) => {
		await page.click(...(await page.center(`.tg-sticky:nth-child(${i + 1}) [aria-label="Color"]`)));
		return page.ev(`window.lastMenu.map((x) => x.title)`);
	};
	const buttons = () => page.ev(`[...document.querySelectorAll('.tg-sticky:first-child .tg-sticky-commands .tg-sticky-tool')].map((b) => b.getAttribute('aria-label'))`);
	// Presses a command button with the mouse, like a user.
	const press = async (title) => {
		await page.ev(`document.querySelector('.tg-sticky').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
		await page.click(...(await page.center(`.tg-sticky:first-child .tg-sticky-tool[aria-label=${JSON.stringify(title)}]`)));
		await page.sleep(30);
	};
	await page.ev(`document.activeElement?.blur()`);
	await page.sleep(50);
	check("rendered when not editing", await page.ev(`document.querySelector('.tg-sticky-view').offsetHeight > 0 && document.querySelector('.tg-sticky-text').offsetHeight === 0`), null);
	await page.click(...(await page.center(".tg-sticky-view")));
	check("clicking the rendered note opens its text", await page.ev(`document.activeElement?.classList.contains('tg-sticky-text')`), null);
	await page.ev(`document.activeElement.setSelectionRange(6, 7)`); // "3"
	check("command buttons sit next to the color button", (await buttons()).join() === "Highlight,Underline,Bold", await buttons());
	const titles = await menuFor(0);
	check("color menu lists only colors", titles[0] === "Default" && !titles.includes("Bold"), titles);
	await press("Bold");
	check("text keeps focus when a button is pressed", await page.ev(`document.activeElement?.classList.contains('tg-sticky-text')`), null);
	check("Bold wraps the selection", (await textOf()) === "קניות **3** milk", await textOf());
	check("selection stays on the word", (await page.ev(`[document.activeElement.selectionStart, document.activeElement.selectionEnd].join()`)) === "8,9", null);
	await press("Bold");
	check("Bold again removes it", (await textOf()) === "קניות 3 milk", await textOf());
	// Leave the note, then highlight the word that was selected: the command still knows the selection.
	await page.ev(`document.activeElement.setSelectionRange(8, 12)`); // "milk"
	await page.ev(`document.activeElement.blur()`);
	await page.sleep(50);
	check("left note shows rendered text", await page.ev(`!document.querySelector('.tg-sticky').classList.contains('is-editing') && document.querySelector('.tg-sticky-view').textContent.includes('milk')`), null);
	await press("Highlight");
	check("command uses the last selection", (await textOf()) === "קניות 3 ==milk==", await textOf());
	await page.ev(`document.activeElement.blur()`);
	await page.sleep(50);
	check("highlight is rendered", (await page.ev(`document.querySelector('.tg-sticky-view mark')?.textContent ?? null`)) === "milk", null);
	// Own command from the settings shows in the menu; a deleted one doesn't.
	await page.ev(`plugin.settings.stickyCommands = plugin.settings.stickyCommands.filter((c) => c.id !== "underline").concat({ id: "x", name: "Strike", before: "~~", after: "~~" })`);
	await page.ev(`draw()`);
	check("buttons follow the settings", (await buttons()).join() === "Highlight,Bold,Strike", await buttons());
	check("own markers show the start of their name", (await page.ev(`document.querySelector('[data-command="x"]').textContent`)) === "St", null);
	await menuFor(0);
	await page.ev(`window.lastMenu.find((i) => i.title === "Default").click()`);

	// Obsidian commands: formatting ones change the sticky note's text, others run in Obsidian.
	const cmds = [["b", "editor:toggle-bold", "Bold (Obsidian)"], ["l", "editor:toggle-bullet-list", "List"], ["r", "editor:toggle-highlight-red", "Red"], ["u", "editor:undo", "Undo"], ["d", "daily-notes", "Daily"]];
	await page.ev(`plugin.settings.stickyCommands = ${JSON.stringify(cmds.map(([id, commandId, name]) => ({ id, name, before: "", after: "", commandId })))}`);
	await page.ev(`store.updateSticky(store.stickyNotes()[0][0], { text: "one\\ntwo" }); draw()`);
	await page.click(...(await page.center(".tg-sticky-view")));
	const pick = async (title, start, end) => {
		await page.ev(`document.querySelector('.tg-sticky-text').setSelectionRange(${start}, ${end})`);
		await press(title);
		return textOf();
	};
	check("Obsidian's Toggle bold formats the note", (await pick("Bold (Obsidian)", 0, 3)) === "**one**\ntwo", await textOf());
	check("Toggle bullet list prefixes the selected lines", (await pick("List", 0, 11)) === "- **one**\n- two", await textOf());
	check("Toggle bullet list again removes it", (await pick("List", 0, 15)) === "**one**\ntwo", await textOf());
	check("red highlight uses Obsidian's syntax", (await pick("Red", 8, 11)) === "**one**\n==🔴two==", await textOf());
	await pick("Daily", 0, 0);
	check("other commands run in Obsidian", (await page.ev(`window.ran.join()`)) === "daily-notes", await page.ev(`window.ran`));
	await pick("Undo", 0, 0);
	check("editor-only command explains itself", /only works in a note's editor/.test(await page.ev(`(window.notices ?? []).at(-1) ?? ""`)), await page.ev(`window.notices`));
	check("text unchanged by commands that run elsewhere", (await textOf()) === "**one**\n==🔴two==", await textOf());
	await page.ev(`store.updateSticky(store.stickyNotes()[0][0], { text: "קניות 3 ==milk==" }); document.activeElement.blur(); draw()`);

	// Double-click on the empty area adds a note there.
	await page.mouse("mousePressed", ax + 450, ay + 400, 1);
	await page.mouse("mouseReleased", ax + 450, ay + 400, 1);
	await page.mouse("mousePressed", ax + 450, ay + 400, 2);
	await page.mouse("mouseReleased", ax + 450, ay + 400, 2);
	await page.sleep(100);
	n = await notes();
	check("double-click adds a note at the pointer", n.length === 2 && Math.abs(n[1][1].x - (450 - 100)) <= 2, n.map((x) => [x[1].x, x[1].y]));

	// Empty note: delete without asking; it stays as a tombstone so the deletion syncs.
	await page.ev(`document.querySelectorAll('.tg-sticky')[1].dispatchEvent(new MouseEvent('mouseover'))`);
	await page.click(...(await page.center(".tg-sticky:nth-child(2) [aria-label=\"Delete sticky note\"]")));
	await page.sleep(100);
	n = await notes();
	const all = JSON.parse(await page.ev(`JSON.stringify(store.data.stickies)`));
	check("delete removes the empty note", n.length === 1 && Object.values(all).filter((x) => x.deleted).length === 1, n.length);

	// Zoomed board: the note follows the pointer.
	await page.ev(`plugin.settings.boardZoom = 150; draw()`);
	const before = (await notes())[0][1];
	// Grab the bar at its free left part (the right holds the buttons).
	const [zbx, zby, , zbh] = await box(".tg-sticky-bar");
	const [zx, zy] = [zbx + 10, zby + zbh / 2];
	await page.drag(zx, zy, zx + 150, zy + 60);
	await page.sleep(100);
	const after = (await notes())[0][1];
	check("zoomed drag moves by pointer distance / zoom", after.x - before.x === 100 && after.y - before.y === 40, [after.x - before.x, after.y - before.y]);

	// Merge from another device: newer edit wins, older is ignored.
	const id = (await notes())[0][0];
	await page.ev(`store.mergeStickies({ ${JSON.stringify(id)}: { ...store.data.stickies[${JSON.stringify(id)}], text: "old", updated: 1 } })`);
	check("older remote copy is ignored", (await notes())[0][1].text === "קניות 3 ==milk==", null);
	await page.ev(`store.mergeStickies({ ${JSON.stringify(id)}: { ...store.data.stickies[${JSON.stringify(id)}], text: "newer", updated: Date.now() + 1000 } })`);
	check("newer remote copy wins", (await notes())[0][1].text === "newer", null);
	check("no page errors", (await page.errors()).length === 0, await page.errors());
} finally {
	page.close();
}
process.exit(failed ? 1 : 0);
