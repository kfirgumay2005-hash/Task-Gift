// Time capsules: sealed notes (words + pictures / videos) to a chosen day, written from the topic's window, any number
// of them; their contents never show before that day. Run: npm run ui-test.
// Files are added by a synthetic drop with real files (the system file picker can't be driven).
import { join } from "path";
import { fileURLToPath } from "url";
import { openPage } from "./harness.mjs";

const page = await openPage(join(fileURLToPath(new URL(".", import.meta.url)), "capsule.page.js"));
let failed = 0;
const check = (name, ok, got) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
	if (!ok) failed++;
};
const capsules = async () => JSON.parse(await page.ev(`JSON.stringify(Object.values(store.data.capsules))`));
const rows = () => page.ev(`[...document.querySelectorAll('.tg-capsule-row-text')].map((e) => e.textContent)`);
const lastModal = `[...document.querySelectorAll('.modal-container')].pop()`;
const clickIn = async (sel) => {
	const [x, y] = await page.ev(`(()=>{const el=${lastModal}.querySelector(${JSON.stringify(sel)});el.scrollIntoView({block:"center"});const b=el.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`);
	await page.click(x, y);
	await page.sleep(150);
};
const newButton = `[...document.querySelectorAll('button')].find((b) => b.textContent === 'New time capsule')`;
const ddmm = (d) => d.split("-").reverse().join("/");

