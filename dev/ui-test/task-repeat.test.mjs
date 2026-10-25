// Task modal: "Monthly on the 1st Monday after day 10" moves the due date there and saves the rule. Run: npm run ui-test
import { join } from "path";
import { fileURLToPath } from "url";
import { openPage } from "./harness.mjs";

const page = await openPage(join(fileURLToPath(new URL(".", import.meta.url)), "task-repeat.page.js"));
let failed = 0;
const check = (name, ok, got) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
	if (!ok) failed++;
};
// Picks an option in the n-th select matching `selector`, like choosing it from the dropdown.
const choose = (selector, value, n = 0) =>
	page.ev(`(()=>{const s=document.querySelectorAll(${JSON.stringify(selector)})[${n}];s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change'))})()`);
const due = () => page.ev(`document.querySelector('.tg-form input[type=date]').value`);
const preview = () => page.ev(`document.querySelector('.tg-after-line + .tg-subhint')?.textContent ?? null`);

try {
	check("modal renders completely", (await page.errors()).length === 0 && (await page.ev(`!!document.querySelector('.tg-modal-buttons .mod-cta')`)), await page.errors());
	await choose(".tg-form-field select.dropdown", "custom", 1);
	await choose(".tg-custom-line select.dropdown", "monthly", 0);
	await choose(".tg-custom-line select.dropdown", "after", 1);
	check("after-day controls shown", await page.ev(`!!document.querySelector('.tg-after-line')`), null);
	check("starts at the due date itself (Sunday on or after day 25)", (await due()) === "2026-10-25", await due());

	// The line: [1st] [weekday] [after / on or after] day [N]
	await choose(".tg-after-line select", "1", 1);
	await choose(".tg-after-line select", "after", 2);
	const [dx, dy] = await page.center(".tg-after-line input");
	await page.click(dx, dy);
	await page.ev(`document.querySelector('.tg-after-line input').select()`);
	await page.type("10");
	await page.sleep(200);
	check("due date moves to the 1st Monday after Nov 10", (await due()) === "2026-11-16", await due());
	check("day field keeps focus while typing", await page.ev(`document.activeElement === document.querySelector('.tg-after-line input')`), null);
	check("preview lists the next dates", /Nov.*16.*Dec.*14.*Jan.*11.*Feb.*15/s.test((await preview()) ?? ""), await preview());

	// Picking a date by hand: the due date goes to the first matching day from there.
	await page.ev(`(()=>{const i=document.querySelector('.tg-form input[type=date]');i.value='2027-03-01';i.dispatchEvent(new Event('change'))})()`);
	check("hand-picked date snaps to the rule", (await due()) === "2027-03-15", await due());
	check("controls kept after the date change", (await page.ev(`document.querySelector('.tg-after-line input')?.value`)) === "10", null);

	await page.click(...(await page.center(".tg-modal-buttons .mod-cta")));
	await page.sleep(100);
	const saved = JSON.parse(await page.ev(`JSON.stringify(window.updates[0] ?? null)`));
	const r = saved?.recurrence;
	check(
		"saves the rule and the due date",
		saved?.due === "2027-03-15" && r?.monthlyMode === "after" && r.afterDay === 10 && r.afterInclusive === false && r.nth === 1 && r.nthWeekday === 1 && r.anchor === "2027-03-15",
		saved,
	);
	check("no page errors", (await page.errors()).length === 0, await page.errors());
} finally {
	page.close();
}
process.exit(failed ? 1 : 0);
