import { TaskModal } from "../../src/modals/TaskModal";
import { TaskStore } from "../../src/sync/store";
import { emptyStore } from "../../src/defaults";
import { useWeekStart } from "../../src/modals/dateFields";
import { addDays, today } from "../../src/util/dates";

window.errors = [];
window.addEventListener("error", (e) => window.errors.push(String(e.message)));
// The real store: reminders are mostly its work.
const data = emptyStore();
data.lists.l1 = { id: "l1", title: "My Tasks", updated: "" };
data.lists.l2 = { id: "l2", title: "Other", updated: "" };
window.store = new TaskStore(data, () => {});
window.day = (n) => addDays(today(), n);
window.weekStart = 0;
useWeekStart(() => window.weekStart);
window.openNew = (due) => new TaskModal({}, window.store, { defaults: { listId: "l1", due } }).open();
window.openEdit = (id) => new TaskModal({}, window.store, { task: window.store.get(id) }).open();
/** Open reminder tasks of a main task's title, as "date title". */
window.open_ = (title) =>
	window.store
		.all()
		.filter((t) => t.title === `🔔 ${title}` && t.status === "needsAction")
		.map((t) => t.due)
		.sort();
window.byTitle = (title) => window.store.all().find((t) => t.title === title);
try {
	window.openNew(window.day(30));
} catch (e) {
	window.errors.push(String(e && e.stack));
}
