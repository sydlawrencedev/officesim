import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./manifest.js";
import { DONE_TIMELINE_WINDOW_MINUTES, DONE_TIMELINE_WINDOWS, type IssuesDone } from "./issuesDone.js";
import { readGitLog } from "./gitLog.js";
import type { DoneTasksLog, GitActivity, GitLog } from "./logs.js";
import type { BoardIssue, IssuesBoard } from "./issuesBoard.js";
import { findLogins, loginPageviewsQuery, type Logins } from "./logins.js";
import {
  isHttpUrl,
  normalizeSettings,
  settingsFromLegacyConfig,
  SETTINGS_STATE_KEY,
  WALL_CHART_SLOTS,
  type OfficeSettings,
  type OfficeSettingsData,
  type WallChartKey,
} from "./officeSettings.js";

type ActivityKind = "coding" | "research" | "writing" | "meeting" | "idle";

function inferActivityKind(agent: { name: string; title: string | null; role: string; status: string }): ActivityKind {
  if (agent.status !== "running") return "idle";

  const text = `${agent.name} ${agent.title ?? ""} ${agent.role}`.toLowerCase();
  if (text.includes("research") || text.includes("seo") || text.includes("analyst")) return "research";
  if (text.includes("copy") || text.includes("content") || text.includes("writer") || text.includes("email")) return "writing";
  if (text.includes("ceo") || text.includes("cmo") || text.includes("strateg")) return "meeting";
  if (text.includes("engineer") || text.includes("devops") || text.includes("cto") || text.includes("software")) return "coding";

  return agent.status === "running" || agent.status === "active" ? "coding" : "idle";
}

/**
 * The status the office shows for an agent, which is not quite the one Paperclip keeps.
 *
 * Paperclip tracks a failure on the *run* (`heartbeat_runs.status` of `failed`, with its error) and
 * leaves the agent itself merely idle, so an errored agent looks indistinguishable from a resting
 * one — it never shows as sick, and the quiet-office toast never reports it. Lift the failed run
 * onto the agent here. The Mac app's harness sources do the same for their own sessions, since
 * those record the error against the agent instead.
 */
function officeStatus(agentStatus: string, lastRun: { status: string; active: boolean; error: string | null } | null | undefined): string {
  if (agentStatus === "running" || agentStatus === "active") return agentStatus;
  // A run in progress always wins: the agent is busy, so nothing has gone wrong yet
  if (lastRun?.active) return agentStatus;
  return lastRun?.status === "failed" || lastRun?.error ? "error" : agentStatus;
}

export type LastRunSummary = {
  runId: string;
  status: string;
  /** True while the run is still in progress; it then takes precedence over finished runs. */
  active: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  lastOutputAt: string | null;
  /** Bytes of run log written so far, so the UI can read just the tail of a live run's log. */
  lastOutputBytes: number | null;
  summary: string | null;
  error: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
};

type LastRunRow = {
  agent_id: string;
  run_id: string;
  status: string;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  last_output_at: string | Date | null;
  last_output_bytes: string | number | null;
  error: string | null;
  result_json: Record<string, unknown> | null;
  issue_identifier: string | null;
  issue_title: string | null;
};

const SUMMARY_MAX_CHARS = 320;

// Per agent: its in-progress run if it has one, otherwise its latest finished run,
// joined to the issue it is/was working on (if any).
const LAST_RUNS_SQL = `
  SELECT a.id AS agent_id, r.id AS run_id, r.status, r.started_at, r.finished_at, r.last_output_at,
         r.last_output_bytes, r.error, r.result_json, i.identifier AS issue_identifier, i.title AS issue_title
  FROM public.agents a
  CROSS JOIN LATERAL (
    SELECT hr.id, hr.status, hr.started_at, hr.finished_at, hr.last_output_at, hr.last_output_bytes, hr.error,
           hr.result_json, hr.context_snapshot
    FROM public.heartbeat_runs hr
    WHERE hr.company_id = a.company_id AND hr.agent_id = a.id
      AND (hr.finished_at IS NOT NULL OR hr.status = 'running')
    ORDER BY (hr.status = 'running') DESC, COALESCE(hr.finished_at, hr.started_at, hr.created_at) DESC
    LIMIT 1
  ) r
  -- Runs woken on demand carry no issueId; the agent checks one out mid-run, which Paperclip
  -- records on the issue until the run ends. (activity_log would cover finished runs too, but
  -- plugins can't read it.)
  LEFT JOIN LATERAL (
    SELECT iss.identifier, iss.title
    FROM public.issues iss
    WHERE iss.company_id = a.company_id
      AND (
        iss.id::text = r.context_snapshot ->> 'issueId'
        OR iss.checkout_run_id = r.id
        OR iss.execution_run_id = r.id
      )
    ORDER BY (iss.id::text = r.context_snapshot ->> 'issueId') DESC NULLS LAST,
             (iss.checkout_run_id = r.id) DESC NULLS LAST,
             iss.updated_at DESC
    LIMIT 1
  ) i ON true
  WHERE a.company_id = $1
`;

// Agents in the office: running, or run in the last 30 days (or, never having run, created in them).
const RECENT_AGENTS_SQL = `
  SELECT a.id AS agent_id
  FROM public.agents a
  WHERE a.company_id = $1
    AND (
      a.created_at > now() - interval '30 days'
      OR EXISTS (
        SELECT 1 FROM public.heartbeat_runs hr
        WHERE hr.company_id = a.company_id AND hr.agent_id = a.id
          AND (hr.status = 'running' OR coalesce(hr.finished_at, hr.started_at) > now() - interval '30 days')
      )
    )
`;

/** Open-work columns on the boardroom kanban, in board order (done and cancelled are left off). */
export const KANBAN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

export type KanbanIssue = {
  id: string;
  identifier: string | null;
  title: string;
  priority: string;
  /** Name of the agent with a run in progress on this issue, if any. */
  workingAgent: string | null;
  /** Name of the assigned agent, if an agent is assigned. */
  assigneeAgent: string | null;
  /** True when a person (e.g. the board) is assigned rather than an agent. */
  assignedToUser: boolean;
};

export type KanbanBoard = {
  /** One entry per KANBAN_STATUSES column: its open issues, most urgent first. */
  columns: Array<{ status: (typeof KANBAN_STATUSES)[number]; issues: KanbanIssue[] }>;
};

/** The Issues tab: every open issue across the company's repos, as a board. */
const ISSUES_BOARD_SQL = `
  SELECT i.id, i.identifier, i.title, i.status, i.priority, i.created_at, i.updated_at,
         coalesce(assignee.name, CASE WHEN i.assignee_user_id IS NOT NULL THEN 'A person' END) AS assignee,
         (SELECT count(*) FROM public.issue_comments c WHERE c.issue_id = i.id AND c.deleted_at IS NULL)::int8 AS comments,
         c.name AS company
  FROM public.issues i
  JOIN public.companies c ON c.id = i.company_id AND c.status = 'active'
  LEFT JOIN public.agents assignee ON assignee.id = i.assignee_agent_id
  WHERE i.hidden_at IS NULL AND i.status IN (${KANBAN_STATUSES.map((status) => `'${status}'`).join(", ")})
  ORDER BY CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.created_at
`;

/** The Issues tab's board, for the plugin: every active company's issues. */
export type { IssuesBoard } from "./issuesBoard.js";

/** One issue on the Issues tab. */
export type { BoardIssue } from "./issuesBoard.js";

// The status list is inlined: the plugin db client expands array params into a row, not an array.
/** Time frames the stats panel offers, in hours. */
export const STATS_RANGE_HOURS = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30 } as const;
export type StatsRange = keyof typeof STATS_RANGE_HOURS;

