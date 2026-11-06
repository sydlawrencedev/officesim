# OfficeSim for Mac

A standalone macOS app (Tauri) showing the AI agents running on this Mac in the OfficeSim pixel
office, read from their harnesses' local files. The Paperclip plugin at the repo root is unchanged
and keeps shipping; this app reuses its office UI and engine (`../src/ui`, `../src/office`) as is.

## How it fits together

- `vite.config.ts` aliases `@paperclipai/plugin-sdk/ui` to `src/host/sdkShim.ts`, which has the
  same hooks (`usePluginData`, `usePluginAction`, `useHostContext`...) backed by Tauri instead of a
  plugin worker. `../public/assets` is served as the app's public folder and the asset index is
  built with `../scripts/assetIndex.mjs`, shared with the plugin build.
- `src/host/bridge.ts` routes each data key: office settings stay in the webview
  (`localHandlers.ts`), everything else goes to Rust (`get_data` / `run_action`). In a plain browser
  `devMock.ts` stands in for the backend.
- `src-tauri/src/sources/` holds one adapter per agent source behind the `Source` trait.
  `watcher.rs` emits `agents-changed` when a source's files change, and the office re-reads its
  agents. `src/host/fetchBridge.ts` answers the Paperclip REST routes the UI calls directly: run
  logs (the live speech bubbles) and the attention feed (decision bubbles).

## Sources

| Source | Reads | Agents |
|---|---|---|
| Claude Code | `~/.claude/sessions/*.json`, `~/.claude/projects/*/*.jsonl` (or `$CLAUDE_CONFIG_DIR`) | Each running session, working while `busy`; sessions closed in the last hour stay on, idle |
| OpenCode | `~/.local/share/opencode/opencode.db` (read only) | Top-level sessions updated in the last hour; working while a reply hasn't completed || Gemini CLI | `~/.gemini/tmp/*/chats/session-*.json` | Sessions written in the last hour; working while just written or waiting on a reply |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (or `$CODEX_HOME`) | Sessions written in the last hour; working while a turn has started and not completed |
| Cursor CLI | `~/.cursor/chats/<md5 of folder>/<chat>/store.db` | Chats written in the last hour; working while just written and cursor-agent runs |
| Goose | `~/.local/share/goose/sessions/sessions.db` (read only) | The person's sessions updated in the last hour; working while a reply or tool call is due |
| Aider | `.aider.chat.history.md` in each running Aider's folder | Each running Aider; working while just written |
| Hermes | `~/.hermes/state.db` (read only) | Sessions not ended and active in the last hour; working while a reply is due |
| Agent Orchestrator | `~/.ao/data/ao.db` (or `$AO_DATA_DIR`, read only) | Live and recent sessions; working while `active`. Its workers claim their harness sessions, and borrow their logs and usage |
| Paperclip | Its Postgres (connection string from `~/.paperclip/instances/*/config.json`), run logs in the instance's `data/run-logs` | Every agent of every active company, with the plugin's own run and stats queries |
| Demo | nothing | Three made-up agents, when `OFFICESIM_DEMO=1` |

Agents are named after their project ("Agent Pixels"; Paperclip agents by their own name),
numbered oldest first when a project has several sessions. An OpenCode session also carries its
own name, so two sessions in one project can be told apart ("Agents Hidden Eagle", "Agents Crisp
Wizard") rather than being just "Agents 2" and "Agents 3".

An agent that started less than a minute ago isn't shown yet: it has barely begun, so seeing it in
the office is just noise. An agent working in a scratch directory isn't in a project, so it isn't
in the office either — a dozen of them fill it with noise.

The harness shows as its favicon before
the name (`src/host/icons`, from claude.ai, opencode.ai, gemini.google.com and Paperclip's local
server), on the canvas, in the tooltip and in the Agents tab. The thread or issue shows in the tooltip.

Agents waiting on the person get the office's decision bubble:

| Source | Waiting when |
|---|---|
| Claude Code | Its session status is `waiting` (a permission prompt or other dialog, with `waitingFor` saying what for), or its latest reply asks a question (AskUserQuestion, or ExitPlanMode for a plan) that hasn't been answered |
| OpenCode | Its `question` tool is waiting on an answer. Permission prompts aren't saved anywhere OfficeSim can read |
| Gemini CLI | Not detectable: tool calls are only written once they're done |
| Codex | An unanswered `request_user_input` call. Approval prompts aren't saved to the rollout |
| Goose | Its latest message asks to confirm a tool call (`toolConfirmationRequest`) or for an action |
| Agent Orchestrator | Its session's `activity_state` is `waiting_input` |
| Cursor CLI, Aider, Hermes | Not detectable from their files |
| Paperclip | It has an item on Paperclip's Decisions page (its local server's attention feed) |

Codex, Cursor, Goose, Aider, Hermes and Agent Orchestrator had no sessions on the Mac they were
built on: their adapters follow those projects' source code and are tested with fixtures, not yet
with real sessions.

OpenCode has two database schemas. The current one keeps sessions in `session_v2` and their
messages in `session_message`; the older one keeps them in `session`, `message` and `part`. The
adapter reads the current one when the database has it, and the older one otherwise.

## Clicking an agent

Opens where it runs: a Paperclip agent's page in Paperclip; otherwise its process (the session's
own for Claude Code, else the harness's process working in the agent's folder) is followed up to
the app it runs in. In Terminal or iTerm2 its exact tab comes forward (macOS asks once to let
OfficeSim control them); in any other app (Claude, Ghostty, VS Code...) the app comes forward.
Issue links open in Paperclip.

