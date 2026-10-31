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

	// The "Ends" dropdown is the second select; the date field shows only for "On a date".
	const setEnd = (v) => page.ev(`(()=>{const s=document.querySelectorAll('.modal-content select')[1];s.value='${v}';s.dispatchEvent(new Event('change'))})()`);
	const untilShown = () => page.ev(`getComputedStyle(document.querySelector('.tg-day-title-until')).display !== 'none'`);
	check("end date hidden by default", !(await untilShown()), await untilShown());
	await setEnd("date");
	check("end date shown for 'On a date'", await untilShown(), await untilShown());
	// The topic was written for a past day (2026-10-21): the earliest last day is today, not that day.
	const todayKey = await page.ev(`(()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')})()`);
	await page.click(...(await page.center(".tg-day-title-until")));
	const pastBlocked = await page.ev(`(()=>{const d=new Date();d.setDate(d.getDate()-1);const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');while(!document.querySelector('[data-date="'+k+'"]')||!document.querySelector('[data-date="${todayKey}"]'))document.querySelector('.tg-date-nav[aria-label="Previous month"]').click();return document.querySelector('[data-date="'+k+'"]').classList.contains('is-disabled')&&!document.querySelector('[data-date="${todayKey}"]').classList.contains('is-disabled')})()`);
	check("earliest last day is today", pastBlocked, pastBlocked);
	await page.ev(`(()=>{const next=document.querySelector('.tg-date-nav[aria-label="Next year"]');while(!document.querySelector('[data-date="2099-11-05"]')&&document.querySelector('.tg-date-month').textContent!=='November 2099'){if(document.querySelector('.tg-date-month').textContent.endsWith('2099'))document.querySelector('.tg-date-nav[aria-label="Next month"]').click();else next.click()}})()`);
	await page.click(...(await page.center('[data-date="2099-11-05"]')));
	const endEl = () => page.ev(`(()=>{const e=document.querySelector('.tg-day-title-preview .tg-day-title-end');return e&&getComputedStyle(e).display!=='none'?{dir:e.getAttribute('dir'),text:e.textContent,size:e.className}:null})()`);
	check("end date not in the preview before it's switched on", (await endEl()) === null, await endEl());
	// "Show the end date" is the first checkbox after the Ends row (Bold, Italic, Background come before it).
	await page.ev(`(()=>{const c=document.querySelectorAll('.modal-content input[type=checkbox]')[3];c.click()})()`);
	await page.click(...(await page.center(".tg-day-title-end-settings input[type=text]")));
	await page.type("עד");
	await page.sleep(100);
	const he = await endEl();
	check("Hebrew words: right-to-left, date as DD/MM/YYYY", he?.dir === "rtl" && he?.text === "עד 05/11/2099", he);
	await page.ev(`(()=>{const i=document.querySelector('.tg-day-title-end-settings input[type=text]');i.value='Ends';i.dispatchEvent(new Event('input'))})()`);
	await page.ev(`(()=>{const s=document.querySelector('.tg-day-title-end-settings select[aria-label="End date size"]');s.value='huge';s.dispatchEvent(new Event('change'))})()`);
	const en = await endEl();
	check("English words: left-to-right, own size", en?.dir === "ltr" && en?.text === "Ends 05/11/2099" && en?.size.includes("is-huge"), en);
	const timeShown = () => page.ev(`getComputedStyle(document.querySelector('.tg-day-title-until-time')).display !== 'none'`);
	check("end time shown for 'On a date'", await timeShown(), await timeShown());
	await page.click(...(await page.center(".tg-day-title-until-time")));
	await page.type("18:30");
	await page.sleep(50);
	check("end time after the date", (await endEl())?.text === "Ends 05/11/2099 18:30", await endEl());

	// Position: where the end date sits on screen next to the topic.
	const place = () => page.ev(`(()=>{const a=document.querySelector('.tg-day-title-preview .tg-day-title:not(.tg-day-title-end)').getBoundingClientRect();const b=document.querySelector('.tg-day-title-preview .tg-day-title-end').getBoundingClientRect();return b.top>=a.bottom-1?'below':b.bottom<=a.top+1?'above':b.left>=a.right-1?'right':b.right<=a.left+1?'left':'overlap'})()`);
	const setPos = (v) => page.ev(`(()=>{const s=document.querySelector('select[aria-label="End date position"]');s.value='${v}';s.dispatchEvent(new Event('change'))})()`);
	check("end date below the topic by default", (await place()) === "below", await place());
	for (const p of ["above", "right", "left", "below"]) {
		await setPos(p);
		check(`end date ${p} the topic`, (await place()) === p, await place());
	}

	// Letters of the end date's words are colored like the topic's.
	const endInput = ".tg-day-title-end-settings input[type=text]";
	const [ex, ey] = await page.center(endInput);
	await page.click(ex, ey);
	await page.ev(`(()=>{const i=document.querySelector('${endInput}');i.focus();i.setSelectionRange(0,2)})()`);
	await page.sleep(50);
	await page.click(...(await page.center(".tg-day-title-end-settings .tg-color-swatch", 1)));
	const endHtml = () => page.ev(`document.querySelector('.tg-day-title-preview .tg-day-title-end .tg-day-title-text').innerHTML`);
	check("selected letters of the words get the color", (await endHtml()).startsWith('<span data-color="red"'), await endHtml());
	check("topic colors untouched by the end date's row", !(await preview()).includes("red"), await preview());
	await setEnd("never");
	check("end date hidden for 'Never'", !(await untilShown()) && !(await timeShown()) && (await endEl()) === null, await endEl());
	await page.click(...(await page.center(".tg-modal-buttons .mod-cta")));
	await page.sleep(100);
	const saved = await page.ev(`JSON.stringify(window.saved)`);
	check("saves a topic that never ends", JSON.parse(saved)?.until === null && JSON.parse(saved)?.untilTime === undefined && JSON.parse(saved)?.text === "Hello world!", saved);
	check("saves the end date's letter colors and position", JSON.parse(saved)?.endNote?.parts?.[0]?.text === "En" && JSON.parse(saved)?.endNote?.position === "below", JSON.parse(saved)?.endNote);
	check("no page errors", (await page.errors()).length === 0, await page.errors());
} finally {
	page.close();
}
process.exit(failed ? 1 : 0);
