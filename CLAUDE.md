# Task Gift — notes for Claude

Obsidian plugin (TypeScript, esbuild) that syncs Google Tasks and shows a board, a calendar and a "gift" mode.
The repo _is_ the installed plugin folder inside the user's vault (`.obsidian/plugins/Task Gift`).

## Working here

- Build / check: `npm run build` (tsc + esbuild). It writes `main.js` in place, i.e. straight into the live plugin.
  No unit tests; for UI there is a browser test (`npm run ui-test`, see below). Obsidian itself can't be driven
  from here: its inspector is disabled, and injecting test code into the running plugin is blocked.
- The plugin reloads itself when `main.js` / `styles.css` / `manifest.json` change on disk (`checkForUpdate` in
  `main.ts`), so a build — or a new version arriving through sync — takes effect without toggling the plugin.
- The user writes in Hebrew; answer in Hebrew. All UI text in the plugin stays English. Original spec: `prompt.md`.
- To debug sync, read the vault notes directly (path in `data.json` → `dataFilePath`; currently
  `ארכיון/Tasksgift/`). Notes written by this device have ns-precision mtimes; files written by LiveSync have
  ms-rounded mtimes — useful to tell who wrote what. Use `PYTHONIOENCODING=utf-8` when printing Hebrew from Python,
  and put longer Python scripts in a file rather than an inline heredoc (backticks/quotes break the Bash tool).

## UI changes (learned the hard way)

A clean build only proves the code compiles. The day-topic letter coloring failed in Obsidian four times in a row
while it compiled — and each time the fix targeted a guessed cause (selection lost on click, events swallowed,
contenteditable) instead of the real one: a method named `selection()` in the modal was overwritten by Obsidian's
`Modal` instance field `this.selection`, so every call threw `this.selection is not a function`.

- **Find the error before redesigning.** "Does nothing", "colors everything", "preview doesn't update" or a modal
  that renders only half are typical of a thrown exception. Ask the user for the red error in Obsidian's console
  (Ctrl+Shift+I → Console) — one screenshot would have saved three rounds. Don't rewrite working parts on a guess.
- **Don't name members of `Modal` subclasses like Obsidian's own instance fields** (missing from `obsidian.d.ts`, so
  tsc doesn't warn): `selection`, `win`, `scope`, `isOpen`, `headerEl`, `bgEl`, `titleEl`, `dimBackground`,
  `bgOpacity`, `shouldRestoreSelection`, `shouldAnimateOpen`, `hasInitialInputFocus`, `onWindowClose`. Other Obsidian
  classes (ItemView, Setting, Menu…) have undeclared fields too — pick specific names (`selectedRange`, not `selection`).
- **Browser test:** `npm run ui-test` runs `dev/ui-test/day-title.test.mjs` — the modal module bundled with an
  `obsidian` shim (`dev/ui-test/obsidian-shim.js`) and the plugin's `styles.css`, opened in headless Chrome, driven
  with real mouse/keyboard input over the DevTools protocol (`dev/ui-test/harness.mjs`). For a new UI piece add a
  `*.page.js` (opens it) and a `*.test.mjs` (drives and checks it). It catches thrown errors and DOM/selection
  behavior, not Obsidian's own scripts or theme; keep the shim's Modal fields in step with the real ones (the list
  above), otherwise clashes stay hidden. Obsidian's code can be read from `%APPDATA%/obsidian/obsidian-*.asar`
  (plain asar archive; `app.js`, `app.css`) to check what a class really does.
- Obsidian's / themes' `button` styles beat the plugin's CSS: use a `div role="button"` when an element needs its
  own colors or background.
- To confirm the user ran the new build: the data note shows what was saved and when (`updated`), compare with the
  `main.js` mtime.
- Say plainly in the answer what was tested where (browser test vs. not tried in Obsidian) and what to check.

## Storage and cross-device sync (learned the hard way)

The user syncs the vault with **Self-hosted LiveSync** on two computers. What works:

1. **Data lives in vault notes, not `data.json`.** `data.json` only points to the data note.
   - `Task Gift Settings.md`: settings only (incl. modes). Changes only when a setting changes.
   - `Task Gift Data.md`: tasks, sync state, sign-in. Rewritten on every sync. Still carries a copy of the
     settings for older plugin versions, but that copy is **ignored** when the data note arrives from another device.
     Keeping fast-changing state and settings in one big note made both devices overwrite each other constantly.
   - `Task Gift Topics.md`: the day topics (`dayTitles`) only, written only when a topic changes. In the data note
     they were lost: the other device rewrote it on its next sync before the topic arrived. Merged per date by
     `updated` (`store.mergeDayTitles`); a device holding a topic the note lacks writes it back, so both settle.
     The data note keeps a copy for older versions and is merged the same way.
   - The Google sync interval is in seconds (`syncIntervalSeconds`, min `MIN_SYNC_SECONDS`; `syncIntervalMinutes`
     is kept for older versions). A sync that only moved `lastSyncAt` doesn't rewrite the data note (at most every
     `SYNC_STAMP_WRITE_MS`), so frequent syncs don't keep LiveSync busy.
2. **Don't rely on the vault `modify` event.** LiveSync sometimes writes straight to disk. `checkFiles()` polls
   mtime+size every 2 s and on window focus; `DataFile.readChanged()` only reads when the stamp changed and never
   hands out the same contents twice.
3. **Never write a note back just because it was loaded.** On startup the loaded settings are `adopt()`ed, so a
   device that hasn't received the newest note yet can't overwrite it with its stale copy. Own writes are
   recognized via `ownWrites` (several, not just the last — `modify` events can arrive late).
