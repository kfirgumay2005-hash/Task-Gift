# Task Gift 🎁

An Obsidian plugin that syncs your **Google Tasks** both ways and shows them either as a **Kanban board** or, when the full list feels like too much, as a **gift**: open a box, get one randomly drawn task, finish it, rest, and open the next gift only when you're ready.

## Features

- **Works on desktop and mobile** (iOS / Android), including Google sign-in.
- **Two-way Google Tasks sync**: all lists, titles, notes, due dates, completion, subtasks. Create, edit, complete, uncomplete and delete from Obsidian or Google.
- **Markdown mirror**: a note (default `Tasks/Google Tasks.md`) with one section per list. Edit it like any checklist and the changes go back to Google.
- **Board view**: cards in columns grouped by list, by due date (Overdue / Today / Tomorrow / Later / No date) or by status. Drag cards between columns, or use the ⋯ menu (long-press on mobile), to move them between lists, change the date or complete them.
- **Gift mode**: a wrapped box that reveals 1–5 random tasks, with "Done" and "Draw again" buttons. The current draw survives restarts.
- **Task modal**: title, notes, list, date, time, and Google-Calendar-style recurrence.
- **Date filters**: Yesterday, Today, Tomorrow, This week, Next 7 days, Overdue, No due date, or a custom range. You can combine them, use a separate filter for gift mode, and choose which lists are included.

## Installation (from source)

```bash
cd <vault>/.obsidian/plugins/Task Gift
npm install
npm run build        # produces main.js
```

Then enable **Task Gift** in *Settings → Community plugins*. Obsidian needs `main.js`, `manifest.json` and `styles.css`. Use `npm run dev` for a watch build.

## Google Cloud setup (one time, about 5 minutes)

Task Gift talks to Google with **your own** OAuth client, so no third party ever sees your tasks.

1. **Create a project.** Go to <https://console.cloud.google.com/>, then *Select a project → New project*, name it e.g. "Task Gift" and create it.
2. **Enable the Tasks API.** Go to *APIs & Services → Library*, search for **Google Tasks API** and click **Enable**.
3. **Configure the OAuth consent screen.** In *APIs & Services → OAuth consent screen* (called "Google Auth Platform → Branding / Audience" in the new console):
   - User type: **External**. App name: "Task Gift". Add your email as the support and developer contact.
   - Scopes: you can skip this; the plugin requests `tasks`, `openid` and `email` at sign-in.
   - **Test users**: add the Google account whose tasks you want to sync. While the app is in *Testing*, only test users can sign in.
4. **Create the OAuth client.** In *APIs & Services → Credentials → Create credentials → OAuth client ID*:
   - Application type: **Desktop app**. Name: "Task Gift desktop".
   - Copy the **Client ID** and **Client secret**.
5. **Connect in Obsidian.** In *Settings → Task Gift*, paste the Client ID and Client secret and click **Connect**. Your browser opens Google's consent page. Google will warn that the app isn't verified; that's expected for your own app, so click *Continue*. After approving, the browser shows "Task Gift is connected" and the first sync starts.

> **Refresh tokens in Testing mode expire after 7 days.** If you get asked to reconnect every week, go to the consent screen and click **Publish app** (moving it to "In production"). For personal use you don't need to go through verification. You'll keep seeing the "unverified app" warning on sign-in, but tokens stop expiring.

### How sign-in works

There are two sign-in methods. Both use OAuth 2.0 with PKCE and the same **Desktop app** client.

- **Automatic (desktop):** the plugin starts a temporary local server on `127.0.0.1`, opens Google's consent page, catches the redirect and exchanges the code. You don't need to do anything else.
- **Manual (phone, tablet, or desktop fallback):** tap **Connect** (or **Manual sign-in** on desktop) and then **Open Google sign-in**. After approving, the browser lands on `http://127.0.0.1:53682/?state=…&code=…` and shows *"This site can't be reached"*. That's expected. Copy the **full address** from the address bar, paste it into the dialog in Obsidian and tap **Connect**.

Because the sign-in is saved in the data note (see below), you only need to connect **once**: the other devices pick it up when the vault syncs. Access tokens are refreshed automatically. **Disconnect** revokes the token at Google.

> **Why not a plain API key?** Google only accepts API keys for *public* data. Your task lists are private, so the Google Tasks API requires OAuth sign-in by the account owner. That's a Google rule, and there's no way around it. You sign in once and the refresh token keeps you connected.

### Where data is stored: the data note

Settings, the Google sign-in, sync state, repeat rules and times are stored in a **markdown note in your vault**, by default `Task Gift Data.md` at the vault root. You can move it in *Settings → Task Gift → Sync → Data file location* and click **Apply**.

- It syncs with the vault (Obsidian Sync, iCloud, Git, …), so phone and desktop share one setup: connect once, and repeat rules made on one device work on the others.
- When the note changes on another device, Task Gift merges it: settings, sign-in and gift state are taken over, and repeat rules and times are combined.
- If you move the note on one device, the others find it automatically by its `task-gift-data` frontmatter.
- The plugin's own `data.json` only remembers the note's path. Existing `data.json` data is migrated into the note automatically.
- ⚠️ The note contains your **client secret and access tokens**. Don't publish or share it, and exclude it from Obsidian Publish or public Git repos.

## Using it

