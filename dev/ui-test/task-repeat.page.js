import { TaskModal } from "../../src/modals/TaskModal";

window.errors = [];
window.addEventListener("error", (e) => window.errors.push(String(e.message)));
window.updates = [];
// Just the store methods the modal uses.
const task = { id: "t1", listId: "l1", title: "Pay the bill", notes: "", status: "needsAction", due: "2026-10-25", position: "0" };
const store = {
	lists: () => [{ id: "l1", title: "My Tasks" }],
	defaultListId: () => "l1",
	time: () => null,
	color: () => null,
	modes: () => null,
	rule: () => null,
	reminders: () => [],
	update: (id, edit) => window.updates.push({ id, ...edit }),
	create: () => task,
	notify: () => {},
};
try {
	new TaskModal({}, store, { task }).open();
} catch (e) {
	window.errors.push(String(e && e.stack));
}