export type AgentStats = {
  id: string;
  name: string;
  status: string;
  issuesDone: number;
  /** Summed run time; concurrent runs of one agent each count. */
  activeSeconds: number;
  runs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** When the agent's most recent run finished, whatever the time frame. */
  lastRunFinishedAt: string | null;
  /** The harness the agent runs in (e.g. "claude"), when the host knows; shown as an icon before its name. */
  source?: string;
  /** The model the agent runs on (e.g. "claude-opus-5-5"), when known. */
  model?: string | null;
  /** False when the office can't start a run for this agent (e.g. a Claude Code session in the Mac app); Paperclip agents always can. */
  canStart?: boolean;
};

/** Games agents play on their downtime; the office records a score when each game ends. */
export const GAMES = ["arcade", "pool", "pingpong"] as const;
export type Game = (typeof GAMES)[number];
/** Well above anything a game can score, to keep a bad client from topping the board. */
const MAX_GAME_SCORE = 100_000;
/** How many top scores per game the stats panel lists. */
const LEADERBOARD_SIZE = 5;

export type GameScore = {
  agentId: string;
  agentName: string | null;
  score: number;
  playedAt: string | null;
};

/**
 * An agent's downtime in a time frame. Games count from when they start; a pool game is one visit to
 * the table, scored in balls potted; a ping pong game is one match, first to 7.
 */
export type LeisureStats = {
  arcadeGames: number;
  arcadeBest: number;
  poolGames: number;
  ballsPotted: number;
  pingPongGames: number;
  pingPongWins: number;
};

export type GameHighScores = {
  range: StatsRange;
  /**
   * Each game's best scores in the time frame, highest first (the earlier game wins a tie). Ping
   * pong's board is by matches won instead: `score` is the agent's wins, `playedAt` their last match.
   */
  leaderboards: Record<Game, GameScore[]>;
  /** Each agent's games in the time frame; agents who played none are left out. */
  leisureByAgent: Record<string, LeisureStats>;
  /** The agents who potted the most balls in the time frame, most first. */
  topPotters: Array<{ agentId: string; agentName: string | null; ballsPotted: number; poolGames: number }>;
};

/** Top scores per game over the last $2 hours. The schema is filled in per call. */
const gameLeaderboardsSql = (namespace: string) => `
  SELECT s.game, s.agent_id, a.name AS agent_name, s.score, s.played_at
  FROM (
    SELECT g.game, g.agent_id, g.score, g.played_at,
           row_number() OVER (PARTITION BY g.game ORDER BY g.score DESC, g.played_at) AS rank
    FROM ${namespace}.game_scores g
    WHERE g.company_id = $1 AND g.played_at >= now() - make_interval(hours => $2::int) AND g.score > 0
      AND g.game <> 'pingpong'
  ) s
  LEFT JOIN public.agents a ON a.id::text = s.agent_id
  WHERE s.rank <= ${LEADERBOARD_SIZE}
  ORDER BY s.game, s.rank
`;

/** Games played, best score and total score per agent and game over the last $2 hours. */
const gameTotalsSql = (namespace: string) => `
  SELECT g.agent_id, a.name AS agent_name, g.game, count(*) AS games, max(g.score) AS best, sum(g.score) AS total,
         count(*) FILTER (WHERE g.won) AS wins, max(g.played_at) AS last_played
  FROM ${namespace}.game_scores g
  LEFT JOIN public.agents a ON a.id::text = g.agent_id
  WHERE g.company_id = $1 AND g.played_at >= now() - make_interval(hours => $2::int)
  GROUP BY g.agent_id, a.name, g.game
`;

// Per agent over the last $2 hours: issues it completed, run time falling inside the window (a run
// that started earlier counts from the window's start) and tokens from its reported cost events.
const AGENT_STATS_SQL = `
  WITH w AS (SELECT now() - make_interval(hours => $2::int) AS since),
  done AS (
    SELECT i.assignee_agent_id AS agent_id, count(*) AS issues_done
    FROM public.issues i, w
    WHERE i.company_id = $1 AND i.status = 'done' AND i.completed_at >= w.since AND i.assignee_agent_id IS NOT NULL
    GROUP BY 1
  ),
  active AS (
    SELECT hr.agent_id, count(*) AS runs,
           sum(extract(epoch FROM least(coalesce(hr.finished_at, now()), now()) - greatest(hr.started_at, w.since))) AS active_seconds
    FROM public.heartbeat_runs hr, w
    WHERE hr.company_id = $1 AND hr.started_at IS NOT NULL
      AND (hr.finished_at IS NOT NULL OR hr.status = 'running')
      AND coalesce(hr.finished_at, now()) > w.since
    GROUP BY 1
  ),
  tokens AS (
    SELECT c.agent_id, sum(c.input_tokens) AS input_tokens, sum(c.cached_input_tokens) AS cached_input_tokens,
           sum(c.output_tokens) AS output_tokens
    FROM public.cost_events c, w
    WHERE c.company_id = $1 AND c.occurred_at >= w.since
    GROUP BY 1
  ),
  last_run AS (
    SELECT hr.agent_id, max(hr.finished_at) AS finished_at
    FROM public.heartbeat_runs hr
    WHERE hr.company_id = $1 AND hr.finished_at IS NOT NULL
    GROUP BY 1
  )
  SELECT a.id, a.name, a.status, done.issues_done, active.runs, active.active_seconds,
         tokens.input_tokens, tokens.cached_input_tokens, tokens.output_tokens, last_run.finished_at AS last_run_finished_at,
         -- The model its harness session reported on its latest run (e.g. OpenCode's), else its configured one
         coalesce((SELECT hr.usage_json ->> 'model' FROM public.heartbeat_runs hr
                   WHERE hr.company_id = $1 AND hr.agent_id = a.id AND hr.finished_at IS NOT NULL AND hr.usage_json ->> 'model' <> ''
                   ORDER BY hr.finished_at DESC LIMIT 1),
                  nullif(a.adapter_config ->> 'model', '')) AS model
  FROM public.agents a
  LEFT JOIN done ON done.agent_id = a.id
  LEFT JOIN active ON active.agent_id = a.id
  LEFT JOIN tokens ON tokens.agent_id = a.id
  LEFT JOIN last_run ON last_run.agent_id = a.id
  WHERE a.company_id = $1 AND a.status <> 'terminated'
  ORDER BY a.name
`;

/** Issues done this recently are sent along so the office can cheer each one as it lands */
const RECENTLY_DONE_MINUTES = 15;

// Issues completed in each 10-minute window back from now: 0 is the latest window.
const DONE_WINDOWS_SQL = `
  SELECT floor(extract(epoch FROM now() - i.completed_at) / ($2::int * 60))::int AS windows_ago, count(*) AS done
  FROM public.issues i
  WHERE i.company_id = $1 AND i.status = 'done' AND i.hidden_at IS NULL
    AND i.completed_at > now() - make_interval(mins => $2::int * $3::int) AND i.completed_at <= now()
  GROUP BY 1
`;

const TOTAL_DONE_SQL = `
  SELECT count(*) AS total FROM public.issues i WHERE i.company_id = $1 AND i.status = 'done' AND i.hidden_at IS NULL
`;

// With the name of each one's assigned agent, credited in the office's toast.
const RECENTLY_DONE_SQL = `
  SELECT i.id, i.identifier, i.title, i.completed_at, assignee.name AS done_by
  FROM public.issues i
  LEFT JOIN public.agents assignee ON assignee.id = i.assignee_agent_id
  WHERE i.company_id = $1 AND i.status = 'done' AND i.hidden_at IS NULL
    AND i.completed_at > now() - make_interval(mins => $2::int)
  ORDER BY i.completed_at DESC
  LIMIT 50
`;

