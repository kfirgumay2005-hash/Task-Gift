Build an Obsidian plugin called "Task Gift" (TypeScript, Obsidian plugin API, esbuild). All UI text in English.

## Why it exists

I use Google Tasks. Seeing my whole list at once is exhausting: even when I'm motivated, I'm physically tired and the list never feels like it shrinks. The core idea is a "gift" mode: instead of seeing everything, I open a gift box that reveals ONE randomly drawn task. I finish it, take a break, and open the next gift only when I feel ready.

Before writing code, read the Obsidian plugin docs and the Google Tasks API v1 docs, then give me a short implementation plan (architecture, file structure, sync model, phases). Build in phases and make sure each phase builds and loads in Obsidian before moving on.

## 1. Google Tasks connection + full two-way sync

- OAuth 2.0 with Google. I'll create my own Google Cloud project and paste Client ID / Client Secret into settings. Use the desktop loopback redirect flow (local http server on 127.0.0.1) with PKCE, store refresh tokens in plugin data, refresh automatically. Add a "Connect / Disconnect Google account" button in settings and a clear connection status.
- Sync ALL task lists and tasks (title, notes, due date, status, completed date, parent/subtasks, list).
- Mirror tasks into a markdown note in my vault (configurable path, e.g. "Tasks/Google Tasks.md"), one section per task list, each task as a "- [ ]" / "- [x]" line with a hidden ID (e.g. an HTML comment or block ID) so edits map back to Google.
- Two-way sync: changes in Google → note and plugin view; changes in the note or plugin view (create, edit, complete, uncomplete, delete) → Google.
- Sync on startup, on a configurable interval (default 5 min), on a manual "Sync now" command/button, and debounced after local edits.
- Conflict handling: compare Google's `updated` timestamp with a locally stored last-synced state; last write wins, but log conflicts to the console and never silently drop a task. Handle offline mode by queueing changes and retrying.
- Respect API rate limits, handle pagination (pageToken), and show a Notice on errors.

## 2. Create / edit tasks from a built-in Obsidian menu

A modal (opened from a command, a ribbon icon, and a "+" button in the view) with:

- Title, notes, task list (dropdown), due date (date picker), optional time.
- Recurrence, Google Calendar style: does not repeat / daily / weekly / monthly / yearly / custom. Custom = every N days/weeks/months/years; for weekly, pick specific weekdays (Sun–Sat toggles); for monthly, "on day X" or "on the Nth <weekday>" (e.g. 2nd Tuesday, last Friday); ends: never / after N occurrences / on a date.
- IMPORTANT: the Google Tasks API does NOT support creating recurring tasks and ignores due times (date only). So implement recurrence inside the plugin: store the recurrence rule locally (RRULE-like, keyed by task ID), and when a recurring task is completed (from anywhere, including Google), create the next occurrence in Google Tasks with the next due date. Store the time locally and display it. Make this limitation visible in the modal with a small hint.
- The same modal edits existing tasks.

## 3. Board view (default)

- A custom ItemView showing tasks as cards in Kanban-style columns, not as text.
- Column grouping setting: by task list, by due date (Overdue / Today / Tomorrow / Later / No date), or by status (To do / Done).
- Each card: checkbox to mark complete/incomplete (syncs to Google), title, due date/time, recurrence icon, list name, notes preview. Click to open the edit modal. Drag between columns where it makes sense (e.g. move between lists, change date group).
- Option to show or hide completed tasks.
- Clean, modern look that follows the current Obsidian theme (use CSS variables), light and dark mode.

## 4. Gift mode

- A toggle in the view header and a setting: "Hide task board, show gifts instead". When on, the board is hidden completely.
- The view shows a wrapped gift box. Clicking "Open gift" plays an animation (box shakes, lid pops off, ribbon unties, light burst / small confetti) and reveals the drawn task(s) as card(s).
- Setting: "Tasks per gift" (default 1) — how many tasks are drawn at once.
- Buttons on each revealed task:
  - "Done" — marks the task complete (syncs to Google, handles recurrence). Only after all drawn tasks are done does a NEW wrapped gift appear, which I must open myself when I'm ready (no auto-reveal).
  - "Draw again" — the task isn't doable right now; put it back and draw a different one (with a smaller animation). Avoid redrawing the same task twice in a row if other options exist.
- The currently drawn task(s) persist across Obsidian restarts and view reloads — closing and reopening must NOT reroll.
- Empty state when no tasks match the filter (a friendly "All done for now" message).
- A small optional counter "Gifts opened today: N".
- Respect "prefers-reduced-motion" with a simpler fade animation, plus a setting to turn animations off.

## 5. Date range filter (applies to both board and gift mode)

- Setting with presets: Yesterday, Today, Tomorrow, This week, Next 7 days, Yesterday + Today, Today + Tomorrow, Overdue, No due date.
- Allow combining ranges via multi-select (e.g. Overdue + Today + Tomorrow), plus a "Custom" option: from N days ago to N days ahead.
- Separate toggles for "Include overdue" and "Include tasks without a due date".
- Option to use different filters for gift mode and board view.
- Setting for week start day (Sunday / Monday).
- Also a setting to choose which task lists are included.

## 6. Settings tab

Google credentials and connection, sync note path, sync interval, default view mode (board / gift), tasks per gift, date filter(s), included lists, column grouping, show completed, animations on/off, week start.

## Quality

- Strict TypeScript, no `any` where avoidable, split into modules (auth, api client, sync engine, recurrence, views, modals, settings).
- Never store secrets anywhere except the plugin's data.json.
- Add a README with setup steps for the Google Cloud project (enable Tasks API, OAuth consent screen, desktop client, test user).
- Desktop first; note in the README what does or doesn't work on mobile.
