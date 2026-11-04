import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePluginAction, usePluginData, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { readSetting, writeSetting } from "./storage.js";
import type { AgentStats, Game, GameHighScores, LeisureStats, StatsRange } from "../worker.js";
import { HarnessMark, RunTooltip, timeAgo, type CameraAgent } from "./PixelOfficeCanvas.js";

/** The agents panel's time range, remembered across visits */
const RANGE_SETTING = "stats-range";

function readStoredRange(): StatsRange {
  try {
    const stored = readSetting(RANGE_SETTING);
    if (stored && RANGES.some((option) => option.id === stored)) return stored as StatsRange;
  } catch {
    // Storage unavailable: use the default
  }
  return "7d";
}

const RANGES: Array<{ id: StatsRange; label: string }> = [
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
];

const STATS_REFRESH_MS = 60_000;

/** Work is runs, issues and tokens; leisure is the games agents play on their downtime. */
type Mode = "work" | "leisure";
const MODES: Array<{ id: Mode; label: string; icon: string }> = [
  { id: "work", label: "Work", icon: "💼" },
  { id: "leisure", label: "Leisure", icon: "🕹️" },
];

type SortKey = "name" | "status" | "model" | "lastRun" | "issuesDone" | "activeSeconds" | "tokens" | keyof LeisureStats;
type Sort = { key: SortKey; descending: boolean };
const DEFAULT_SORTS: Record<Mode, Sort> = {
  work: { key: "activeSeconds", descending: true },
  leisure: { key: "arcadeBest", descending: true },
};

const NO_GAMES: LeisureStats = { arcadeGames: 0, arcadeBest: 0, poolGames: 0, ballsPotted: 0, pingPongGames: 0, pingPongWins: 0 };

/**
 * `usePluginAction` throws a `PluginBridgeError` (a plain object with `{code, message, details}`),
 * not a real `Error` instance, so `String(err)` and `err.message` can land on "[object Object]".
 * Pull out the message — and the most useful `details` field if there is one — so toasts show real text.
 */
function describeError(error: unknown): string {
  if (error == null) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);
  const obj = error as { code?: unknown; message?: unknown; details?: unknown };
  const parts: string[] = [];
  if (typeof obj.message === "string" && obj.message.length > 0) parts.push(obj.message);
  if (obj.details && typeof obj.details === "object") {
    const details = obj.details as Record<string, unknown>;
    const reason = typeof details.reason === "string" ? details.reason : null;
    const cooldown = typeof details.cooldownMs === "number" ? details.cooldownMs
      : typeof details.cooldown === "number" ? details.cooldown
      : null;
    if (reason) parts.push(reason);
    if (cooldown != null) parts.push(`Try again in ${Math.ceil(cooldown / 1000)}s`);
  } else if (typeof obj.details === "string" && obj.details.length > 0) {
    parts.push(obj.details);
  }
  if (parts.length === 0 && typeof obj.code === "string") parts.push(`Error: ${obj.code}`);
  return parts.length > 0 ? parts.join(" — ") : "Unknown error";
}

/** How each game is scored, for the high-score boards. */
const GAME_INFO: Record<Game, { title: string; unit: (score: number) => string; how: string }> = {
  arcade: {
    title: "Arcade high score",
    unit: () => "pts",
    how: "Space invaders: 10–30 points an invader, 100 for clearing a wave. One game ends when the fleet lands, the cannon is hit or the player walks away.",
  },
  pool: {
    title: "Pool high score",
    unit: (score) => (score === 1 ? "ball" : "balls"),
    how: "Balls potted in one visit to the table.",
  },
  pingpong: {
    title: "Ping pong champion",
    unit: (score) => (score === 1 ? "win" : "wins"),
    how: "Matches won: first to 7 points, by 2 clear. A match a player walks away from counts as played but not won.",
  },
};

/**
 * Agent statuses, in the order the Status column sorts them. "decision" isn't a Paperclip status:
 * it stands in for any other while the agent is waiting on someone's decision.
 */
const STATUS_ORDER = ["decision", "running", "error", "paused", "idle"];
const STATUS_LABELS: Record<string, string> = {
  decision: "Needs decision",
  running: "Working",
  error: "Error",
  paused: "Paused",
  idle: "Idle",
};

type Hover = { agentId: string; x: number; y: number };

/** Input plus output; cached input is left out of the headline numbers but shown in the breakdown. */
const totalTokens = (agent: Pick<AgentStats, "inputTokens" | "outputTokens">) => agent.inputTokens + agent.outputTokens;