/** Done tasks in the Activity tab, newest first */
const DONE_TASKS_LIMIT = 100;
const LAST_COMMENT_MAX_CHARS = 280;

const DONE_TASKS_SQL = `
  SELECT i.id, i.identifier, i.title, i.priority, i.created_at, i.started_at, i.completed_at,
         assignee.name AS assignee,
         coalesce(creator.name, CASE WHEN i.created_by_user_id IS NOT NULL THEN 'Board' END) AS created_by,
         (SELECT count(*) FROM public.issue_comments c WHERE c.issue_id = i.id AND c.deleted_at IS NULL) AS comments,
         (SELECT c.body FROM public.issue_comments c WHERE c.issue_id = i.id AND c.deleted_at IS NULL
           ORDER BY c.created_at DESC LIMIT 1) AS last_comment
  FROM public.issues i
  LEFT JOIN public.agents assignee ON assignee.id = i.assignee_agent_id
  LEFT JOIN public.agents creator ON creator.id = i.created_by_agent_id
  WHERE i.company_id = $1 AND i.status = 'done' AND i.hidden_at IS NULL
  ORDER BY i.completed_at DESC NULLS LAST
  LIMIT $2
`;

const KANBAN_SQL = `
  SELECT i.id, i.identifier, i.title, i.status, i.priority, w.name AS "workingAgent",
         assignee.name AS "assigneeAgent", (i.assignee_user_id IS NOT NULL) AS "assignedToUser"
  FROM public.issues i
  LEFT JOIN public.agents assignee ON assignee.id = i.assignee_agent_id
  -- A run in progress on the issue: it holds the checkout, or was woken for this issue.
  LEFT JOIN LATERAL (
    SELECT a.name
    FROM public.heartbeat_runs hr
    JOIN public.agents a ON a.id = hr.agent_id
    WHERE hr.company_id = i.company_id AND hr.status = 'running'
      AND (hr.id = i.checkout_run_id OR hr.id = i.execution_run_id OR hr.context_snapshot ->> 'issueId' = i.id::text)
    ORDER BY hr.started_at DESC
    LIMIT 1
  ) w ON true
  WHERE i.company_id = $1 AND i.hidden_at IS NULL
    AND i.status IN (${KANBAN_STATUSES.map((status) => `'${status}'`).join(", ")})
  ORDER BY CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.created_at
`;

export type ScorecardStatus = "green" | "yellow" | "red";

/** The latest business scorecard posted in an issue comment, for the boardroom's traffic-light board. */
export type Scorecard = {
  title: string | null;
  overall: ScorecardStatus;
  sections: Array<{ name: string; status: ScorecardStatus; metric: string }>;
  priorities: string[];
  issueIdentifier: string | null;
  postedAt: string | null;
};

/** Recent comments containing the scorecard keyword ($2), optionally only by the agent named $3. */
const SCORECARD_SQL = `
  SELECT c.body, c.created_at, i.identifier
  FROM public.issue_comments c
  JOIN public.issues i ON i.id = c.issue_id
  LEFT JOIN public.agents a ON a.id = c.author_agent_id
  WHERE i.company_id = $1 AND c.body ILIKE $2::text
    AND ($3::text = '' OR lower(a.name) = lower($3::text))
  ORDER BY c.created_at DESC
  LIMIT 10
`;