try {
	check("topic window renders with the capsules section", (await page.errors()).length === 0 && (await page.ev(`!!${newButton}`)), await page.errors());
	check("no capsules listed yet", (await rows()).length === 0, await rows());

	// Write one: words and a picture (a second one dropped and removed again).
	await page.ev(`${newButton}.click()`);
	await page.sleep(150);
	check("New time capsule opens its own window", await page.ev(`!!document.querySelector('.tg-capsule-edit-modal .tg-capsule-input')`), null);
	await clickIn(".mod-cta");
	check("an empty capsule isn't sealed", (await capsules()).length === 0 && (await page.ev(`(window.notices||[]).pop()`))?.startsWith("Write something"), await capsules());
	await clickIn(".tg-capsule-input");
	await page.type("Good luck, me");
	await page.ev(`Promise.all([makePng(40, 30, "a.png"), makePng(20, 20, "b.png")]).then((f) => dropFiles(document.querySelector('.tg-capsule-edit'), f))`);
	await page.sleep(200);
	check("dropped pictures show as thumbnails", (await page.ev(`document.querySelectorAll('.tg-capsule-thumb img').length`)) === 2, null);
	await clickIn(".tg-capsule-thumb:nth-child(2) .tg-capsule-remove");
	check("a thumbnail's x removes it", (await page.ev(`document.querySelectorAll('.tg-capsule-thumb').length`)) === 1, null);
	check("nothing is copied into the vault before sealing", (await page.ev(`Object.keys(files).length`)) === 0, null);
	await clickIn(".mod-cta");
	await page.sleep(150);
	let c = await capsules();
	check("Seal stores the capsule for the chosen day (a week ahead by default)", c.length === 1 && c[0].opens === (await page.ev("inWeek")) && c[0].written === (await page.ev("today")) && c[0].text === "Good luck, me" && JSON.stringify(c[0].media) === '["Images/a.png"]', c);
	check("…and saves it right away", (await page.ev("touched")) === 1, await page.ev("touched"));
	check("the topic window lists it as sealed, with its day only", JSON.stringify(await rows()) === JSON.stringify([`Sealed until ${ddmm(await page.ev("inWeek"))}`]), await rows());
	check("its contents are nowhere on screen", !(await page.ev(`document.body.textContent.includes('Good luck')`)) && (await page.ev(`document.querySelectorAll('img').length`)) === 0, null);

	// A second capsule, for today: as many as wanted.
	await page.ev(`${newButton}.click()`);
	await page.sleep(150);
	await page.ev(`(()=>{const f=${lastModal};const a=f.querySelector('.tg-capsule-input');a.value='Today one';a.dispatchEvent(new Event('input'))})()`);
	await clickIn(".tg-capsule-opens");
	await clickIn(".tg-date-day.is-today");
	await clickIn(".mod-cta");
	c = await capsules();
	check("a second capsule is added next to the first", c.length === 2 && c.some((x) => x.opens === c[0].opens) && c.some((x) => x.text === "Today one"), c);
	check("…for today, when that day is picked", c.find((x) => x.text === "Today one")?.opens === (await page.ev("today")), c);
	check("both are listed, soonest first", (await rows()).length === 2 && (await rows())[0].startsWith("Opens today"), await rows());

	// Only on its day.
	check("only the capsule of a day opens on it", (await page.ev(`store.capsulesOpeningOn(today).map(([,x])=>x.text).join()`)) === "Today one", null);
	check("nothing opens the day before or after", (await page.ev(`store.capsulesOpeningOn(addDays(inWeek, -1)).length + store.capsulesOpeningOn(addDays(inWeek, 1)).length`)) === 0, null);
	check("a past capsule is no longer listed", (await page.ev(`store.pendingCapsules(addDays(today, 1)).length`)) === 1, null);

	// Delete one (asks first).
	await page.ev(`document.querySelectorAll('.tg-capsule-row-delete')[1].click()`);
	await page.sleep(150);
	check("delete asks first", (await page.ev(`${lastModal}.querySelector('.modal-title').textContent`)) === "Delete time capsule", null);
	await clickIn(".mod-warning");
	c = await capsules();
	check("deleting leaves a tombstone without contents (so it syncs)", c.length === 2 && c.filter((x) => x.deleted).length === 1 && c.find((x) => x.deleted).text === "" && (await rows()).length === 1, c);

	// From another device: the newer edit wins, a deletion arrives.
	const merged = await page.ev(`(()=>{const id=Object.keys(store.data.capsules).find((k)=>!store.data.capsules[k].deleted);const old={...store.data.capsules[id],text:'stale',updated:1};const a=store.mergeCapsules({[id]:old,'capsule-x':{opens:inWeek,written:today,text:'from B',media:[],updated:Date.now()}});const b=store.mergeCapsules({'capsule-x':{opens:inWeek,written:today,text:'',media:[],deleted:true,updated:Date.now()+5}});return [a,b,store.data.capsules[id].text,store.data.capsules['capsule-x'].deleted]})()`);
	check("capsules from another device merge per capsule by updated", JSON.stringify(merged) === JSON.stringify([true, true, "Today one", true]), merged);

	// The first version's single capsule on a topic is moved over.
	const moved = await page.ev(`(()=>{store.data.dayTitles['2026-11-01']={text:'Older',color:null,size:'large',bold:true,italic:false,highlight:false,capsule:{text:'past',media:[]},updated:4};store.data.dayTitles['2026-11-07']={text:'Old',color:null,size:'large',bold:true,italic:false,highlight:false,capsule:{text:'old capsule',media:['Images/a.png']},updated:5};store.migrateTopicCapsules();const c=store.data.capsules['capsule-topic-2026-11-07'];return [c&&c.opens,c&&c.text,'capsule' in store.data.dayTitles['2026-11-07'],store.data.capsules['capsule-topic-2026-11-01'].opens===today]})()`);
	check("a topic's old capsule becomes a capsule for that day (a past day: today)", JSON.stringify(moved) === JSON.stringify(["2026-11-07", "old capsule", false, true]), moved);

	// The capsule window on its day: two capsules, a picture, a video and a file not synced yet.
	await page.ev(`closeAll()`);
	await page.ev(`files["Clips/v.mp4"] = "data:video/mp4;base64,"`);
	await page.ev(`openCapsules([{ opens: today, written: "2026-10-01", text: "שלום 123\\nsecond line", media: ["Images/a.png", "Clips/v.mp4", "Images/missing.png"], updated: 1 }, { opens: today, written: "2026-10-05", text: "Another", media: [], updated: 2 }])`);
	await page.sleep(200);
	const v = await page.ev(`(()=>{const m=document.querySelector('.tg-capsule-modal');return m&&{title:m.querySelector('.modal-title').textContent,sections:m.querySelectorAll('.tg-capsule-section').length,written:m.querySelector('.tg-capsule-written')?.textContent,text:m.querySelector('.tg-capsule-text')?.textContent,dir:m.querySelector('.tg-capsule-text')?.getAttribute('dir'),img:m.querySelectorAll('img.tg-capsule-item').length,video:m.querySelectorAll('video.tg-capsule-item').length,controls:m.querySelector('video')?.controls,missing:m.querySelector('.is-missing')?.textContent}})()`);
	check("the capsule window shows every capsule of the day", v?.title === "Time capsules (2)" && v.sections === 2 && v.written === "Written 01/10/2026", v);
	check("…the words", v?.text === "שלום 123\nsecond line" && v?.dir === "auto", v);
	check("…the picture and the video (with controls)", v?.img === 1 && v?.video === 1 && v?.controls === true, v);
	check("…and a placeholder for a file not here yet", v?.missing === "Not here yet: missing.png", v);
	const [ix, iy] = await page.center("img.tg-capsule-item");
	await page.mouse("mousePressed", ix, iy, 1);
	await page.mouse("mouseReleased", ix, iy, 1);
	await page.mouse("mousePressed", ix, iy, 2);
	await page.mouse("mouseReleased", ix, iy, 2);
	await page.sleep(100);
	check("double-clicking the picture opens it", (await page.ev(`window.opened`)) === "Images/a.png", await page.ev(`window.opened`));
	check("no page errors", (await page.errors()).length === 0, await page.errors());
} finally {
	page.close();
}
process.exit(failed ? 1 : 0);
