// Calendar picker: extra calendars can be deleted from its menu, the Tasks calendar can't. Run: npm run ui-test
import { join } from "path";
import { fileURLToPath } from "url";
import { openPage } from "./harness.mjs";

const page = await openPage(join(fileURLToPath(new URL(".", import.meta.url)), "calendar-delete.page.js"));
let failed = 0;
const check = (name, ok, got) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
	if (!ok) failed++;
};
const openMenu = async () => {
	await page.click(...(await page.center(".tg-cal-picker")));
	await page.sleep(50);
	return page.ev(`window.lastMenu.map((i) => i.title)`);
};
const pick = (title) => page.ev(`window.lastMenu.find((i) => i.title === ${JSON.stringify(title)}).click()`);
const button = async (text) => {
	await page.ev(`[...document.querySelectorAll('.modal-container:last-of-type button')].find((b) => b.textContent === ${JSON.stringify(text)}).click()`);
	await page.sleep(50);
};
const picker = () => page.ev(`document.querySelector('.tg-cal-picker').textContent`);

try {
	let items = await openMenu();
	check("from the tasks, every extra calendar can be deleted", items.includes('Delete "Shifts"…') && items.includes('Delete "Trips"…'), items);
	check("the Tasks calendar can't", !items.includes('Delete "Tasks"…'), items);
	check("delete items are marked as dangerous", await page.ev(`window.lastMenu.filter((i) => i.title.startsWith("Delete")).every((i) => i.warning)`), null);

	await pick('Delete "Trips"…');
	await page.sleep(50);
	check("asks first, naming the calendar and its entries", await page.ev(`/"Trips" and its 1 entry go to the trash/.test(document.querySelector('.modal-content p').textContent)`), null);
	await button("Cancel");
	check("Cancel keeps it", (await page.ev(`window.removed.length`)) === 0, await page.ev(`window.removed`));

	await openMenu();
	await pick('Delete "Trips"…');
	await page.sleep(50);
	await button("Delete");
	check("Delete removes it", (await page.ev(`window.removed.join()`)) === "Trips", await page.ev(`window.removed`));
	items = await openMenu();
	check("it left the menu", !items.includes("Trips") && !items.includes('Delete "Trips"…'), items);

	await pick("Shifts");
	await page.sleep(50);
	check("the shown calendar opens", (await picker()).includes("Shifts"), await picker());
	items = await openMenu();
	check("while shown, the menu deletes only it", items.filter((t) => t.startsWith("Delete")).join() === 'Delete "Shifts"…', items);

	await pick('Delete "Shifts"…');
	await page.sleep(50);
	await button("Delete");
	check("deleting the shown calendar goes back to Tasks", (await picker()).includes("Tasks") && (await page.ev(`window.ui.calendar`)) === null, await picker());
	items = await openMenu();
	check("with none left, nothing to delete", !items.some((t) => t.startsWith("Delete")), items);
	check("no page errors", (await page.errors()).length === 0, await page.errors());
} catch (e) {
	check("test ran to the end", false, String(e));
}
page.close();
process.exit(failed ? 1 : 0);