/** A LIKE pattern matching the keyword anywhere, with LIKE's own wildcards taken literally. */
const containsPattern = (keyword: string) => `%${keyword.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

const STATUS_EMOJI: Record<string, ScorecardStatus> = { "🟢": "green", "🟡": "yellow", "🔴": "red" };
const STATUS_RANK: Record<ScorecardStatus, number> = { green: 0, yellow: 1, red: 2 };

const stripMarkdown = (text: string) => text.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();

/**
 * Parse a scorecard comment: a markdown table of `| Section | 🟢/🟡/🔴 | metric |` rows, an optional
 * "Overall Status: 🟡" (otherwise the worst section), and an optional numbered priorities list.
 * Returns null when the comment has no such table (e.g. a message just mentioning the scorecard).
 */
function parseScorecard(body: string, keyword: string, minSections: number): Omit<Scorecard, "issueIdentifier" | "postedAt"> | null {
  const sections: Scorecard["sections"] = [];
  for (const line of body.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const statusIndex = cells.findIndex((cell) => cell in STATUS_EMOJI);
    if (statusIndex < 1) continue;
    // Section names lead with an emoji icon; keep from the first letter.
    const name = stripMarkdown(cells[statusIndex - 1]).replace(/^[^\p{L}]+/u, "");
    if (!name) continue;
    sections.push({ name, status: STATUS_EMOJI[cells[statusIndex]], metric: stripMarkdown(cells[statusIndex + 1] ?? "") });
  }
  if (sections.length < minSections) return null;

  const overallMatch = body.match(/overall status:?\**\s*(🟢|🟡|🔴)/i);
  const overall = overallMatch
    ? STATUS_EMOJI[overallMatch[1]]
    : sections.reduce<ScorecardStatus>((worst, s) => (STATUS_RANK[s.status] > STATUS_RANK[worst] ? s.status : worst), "green");
  // A bold heading naming the keyword, e.g. "**Weekly scorecard: 3 March**"; otherwise the board
  // uses the default title from the settings (other bold text is usually "**done**" or a label).
  const lowerKeyword = keyword.toLowerCase();
  const title = lowerKeyword
    ? [...body.matchAll(/\*\*([^*\n]{3,80})\*\*/g)].map((match) => match[1]).find((text) => text.toLowerCase().includes(lowerKeyword))
    : undefined;
  const prioritiesBlock = body.split(/top priority issues:?\**/i)[1] ?? "";
  const priorities = [...prioritiesBlock.matchAll(/^\s*\d+\.\s+(.+)$/gm)].map((match) => stripMarkdown(match[1])).slice(0, 5);
  return { title: title ? stripMarkdown(title) : null, overall, sections, priorities };
}

/** Charts computed from Stripe (through its MCP server), for boards set to show them. */
export const STRIPE_CHARTS = ["stripeMrr", "stripeNewCustomers"] as const;
export type StripeChartKey = (typeof STRIPE_CHARTS)[number];

export type WhiteboardChart = {
  title: string | null;
  points: Array<{ label: string; value: number }>;
  /** Trends interval ("week", "month", …) when known, for labelling points. */
  interval: string | null;
  /** ISO currency code when values are money (in major units, e.g. pounds). */
  currency?: string | null;
  /** Where the numbers came from; "placeholder" when not configured or the fetch failed. */
  source: "posthog" | "stripe" | "placeholder";
};

type InsightQuery = {
  kind?: string;
  source?: InsightQuery;
  interval?: string;
  breakdownFilter?: unknown;
  chartSettings?: { xAxis?: { column?: string }; yAxis?: Array<{ column?: string }> };
};

type TrendsSeries = { data?: unknown[]; days?: string[]; labels?: string[] };

const PLACEHOLDER_CHART: WhiteboardChart = {
  title: null,
  points: [2, 3, 5, 4, 7, 9].map((value, i) => ({ label: String(i), value })),
  interval: null,
  source: "placeholder",
};
const WHITEBOARD_CACHE_MS = 15 * 60_000;
const WHITEBOARD_RETRY_MS = 60_000;
/** Wall art pictures are scaled down to a few dozen pixels, so anything bigger is a mistake. */
const WALL_IMAGE_MAX_BYTES = 2_000_000;
const WALL_IMAGE_CACHE_MS = 60 * 60_000;
/** Just under the UI's one-minute check, so each check gets fresh pageviews */
const LOGINS_CACHE_MS = 50_000;

/**
 * Total a SQL insight's rows per x-axis value (e.g. month), collapsing any breakdown
 * column. Columns come from the insight's chart settings, falling back to first/last.
 * Only right when each actor lands in one breakdown row, as with a first-touch domain.
 */
function totalSqlRows(rows: unknown[], columns: string[], settings: InsightQuery["chartSettings"]): WhiteboardChart["points"] {
  const xIndex = Math.max(0, columns.indexOf(settings?.xAxis?.column ?? ""));
  const yName = settings?.yAxis?.[0]?.column;
  const yIndex = yName && columns.includes(yName) ? columns.indexOf(yName) : columns.length - 1;
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const value = Number(row[yIndex]);
    if (!Number.isFinite(value)) continue;
    const label = String(row[xIndex]);
    totals.set(label, (totals.get(label) ?? 0) + value);
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => ({ label, value }));
}

/** Add a trends result's series together point by point (a series per event, not per breakdown). */
function totalTrendsSeries(series: TrendsSeries[]): WhiteboardChart["points"] {
  const first = series[0];
  if (!first?.data) return [];
  const labels = first.days ?? first.labels ?? [];
  return first.data.map((_, i) => ({
    label: String(labels[i] ?? i),
    value: series.reduce((sum, s) => sum + (Number(s.data?.[i]) || 0), 0),
  }));
}

type StripeList<T> = { data?: T[]; has_more?: boolean };
type StripeSubscription = {
  id: string;
  status: string;
  currency: string;
  start_date: number;
  ended_at: number | null;
  trial_start: number | null;
  trial_end: number | null;
  items?: { data?: Array<{ quantity?: number | null; price?: { unit_amount?: number | null; recurring?: { interval?: string; interval_count?: number } | null } }> };
};

const STRIPE_MRR_MONTHS = 6;
const STRIPE_CUSTOMER_WEEKS = 9;
const STRIPE_MAX_PAGES = 50;
const DAY_MS = 86_400_000;

/** A subscription's monthly recurring value in minor units (pence), from its current prices; discounts aren't applied. */
function monthlyValue(subscription: StripeSubscription): number {
  const perMonth: Record<string, number> = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 };
  let total = 0;
  for (const item of subscription.items?.data ?? []) {
    const recurring = item.price?.recurring;
    const rate = recurring?.interval ? perMonth[recurring.interval] : undefined;
    if (!rate || !item.price?.unit_amount) continue;
    total += (item.price.unit_amount * (item.quantity ?? 1) * rate) / (recurring?.interval_count || 1);
  }
  return total;
}

/** Whether a subscription was paying at a moment: started, not ended, and not in a trial. */
function payingAt(subscription: StripeSubscription, at: number): boolean {
  if (["incomplete", "incomplete_expired"].includes(subscription.status)) return false;
  if (subscription.start_date > at || (subscription.ended_at !== null && subscription.ended_at <= at)) return false;
  return !(subscription.trial_start !== null && subscription.trial_end !== null && subscription.trial_start <= at && subscription.trial_end > at);
}

/** UTC midnight on the Monday starting the week that contains `time`. */
function startOfWeek(time: number): Date {
  const date = new Date(time);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date;
}

/** Reads a JSON-RPC reply that arrives either as plain JSON or as a server-sent-events stream. */
async function readJsonRpc(response: Response, id: number): Promise<{ result?: unknown; error?: { message?: string } }> {
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text);
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const message = JSON.parse(line.slice(5).trim()) as { id?: number; result?: unknown; error?: { message?: string } };
    if (message.id === id) return message;
  }
  throw new Error("No reply in the MCP event stream");
}

/**
 * A minimal MCP client over streamable HTTP: initialises once, then calls tools. Enough to read
 * from a hosted MCP server (e.g. Stripe's) with a bearer token the host keeps refreshed.
 */
function createMcpClient(http: { fetch(url: string, init?: RequestInit): Promise<Response> }, url: string, token: string) {
  let nextId = 1;
  let sessionId: string | null = null;
  let ready: Promise<void> | null = null;

  async function send(method: string, params: unknown, notification = false) {
    const id = nextId++;
    const response = await http.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) throw new Error(`MCP ${method} responded ${response.status}`);
    if (notification) return undefined;
    const reply = await readJsonRpc(response, id);
    if (reply.error) throw new Error(`MCP ${method} failed: ${reply.error.message ?? "unknown error"}`);
    return reply.result;
  }

  function init() {
    ready ??= (async () => {
      await send("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "officesim", version: "0.1.0" },
      });
      await send("notifications/initialized", {}, true);
    })();
    return ready;
  }

  return {
    /** Calls a tool and returns its text content, parsed as JSON when it is JSON. */
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      await init();
      const result = (await send("tools/call", { name, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
      if (result.isError) throw new Error(`MCP tool ${name} failed: ${text.slice(0, 200)}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  };
}