- **Open the view** with the gift icon in the ribbon, or the command *Task Gift: Open Task Gift*.
- **New task**: the list-plus ribbon icon, the `+` in the view header or in a column, or the command *Task Gift: New task*.
- **Edit**: click a card. The modal also has **Delete**.
- **Sync**: automatic on startup, every N minutes (default 5) and about 1.5 seconds after local edits. You can also use the sync button, the command *Sync now*, or *Full resync* to re-download everything.
- **Gift mode**: switch with the Board / Gift toggle in the header, the setting "Hide task board, show gifts instead", or the command *Toggle gift mode*.
  - **Open gift** shakes the box, pops the lid and reveals the drawn task(s).
  - **Done** completes the task in Google. Once every drawn task is done, a fresh wrapped gift appears, and it waits for you to open it.
  - **Draw again** puts the task back and draws a different one. The rejected task is avoided for the next few draws if there are alternatives.
  - The current draw is saved, so closing Obsidian or the view never rerolls it.
  - With *Reduce motion* enabled in your OS, the animations become a simple fade. You can also turn animations off completely in settings.

### The sync note

```markdown
## Work <!-- gtl:MDk2... -->

- [ ] Write report 📅 2025-10-20 ⏰ 09:30 🔄 weekly on Mon <!-- gt:abc123 -->
	> notes go on indented "> " lines
	- [ ] A subtask <!-- gt:def456 -->
- [ ] A brand new task 📅 2025-10-21
```

- **Add a task** by writing a new `- [ ]` line under a list heading; it gets its hidden ID after the next sync. You can add `📅 YYYY-MM-DD` and `⏰ HH:MM`.
- **Edit** the text, date, time or checkbox. **Move** a line under another heading to move the task to another list. **Indent** it under another task to make it a subtask.
- **Delete** a line to delete the task in Google. If more than half of the tasks (and at least 5) disappear at once, Task Gift asks before deleting anything.
- Keep the `<!-- gt:… -->` markers (hidden in Reading view and Live Preview). The `🔄` text is display-only; edit recurrence in the modal.
- Edits are applied as a 3-way diff against the last rendered version, so the note never overwrites changes made in Google or on the board meanwhile.
- Changing the list headings themselves (renaming or creating lists) is not synced; manage lists in Google Tasks.

## Recurrence and due times (important)

The Google Tasks API **cannot create recurring tasks** and **stores dates only, no times**. Task Gift works around this:

- The repeat rule and the time are stored in the Task Gift data note, keyed by task ID, and shown on cards and in the note.
- When a repeating task is completed, from anywhere (board, gift, note, or the Google Tasks app, picked up on the next sync), Task Gift creates the **next occurrence** in Google with the next due date and moves the rule to it. Ends "after N occurrences" and "on date" are honoured.
- Google's apps only see ordinary one-off tasks with a date. If Obsidian isn't running, the next occurrence is created on the next sync.
- Repeat rules created in the Google Tasks app itself can't be read through the API. Those tasks show up as ordinary tasks.

## Sync details

- **Model**: a local store (in the data note) mirrors Google. Local changes mark tasks *dirty*, which works as the offline queue. Each sync first **pulls** (incrementally via `updatedMin`, plus a full pull every 6 hours) and then **pushes**.
- **Conflicts**: if a task changed both locally and in Google since the last sync, the newer change wins (Google's `updated` vs. your local edit time). Every conflict is logged to the developer console (`Ctrl+Shift+I`). A task deleted in Google but edited locally is **re-created**, not dropped.
- **Offline**: changes stay queued and the plugin retries every minute until it reaches Google.
- **Rate limits**: requests are throttled and retried with exponential backoff on 429/5xx. Pagination uses `pageToken`.
- **Completed tasks** older than *Keep completed tasks for (days)* (default 30) are dropped locally but stay in Google.
- Moving a task between lists uses the API's `move` with `destinationTasklist`. If Google refuses, the task is copied to the new list and deleted from the old one.

## Desktop vs. mobile

| | Desktop | Mobile (iOS / Android) |
|---|---|---|
| Connect Google account | ✅ automatic or manual | ✅ manual sign-in (paste the address) |
| Sync, board, gift mode, task modal, recurrence | ✅ | ✅ |
| Sync note editing | ✅ | ✅ |
| Moving cards | drag & drop, or the ⋯ menu / right-click | ⋯ button or long-press on a card: complete, reschedule (today / tomorrow / next week / no date), move to another list, delete |

All network calls use Obsidian's `requestUrl`, so they work on mobile too. Install the plugin on the phone by copying `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/Task Gift/` (Obsidian Sync with "Installed community plugins" enabled does this automatically).

Since the data note syncs with the vault, connecting on one device is enough. Every device then talks to Google directly.

## Troubleshooting

- **"Access blocked: app has not completed verification" / `Error 403: access_denied`**: the Google account you're signing in with is not a **Test user**. Add that exact email under *OAuth consent screen → Audience → Test users*, or click **Publish app**.
- **Automatic sign-in never returns to Obsidian** (firewall, antivirus): use **Manual sign-in**.
- **"redirect_uri_mismatch"**: the OAuth client must be of type **Desktop app**, not "Web application".
- **"Google did not return a refresh token"**: remove the app at <https://myaccount.google.com/permissions> and connect again.
- **Asked to reconnect every 7 days**: publish the app (see above).
- **Something looks off**: run the command *Full resync with Google*, and check the developer console for `[Task Gift]` logs.

## Project structure

```
src/
  main.ts             plugin lifecycle, commands, ribbon, scheduling
  settings.ts         settings tab
  types.ts, defaults.ts
  auth/oauth.ts       loopback + PKCE login, token refresh, revoke
  api/client.ts       typed Google Tasks API client (pagination, throttling, retries)
  sync/store.ts       local task store and all local mutations (+ recurrence spawning)
  sync/engine.ts      pull / push / conflict handling
  sync/note.ts        markdown mirror: render + parse + 3-way diff
  recurrence/rule.ts  recurrence model and next-date calculation
  filters/dates.ts    date range filters
  views/              TaskView (header), board, gift mode, card
  modals/             task modal, confirm modal
```