/** A model's name without its provider (Paperclip and OpenCode name them "provider/model"). */
function modelLabel(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "—";
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

export function formatTokens(tokens: number): string {
  if (tokens <= 0) return "—";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(tokens);
}

function tokenBreakdown(agent: Pick<AgentStats, "inputTokens" | "cachedInputTokens" | "outputTokens">): string {
  const full = new Intl.NumberFormat("en");
  return `Input ${full.format(agent.inputTokens)} · Cached input ${full.format(agent.cachedInputTokens)} · Output ${full.format(agent.outputTokens)}`;
}

export function StatsPanel({
  companyId,
  onAgentClick,
  onAvatarClick,
  renderCharacter,
  workplaceFor,
  liveAgents,
  active = true,
}: {
  companyId: string | null;
  /** Whether the panel is showing. It stays mounted while hidden, keeping its numbers to show straight
   * away when it comes back; it doesn't poll while hidden, and refreshes when shown again. */
  active?: boolean;
  onAgentClick: (agentId: string) => void;
  /** Called when an agent's avatar is clicked, to change their character and room. */
  onAvatarClick: (agent: { id: string; name: string }) => void;
  /** The agent's sprite, or null if it isn't known. */
  renderCharacter: (agentId: string) => ReactNode;
  /** The name of the room the agent works in. */
  workplaceFor: (agent: { id: string; name: string }) => string;
  /** The office's live view of each agent (polled every few seconds), for status and the hover card. */
  liveAgents: Map<string, CameraAgent>;
}) {
  const [range, setRange] = useState<StatsRange>(readStoredRange);
  const [mode, setMode] = useState<Mode>("work");
  // Each mode keeps its own sort, since their columns differ.
  const [sorts, setSorts] = useState(DEFAULT_SORTS);
  const sort = sorts[mode];
  const { data, loading, error, refresh } = usePluginData<{ range: StatsRange; agents: AgentStats[] }>("agent-stats", { companyId, range });
  const games = usePluginData<GameHighScores>("game-high-scores", { companyId, range });
  const leisureByAgent = games.data?.leisureByAgent;
  const leisureOf = (agentId: string) => leisureByAgent?.[agentId] ?? NO_GAMES;
  const startRun = usePluginAction("start-agent-run");
  const showToast = usePluginToast();

  const refreshRef = useRef(() => {
    refresh();
    games.refresh();
  });
  refreshRef.current = () => {
    refresh();
    games.refresh();
  };
  const shownRef = useRef(active);
  useEffect(() => {
    if (!active) return;
    // Coming back to the tab: refresh behind the numbers it's still showing
    if (!shownRef.current) refreshRef.current();
    shownRef.current = true;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshRef.current();
    }, STATS_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      shownRef.current = false;
    };
  }, [active]);

  const [hover, setHover] = useState<Hover | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Agent IDs with an in-progress start-run click, so the button shows a spinner and the next poll
  // doesn't blank out the row before the run lands.
  const [starting, setStarting] = useState<Record<string, true>>({});
  // Agent IDs in the post-click cooldown: the host has accepted the invoke but the heartbeat
  // hasn't reported the new run yet. The button stays disabled with a "Spinning up" label until
  // either the agent's status flips to "running" or the 10-second grace expires.
  const [spinningUp, setSpinningUp] = useState<Record<string, true>>({});
  // Timers that clear the spinningUp entries; tracked so we can cancel them on unmount.
  const spinningTimersRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const timers = spinningTimersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  async function handleStartRun(agent: AgentStats) {
    if (!companyId) return;
    setStarting((current) => ({ ...current, [agent.id]: true }));
    // Keep the spinner visible for at least this long, so even a fast host doesn't make the
    // click look like nothing happened.
    const MIN_SPINNER_MS = 350;
    const SPIN_UP_WINDOW_MS = 10_000;
    const spinnerStartedAt = Date.now();
    try {
      const result = (await startRun({
        companyId,
        agentId: agent.id,
        reason: "Manual run from OfficeSim",
      })) as { runId?: string } | undefined;
      showToast({
        dedupeKey: `run-started:${agent.id}`,
        title: `Run started for ${agent.name}`,
        body: result?.runId ? `Run ${result.runId.slice(0, 8)} is warming up.` : undefined,
        tone: "success",
        ttlMs: 4000,
      });
      // Lock the button for the spin-up window. A later status poll will replace this with the
      // agent's real "running" state; if the host never reports a run, the timer clears the lock
      // and a final refresh shows the truth.
      setSpinningUp((current) => ({ ...current, [agent.id]: true }));
      const existingTimer = spinningTimersRef.current.get(agent.id);
      if (existingTimer) window.clearTimeout(existingTimer);
      const timer = window.setTimeout(() => {
        spinningTimersRef.current.delete(agent.id);
        setSpinningUp((current) => {
          if (!(agent.id in current)) return current;
          const next = { ...current };
          delete next[agent.id];
          return next;
        });
        // Time's up: poll the agent's row so the status column reflects whatever the host has.
        refreshRef.current();
      }, SPIN_UP_WINDOW_MS);
      spinningTimersRef.current.set(agent.id, timer);
    } catch (error) {
      const message = describeError(error);
      showToast({
        dedupeKey: `run-failed:${agent.id}`,
        title: `Couldn't start a run for ${agent.name}`,
        body: message,
        tone: "error",
        ttlMs: 6000,
      });
      console.warn("Could not start a run for", agent.name, error);
    } finally {
      const elapsed = Date.now() - spinnerStartedAt;
      const wait = Math.max(0, MIN_SPINNER_MS - elapsed);
      window.setTimeout(() => {
        setStarting((current) => {
          if (!(agent.id in current)) return current;
          const next = { ...current };
          delete next[agent.id];
          return next;
        });
      }, wait);
    }
  }

  // The office's data refreshes more often than the stats, so prefer it for what's happening now.
  const agents = useMemo(
    () =>
      (data?.agents ?? []).map((agent) => {
        const live = liveAgents.get(agent.id);
        const liveFinishedAt = live?.lastRun && !live.lastRun.active ? live.lastRun.finishedAt : null;
        const lastRunFinishedAt =
          liveFinishedAt && (!agent.lastRunFinishedAt || liveFinishedAt > agent.lastRunFinishedAt) ? liveFinishedAt : agent.lastRunFinishedAt;
        const status = live?.pendingDecisions?.count ? "decision" : (live?.status ?? agent.status);
        return { ...agent, status, decisions: live?.pendingDecisions ?? null, lastRunFinishedAt };
      }),
    [data?.agents, liveAgents],
  );
  // The Run column only shows when some agent can be started (in the Mac app, none can yet)
  const showRun = agents.some((agent) => agent.canStart !== false);

  // If the host reports the agent as "running" (or any other state that already locks the button)
  // during the spin-up window, end the lock early so the button reflects the real status.
  useEffect(() => {
    for (const agent of agents) {
      if (spinningUp[agent.id] !== true) continue;
      if (agent.status === "running" || agent.status === "paused" || agent.decisions?.count) {
        const timer = spinningTimersRef.current.get(agent.id);
        if (timer) {
          window.clearTimeout(timer);
          spinningTimersRef.current.delete(agent.id);
        }
        setSpinningUp((current) => {
          if (!(agent.id in current)) return current;
          const next = { ...current };
          delete next[agent.id];
          return next;
        });
      }
    }
  }, [agents, spinningUp]);
  const totals = useMemo(
    () =>
      agents.reduce(
        (sum, agent) => ({
          issuesDone: sum.issuesDone + agent.issuesDone,
          activeSeconds: sum.activeSeconds + agent.activeSeconds,
          inputTokens: sum.inputTokens + agent.inputTokens,
          cachedInputTokens: sum.cachedInputTokens + agent.cachedInputTokens,
          outputTokens: sum.outputTokens + agent.outputTokens,
        }),
        { issuesDone: 0, activeSeconds: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      ),
    [agents],
  );
  // Over every agent who played, including any since removed from the list.
  const leisureTotals = useMemo(
    () =>
      Object.values(leisureByAgent ?? {}).reduce(
        (sum, games) => ({
          arcadeGames: sum.arcadeGames + games.arcadeGames,
          arcadeBest: Math.max(sum.arcadeBest, games.arcadeBest),
          poolGames: sum.poolGames + games.poolGames,
          ballsPotted: sum.ballsPotted + games.ballsPotted,
          pingPongGames: sum.pingPongGames + (games.pingPongGames ?? 0),
          pingPongWins: sum.pingPongWins + (games.pingPongWins ?? 0),
        }),
        NO_GAMES,
      ),
    [leisureByAgent],
  );
  const maxSeconds = Math.max(1, ...agents.map((agent) => agent.activeSeconds));

  const sorted = useMemo(() => {
    const value = (agent: AgentStats): number | string => {
      switch (sort.key) {
        case "name":
          return agent.name.toLowerCase();
        case "status": {
          // Descending (the default) puts running agents first.
          const rank = STATUS_ORDER.indexOf(agent.status);
          return -(rank === -1 ? STATUS_ORDER.length : rank);
        }
        case "model":
          // Agents without one sort last going up
          return agent.model ? modelLabel(agent.model).toLowerCase() : "\uffff";
        case "lastRun":
          return agent.lastRunFinishedAt ? new Date(agent.lastRunFinishedAt).getTime() : 0;
        case "tokens":
          return totalTokens(agent);
        case "arcadeGames":
        case "arcadeBest":
        case "poolGames":
        case "ballsPotted":
        case "pingPongGames":
        case "pingPongWins":
          return leisureByAgent?.[agent.id]?.[sort.key] ?? 0;
        default:
          return agent[sort.key];
      }
    };
    return [...agents].sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const order = x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name);
      return sort.descending ? -order : order;
    });
  }, [agents, sort, leisureByAgent]);

  function sortBy(key: SortKey) {
    setSorts((current) => ({
      ...current,
      [mode]: current[mode].key === key ? { key, descending: !current[mode].descending } : { key, descending: key !== "name" },
    }));
  }

  function trackHover(agentId: string, event: React.MouseEvent) {
    const bounds = panelRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setHover({ agentId, x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  }

  const hoveredAgent = hover ? liveAgents.get(hover.agentId) : undefined;

  function header(key: SortKey, label: string) {
    const active = sort.key === key;
    return (
      <button
        type="button"
        className="op-colhead"
        aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}
        onClick={() => sortBy(key)}
      >
        {label}
        {active ? <span aria-hidden="true">{sort.descending ? " ▼" : " ▲"}</span> : null}
      </button>
    );
  }

  // Keep showing the previous range's numbers while the next loads, so the panel doesn't blank out.
  const stale = loading && data?.range !== range;
  const gamesStale = games.loading && games.data?.range !== range;
  const count = (n: number) => (n ? n.toLocaleString("en") : "—");

  return (
    <div className="op-stats" ref={panelRef}>
      <div className="op-stats-top">
        <div className="op-segment" role="group" aria-label="Time frame">
          {RANGES.map((option) => (
            <button
              key={option.id}
              type="button"
              className="op-button"
              aria-pressed={range === option.id}
              onClick={() => {
                setRange(option.id);
                try {
                  writeSetting(RANGE_SETTING, option.id);
                } catch {
                  // Storage unavailable: the choice just lasts until reload
                }
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="op-segment" role="group" aria-label="Show">
          {MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              className="op-button op-button-icon"
              aria-pressed={mode === option.id}
              aria-label={option.label}
              title={option.label}
              onClick={() => setMode(option.id)}
            >
              <span aria-hidden="true">{option.icon}</span>
            </button>
          ))}
        </div>
        {mode === "leisure" ? (
          <div className="op-stats-totals" style={{ opacity: gamesStale ? 0.55 : 1 }}>
            <div className="op-readout">
              <span className="op-readout-label">Arcade games</span>
              <span className="op-readout-value">{leisureTotals.arcadeGames.toLocaleString("en")}</span>
            </div>
            <div className="op-readout">
              <span className="op-readout-label">Pool games</span>
              <span className="op-readout-value">{leisureTotals.poolGames.toLocaleString("en")}</span>
            </div>
            <div className="op-readout">
              <span className="op-readout-label">Balls potted</span>
              <span className="op-readout-value">{leisureTotals.ballsPotted.toLocaleString("en")}</span>
            </div>
            <div className="op-readout">
              <span className="op-readout-label">Ping pong games</span>
              <span className="op-readout-value">{leisureTotals.pingPongGames.toLocaleString("en")}</span>
            </div>
          </div>
        ) : (
          <div className="op-stats-totals">
            <div className="op-readout">
              <span className="op-readout-label">Tasks complete</span>
              <span className="op-readout-value">{totals.issuesDone.toLocaleString("en")}</span>
            </div>
            <div className="op-readout">
              <span className="op-readout-label">Time active</span>
              <span className="op-readout-value">{formatDuration(totals.activeSeconds)}</span>
            </div>
            <div className="op-readout" title={tokenBreakdown(totals)}>
              <span className="op-readout-label">Tokens</span>
              <span className="op-readout-value">{formatTokens(totalTokens(totals))}</span>
            </div>
          </div>
        )}
      </div>

      {mode === "leisure" ? (
        <div className="op-highscores" style={{ opacity: gamesStale ? 0.55 : 1 }}>
          {(Object.keys(GAME_INFO) as Game[]).map((game) => (
            <HighScoreBoard
              key={game}
              game={game}
              scores={games.data?.leaderboards[game] ?? []}
              rangeLabel={RANGES.find((option) => option.id === range)?.label.toLowerCase() ?? ""}
              renderCharacter={renderCharacter}
              onAgentClick={onAgentClick}
            />
          ))}
        </div>
      ) : null}

      <div className="op-list" data-mode={mode} data-run={showRun ? undefined : "hidden"} aria-busy={mode === "leisure" ? gamesStale : stale}>
        <div className="op-list-row op-list-head">
          {header("name", "Agent")}
          {showRun ? <span className="op-colhead" aria-hidden="true">Run</span> : null}
          {header("status", "Status")}
          {mode === "leisure" ? (
            <>
              {header("arcadeGames", "Arcade games")}
              {header("arcadeBest", "Arcade top score")}
              {header("poolGames", "Pool games")}
              {header("ballsPotted", "Balls potted")}
              {header("pingPongGames", "Ping pong games")}
              {header("pingPongWins", "Ping pong wins")}
            </>
          ) : (
            <>
              {header("model", "Model")}
              {header("lastRun", "Last run")}
              {header("issuesDone", "Tasks complete")}
              {header("activeSeconds", "Time active")}
              {header("tokens", "Tokens")}
            </>
          )}
        </div>
        <div className="op-list-body" style={{ opacity: (mode === "leisure" ? gamesStale : stale) ? 0.55 : 1 }}>
          {error ? (
            <div className="op-list-empty">Stats unavailable: {error.message}</div>
          ) : !data && loading ? (
            <div className="op-list-empty">Loading…</div>
          ) : sorted.length === 0 ? (
            <div className="op-list-empty">No agents yet</div>
          ) : (
            sorted.map((agent) => {
              const tokens = totalTokens(agent);
              const leisure = leisureOf(agent.id);
              const idle =
                mode === "leisure"
                  ? leisure.arcadeGames === 0 && leisure.poolGames === 0 && !leisure.pingPongGames
                  : agent.issuesDone === 0 && agent.activeSeconds === 0 && tokens === 0;
              // The host throws if invoke is called on a paused/terminated/pending_approval agent,
              // so disable the button in those cases plus while a run is already in flight or
              // during the 10-second spin-up window after a successful invoke.
              const runDisabled = Boolean(
                !companyId ||
                  starting[agent.id] === true ||
                  spinningUp[agent.id] === true ||
                  agent.status === "running" ||
                  agent.status === "paused" ||
                  agent.decisions?.count,
              );
              const runTitle = !companyId
                ? "Pick a company first"
                : starting[agent.id]
                  ? "Starting run…"
                  : spinningUp[agent.id]
                    ? "Spinning up"
                    : agent.status === "running"
                      ? "Already working"
                      : agent.status === "paused"
                        ? "Paused — resume to start a run"
                        : agent.decisions?.count
                          ? "Waiting on a decision"
                          : `Start a new run for ${agent.name}`;
              return (
                <div
                  key={agent.id}
                  className="op-list-row"
                  data-idle={idle || undefined}
                  onMouseMove={(event) => trackHover(agent.id, event)}
                  onMouseLeave={() => setHover(null)}
                >
                  <span className="op-agent">
                    <button
                      type="button"
                      className="op-avatar op-avatar-button"
                      title={`Change ${agent.name}'s character and room`}
                      aria-label={`Change ${agent.name}'s character and room`}
                      onClick={() => onAvatarClick(agent)}
                    >
                      {renderCharacter(agent.id)}
                    </button>
                    <button type="button" className="op-link op-agent-text" onClick={() => onAgentClick(agent.id)}>
                      <span className="op-agent-name">
                        <HarnessMark source={agent.source} />
                        {agent.name}
                      </span>
                      <span className="op-agent-room">{workplaceFor(agent)}</span>
                    </button>
                  </span>
                  {showRun ? (
                    <span className="op-run-cell">
                      {agent.canStart === false ? null : (
                        <button
                          type="button"
                          className="op-run-button"
                          aria-label={runTitle}
                          title={runTitle}
                          disabled={runDisabled}
                          aria-busy={starting[agent.id] === true || undefined}
                          onClick={() => handleStartRun(agent)}
                        >
                          <span aria-hidden="true">{starting[agent.id] ? "…" : "▶"}</span>
                        </button>
                      )}
                    </span>
                  ) : null}
                  <span
                    className="op-status-cell"
                    title={
                      agent.decisions?.count
                        ? `${agent.decisions.count === 1 ? "1 decision" : `${agent.decisions.count} decisions`} waiting${agent.decisions.title ? `: ${agent.decisions.title}` : ""}`
                        : undefined
                    }
                  >
                    <span className="op-lamp" data-state={agent.status} />
                    {STATUS_LABELS[agent.status] ?? agent.status.replace(/_/g, " ")}
                  </span>
                  {mode === "leisure" ? (
                    <>
                      <span className="op-num">{count(leisure.arcadeGames)}</span>
                      <span className="op-num">{count(leisure.arcadeBest)}</span>
                      <span className="op-num">{count(leisure.poolGames)}</span>
                      <span className="op-num">{count(leisure.ballsPotted)}</span>
                      <span className="op-num">{count(leisure.pingPongGames ?? 0)}</span>
                      <span className="op-num">{count(leisure.pingPongWins ?? 0)}</span>
                    </>
                  ) : (
                    <>
                      <span className="op-model-cell" title={agent.model ?? undefined}>
                        {agent.model ? modelLabel(agent.model) : "—"}
                      </span>
                      <span
                        className="op-num"
                        title={agent.lastRunFinishedAt ? new Date(agent.lastRunFinishedAt).toLocaleString() : undefined}
                      >
                        {timeAgo(agent.lastRunFinishedAt) ?? "Never"}
                      </span>
                      <span className="op-num">{agent.issuesDone ? agent.issuesDone.toLocaleString("en") : "—"}</span>
                      <span className="op-num op-bar-cell" title={agent.runs ? `${agent.runs.toLocaleString("en")} runs` : undefined}>
                        <span className="op-bar" style={{ width: `${(agent.activeSeconds / maxSeconds) * 100}%` }} />
                        <span className="op-bar-label">{formatDuration(agent.activeSeconds)}</span>
                      </span>
                      <span className="op-num" title={tokens ? tokenBreakdown(agent) : undefined}>
                        {formatTokens(tokens)}
                      </span>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
      {hover && hoveredAgent ? (
        <RunTooltip
          agent={hoveredAgent}
          x={hover.x}
          y={hover.y}
          bounds={panelRef.current?.getBoundingClientRect() ?? null}
          clickable
        />
      ) : null}
      <div className="op-stats-note">
        {mode === "leisure"
          ? "Games count when they start; a pool game is one visit to the table, a ping pong game one match. Games are recorded by open office views, so games nobody was watching aren't counted."
          : "Time active is total run time, so overlapping runs each count. Tokens are input plus output, not cached input; hover a number for the breakdown."}
      </div>
    </div>
  );
}

/** One game's top scores in the time frame, champion first. */
function HighScoreBoard({
  game,
  scores,
  rangeLabel,
  renderCharacter,
  onAgentClick,
}: {
  game: Game;
  scores: GameHighScores["leaderboards"][Game];
  rangeLabel: string;
  renderCharacter: (agentId: string) => ReactNode;
  onAgentClick: (agentId: string) => void;
}) {
  const info = GAME_INFO[game];
  const [champion, ...rest] = scores;
  return (
    <div className="op-highscore" title={info.how}>
      <div className="op-readout-label">
        {info.title} · {rangeLabel}
      </div>
      {!champion ? (
        <div className="op-highscore-empty">No games played yet</div>
      ) : (
        <>
          <button type="button" className="op-link op-agent" onClick={() => onAgentClick(champion.agentId)}>
            <span className="op-avatar">{renderCharacter(champion.agentId)}</span>
            <span className="op-agent-text">
              <span className="op-readout-value">
                {champion.score.toLocaleString("en")} <span className="op-highscore-unit">{info.unit(champion.score)}</span>
              </span>
              <span className="op-agent-name">{champion.agentName ?? "Former agent"}</span>
              <span className="op-agent-room" title={champion.playedAt ? new Date(champion.playedAt).toLocaleString() : undefined}>
                {timeAgo(champion.playedAt) ?? ""}
              </span>
            </span>
          </button>
          {rest.length ? (
            <ol className="op-highscore-rest" start={2}>
              {rest.map((entry, i) => (
                <li key={`${entry.agentId}-${entry.playedAt ?? i}`}>
                  <span className="op-highscore-name">{entry.agentName ?? "Former agent"}</span>
                  <span className="op-num">{entry.score.toLocaleString("en")}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      )}
    </div>
  );
}