function toIso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function tidy(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(#{1,6}|>)\s*/gm, "")
    .replace(/[*`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > SUMMARY_MAX_CHARS ? `${flat.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : flat;
}

// Agents often open their final message with narration before the outcome.
const NARRATION_RE = /^(let me|let's|i'll|i will|i need to|i'm going to|now,? (let|i)|first,? (let|i))\b/i;

/** A comment as one plain line for the Activity tab: markdown and code blocks dropped, trimmed to length. */
function tidyComment(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(#{1,6}|>|[-*]\s)\s*/gm, "")
    .replace(/[*`_]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > LAST_COMMENT_MAX_CHARS ? `${flat.slice(0, LAST_COMMENT_MAX_CHARS - 1).trimEnd()}…` : flat;
}

/**
 * Same field order as Paperclip's own run summary (summary → result → message).
 * stdout is skipped on purpose: it is the adapter's raw JSON event stream.
 */
function summarizeRun(row: LastRunRow): string | null {
  const result = row.result_json && typeof row.result_json === "object" ? row.result_json : {};
  for (const key of ["summary", "result", "message"]) {
    const value = result[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const paragraphs = value.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    const outcome = paragraphs.filter((part) => !NARRATION_RE.test(part));
    return tidy((outcome.length ? outcome : paragraphs).join("\n"));
  }
  return null;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("OfficeSim plugin setup complete");

    const configFor = (companyId: string | undefined) => ctx.config.get(companyId).catch(() => ({} as Record<string, unknown>));
    const settingsScope = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: SETTINGS_STATE_KEY });

    /** The company's saved office settings, or ones carried over from older plugin config until it saves its own. */
    async function loadSettings(companyId: string | undefined, config?: Record<string, unknown>): Promise<{ settings: OfficeSettings; saved: boolean }> {
      if (companyId) {
        try {
          const stored = await ctx.state.get(settingsScope(companyId));
          if (stored) return { settings: normalizeSettings(stored), saved: true };
        } catch (error) {
          ctx.logger.warn("Could not read office settings", { error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { settings: settingsFromLegacyConfig(config ?? (await configFor(companyId))), saved: false };
    }

    ctx.data.register("office-settings", async (params): Promise<OfficeSettingsData> => {
      const companyId = typeof params.companyId === "string" ? params.companyId : undefined;
      const config = await configFor(companyId);
      const { settings, saved } = await loadSettings(companyId, config);
      return { settings, saved, posthogConnected: !!config.posthogApiKey, stripeConnected: !!config.stripeAccessToken };
    });

    ctx.actions.register("save-office-settings", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) throw new Error("Pick a company before saving office settings");
      const settings = normalizeSettings(params.settings);
      await ctx.state.set(settingsScope(companyId), settings);
      // Boards and logins pick up the new setup on their next check rather than waiting out the cache.
      wallChartCache.clear();
      stripeCache = null;
      loginsCache = null;
      return { settings };
    });

    const wallImageCache = new Map<string, { image: { contentType: string; base64: string }; expiresAt: number }>();

    // Wall art pictures, fetched here so any image host works regardless of its CORS headers
    ctx.actions.register("fetch-wall-image", async (params) => {
      const url = typeof params.url === "string" ? params.url.trim() : "";
      if (!isHttpUrl(url)) throw new Error("Wall images need an http(s) URL");
      const cached = wallImageCache.get(url);
      if (cached && cached.expiresAt > Date.now()) return cached.image;
      // Node's own fetch rather than ctx.http.fetch: the host's proxy hands bodies back as text, which garbles image bytes.
      const response = await fetch(url, { headers: { Accept: "image/*" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`The image responded ${response.status}`);
      const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!contentType.startsWith("image/")) throw new Error(`That URL is ${contentType || "not an image"}, not an image`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > WALL_IMAGE_MAX_BYTES) throw new Error(`The image is over ${WALL_IMAGE_MAX_BYTES / 1_000_000} MB`);
      const image = { contentType, base64: bytes.toString("base64") };
      if (wallImageCache.size >= 64) wallImageCache.delete(wallImageCache.keys().next().value!);
      wallImageCache.set(url, { image, expiresAt: Date.now() + WALL_IMAGE_CACHE_MS });
      return image;
    });

    async function loadLastRuns(companyId: string): Promise<Map<string, LastRunSummary>> {
      try {
        const rows = (await ctx.db.query(LAST_RUNS_SQL, [companyId])) as LastRunRow[];
        return new Map(rows.map((row) => [row.agent_id, {
          runId: row.run_id,
          status: row.status,
          active: row.status === "running",
          startedAt: toIso(row.started_at),
          finishedAt: toIso(row.finished_at),
          lastOutputAt: toIso(row.last_output_at),
          lastOutputBytes: row.last_output_bytes == null ? null : Number(row.last_output_bytes),
          summary: summarizeRun(row),
          error: row.error ? tidy(row.error) : null,
          issueIdentifier: row.issue_identifier,
          issueTitle: row.issue_title,
        }]));
      } catch (error) {
        // Older hosts without plugin database support: the camera still works, just without run summaries.
        ctx.logger.warn("Could not load last runs", { error: error instanceof Error ? error.message : String(error) });
        return new Map();
      }
    }

    async function loadRecentAgentIds(companyId: string): Promise<Set<string> | null> {
      try {
        const rows = (await ctx.db.query(RECENT_AGENTS_SQL, [companyId])) as Array<{ agent_id: string }>;
        return new Set(rows.map((row) => row.agent_id));
      } catch {
        // Older hosts without plugin database support: everyone stays in the office.
        return null;
      }
    }

    ctx.data.register("camera-room", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const [agents, lastRuns, recent] = companyId
        ? await Promise.all([ctx.agents.list({ companyId, limit: 100, offset: 0 }), loadLastRuns(companyId), loadRecentAgentIds(companyId)])
        : [[], new Map<string, LastRunSummary>(), null];

      return {
        room: "Office",
        agents: agents.filter((agent) => !recent || recent.has(agent.id)).map((agent) => ({
          id: agent.id,
          name: agent.name,
          status: officeStatus(agent.status, lastRuns.get(agent.id)),
          urlKey: agent.urlKey,
          activityKind: inferActivityKind(agent),
          lastRun: lastRuns.get(agent.id) ?? null,
        })),
      };
    });

    ctx.data.register("agent-stats", async (params): Promise<{ range: StatsRange; agents: AgentStats[] }> => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const range: StatsRange = typeof params.range === "string" && params.range in STATS_RANGE_HOURS ? (params.range as StatsRange) : "7d";
      if (!companyId) return { range, agents: [] };
      try {
        const [rows, lastRuns] = await Promise.all([
          ctx.db.query(AGENT_STATS_SQL, [companyId, STATS_RANGE_HOURS[range]]),
          companyId ? loadLastRuns(companyId) : Promise.resolve(new Map<string, LastRunSummary>()),
        ]) as [
          Array<
            Record<"id" | "name" | "status", string> &
              Record<"model", string | null> &
              Record<"issues_done" | "runs" | "active_seconds" | "input_tokens" | "cached_input_tokens" | "output_tokens", string | number | null> & {
                last_run_finished_at: string | Date | null;
              }
          >,
          Map<string, LastRunSummary>,
        ];
        // Postgres returns counts and sums as strings.
        const num = (value: string | number | null) => (value == null ? 0 : Number(value));
        return {
          range,
          agents: rows.map((row) => ({
            id: row.id,
            name: row.name,
            status: officeStatus(row.status, lastRuns.get(row.id)),
            issuesDone: num(row.issues_done),
            activeSeconds: Math.round(num(row.active_seconds)),
            runs: num(row.runs),
            inputTokens: num(row.input_tokens),
            cachedInputTokens: num(row.cached_input_tokens),
            outputTokens: num(row.output_tokens),
            lastRunFinishedAt: toIso(row.last_run_finished_at),
            model: row.model,
          })),
        };
      } catch (error) {
        ctx.logger.warn("Could not load agent stats", { error: error instanceof Error ? error.message : String(error) });
        return { range, agents: [] };
      }
    });

    // Called with a score of 0 when a game starts, then again with the final score when it ends.
    // Either may arrive first, so each inserts the game if it's new and keeps the higher score.
    ctx.actions.register("record-game", async (params) => {
      const { companyId, agentId, game, gameId, score } = params;
      const won = params.won === true;
      if (
        typeof companyId !== "string" ||
        typeof agentId !== "string" ||
        typeof gameId !== "string" ||
        gameId.length === 0 ||
        gameId.length > 64 ||
        !GAMES.includes(game as Game) ||
        typeof score !== "number" ||
        !Number.isInteger(score) ||
        score < 0 ||
        score > MAX_GAME_SCORE
      ) {
        return { recorded: false };
      }
      await ctx.db.execute(
        `INSERT INTO ${ctx.db.namespace}.game_scores AS g (company_id, agent_id, game, game_id, score, won) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (game_id) DO UPDATE SET score = GREATEST(g.score, EXCLUDED.score), won = g.won OR EXCLUDED.won`,
        [companyId, agentId, game, gameId, score, won],
      );
      return { recorded: true };
    });

    // Wake an agent up with a fresh heartbeat. The host throws if the agent is paused, terminated
    // or pending approval, so the button on the stats panel just disables itself in those cases.
    ctx.actions.register("start-agent-run", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const agentId = typeof params.agentId === "string" ? params.agentId : null;
      if (!companyId || !agentId) throw new Error("Pick a company and agent before starting a run");
      const reason = typeof params.reason === "string" && params.reason.trim().length > 0 ? params.reason.trim() : "Manual run from OfficeSim";
      const { runId } = await ctx.agents.invoke(agentId, companyId, { prompt: reason });
      return { runId };
    });

    ctx.data.register("game-high-scores", async (params): Promise<GameHighScores> => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const range: StatsRange = typeof params.range === "string" && params.range in STATS_RANGE_HOURS ? (params.range as StatsRange) : "7d";
      const result: GameHighScores = { range, leaderboards: { arcade: [], pool: [], pingpong: [] }, leisureByAgent: {}, topPotters: [] };
      if (!companyId) return result;
      try {
        const params = [companyId, STATS_RANGE_HOURS[range]];
        const [leaders, totals] = await Promise.all([
          ctx.db.query(gameLeaderboardsSql(ctx.db.namespace), params) as Promise<Array<{
            game: Game;
            agent_id: string;
            agent_name: string | null;
            score: number | string;
            played_at: string | Date | null;
          }>>,
          ctx.db.query(gameTotalsSql(ctx.db.namespace), params) as Promise<Array<{
            agent_id: string;
            agent_name: string | null;
            game: Game;
            games: number | string;
            best: number | string;
            total: number | string;
            wins: number | string;
            last_played: string | Date | null;
          }>>,
        ]);
        for (const row of leaders) {
          if (!GAMES.includes(row.game)) continue;
          result.leaderboards[row.game].push({ agentId: row.agent_id, agentName: row.agent_name, score: Number(row.score), playedAt: toIso(row.played_at) });
        }
        for (const row of totals) {
          const stats = (result.leisureByAgent[row.agent_id] ??= {
            arcadeGames: 0,
            arcadeBest: 0,
            poolGames: 0,
            ballsPotted: 0,
            pingPongGames: 0,
            pingPongWins: 0,
          });
          if (row.game === "arcade") {
            stats.arcadeGames = Number(row.games);
            stats.arcadeBest = Number(row.best);
          } else if (row.game === "pingpong") {
            stats.pingPongGames = Number(row.games);
            stats.pingPongWins = Number(row.wins);
            if (stats.pingPongWins > 0) {
              result.leaderboards.pingpong.push({ agentId: row.agent_id, agentName: row.agent_name, score: stats.pingPongWins, playedAt: toIso(row.last_played) });
            }
          } else if (row.game === "pool") {
            stats.poolGames = Number(row.games);
            stats.ballsPotted = Number(row.total);
            if (stats.ballsPotted > 0) {
              result.topPotters.push({ agentId: row.agent_id, agentName: row.agent_name, ballsPotted: stats.ballsPotted, poolGames: stats.poolGames });
            }
          }
        }
        result.topPotters.sort((a, b) => b.ballsPotted - a.ballsPotted || a.poolGames - b.poolGames);
        // Most wins first; between equals, whoever won theirs first
        result.leaderboards.pingpong.sort((a, b) => b.score - a.score || (a.playedAt ?? "").localeCompare(b.playedAt ?? ""));
        result.leaderboards.pingpong.splice(LEADERBOARD_SIZE);
        result.topPotters.splice(LEADERBOARD_SIZE);
      } catch (error) {
        // Hosts that haven't run the migration yet: the panel just shows no scores.
        ctx.logger.warn("Could not load game scores", { error: error instanceof Error ? error.message : String(error) });
      }
      return result;
    });

    ctx.data.register("scorecard", async (params): Promise<{ scorecard: Scorecard | null }> => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { scorecard: null };
      const { scorecard: setup } = (await loadSettings(companyId)).settings;
      if (!setup.enabled) return { scorecard: null };
      try {
        const rows = (await ctx.db.query(SCORECARD_SQL, [companyId, containsPattern(setup.keyword), setup.authorAgentName])) as Array<{
          body: string;
          created_at: string | Date;
          identifier: string | null;
        }>;
        for (const row of rows) {
          const parsed = parseScorecard(row.body, setup.keyword, setup.minSections);
          if (parsed) {
            return {
              scorecard: { ...parsed, title: parsed.title ?? setup.defaultTitle, issueIdentifier: row.identifier, postedAt: toIso(row.created_at) },
            };
          }
        }
      } catch (error) {
        ctx.logger.warn("Could not load scorecard", { error: error instanceof Error ? error.message : String(error) });
      }
      return { scorecard: null };
    });

    ctx.data.register("kanban-board", async (params): Promise<KanbanBoard> => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const columns = KANBAN_STATUSES.map((status) => ({ status, issues: [] as KanbanIssue[] }));
      if (!companyId) return { columns };
      try {
        const rows = (await ctx.db.query(KANBAN_SQL, [companyId])) as Array<KanbanIssue & { status: string }>;
        for (const { status, ...issue } of rows) columns.find((column) => column.status === status)?.issues.push(issue);
      } catch (error) {
        ctx.logger.warn("Could not load kanban issues", { error: error instanceof Error ? error.message : String(error) });
      }
      return { columns };
    });

    ctx.data.register("issues-done", async (params): Promise<IssuesDone> => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const windows = new Array<number>(DONE_TIMELINE_WINDOWS).fill(0);
      const empty = { windows, endsAt: new Date().toISOString(), total: 0, recent: [] };
      if (!companyId) return empty;
      try {
        const [counts, totals, recent] = await Promise.all([
          ctx.db.query(DONE_WINDOWS_SQL, [companyId, DONE_TIMELINE_WINDOW_MINUTES, DONE_TIMELINE_WINDOWS]) as Promise<
            Array<{ windows_ago: number; done: string | number }>
          >,
          ctx.db.query(TOTAL_DONE_SQL, [companyId]) as Promise<Array<{ total: string | number }>>,
          ctx.db.query(RECENTLY_DONE_SQL, [companyId, RECENTLY_DONE_MINUTES]) as Promise<
            Array<{ id: string; identifier: string | null; title: string; completed_at: string | Date | null; done_by: string | null }>
          >,
        ]);
        for (const row of counts) {
          const index = DONE_TIMELINE_WINDOWS - 1 - Number(row.windows_ago);
          if (index >= 0 && index < DONE_TIMELINE_WINDOWS) windows[index] = Number(row.done);
        }
        return {
          windows,
          endsAt: new Date().toISOString(),
          total: Number(totals[0]?.total ?? 0),
          recent: recent.map((row) => ({ id: row.id, identifier: row.identifier, title: row.title, completedAt: toIso(row.completed_at), doneBy: row.done_by })),
        };
      } catch (error) {
        ctx.logger.warn("Could not load issues done", { error: error instanceof Error ? error.message : String(error) });
        return empty;
      }
    });

    ctx.data.register("done-tasks", async (params): Promise<DoneTasksLog> => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { tasks: [] };
      try {
        const rows = (await ctx.db.query(DONE_TASKS_SQL, [companyId, DONE_TASKS_LIMIT])) as Array<{
          id: string; identifier: string | null; title: string; priority: string; assignee: string | null; created_by: string | null;
          created_at: string | Date | null; started_at: string | Date | null; completed_at: string | Date | null;
          comments: string | number; last_comment: string | null;
        }>;
        return {
          tasks: rows.map((row) => ({
            id: row.id,
            identifier: row.identifier,
            title: row.title,
            priority: row.priority,
            assignee: row.assignee,
            createdBy: row.created_by,
            createdAt: toIso(row.created_at),
            startedAt: toIso(row.started_at),
            completedAt: toIso(row.completed_at),
            comments: Number(row.comments),
            lastComment: row.last_comment ? tidyComment(row.last_comment) : null,
          })),
        };
      } catch (error) {
        ctx.logger.warn("Could not load done tasks", { error: error instanceof Error ? error.message : String(error) });
        return { tasks: [] };
      }
    });

    // The repo the company's agents commit to, from the plugin settings
    ctx.data.register("git-log", async (params): Promise<GitLog> => {
      const companyId = typeof params.companyId === "string" ? params.companyId : undefined;
      const repoPath = (await loadSettings(companyId)).settings.gitRepoPath;
      if (!repoPath) return { state: "unconfigured" };
      return readGitLog(repoPath);
    });

    // The Issues tab: every open issue across the active companies, as a board
    ctx.data.register("issues-board", async (): Promise<IssuesBoard> => {
      const columns = KANBAN_STATUSES.map((status) => ({ status, issues: [] as BoardIssue[] }));
      const repos = new Map<string, number>();
      try {
        const rows = (await ctx.db.query(ISSUES_BOARD_SQL, [])) as Array<{
          id: string;
          identifier: string | null;
          title: string;
          status: string;
          priority: string;
          created_at: string | Date | null;
          updated_at: string | Date | null;
          assignee: string | null;
          comments: number;
          company: string;
        }>;
        for (const row of rows) {
          const repo = row.company;
          repos.set(repo, (repos.get(repo) ?? 0) + 1);
          const issue: BoardIssue = {
            id: row.id,
            identifier: row.identifier,
            title: row.title,
            status: row.status,
            priority: row.priority,
            repo,
            labels: [],
            assignee: row.assignee,
            comments: Number(row.comments ?? 0),
            createdAt: toIso(row.created_at),
            updatedAt: toIso(row.updated_at),
            url: null,
          };
          columns.find((column) => column.status === row.status)?.issues.push(issue);
        }
      } catch (error) {
        ctx.logger.warn("Could not load the issues board", { error: error instanceof Error ? error.message : String(error) });
      }
      return {
        columns,
        repos: [...repos.entries()].map(([repo, open]) => ({ repo, open })).sort((a, b) => b.open - a.open),
        problems: [],
      };
    });

    // The Activity tab's git: every repo the company's agents work in
    ctx.data.register("git-activity", async (params): Promise<GitActivity> => {
      const companyId = typeof params.companyId === "string" ? params.companyId : undefined;
      const repoPath = (await loadSettings(companyId)).settings.gitRepoPath;
      if (!repoPath) return { state: "unconfigured", repos: [] };
      const log = await readGitLog(repoPath);
      if (log.state !== "ok") return { state: "unconfigured", repos: [] };
      return {
        state: "ok",
        repos: [
          {
            repoPath: log.repoPath,
            name: log.repoPath.split("/").filter(Boolean).pop() ?? log.repoPath,
            branch: log.branch,
            changes: log.changes,
            commits: log.commits,
            problem: null,
          },
        ],
      };
    });

    const wallChartCache = new Map<string, { chart: WhiteboardChart; expiresAt: number }>();

    /**
     * Run a saved insight's query through PostHog's query API. Trends insights run without their
     * breakdown, so unique-user counts come back as one true total rather than per-domain rows
     * that would double-count people seen from more than one domain.
     */
    async function fetchInsightChart(host: string, projectId: string, insightId: string, apiKey: string): Promise<WhiteboardChart> {
      const api = `${host}/api/projects/${encodeURIComponent(projectId)}`;
      const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
      const insightResponse = await ctx.http.fetch(`${api}/insights/${encodeURIComponent(insightId)}/`, { headers });
      if (!insightResponse.ok) throw new Error(`PostHog insight ${insightId} responded ${insightResponse.status}`);
      const insight = (await insightResponse.json()) as { name?: string | null; query?: InsightQuery };
      const source = insight.query?.source ?? insight.query;
      if (!source?.kind) throw new Error(`Insight ${insightId} has no query`);

      const { breakdownFilter: _breakdown, ...unbroken } = source;
      const query = source.kind === "TrendsQuery" ? unbroken : source;
      const queryResponse = await ctx.http.fetch(`${api}/query/`, { method: "POST", headers, body: JSON.stringify({ query }) });
      if (!queryResponse.ok) throw new Error(`PostHog query for insight ${insightId} responded ${queryResponse.status}`);
      const result = (await queryResponse.json()) as { results?: unknown[]; columns?: string[] };
      const rows = result.results ?? [];

      let points: WhiteboardChart["points"];
      if (source.kind === "TrendsQuery") points = totalTrendsSeries(rows as TrendsSeries[]);
      else if (source.kind === "HogQLQuery") points = totalSqlRows(rows, result.columns ?? [], insight.query?.chartSettings);
      else throw new Error(`Insight ${insightId} is a ${source.kind}, which the wall charts can't draw`);

      return points.length >= 2
        ? { title: insight.name ?? null, points, interval: source.interval ?? null, source: "posthog" }
        : PLACEHOLDER_CHART;
    }

    /**
     * The overflow office's Stripe boards: active MRR at each of the last month-ends (and now), and
     * customers created each week. Read through Stripe's MCP server with the configured token.
     */
    async function fetchStripeCharts(url: string, token: string): Promise<Record<StripeChartKey, WhiteboardChart>> {
      const client = createMcpClient(ctx.http, url, token);
      const accounts = (await client.callTool("list_available_accounts_or_orgs", {})) as {
        accounts?: Array<{ stripe_context: string; livemode: boolean }>;
      };
      const account = accounts.accounts?.find((candidate) => candidate.livemode) ?? accounts.accounts?.[0];
      if (!account) throw new Error("The Stripe connection has no accounts");

      async function listAll<T extends { id: string }>(operation: string, parameters: Record<string, unknown>): Promise<T[]> {
        const all: T[] = [];
        for (let page = 0; page < STRIPE_MAX_PAGES; page++) {
          const last = all[all.length - 1];
          const list = (await client.callTool("stripe_api_read", {
            stripe_api_operation_id: operation,
            parameters: { ...parameters, limit: 100, ...(last ? { starting_after: last.id } : {}) },
            stripe_context: account!.stripe_context,
            livemode: account!.livemode,
          })) as StripeList<T>;
          all.push(...(list.data ?? []));
          if (!list.has_more || !list.data?.length) return all;
        }
        ctx.logger.warn("Stripe list truncated", { operation, pages: STRIPE_MAX_PAGES });
        return all;
      }

      const now = Date.now();
      const firstWeek = startOfWeek(now - (STRIPE_CUSTOMER_WEEKS - 1) * 7 * DAY_MS);
      const [subscriptions, customers] = await Promise.all([
        listAll<StripeSubscription>("GetSubscriptions", { status: "all" }),
        listAll<{ id: string; created: number }>("GetCustomers", { created: { gte: Math.floor(firstWeek.getTime() / 1000) } }),
      ]);

      // MRR in the main currency only; mixing currencies would need exchange rates.
      const currencyCounts = new Map<string, number>();
      for (const subscription of subscriptions) currencyCounts.set(subscription.currency, (currencyCounts.get(subscription.currency) ?? 0) + 1);
      const currency = [...currencyCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "usd";
      const inCurrency = subscriptions.filter((subscription) => subscription.currency === currency);
      const mrrPoints = Array.from({ length: STRIPE_MRR_MONTHS }, (_, i) => {
        const monthStart = new Date(now);
        monthStart.setUTCHours(0, 0, 0, 0);
        monthStart.setUTCDate(1);
        monthStart.setUTCMonth(monthStart.getUTCMonth() - (STRIPE_MRR_MONTHS - 1 - i));
        const nextMonth = new Date(monthStart);
        nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
        // Month-end for past months; right now for the current one.
        const at = Math.min(nextMonth.getTime() - 1, now) / 1000;
        const pence = inCurrency.filter((subscription) => payingAt(subscription, at)).reduce((sum, s) => sum + monthlyValue(s), 0);
        return { label: monthStart.toISOString().slice(0, 10), value: Math.round(pence) / 100 };
      });

      const weekPoints = Array.from({ length: STRIPE_CUSTOMER_WEEKS }, (_, i) => ({
        label: new Date(firstWeek.getTime() + i * 7 * DAY_MS).toISOString().slice(0, 10),
        value: 0,
      }));
      for (const customer of customers) {
        const index = Math.floor((customer.created * 1000 - firstWeek.getTime()) / (7 * DAY_MS));
        if (index >= 0 && index < weekPoints.length) weekPoints[index].value++;
      }

      return {
        stripeMrr: { title: "Active MRR", points: mrrPoints, interval: "month", currency, source: "stripe" },
        stripeNewCustomers: { title: "New customers", points: weekPoints, interval: "week", source: "stripe" },
      };
    }

    let stripeCache: { charts: Record<StripeChartKey, WhiteboardChart>; expiresAt: number } | null = null;

    async function loadStripeCharts(config: Record<string, unknown>, companyId: string | undefined, url: string): Promise<Record<StripeChartKey, WhiteboardChart>> {
      const placeholders = Object.fromEntries(STRIPE_CHARTS.map((key) => [key, PLACEHOLDER_CHART])) as Record<StripeChartKey, WhiteboardChart>;
      if (!config.stripeAccessToken) return placeholders;
      if (stripeCache && stripeCache.expiresAt > Date.now()) return stripeCache.charts;
      try {
        const token = await ctx.secrets.resolve(config.stripeAccessToken as Parameters<typeof ctx.secrets.resolve>[0], { companyId });
        const charts = await fetchStripeCharts(url, token as string);
        stripeCache = { charts, expiresAt: Date.now() + WHITEBOARD_CACHE_MS };
        return charts;
      } catch (error) {
        ctx.logger.warn("Could not load Stripe wall charts", { error: error instanceof Error ? error.message : String(error) });
        // Keep showing the last good charts, and don't hammer Stripe while it's failing.
        const charts = stripeCache?.charts ?? placeholders;
        stripeCache = { charts, expiresAt: Date.now() + WHITEBOARD_RETRY_MS };
        return charts;
      }
    }

    /** A board's chart from a saved PostHog insight, cached for 15 minutes (a minute after a failure). */
    async function loadInsightChart(settings: OfficeSettings, apiKey: () => Promise<string>, insightId: string, label: string): Promise<WhiteboardChart> {
      const { host, projectId } = settings.posthog;
      const cacheKey = `${host}|${projectId}|${insightId}`;
      const cached = wallChartCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.chart;
      try {
        const chart = await fetchInsightChart(host, projectId, insightId, await apiKey());
        wallChartCache.set(cacheKey, { chart, expiresAt: Date.now() + WHITEBOARD_CACHE_MS });
        return chart;
      } catch (error) {
        ctx.logger.warn("Could not load wall chart insight", { chart: label, error: error instanceof Error ? error.message : String(error) });
        // Keep showing the last good chart, and don't hammer PostHog while it's failing.
        const chart = cached?.chart ?? PLACEHOLDER_CHART;
        wallChartCache.set(cacheKey, { chart, expiresAt: Date.now() + WHITEBOARD_RETRY_MS });
        return chart;
      }
    }

    /** Resolves the PostHog key once per request, and only if a board needs it. */
    function posthogKey(config: Record<string, unknown>, companyId: string | undefined): () => Promise<string> {
      let key: Promise<string> | null = null;
      return () =>
        (key ??= ctx.secrets
          .resolve(config.posthogApiKey as Parameters<typeof ctx.secrets.resolve>[0], { companyId })
          .then((value) => value as string));
    }

    ctx.data.register("wall-charts", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : undefined;
      const config = await configFor(companyId);
      const { settings } = await loadSettings(companyId, config);
      const usesStripe = WALL_CHART_SLOTS.some((slot) => settings.wallCharts[slot].kind.startsWith("stripe"));
      const stripeCharts = usesStripe ? loadStripeCharts(config, companyId, settings.stripe.mcpUrl) : null;
      const apiKey = posthogKey(config, companyId);

      const charts = await Promise.all(WALL_CHART_SLOTS.map(async (slot): Promise<[WallChartKey, WhiteboardChart]> => {
        const source = settings.wallCharts[slot];
        let chart: WhiteboardChart = PLACEHOLDER_CHART;
        if (source.kind === "posthogInsight" && config.posthogApiKey && settings.posthog.projectId) {
          chart = await loadInsightChart(settings, apiKey, source.insightId, slot);
        } else if ((source.kind === "stripeMrr" || source.kind === "stripeNewCustomers") && stripeCharts) {
          chart = (await stripeCharts)[source.kind];
        }
        const title = source.kind !== "none" ? source.title : undefined;
        return [slot, title && chart.source !== "placeholder" ? { ...chart, title } : chart];
      }));
      return { charts: Object.fromEntries(charts) };
    });

    // The Settings tab's "Test" button: one insight, straight from PostHog, so a wrong ID shows its error
    ctx.actions.register("test-posthog-insight", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : undefined;
      const insightId = typeof params.insightId === "string" ? params.insightId.trim() : "";
      const config = await configFor(companyId);
      if (!config.posthogApiKey) throw new Error("Add a PostHog personal API key in the plugin configuration first");
      // Test against the form's unsaved host and project when given.
      const settings = normalizeSettings({ posthog: params.posthog ?? (await loadSettings(companyId, config)).settings.posthog });
      if (!settings.posthog.projectId) throw new Error("Set the PostHog project ID first");
      if (!insightId) throw new Error("Enter an insight ID");
      return { chart: await fetchInsightChart(settings.posthog.host, settings.posthog.projectId, insightId, await posthogKey(config, companyId)()) };
    });

    let loginsCache: { key: string; logins: Logins; expiresAt: number } | null = null;

    // Product logins (login page, then the dashboard) from PostHog pageviews; the UI checks once a minute
    ctx.data.register("logins", async (params): Promise<Logins> => {
      const companyId = typeof params.companyId === "string" ? params.companyId : undefined;
      const config = await configFor(companyId);
      const { host, projectId, loginsEnabled, loginPath, dashboardPath } = (await loadSettings(companyId, config)).settings.posthog;
      if (!config.posthogApiKey || !projectId || !loginsEnabled) return { live: false, recent: [] };
      const cacheKey = `${host}|${projectId}|${loginPath}|${dashboardPath}`;
      // Several open offices share one query a minute
      if (loginsCache?.key === cacheKey && loginsCache.expiresAt > Date.now()) return loginsCache.logins;
      try {
        const apiKey = await ctx.secrets.resolve(config.posthogApiKey as Parameters<typeof ctx.secrets.resolve>[0], { companyId });
        const response = await ctx.http.fetch(`${host}/api/projects/${encodeURIComponent(projectId)}/query/`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey as string}`, "Content-Type": "application/json" },
          // PostHog otherwise answers a repeat of the same query from its cache, and this one never changes
          body: JSON.stringify({ query: loginPageviewsQuery(loginPath, dashboardPath), refresh: "force_blocking" }),
        });
        if (!response.ok) throw new Error(`PostHog logins query responded ${response.status}`);
        const result = (await response.json()) as { results?: unknown[][] };
        const logins: Logins = { live: true, recent: findLogins(result.results ?? [], loginPath, dashboardPath) };
        loginsCache = { key: cacheKey, logins, expiresAt: Date.now() + LOGINS_CACHE_MS };
        return logins;
      } catch (error) {
        ctx.logger.warn("Could not load logins", { error: error instanceof Error ? error.message : String(error) });
        // Keep the last good list, so a failed check doesn't make old logins look new afterwards
        const logins = loginsCache?.key === cacheKey ? loginsCache.logins : { live: false, recent: [] };
        loginsCache = { key: cacheKey, logins, expiresAt: Date.now() + LOGINS_CACHE_MS };
        return logins;
      }
    });

    ctx.data.register("character-settings", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const agents = companyId ? await ctx.agents.list({ companyId, limit: 100, offset: 0 }) : [];

      return {
        agents: agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          status: agent.status,
          urlKey: agent.urlKey,
        })),
      };
    });
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_ID} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
