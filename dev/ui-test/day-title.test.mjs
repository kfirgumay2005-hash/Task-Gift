// Day-topic modal: typing updates the preview, selected letters get their own color. Run: npm run ui-test
import { join } from "path";
import { fileURLToPath } from "url";
import { openPage } from "./harness.mjs";

const page = await openPage(join(fileURLToPath(new URL(".", import.meta.url)), "day-title.page.js"));
let failed = 0;
const check = (name, ok, got) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
	if (!ok) failed++;
};
const preview = () => page.ev(`document.querySelector('.tg-day-title-preview .tg-day-title-text').innerHTML`);
// Screen x of the caret before character `i` of the title field.
const xAt = (i) => page.ev(`(()=>{const el=document.querySelector('.tg-day-title-input');const cs=getComputedStyle(el);const c=document.createElement('canvas').getContext('2d');c.font=cs.font;return el.getBoundingClientRect().x+parseFloat(cs.paddingLeft)+parseFloat(cs.borderLeftWidth)+c.measureText(el.value.slice(0,${i})).width})()`);

try {
	check("modal renders completely", (await page.errors()).length === 0 && (await page.ev(`document.querySelectorAll('.tg-color-swatch').length`)) > 1, await page.errors());
	const [ix, iy] = await page.center(".tg-day-title-input");
	await page.click(ix, iy);
	await page.type("Hello world");
	await page.sleep(300);
	check("typing updates the preview", (await preview()) === "Hello world", await preview());

	await page.drag((await xAt(6)) + 1, iy, (await xAt(11)) + 1, iy);
	await page.click(...(await page.center(".tg-color-swatch", 1)));
	check("only the selected letters get the color", (await preview()).startsWith("Hello <span data-color=\"red\""), await preview());

	await page.key("End", 35);
	await page.type("!");
	await page.sleep(300);
	check("typed letter takes the color before it", (await preview()).includes(">world!</span>"), await preview());

	await page.key("Home", 36);
	for (let i = 0; i < 5; i++) await page.key("ArrowRight", 39, 8);
	const [sx, sy] = await page.center(".modal-content select");
	await page.click(sx - 60, sy);
	await page.click(...(await page.center(".tg-color-swatch", 6)));
	check("selection survives a click elsewhere", (await preview()).startsWith("<span data-color=\"blue\""), await preview());

	await page.click(ix - 50, iy);
	await page.click(...(await page.center(".tg-color-swatch", 3)));
	check("no selection colors the whole title", (await preview()) === "Hello world!", await preview());
	check("no page errors", (await page.errors()).length === 0, await page.errors());
} finally {
	page.close();
}
process.exit(failed ? 1 : 0);
