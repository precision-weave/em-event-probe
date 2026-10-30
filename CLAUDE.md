# em-event-probe: agent guide

A lab tool. It records every event an Eventmodelers board emits (realtime broadcasts and the REST event log) and drives the board through scripted scenarios, so a person can see each change next to the events it caused. It was built to design a system that reacts to board changes, such as a dispatcher that builds a slice when it becomes Planned, from observed behaviour rather than from the API documentation. Read `README.md` for the human view, the screenshots and the architecture diagram.

## Hard rules

- **The configured board gets wiped.** Reset board, and "Run the happy path" on the first-use panel, delete every timeline on the board. Only run scenarios against a board the user has said is a lab board. Ask before pointing the app at any other board.
- **Credentials stay out of the repo and out of the browser.** They live in `config.local.json` at the repo root, the board connection object from EM Studio (`token`, `boardId`, `organizationId`, `baseUrl`). It is git-ignored. `app.mjs` reads it and makes every platform call itself. Never send the token to the viewer, never log it, never commit it.
- **Configuration order:** arguments (`[board-id] [port]`), then environment variables (`EP_BOARD_ID`, `EP_PORT`, `EP_TOKEN`, `EP_ORG_ID`, `EP_BASE_URL`; `.env` is loaded by `loadConfig()` without overriding the shell), then `config.local.json`, then defaults. Keep that order if you add a setting, and add it to `.env.example` and the README table.
- No dependency on the Eventmodelers CLI or its files. The app must start from this repo alone.
- **`records/` is git-ignored and stays that way.** Recordings hold board and organisation ids and full event payloads. `.env` and `config.local.json` are ignored for the same reason.
- No build step. `app.mjs` is plain Node ESM and `index.html` is one page with inline CSS and JS. Keep it that way unless the user asks otherwise.

## Run and check

```sh
just install                 # npm install; @pw/ui is private and needs NODE_AUTH_TOKEN
just start [board-id] [port] # board, token and org from config.local.json unless overridden
```

Open http://127.0.0.1:8790/. To check the UI headlessly, use `playwright-cli`: open the page, drive it with `eval`, take screenshots, and read `console` for errors. Check both themes by setting `data-theme="light"` and `data-theme="dark"` on `<html>`. `GET /info` reports the board, the current recording file, the fixture and the running scenario. `index.html` is read on every request, so UI changes need only a reload. Changes to `app.mjs`, including its icon list, need a restart.

## Code map

`app.mjs`, top to bottom:

| Part | What it does |
|---|---|
| `record()` | Appends one JSON line to the current recording and pushes it to every open viewer. `newRecording()` starts a new file. |
| `api()`, `nodeEvents()`, `mcp()` | Platform calls. `nodeEvents()` posts to `nodes/events` the way the build kit does, with `x-agent-id`. `mcp()` sends one JSON-RPC `tools/call` to `/mcp` over plain HTTP, with no session. |
| Realtime | Subscribes with `@supabase/supabase-js` to `board:<id>`, `board:<id>-slicechanged` and `org:<org-id>`, all events (`*`), private channels, using the platform's realtime token, refreshed every 9 minutes. |
| REST poller | Polls `GET /events?since=&skipSilent=false` every second. It re-reads the last 5 s and drops duplicates by event id. |
| `act()` | Wraps every board write as an action with start and end records. In sync mode it then calls `waitForTimeline()`. |
| `settle()`, `waitForTimeline()` | Sync mode. Wait for one poll and 1.2 s of quiet, then for the requesting viewer's playback position (`POST /ack`) to pass the newest record, then 0.8 s. A viewer that has disconnected is not waited for. |
| Fixture | `buildFixture()` creates the "Probe" timeline: S1 Register user, S2 User list, an empty column and a stray event. Ids go to `records/fixture.json`. `ensureFixture()` rebuilds it if the timeline is gone. `wipeBoard()` deletes every timeline. |
| `SCENARIOS` | `{ id, title, group, about, run(fx) }`. The groups are setup, slice, element, delivery and pipeline. |
| `runScenario()` | One scenario at a time. With `reset=1` it wipes the board without waiting, clears the view, rebuilds the fixture in sync mode, then runs the scenario. |
| HTTP | `GET /`, `GET /pw/*.css`, `GET /stream?viewer=` (SSE: `hello`, the recording replayed, then `replayed`, then live records), `GET /scenarios`, `POST /scenario/:id?viewer=&sync=1&reset=1`, `POST /reset-view`, `POST /ack`, `GET /info`. |

