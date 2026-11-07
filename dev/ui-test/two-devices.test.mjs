// Two devices running the whole plugin, notes copied between them like Self-hosted LiveSync. Run: npm run ui-test
import { join } from "path";
import { fileURLToPath } from "url";
import { openPage } from "./harness.mjs";

const page = await openPage(join(fileURLToPath(new URL(".", import.meta.url)), "two-devices.page.js"));
let failed = 0;
const check = (name, ok, got) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
	if (!ok) failed++;
};
const pos = async (dev, id) => JSON.parse(await page.ev(`JSON.stringify(sticky(${JSON.stringify(dev)}, ${JSON.stringify(id)}))`));
const disk = async (dev, id) => JSON.parse(await page.ev(`JSON.stringify(onDisk(${JSON.stringify(dev)}, ${JSON.stringify(id)}))`));
const at = (p, x, y) => !!p && p.x === x && p.y === y;

try {
	await page.ev(`start("A")`);
	const id = await page.ev(`addNote("A")`);
	await page.sleep(2000);
	await page.ev(`start("B")`);
	check("B starts with A's note", at(await pos("B", id), 10, 10), await pos("B", id));

	await page.ev(`move("B", ${JSON.stringify(id)}, 300, 200)`);
	await page.sleep(1500);
	check("B wrote the new position to its topics note", at(await disk("B", id), 300, 200), await disk("B", id));
	check("the note reached A's disk", at(await disk("A", id), 300, 200), await disk("A", id));
	await page.sleep(2500);
	check("A shows B's move (without restarting)", at(await pos("A", id), 300, 200), await pos("A", id));
	await page.sleep(3000);
	check("B keeps its own move", at(await pos("B", id), 300, 200), await pos("B", id));

	await page.ev(`move("A", ${JSON.stringify(id)}, 50, 60)`);
	await page.sleep(5000);
	check("B shows A's move back", at(await pos("B", id), 50, 60), await pos("B", id));
	check("A keeps its own move", at(await pos("A", id), 50, 60), await pos("A", id));

	console.log((await page.ev("JSON.stringify(log.slice(-30))")));
	check("no page errors", (await page.errors()).length === 0, await page.errors());
} finally {
	page.close();
}
process.exit(failed ? 1 : 0);
