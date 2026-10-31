// Reminders: set in the task modal, then real tasks that follow their task (real TaskStore). Run: npm run ui-test
import { join } from "path";
import { fileURLToPath } from "url";
import { openPage } from "./harness.mjs";

const page = await openPage(join(fileURLToPath(new URL(".", import.meta.url)), "reminders.page.js"));
let failed = 0;
const check = (name, ok, got) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
	if (!ok) failed++;
};
const json = async (expr) => JSON.parse(await page.ev(`JSON.stringify(${expr})`));
const clickSel = async (sel) => {
	await page.click(...(await page.center(sel)));
	await page.sleep(50);
};
const reminders = (title) => json(`window.open_(${JSON.stringify(title)})`);
const day = (n) => page.ev(`window.day(${n})`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const typeTitle = async (t) => {
	await clickSel(".tg-title-input");
	await page.type(t);
};

try {
	check("modal renders completely", (await page.errors()).length === 0 && (await page.ev(`!!document.querySelector('.tg-modal-buttons .mod-cta')`)), await page.errors());

	// In the modal: up to three, each with its own date.
	await clickSel(".tg-reminder-add");
	await clickSel(".tg-reminder-add");
	await clickSel(".tg-reminder-add");
	check("three reminders added", (await page.ev(`document.querySelectorAll('.tg-reminder-line').length`)) === 3, null);
	check("no fourth reminder", await page.ev(`!document.querySelector('.tg-reminder-add')`), null);
	await page.ev(`document.querySelectorAll('.tg-reminder-line .tg-clear')[2].click()`);
	await page.sleep(50);
	check("removing one brings the button back", await page.ev(`!!document.querySelector('.tg-reminder-add') && document.querySelectorAll('.tg-reminder-line').length === 2`), null);

	// Typing keeps focus in the amount (the line isn't redrawn).
	await clickSel(".tg-reminder-line input");
	await page.ev(`document.querySelector('.tg-reminder-line input').select()`);
	await page.type("3");
	await page.sleep(50);
	check("amount keeps focus while typing", await page.ev(`document.activeElement === document.querySelector('.tg-reminder-line input')`), null);
	check("each line shows its date", /\d{4}/.test(await page.ev(`document.querySelector('.tg-reminder-date').textContent`)), null);

	await typeTitle("חשבון חשמל");
	await clickSel(".tg-modal-buttons .mod-cta");
	await page.sleep(50);
	const title = "חשבון חשמל";
	const main = () => page.ev(`window.byTitle(${JSON.stringify(title)}).id`);
	check("creating makes the reminder tasks", same(await reminders(title), [await day(23), await day(27)]), await reminders(title));
	const first = await json(`window.store.all().find((t) => t.title.startsWith("🔔"))`);
	check("reminder has the list and says when the task is due", first.listId === "l1" && /^Due \d\d\/\d\d\/\d{4}$/.test(first.notes) && first.dirty, first);
	check("a reminder leads to its task", (await page.ev(`window.store.reminderTask(${JSON.stringify(first.id)})?.title`)) === title, null);

	// The task changes: its reminders follow.
	await page.ev(`window.store.update(${JSON.stringify(await main())}, { due: window.day(40) })`);
	check("moving the task moves them", same(await reminders(title), [await day(33), await day(37)]), await reminders(title));
	await page.ev(`window.store.update(${JSON.stringify(await main())}, { title: "ארנונה" })`);
	check("renaming renames them", same(await reminders("ארנונה"), [await day(33), await day(37)]), await reminders("ארנונה"));
	await page.ev(`window.store.update(window.byTitle("ארנונה").id, { title: ${JSON.stringify(title)}, listId: "l2" })`);
	check("changing list moves them", await page.ev(`window.store.all().filter((t) => t.title.startsWith("🔔")).every((t) => t.listId === "l2")`), null);

	// Done or deleted by hand: it doesn't come back.
	const r33 = await page.ev(`window.store.all().find((t) => t.due === window.day(33)).id`);
	await page.ev(`window.store.delete(${JSON.stringify(r33)})`);
	await page.ev(`window.store.update(${JSON.stringify(await main())}, { notes: "edited" })`);
	check("a deleted reminder stays deleted", same(await reminders(title), [await day(37)]), await reminders(title));
	const r37 = await page.ev(`window.store.all().find((t) => t.due === window.day(37)).id`);
	await page.ev(`window.store.setCompleted(${JSON.stringify(r37)}, true)`);
	await page.ev(`window.store.update(${JSON.stringify(await main())}, { notes: "edited again" })`);
	check("a completed reminder stays completed", (await reminders(title)).length === 0, await reminders(title));
	await page.ev(`window.store.update(${JSON.stringify(await main())}, { due: window.day(50) })`);
	check("moving the task again brings both back", same(await reminders(title), [await day(43), await day(47)]), await reminders(title));

	// A reminder moved by hand stays where it was put.
	const r47 = await page.ev(`window.store.all().find((t) => t.due === window.day(47)).id`);
	await page.ev(`window.store.update(${JSON.stringify(r47)}, { due: window.day(46) })`);
	await page.ev(`window.store.update(${JSON.stringify(await main())}, { notes: "edited a third time" })`);
	check("a reminder moved by hand stays", same(await reminders(title), [await day(43), await day(46)]), await reminders(title));

	// Completing the task clears its open reminders; undoing brings them back.
	await page.ev(`window.store.setCompleted(${JSON.stringify(await main())}, true)`);
	check("completing the task removes them", (await reminders(title)).length === 0, await reminders(title));
	await page.ev(`window.store.setCompleted(${JSON.stringify(await main())}, false)`);
	check("undoing brings them back", same(await reminders(title), [await day(43), await day(47)]), await reminders(title));

	// Local IDs turn into Google IDs.
	const oldMain = await main();
	await page.ev(`window.store.remap(${JSON.stringify(oldMain)}, "g-main")`);
	const reminderIds = await json(`window.store.all().filter((t) => t.title.startsWith("🔔")).map((t) => t.id)`);
	await page.ev(`window.store.remap(${JSON.stringify(reminderIds[0])}, "g-rem")`);
	await page.ev(`window.store.update("g-main", { due: window.day(60) })`);
	check("still linked after getting Google IDs", same(await reminders(title), [await day(53), await day(57)]), await reminders(title));

	// Pausing removes them, resuming brings them back.
	await page.ev(`window.store.pause("g-main")`);
	check("pausing removes them", (await reminders(title)).length === 0, await reminders(title));
	check("a paused task still shows its reminders", (await json(`window.store.reminders("g-main")`)).length === 2, null);
	await page.ev(`window.store.resume("g-main")`);
	check("resuming brings them back", same(await reminders(title), [await day(53), await day(57)]), await reminders(title));

	// Deleting the task deletes them.
	await page.ev(`window.store.delete(window.byTitle(${JSON.stringify(title)}).id)`);
	check("deleting the task deletes them", (await reminders(title)).length === 0, await reminders(title));

	// In the past: no reminder; a task in Google gone: its reminders go too.
	await page.ev(`(()=>{const t=window.store.create({title:"Soon",listId:"l1",due:window.day(2)},"local",true);window.store.update(t.id,{reminders:[{amount:1,unit:"weeks"},{amount:1,unit:"days"}]});})()`);
	check("a date already past gets no reminder", same(await reminders("Soon"), [await day(1)]), await reminders("Soon"));
	await page.ev(`window.store.forget(window.byTitle("Soon").id)`);
	check("a task deleted in Google takes them along", (await reminders("Soon")).length === 0, await reminders("Soon"));

	// Repeating: the next occurrence has its own.
	await page.ev(`(()=>{
		const due = window.day(10);
		const t = window.store.create({ title: "Rent", listId: "l1", due }, "local", true);
		window.store.update(t.id, {
			reminders: [{ amount: 2, unit: "days" }],
			recurrence: { preset: "daily", freq: "daily", interval: 7, byWeekday: [], monthlyMode: "day", monthDay: 1, nth: 1, nthWeekday: 0, end: { type: "never" }, occurrence: 1, anchor: due },
		});
		window.store.setCompleted(t.id, true);
	})()`);
	check("the next occurrence gets its reminder", same(await reminders("Rent"), [await day(15)]), await reminders("Rent"));

	// Another device: the newer change wins, and clearing arrives too.
	await page.ev(`(()=>{const t=window.store.create({title:"Sync",listId:"l1",due:window.day(20)},"local",true);window.store.update(t.id,{reminders:[{amount:1,unit:"days"}]});window.syncId=t.id;})()`);
	await page.ev(`window.store.mergeReminders({ [window.syncId]: { rules: [], updated: 1 } })`);
	check("an older change from another device is ignored", (await json(`window.store.reminders(window.syncId)`)).length === 1, null);
	await page.ev(`window.store.mergeReminders({ [window.syncId]: { rules: [], updated: Date.now() + 1000 } })`);
	check("a newer clearing arrives", (await json(`window.store.reminders(window.syncId)`)).length === 0, null);

	// Two devices each made the copy of a reminder: the kept copy stays linked.
	await page.ev(`(()=>{
		const t = window.store.create({ title: "Dup", listId: "l1", due: window.day(20) }, "local", true);
		window.store.update(t.id, { reminders: [{ amount: 1, unit: "days" }] });
		window.store.remap(window.store.data.reminders[t.id].rules[0].taskId, "z-copy");
		const other = window.store.create({ title: "🔔 Dup", listId: "l1", due: window.day(19) }, "local", true);
		window.store.remap(other.id, "a-copy");
		window.store.data.tasks["z-copy"].dirty = false;
		window.store.data.tasks["a-copy"].dirty = false;
		window.store.removeDuplicates();
		window.dupId = t.id;
	})()`);
	check("after removing a duplicate the link moves to the kept copy", (await page.ev(`window.store.data.reminders[window.dupId].rules[0].taskId`)) === "a-copy", null);

	// Editing: the modal shows them, and saving unchanged keeps the same reminder task.
	await page.ev(`(()=>{document.querySelectorAll('.modal-container, .tg-modal').forEach((m)=>m.remove());window.keepId=window.store.data.reminders[window.syncId];const t=window.store.create({title:"Edit",listId:"l1",due:window.day(20)},"local",true);window.store.update(t.id,{reminders:[{amount:1,unit:"weeks"}]});window.editId=t.id;window.remId=window.store.data.reminders[t.id].rules[0].taskId;window.openEdit(t.id)})()`);
	await page.sleep(50);
	check("editing shows the saved reminder", (await page.ev(`document.querySelector('.tg-reminder-line select').value`)) === "weeks", null);
	await clickSel(".tg-modal-buttons .mod-cta");
	await page.sleep(50);
	check("saving unchanged keeps the same task", await page.ev(`window.store.data.reminders[window.editId].rules[0].taskId === window.remId`), null);

	// Each reminder has its own description.
	const reopenEdit = async () => {
		await page.ev(`document.querySelectorAll('.modal-container').forEach((m)=>m.remove()); window.openEdit(window.editId)`);
		await page.sleep(50);
	};
	await reopenEdit();
	await clickSel(".tg-reminder-add");
	await clickSel(".tg-reminder-text");
	await page.type("להביא תעודה");
	await page.click(...(await page.center(".tg-reminder-text", 1)));
	await page.type("לאשר שעה");
	await clickSel(".tg-modal-buttons .mod-cta");
	const notesOf = (id) => page.ev(`window.store.get(${id}).notes`);
	check("the first reminder has its own text, above the due date", /^להביא תעודה\nDue \d\d\/\d\d\/\d{4}$/.test(await notesOf("window.remId")), await notesOf("window.remId"));
	check("adding text keeps the same task", await page.ev(`window.store.data.reminders[window.editId].rules[0].taskId === window.remId`), null);
	check("the second has a different text", /^לאשר שעה\nDue /.test(await notesOf("window.store.data.reminders[window.editId].rules[1].taskId")), await notesOf("window.store.data.reminders[window.editId].rules[1].taskId"));
	await reopenEdit();
	check("the texts are back when editing", (await page.ev(`[...document.querySelectorAll('.tg-reminder-text')].map((t)=>t.value).join('|')`)) === "להביא תעודה|לאשר שעה", null);
	await page.ev(`document.querySelectorAll('.tg-reminder-line .tg-clear')[1].click()`);
	await page.sleep(50);
	check("removing one keeps the other's text", (await page.ev(`[...document.querySelectorAll('.tg-reminder-text')].map((t)=>t.value).join('|')`)) === "להביא תעודה", null);
	await page.ev(`(()=>{const t=document.querySelector('.tg-reminder-text');t.value='';t.dispatchEvent(new Event('input'))})()`);
	await clickSel(".tg-modal-buttons .mod-cta");
	check("clearing the text leaves just the due date", /^Due /.test(await notesOf("window.remId")), await notesOf("window.remId"));

	await page.ev(`(()=>{
		const due = window.day(10);
		const t = window.store.create({ title: "Gym", listId: "l1", due }, "local", true);
		window.store.update(t.id, {
			reminders: [{ amount: 2, unit: "days", text: "לארוז תיק" }],
			recurrence: { preset: "daily", freq: "daily", interval: 7, byWeekday: [], monthlyMode: "day", monthDay: 1, nth: 1, nthWeekday: 0, end: { type: "never" }, occurrence: 1, anchor: due },
		});
		window.store.setCompleted(t.id, true);
		const next = window.store.all().find((x) => x.title === "Gym" && x.status === "needsAction");
		window.store.pause(next.id);
		window.store.resume(next.id);
	})()`);
	check("the text goes along with repeats and pausing", await page.ev(`window.store.all().find((t) => t.title === "🔔 Gym" && t.status === "needsAction").notes.startsWith("לארוז תיק")`), null);

	check("no page errors", (await page.errors()).length === 0, await page.errors());
} finally {
	page.close();
}
process.exit(failed ? 1 : 0);