`index.html`:

| Part | What it does |
|---|---|
| `annotate()` | Per-record facts: realtime gaps and reordering on `board:<id>` (`prev_seq`), the REST lag behind realtime, never-broadcast entries, and gaps explained by a silent write. |
| `buildRows()` | "By seq" merges a broadcast and its REST entry into one row. "By arrival" gives one row per record. It also computes the action stripes. |
| `render()` | Newest first. Keeps the reading position while new rows arrive above. Reports the playback position to `POST /ack`. |
| Playback | `play` reveals rows at the chosen speed, `live` shows all, `pause` holds. Only the viewer that started a scenario is waited for. |
| First use | Every load starts with the replayed history hidden and the first-use panel showing. Its states are `intro`, `resetting` and dismissed. |

## Adding a scenario

Add an entry to `SCENARIOS`. Make every board write through `act(label, detail, fn)` so it is logged and paced in sync mode. Use the helpers: `setStatus(sliceId, status, via)`, where `via` is `'mcp'` or an agent id; `retitle()`; `addField()`; `nodeEvents()`; and `mcp()`. Use `AGENT_A` and `AGENT_B` for builder attribution, and fixture ids from `fx`. Give it a one-sentence `about`, because it becomes the button's tooltip. The viewer picks it up from `GET /scenarios` with no UI change.

## UI conventions

- Styled with the private `@pw/ui` package: the `precision-weave-glass` theme, `components.css` and `styles/glass.css`, served from `node_modules` at `/pw/*.css`. Use its `pw-*` classes and `--pw-*` tokens. Page-specific layout uses `ep-*` classes composed from tokens only, with no colour literals and no px values off the 4px scale. `npx pw-ui-lint .` must report 0 problems.
- Icons are Lucide, from `lucide-static`, built into an inline sprite by `app.mjs`. Add a new icon's name to `ICONS` and restart.
- Content: British English, sentence case, no exclamation marks. Status is always an icon and a word. One primary button per view. Confirm before anything destructive.

## What the probes established

These came from recorded events on a real board, not from documentation. Rely on them, and re-probe if behaviour seems to have changed.

- `slice:changed` fires on any change to a SLICE_BORDER node (status, column, same-status writes). It does not fire on slice creation, or on element edits, additions, deletions or moves. Its payload has no `seq`, and `sliceTitle` is null.
- `board:<id>` carries every non-silent write with `type`, `id`, `node_id`, `node_type`, `seq`, `prev_seq`, `agent_id`, `user_id` and `transaction_id`. `seq` is global across boards, and `prev_seq` is this board's previous event.
- Moving an element between columns emits only a CHAPTER `node:changed`. Membership has to be derived from the chapter's `meta.timelineData.cells` in the REST log.
- Each REST log event carries the node's full state after the write in `meta`, not a delta.
- Silent writes (`silent: true`) are not broadcast. The only realtime trace is a `notification:transaction-committed` with no `seq`. The next event's `prev_seq` points at the silent one. Deleting a timeline deletes its nodes and edges silently.
- Events from one request can arrive out of order on realtime. `transaction_id` is one per request.
- `comment:added` is broadcast twice, the second time without `seq`.
- No same-status guard: status writes into the current status are accepted from any agent, over REST and over MCP.
- `agent_id` is set only when the writer sends `x-agent-id`. MCP calls without it are unattributed.
- A slice's `slicedata` changes with its status, comments, linked-copy dependencies and edits to connected elements in other slices. Linked copies are snapshots: editing the original does not change the copy's slice.
