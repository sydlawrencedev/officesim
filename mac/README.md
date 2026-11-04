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
numbered oldest first when a project has several sessions. The harness shows as its favicon before
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

## The Mac app

- A menu bar icon shows how many agents are working (and waiting on you), lists those waiting
  (click one to open it), and opens the office or the mini camera.
- A notification when an agent starts waiting on you (Settings → This Mac, or the menu bar menu).
- The mini camera: a small always-on-top window with just the camera.
- Launch at login, into the menu bar. Closing the office window leaves OfficeSim in the menu bar.

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
