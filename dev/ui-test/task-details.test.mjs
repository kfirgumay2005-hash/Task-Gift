// Task colors and paused tasks between two devices (whole plugin, notes copied like Self-hosted LiveSync).
// Run: npm run ui-test
import { join } from "path";
import { fileURLToPath } from "url";
import { openPage } from "./harness.mjs";

const page = await openPage(join(fileURLToPath(new URL(".", import.meta.url)), "two-devices.page.js"));
let failed = 0;
const check = (name, ok, got) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
	if (!ok) failed++;
};
const ev = async (expr) => JSON.parse((await page.ev(`JSON.stringify(${expr})`)) ?? "null");
const q = JSON.stringify;

try {
	await page.ev(`start("A")`);
	const t1 = await ev(`addTask("A", "Salad", "2026-11-14")`);
	const t2 = await ev(`addTask("A", "Quinoa", "2026-11-15")`);
	await page.sleep(2000);
	await page.ev(`start("B")`);
	check("B starts with A's tasks", (await ev(`devices.B.plugin.store.get(${q(t1)})?.title`)) === "Salad");

	// A color set on B reaches A, also when A's data note (still without it) is written and arrives afterwards.
	await page.ev(`setColor("A", ${q(t1)}, "blue")`);
	await page.sleep(4000);
	check("B shows A's color", (await ev(`colorOf("B", ${q(t1)})`)) === "blue", await ev(`colorOf("B", ${q(t1)})`));
	await page.ev(`keepDataNote("A")`);
	await page.ev(`setColor("B", ${q(t1)}, "red")`);
	await page.sleep(4000);
	check("A shows B's color", (await ev(`colorOf("A", ${q(t1)})`)) === "red", await ev(`colorOf("A", ${q(t1)})`));
	await page.ev(`deliverKept("B")`);
	await page.sleep(3000);
	check("B keeps its color after A's old data note arrives", (await ev(`colorOf("B", ${q(t1)})`)) === "red", await ev(`colorOf("B", ${q(t1)})`));
	check("A still red", (await ev(`colorOf("A", ${q(t1)})`)) === "red");

	// Clearing a color syncs too.
	await page.ev(`setColor("A", ${q(t1)}, null)`);
	await page.sleep(4000);
	check("B shows the color cleared on A", (await ev(`colorOf("B", ${q(t1)})`)) === null, await ev(`colorOf("B", ${q(t1)})`));

	// A pause on A shows on B, also when B's data note (still without the pause) arrives at A afterwards.
	await page.ev(`keepDataNote("B")`);
	await page.ev(`pause("A", ${q(t2)})`);
	await page.sleep(4000);
	check("B shows A's paused task", (await ev(`pausedTitles("B")`)).join() === "Quinoa", await ev(`pausedTitles("B")`));
	await page.ev(`deliverKept("A")`);
	await page.sleep(3000);
	check("A keeps its paused task", (await ev(`pausedTitles("A")`)).join() === "Quinoa", await ev(`pausedTitles("A")`));

	// The same task paused on both devices ends up once on both.
	await page.ev(`pauseCopy("A", "keyA", "Salad", "2026-11-14")`);
	await page.ev(`pauseCopy("B", "keyB", "Salad", "2026-11-20")`);
	await page.sleep(6000);
	check("A shows one Salad", (await ev(`pausedTitles("A")`)).join() === "Quinoa,Salad", await ev(`pausedTitles("A")`));
	check("B shows one Salad", (await ev(`pausedTitles("B")`)).join() === "Quinoa,Salad", await ev(`pausedTitles("B")`));

	// Colors that differed before the stamps: the device that claims them wins on both.
	await page.ev(`oldColor("A", ${q(t1)}, "green")`);
	await page.ev(`oldColor("B", ${q(t1)}, "purple")`);
	await page.ev(`claim("B")`);
	await page.sleep(4000);
	check("A takes B's claimed color", (await ev(`colorOf("A", ${q(t1)})`)) === "purple", await ev(`colorOf("A", ${q(t1)})`));
	check("B keeps its claimed color", (await ev(`colorOf("B", ${q(t1)})`)) === "purple", await ev(`colorOf("B", ${q(t1)})`));

	check("no page errors", (await page.errors()).length === 0, await page.errors());
} finally {
	page.close();
}
process.exit(failed ? 1 : 0);
