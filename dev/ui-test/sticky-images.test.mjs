// Pictures on the sticky-note board: drop on the board, paste / drop into a note, move, delete, not-yet-synced file.
// Run: npm run ui-test. Drop and paste are synthetic events with real files (the system file picker can't be driven).
import { join } from "path";
import { fileURLToPath } from "url";
import { openPage } from "./harness.mjs";

const page = await openPage(join(fileURLToPath(new URL(".", import.meta.url)), "sticky-images.page.js"));
let failed = 0;
const check = (name, ok, got) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
	if (!ok) failed++;
};
const notes = async () => JSON.parse(await page.ev(`JSON.stringify(store.stickyNotes())`));
const box = (sel) => page.ev(`(()=>{const b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return [b.x,b.y,b.width,b.height]})()`);
const FOLDER = "ארכיון/Tasksgift/Sticky images";

try {
	check("renders without errors", (await page.errors()).length === 0, await page.errors());
	check("toolbar has an Add image button", await page.ev(`!!document.querySelector('[aria-label="Add a picture"]')`), null);

	// Drop a wide picture on the empty board.
	const [cx, cy] = await box(".tg-stickies-canvas");
	await page.ev(`makePng(480, 240, "image.png").then((f) => dropFiles(document.querySelector('.tg-stickies-canvas'), [f], ${cx + 200}, ${cy + 150}))`);
	await page.sleep(400);
	let n = await notes();
	const pic = n[0]?.[1];
	check("dropping a picture adds a picture note", n.length === 1 && pic.image?.startsWith(FOLDER + "/Image ") && pic.image.endsWith(".png"), pic);
	check("the file is saved in the folder next to the data note", await page.ev(`Object.keys(files).length === 1 && folders.has(${JSON.stringify(FOLDER)})`), await page.ev(`Object.keys(files)`));
	check("its size keeps the picture's shape", pic && pic.w === 240 + 10 && pic.h === 120 + 28 + 10, pic && [pic.w, pic.h]);
	check("it's placed where it was dropped", pic && pic.x === 160 && Math.abs(pic.y - 138) <= 10, pic && [pic.x, pic.y]);
	const img = await page.ev(`(()=>{const i=document.querySelector('.tg-sticky.is-image img');return i?[i.complete,i.naturalWidth,i.getBoundingClientRect().width]:null})()`);
	check("the picture shows on the board", img && img[0] && img[1] === 480 && img[2] > 200, img);

	// Move it by its bar.
	const [bx, by, , bh] = await box(".tg-sticky.is-image .tg-sticky-bar");
	await page.drag(bx + 10, by + bh / 2, bx + 60, by + bh / 2 + 30);
	await page.sleep(100);
	n = await notes();
	check("a picture note moves like a note", n[0][1].x === pic.x + 50 && n[0][1].y === pic.y + 30, [n[0][1].x, n[0][1].y]);

	// Expand button: the note grows to the picture's full size, then back.
	const imgBox = async () => page.ev(`(()=>{const i=document.querySelector('.tg-sticky.is-image img').getBoundingClientRect();return [Math.round(i.width),Math.round(i.height)]})()`);
	await page.click(...(await page.center(".tg-sticky.is-image .tg-sticky-expand")));
	await page.sleep(100);
	n = await notes();
	check("expand grows the note to the picture's full size", n[0][1].w === 480 + 10 && n[0][1].h === 240 + 28 + 10, [n[0][1].w, n[0][1].h]);
	check("the picture is shown at its full size", JSON.stringify(await imgBox()) === "[480,240]", await imgBox());
	check("the button now shrinks", (await page.ev(`document.querySelector('.tg-sticky-expand').getAttribute('aria-label')`)) === "Shrink back", null);
	// A full-size picture can reach past the visible area: scroll to its button, as you would.
	await page.ev(`document.querySelector('.tg-sticky-expand').scrollIntoView({ block: "nearest", inline: "nearest" })`);
	await page.click(...(await page.center(".tg-sticky.is-image .tg-sticky-expand")));
	await page.sleep(100);
	n = await notes();
	check("pressed again it shrinks back", n[0][1].w === 250 && n[0][1].h === 158, [n[0][1].w, n[0][1].h]);
	check("the picture fills the note exactly", JSON.stringify(await imgBox()) === "[240,120]", await imgBox());

	// Double-click opens it in a tab.
	const [ix, iy, iw, ih] = await box(".tg-sticky-image");
	await page.mouse("mousePressed", ix + iw / 2, iy + ih / 2, 1);
	await page.mouse("mouseReleased", ix + iw / 2, iy + ih / 2, 1);
	await page.mouse("mousePressed", ix + iw / 2, iy + ih / 2, 2);
	await page.mouse("mouseReleased", ix + iw / 2, iy + ih / 2, 2);
	await page.sleep(100);
	check("double-click opens the picture", (await page.ev("window.opened")) === n[0][1].image, await page.ev("window.opened"));

	// Paste a picture into a text note: it goes into the text at the caret.
	await page.click(...(await page.center(".tg-stickies-add")));
	await page.sleep(100);
	await page.type("before");
	const prevented = await page.ev(`makePng(50, 50, "photo.png").then((f) => pasteFiles(document.activeElement, [f]))`);
	await page.sleep(300);
	n = await notes();
	const textNote = n.find(([, x]) => !x.image)[1];
	check("pasting a picture into a note embeds it", prevented && textNote.text === `before\n![[${FOLDER}/photo.png]]\n`, textNote.text);
	check("the caret is after the picture", await page.ev(`document.activeElement.selectionStart === document.activeElement.value.length`), null);

	// Drop a second picture on that note (not on the board): goes into its text too.
	const [tx, ty, tw, th] = await box(".tg-sticky:not(.is-image)");
	await page.ev(`makePng(50, 50, "photo.png").then((f) => dropFiles(document.querySelector('.tg-sticky:not(.is-image) .tg-sticky-text'), [f], ${tx + tw / 2}, ${ty + th / 2}))`);
	await page.sleep(300);
	n = await notes();
	check("dropping on a note embeds instead of adding a note", n.length === 2 && n.find(([, x]) => !x.image)[1].text.endsWith(`![[${FOLDER}/photo 1.png]]\n`), n.map(([, x]) => x.text));

	// A picture not synced yet shows a placeholder, then appears.
	await page.ev(`store.addSticky({ text: "", image: "ארכיון/Tasksgift/Sticky images/later.png", color: "default", x: 400, y: 300, w: 150, h: 150 }); draw()`);
	check("missing picture shows a placeholder", await page.ev(`[...document.querySelectorAll('.tg-sticky-image .tg-sticky-placeholder')].some((p) => p.textContent.includes('still syncing'))`), null);
	await page.ev(`makePng(20, 20, "x.png").then(async (f) => { files["ארכיון/Tasksgift/Sticky images/later.png"] = URL.createObjectURL(f); })`);
	await page.sleep(3500);
	check("it appears once the file arrives", (await page.ev(`document.querySelectorAll('.tg-sticky.is-image img').length`)) === 2, await page.ev(`document.querySelectorAll('.tg-sticky.is-image img').length`));

	// Delete the first picture: asks, then the note is a tombstone and the file goes to the trash.
	const firstPath = (await notes()).find(([, x]) => x.image?.includes("/Image "))[1].image;
	await page.ev(`document.querySelector('.tg-sticky.is-image [aria-label="Delete picture"]').click()`);
	await page.ev(`[...document.querySelectorAll('.modal-container:last-of-type button')].find((b) => b.textContent === "Delete").click()`);
	await page.sleep(200);
	n = await notes();
	check("delete removes the picture note", n.length === 2 && !n.some(([, x]) => x.image === firstPath), n.map(([, x]) => x.image));
	check("its file goes to the trash", (await page.ev("JSON.stringify(trashed)")) === JSON.stringify([firstPath]), await page.ev("JSON.stringify(trashed)"));
	// Default setting: Obsidian's attachment folder.
	await page.ev(`plugin.settings.stickyImagesLocation = "attachments"`);
	await page.ev(`makePng(60, 30, "photo.png").then((f) => dropFiles(document.querySelector('.tg-stickies-canvas'), [f], ${cx + 500}, ${cy + 500}))`);
	await page.sleep(300);
	await page.ev(`makePng(60, 30, "photo.png").then((f) => dropFiles(document.querySelector('.tg-stickies-canvas'), [f], ${cx + 500}, ${cy + 560}))`);
	await page.sleep(400);
	const inImages = (await notes()).map(([, x]) => x.image).filter((p) => p?.startsWith("Images/")).sort();
	check("by default pictures go to Obsidian's attachment folder", JSON.stringify(inImages) === JSON.stringify(["Images/photo 1.png", "Images/photo.png"]), inImages);
	check("the attachment folder is created when missing", await page.ev(`folders.has("Images")`), null);
	await page.screenshot(join(fileURLToPath(new URL(".", import.meta.url)), "out", "sticky-images.png"));
	check("no page errors", (await page.errors()).length === 0, await page.errors());
} finally {
	page.close();
}
process.exit(failed ? 1 : 0);
