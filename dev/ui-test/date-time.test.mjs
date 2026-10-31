// The task modal's date and time fields: times survive saving, whatever the computer's clock format. Run: npm run ui-test
import { join } from "path";
import { fileURLToPath } from "url";
import { openPage } from "./harness.mjs";

const page = await openPage(join(fileURLToPath(new URL(".", import.meta.url)), "reminders.page.js"));
let failed = 0;
const check = (name, ok, got) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
	if (!ok) failed++;
};
const clickSel = async (sel) => {
	await page.click(...(await page.center(sel)));
	await page.sleep(50);
};
const reopenNew = async (due) => {
	await page.ev(`document.querySelectorAll('.modal-container').forEach((m)=>m.remove()); window.openNew(${due ? `window.day(${due})` : '""'})`);
	await page.sleep(50);
};
const panelOpen = () => page.ev(`!document.querySelector('.tg-form .tg-date-panel').classList.contains('is-hidden')`);
const dueValue = () => page.ev(`document.querySelector('.tg-form .tg-date-field').dataset.value`);

/** Types a task with a time, saves it and returns the time the store has. */
async function saveWithTime(name, typed) {
	await reopenNew(5);
	await clickSel(".tg-title-input");
	await page.type(name);
	await clickSel(".tg-time-field");
	await page.keys(typed);
	await clickSel(".tg-modal-buttons .mod-cta");
	return page.ev(`window.byTitle(${JSON.stringify(name)})?.id ? window.store.time(window.byTitle(${JSON.stringify(name)}).id) : "not saved"`);
}

try {
	check("modal renders completely", (await page.errors()).length === 0 && (await page.ev(`!!document.querySelector('.tg-modal-buttons .mod-cta')`)), await page.errors());

	// The reported bug: a morning time typed without AM/PM was silently dropped.
	check("a morning time is saved", (await saveWithTime("morning", "02:30")) === "02:30", null);
	check("an afternoon time is saved", (await saveWithTime("afternoon", "14:30")) === "14:30", null);
	check("digits only", (await saveWithTime("digits", "930")) === "09:30", null);
	check("just the hour", (await saveWithTime("hour", "16")) === "16:00", null);
	check("am/pm still works", (await saveWithTime("pm", "2:30pm")) === "14:30", null);

	await page.ev(`document.querySelectorAll('.modal-container').forEach((m)=>m.remove()); window.openEdit(window.byTitle("morning").id)`);
	await page.sleep(50);
	check("the saved time is back when the task is opened again", (await page.ev(`document.querySelector('.tg-time-field').value`)) === "02:30", null);

	// Something that isn't a time stops the save instead of vanishing.
	await page.ev(`window.notices = []`);
	check("a wrong time isn't saved", (await saveWithTime("wrong", "25:00")) === "not saved", null);
	check("and says why", /HH:MM/.test(await page.ev(`(window.notices ?? []).join()`)), await page.ev(`window.notices`));
	check("the modal stays open", await page.ev(`!!document.querySelector('.tg-form')`), null);
	check("the field is marked", await page.ev(`document.querySelector('.tg-time-field').classList.contains('is-invalid')`), null);

	// The calendar.
	await reopenNew(0);
	check("no date yet: time is off", await page.ev(`document.querySelector('.tg-time-field').disabled`), null);
	await clickSel(".tg-form .tg-date-field");
	check("clicking opens the calendar", await panelOpen(), null);
	check("six weeks of days", (await page.ev(`document.querySelectorAll('.tg-form .tg-date-grid .tg-date-day').length`)) === 42, null);
	const t0 = await page.ev(`window.day(0)`);
	check("today is marked", await page.ev(`document.querySelector('[data-date="${t0}"]').classList.contains('is-today')`), null);
	await clickSel(".tg-form .tg-date-quick-item:nth-child(2)");
	check("Tomorrow picks tomorrow", (await dueValue()) === (await page.ev(`window.day(1)`)), await dueValue());
	check("picking closes it", !(await panelOpen()), null);
	check("the time field wakes up", await page.ev(`!document.querySelector('.tg-time-field').disabled`), null);

	await clickSel(".tg-form .tg-date-field");
	const before = await page.ev(`document.querySelector('.tg-date-month').textContent`);
	await clickSel('.tg-date-nav[aria-label="Next month"]');
	check("the arrows change the month", (await page.ev(`document.querySelector('.tg-date-month').textContent`)) !== before, null);
	check("and leave it open", await panelOpen(), null);
	await clickSel(".tg-date-day:not(.is-outside)");
	check("a day of that month can be picked", (await dueValue()).endsWith("-01"), await dueValue());
	await page.ev(`window.weekStart = 1`);
	await clickSel(".tg-form .tg-date-field");
	check("the week starts where the settings say", (await page.ev(`document.querySelector('.tg-date-weekdays div').textContent`)) === "Mo", null);
	await clickSel(".tg-title-input");
	check("clicking elsewhere closes it", !(await panelOpen()), null);

	await clickSel(".tg-form .tg-clear");
	check("clearing the date empties the field", (await dueValue()) === "", await dueValue());

	check("no page errors", (await page.errors()).length === 0, await page.errors());
	if (process.env.SHOT) {
		await reopenNew(5);
		await page.ev(`(()=>{const s=document.createElement('style');s.textContent=':root{--background-primary:#fff;--background-secondary:#f6f6f6;--background-modifier-border:#ddd;--background-modifier-hover:#0000000d;--interactive-accent:#7852ee;--text-on-accent:#fff;--text-muted:#5c5c5c;--text-faint:#ababab;--text-normal:#222;--font-ui-small:13px;--font-ui-smaller:12px}body{font-family:Segoe UI,sans-serif;color:#222}.modal{width:520px;margin:10px auto;padding:16px;background:#fff}';document.head.appendChild(s)})()`);
		await clickSel(".tg-form .tg-date-field");
		await page.screenshot(process.env.SHOT);
	}
} finally {
	page.close();
}
process.exit(failed ? 1 : 0);