## The DJ booth

The games room's DJ booth plays along to your music: the records spin, the mixer's meters bounce,
the speaker cones pump with the bass, and the room lights up with lasers and a disco ball.

A web page can't hear what else the computer is playing, so the Mac app does it natively. The
`officesim-audio` helper (src-tauri/sources/audio-capture.swift) taps the system's audio output
with Core Audio and works out the beat and the levels; the app passes them to the office. The
sound is analysed for the beat and the levels only: it is never recorded, saved or sent anywhere.

The tap needs the **System Audio Recording** permission, which macOS asks for the first time you
use the booth. If you decline it, turn OfficeSim on in System Settings → Privacy & Security →
Screen & System Audio Recording, then try again.

Turn it on and off by clicking the DJ booth, pressing **M**, or from the menu bar (OfficeSim's
icon → "Play along to the music").

## The Issues tab

Every open issue in the repos the agents work in, as a kanban board: the same five columns as the
boardroom's board (backlog, to do, in progress, in review, blocked), with more about each issue —
its labels, who it's assigned to, how many comments it has and when it was last touched.

The board can be grouped by column or by repo, and filtered by any of them. It fills the height
of the window. Each column is tinted with its stage's colour and its header floats as the board
scrolls, so the stage is always named. Each repo keeps its own colour wherever it appears. A
column with nothing in it collapses to just its header, so the columns with work in them get the
room.

An issue's column doesn't come from its labels alone. The office knows what the agents are working
on, so:

- **In progress** — an agent's session is on the issue, or a branch names it ("fix/520-something")
- **In review** — the issue's work is on a pull request, but the issue is still open
- **Backlog, to do, blocked** — from the issue's labels

The boardroom's own kanban on the wall uses the same rule, so an issue an agent is on isn't in
"to do" there either.

The board and the wall board read the same repos, so they show the same issues. The repos are
every one the office knows about: the ones the agents work in now, the ones they worked in
before, and the ones remembered from earlier. A repo nobody is in right now still has open
issues, and they still show here.

On the Mac the issues come from GitHub, read with `gh`. Clicking one opens it on GitHub. The
Paperclip plugin's own board shows that company's issues instead.

**+ New issue** opens a form that adds an issue to any of the repos, on GitHub. The list is every
repo the office knows about, not just the ones with something open: a repo the agents worked in
last week is still one you can add an issue to. A repo reached only through a scratch directory
isn't a project, so it isn't in the list.

**Refresh** reads GitHub again straight away, rather than waiting for the two-minute sync.

## The Activity tab

Two lists, each newest first, each entry saying which repo it came from. A coloured rule under
the buttons says which list is showing: green for issues, blue for git. Both lists fill the
height of the window, like the Agents one does.

- **Issues** — the issues closed recently across the tracked repos. How it went (how many comments,
  when it closed) sits under the labels, and each repo keeps its own colour. An issue with nobody
  on it says nothing, rather than saying "Unassigned".
- **Git** — every repo's commits in one list, with the repo and branch on each

## The Mac app

- A menu bar icon shows how many agents are working (and waiting on you), lists those waiting
  (click one to open it), and opens the office or the mini camera.
- A notification when an agent starts waiting on you (Settings → This Mac, or the menu bar menu).
- The mini camera: a small always-on-top window with just the camera.
- Launch at login, into the menu bar. Closing the office window leaves OfficeSim in the menu bar.
- The toolbar's Done count is the same closed issues the Activity tab shows. Beside it, the chart
  shows the issues done in each window as green bars, with the commits made in the same windows as
  a red line over them.
- GitHub is read in the background while the office opens, and each repo is asked for side by
  side, so the Issues and Activity tabs have their numbers straight away.

## Task sources

Where the boardroom kanban, the done timeline (and its cheers) and the Activity tab's done tasks come
from, separate from the agent harnesses and turned on and off under "Task sources" in Settings.
Paperclip's issues are the first, across every active company, with the plugin's own queries.

Paperclip runs its agents in other harnesses. The sessions its runs used (and sessions started
just after a run that hasn't reported one yet) show once, as the Paperclip agent.

Each source can be turned off in the Settings tab ("Agent sources"); a source that's off isn't
read. That's saved in `~/Library/Application Support/com.officesim.mac/settings.json`.

The Agents tab: tokens per reply, runs as prompts (Paperclip: heartbeat runs), time active as
prompt to end of reply.

To see what a source reads on this Mac:

```bash
cargo test --manifest-path src-tauri/Cargo.toml prints_this_macs_office -- --ignored --nocapture
```

## Develop

Needs Node, pnpm and Rust (`rustup`).

```bash
pnpm install
pnpm tauri dev      # the app, with the Rust backend
pnpm dev            # just the UI in a browser at http://localhost:1420, with mock agents
pnpm typecheck      # also checks ../src/ui against the shim
pnpm test:audio     # the levels the audio capture works out
cargo test --manifest-path src-tauri/Cargo.toml
```

## Build

```bash
pnpm release              # this Mac's architecture
pnpm release universal    # Apple silicon and Intel in one app
```

`scripts/release.sh` builds `src-tauri/target/release/bundle/macos/OfficeSim.app` and a DMG next to
it (`bundle/OfficeSim_<version>_<arch>.dmg`, the app plus an Applications shortcut).

The app is ad-hoc signed, not with an Apple Developer ID, and not notarized. The first time, open it
with right-click → Open (or System Settings → Privacy & Security → Open Anyway). Signing,
notarization and auto-update come with a Developer ID.