4. **Settings from another device replace the `plugin.settings` object** (`applyExternal` → `mergeSettings`).
   Never keep a settings or mode object in a long-lived closure; look modes up by id at the time of the change
   (`ModesEditor.live`).
5. **Edit cross-device state in the plugin's own view, not in the Obsidian settings tab.** The settings tab does
   not redraw when settings change from outside, so synced changes looked "lost" even though they had arrived.
   The view redraws through `plugin.refreshViews()` on every change. The Modes page (`views/modes.ts`) redraws
   when the settings object identity changes (another device) and not on its own edits (keeps typing focus);
   edits that show/hide rows redraw explicitly.

When adding a setting, ask: is it changed often or automatically? If yes, it belongs in the data note's store,
not in the settings note (otherwise two devices write the settings note at once and one change is lost).

## Other conventions

- Google Tasks API has no recurrence and no due times: repeat rules, times, colors and per-task modes are stored
  locally in the store, keyed by task ID. Keep `remap` / `forget` / `maybeSpawnNext` in `sync/store.ts` in step
  when adding another per-task map.
- Repeating tasks could still be created twice: both devices completed/pulled within the same second and each
  created the next occurrence before seeing the other's (two copies ~200 ms apart in Google). Push now inserts new
  tasks before sending completions, and after every pull `store.removeDuplicates` deletes open tasks with exactly
  the same title on the same day, today up to `DUPLICATE_CHECK_MONTHS` ahead (also the "Remove duplicate tasks"
  command). It keeps the smallest Google ID so every device deletes the same copy, and skips groups with an
  unpushed (`local-`) copy until it has an ID.
- Monthly repeats can be "the Nth weekday (on or) after day X" (`monthlyMode: "after"`, `afterDay`, `afterInclusive`;
  the date may spill into the next month). Older plugin versions read such a rule as "monthly on `monthDay`".
- The header search also lists the next `UPCOMING_REPEATS` (3) occurrences of each open repeating task, computed
  like the calendar's ghosts (`renderCard` with `upcoming`: no checkbox/menu, clicking edits the real task).
- Modes only affect gifts; the board always shows every task. Each mode owns its own sounds, victory and music.
- User-entered text (titles, notes, list and mode names) gets `dir="auto"` so Hebrew mixed with numbers keeps
  its order.
- Extra calendars (e.g. shifts) never touch Google: one note each in `Calendars/` next to the data note, written in
  the same text format the import parses (`src/calendars/format.ts`), so they sync per file and can be edited by hand.
- Within a day, extra-calendar entries keep the order of their note (`sortByDay` sorts by date only); dragging an
  entry or "Move up/down" in its context menu rewrites that order. New entries are placed by time (`insertEntry`).
- The day's topic in the view header is per date in the data note's store (`dayTitles`), merged across devices by
  `updated` (newest wins); a cleared one is kept with empty text so the clearing syncs. Its `until` sets how long
  it lasts (missing = that day only, null = never ends; `untilTime` HH:MM ends it at that time of the `until` day); the header shows the newest one still lasting
  (`store.activeDayTitle`), and a lasting topic is edited under the date it was written for. `endNote` shows the
  end date next to it (below/above/left/right) with the user's words and its own style; Hebrew words → RTL; the date is
  DD/MM/YYYY. Both texts use `LetterColorField` in `DayTitleModal.ts` for per-letter colors.
- Description templates of calendar entries are notes too, in `Templates/` next to the data note
  (`src/calendars/templates.ts`), read only when the Templates menu opens. Lines ending with ":" and `___` are
  fields; a template with fields opens a fill-in form before it's inserted.
- Modes are switched and edited only from gift mode (the Modes tab and the mode chip show only there).
- Sticky notes fill the board's empty side after the columns (`views/stickies.ts`). They live in the store
  (`stickies`, merged per note by `updated`, deleted = tombstone; color `"default"` = Obsidian's neutral background, the default for new notes) and are saved in the topics note next to the
  day topics. Typing saves without redrawing (`plugin.saveLater`); `TaskView.renderBoardBody` keeps the caret when a
  sync redraws. A note is Markdown: rendered (`MarkdownRenderer`) until clicked, then a textarea. Its top bar
  shows `settings.stickyCommands` as buttons next to the color (palette) button (defaults Highlight, Underline, Bold; edited in the settings tab as a
  `type: "list"` group, missing = defaults, empty = all deleted). A command is text markers (wrap/unwrap the
  selection in `before`/`after`) or any Obsidian command (`commandId`, picked from `app.commands.commands`).
  Obsidian's editor commands can't reach the sticky textarea, so `src/stickyCommands.ts` redoes the formatting ones
  on the Markdown (`stickyEditFor`); other commands run via `executeCommandById`.
  Test: `dev/ui-test/stickies.test.mjs`.
- Board columns are folded with their eye button (`settings.collapsedColumns`); there is no "show completed" switch.
- Paused tasks ("Pause" in a card's menu, or dropped on the column) are **deleted from Google** (so they leave the
  phone's Google Tasks widget) and kept in `store.paused` (`{on, updated, task}`: title, notes, list, date, repeat,
  time, color, modes, subtasks), merged per task by `updated` (resumed/deleted = `on: false` without `task`, so it
  syncs). The board's "Paused" column (`store.pausedTasks()`, cards whose ID is the paused key) is first on the board
  (stickies take the other end) and shown only while it has tasks. Dragging one to another column or "Resume" creates
  it again as a new task (`store.resume`); a repeating one that fell behind starts at its next date from today.
  `forget` must not drop `paused` (the sync forgets the deleted task). `migratePauses` converts the first version's
  hide-only pauses.
