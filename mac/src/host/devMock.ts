/*
 * A stand-in backend for working on the UI in a plain browser (`pnpm dev` without Tauri): a few
 * made-up agents, and empty answers for everything else. The real app never reaches this.
 */

const startedAt = new Date(Date.now() - 7 * 60_000).toISOString();

// Shaped like the backend's agents: named after the project (or the Paperclip agent), the thread in issueTitle
const MOCK_AGENTS = [
  { id: "mock-1", source: "claude", name: "Agent Pixels 1", status: "running", activityKind: "coding", thread: "Standalone Mac app for agent data", branch: "paperclip-2026-compat", summary: null },
  { id: "mock-2", source: "claude", name: "Agent Pixels 2", status: "idle", activityKind: "idle", thread: "Black screen flicker bug", branch: "paperclip-2026-compat", summary: "I've committed the fix for the black screen flicker." },
  { id: "mock-3", source: "opencode", name: "Delphina", status: "running", activityKind: "coding", thread: "Customizable settings panel", branch: "main", summary: null },
  { id: "mock-4", source: "paperclip", name: "CEO", status: "idle", activityKind: "idle", thread: "Fix the flaky checkout test", branch: "main", summary: "The checkout test is stable now." },
] as const;

function lastRun(agent: (typeof MOCK_AGENTS)[number]) {
  const active = agent.status === "running";
  return {
    runId: `${agent.id}-run`,
    status: active ? "running" : "succeeded",
    active,
    startedAt,
    finishedAt: active ? null : new Date().toISOString(),
    lastOutputAt: new Date().toISOString(),
    lastOutputBytes: null,
    summary: agent.summary,
    error: null,
    issueIdentifier: null,
    issueTitle: agent.thread,
  };
}

export async function devMockData(key: string, params: Record<string, unknown>): Promise<unknown> {
  switch (key) {
    case "camera-room":
      return {
        room: "Office",
        agents: MOCK_AGENTS.map((agent) => ({
          id: agent.id, name: agent.name, source: agent.source, status: agent.status, urlKey: null, activityKind: agent.activityKind, lastRun: lastRun(agent),
        })),
      };
    case "app-settings":
      return { launchAtLogin: false, notifyWaiting: true };
    case "harnesses":
      return {
        harnesses: MOCK_HARNESSES.map((harness) => ({ ...harness, agents: harness.enabled ? harness.agents : null })),
        taskSources: [{ id: "paperclip-tasks", label: "Paperclip issues", location: "postgres://localhost:5432/paperclip", detected: true, enabled: true, open: 15, problem: null }],
      };
    case "character-settings":
      return { agents: MOCK_AGENTS.map(({ id, name, status }) => ({ id, name, status, urlKey: null })) };
    case "agent-stats":
      return {
        range: typeof params.range === "string" ? params.range : "7d",
        agents: MOCK_AGENTS.map(({ id, name, source, status }, index) => ({
          id, name, source, status, model: ["claude-opus-5-5", "minimax-coding-plan/MiniMax-M3", "gemini-2.5-flash"][index % 3], issuesDone: 0, activeSeconds: (index + 1) * 1500, runs: (index + 1) * 6,
          inputTokens: (index + 1) * 300_000, cachedInputTokens: (index + 1) * 20_000_000, outputTokens: (index + 1) * 90_000,
          lastRunFinishedAt: status === "running" ? null : new Date().toISOString(),
          canStart: false,
        })),
      };
    default:
      return emptyData(key, params);
  }
}

// Agent sources for the Settings tab, turned on and off in memory
const MOCK_HARNESSES = [
  { id: "claude", label: "Claude Code", location: "~/.claude", detected: true, enabled: true, agents: 4, problem: null },
  { id: "opencode", label: "OpenCode", location: "~/.local/share/opencode/opencode.db", detected: true, enabled: true, agents: 1, problem: null },
  { id: "gemini", label: "Gemini CLI", location: "~/.gemini/tmp", detected: false, enabled: true, agents: null, problem: null },
  { id: "paperclip", label: "Paperclip", location: "postgres://localhost:5432/paperclip", detected: true, enabled: true, agents: null, problem: "Can't reach Paperclip's database: connection refused" },
];

export async function devMockAction(key: string, params: Record<string, unknown>): Promise<unknown> {
  if (key === "record-game") return { recorded: false };
  if (key === "set-harness-enabled") {
    const harness = MOCK_HARNESSES.find((candidate) => candidate.id === params.id);
    if (harness) harness.enabled = params.enabled === true;
    return { id: params.id, enabled: params.enabled };
  }
  return null;
}

/** What each data key returns when there's nothing to show; the backend answers the same way. */
export function emptyData(key: string, params: Record<string, unknown>): unknown {
  const range = typeof params.range === "string" ? params.range : "7d";
  switch (key) {
    case "agent-stats":
      return { range, agents: [] };
    case "game-high-scores":
      return { range, leaderboards: { arcade: [], pool: [], pingpong: [] }, leisureByAgent: {}, topPotters: [] };
    case "scorecard":
      return { scorecard: null };
    case "kanban-board":
      return { columns: ["backlog", "todo", "in_progress", "in_review", "blocked"].map((status) => ({ status, issues: [] })) };
    case "issues-board":
      return { columns: ["backlog", "todo", "in_progress", "in_review", "blocked"].map((status) => ({ status, issues: [] })), repos: [], problems: [] };
    case "issues-done":
      return { windows: new Array(12).fill(0), endsAt: new Date().toISOString(), total: 0, recent: [] };
    case "done-tasks":
      return { tasks: [] };
    case "closed-issues":
      return { issues: [], problems: [] };
    case "git-log":
      return { state: "unconfigured" };
    case "git-activity":
      return { state: "unconfigured", repos: [] };
    case "git-commits":
      return { state: "unconfigured", commits: [], problems: [] };
    case "wall-charts":
      return { charts: {} };
    case "logins":
      return { live: false, recent: [] };
    default:
      return null;
  }
}
