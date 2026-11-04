import { useEffect, useMemo, useRef, useState } from "react";
import { useHostContext, useHostNavigation, usePluginAction, usePluginData, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { PAGE_ROUTE } from "../manifest.js";
import {
  PixelOfficeCanvas,
  type CameraAgent,
  type KanbanNote,
  type LastRun,
  type PendingDecisions,
  type GameLeaders,
  type ScorecardData,
  type WhiteboardChart,
} from "./PixelOfficeCanvas.js";
import type { WallChartKey } from "./wallCharts.js";
import { readStoredTheme, THEME_IDS, THEMES, writeStoredTheme, type ThemeId } from "./themes.js";
import { getPluginAssetBaseUrl, type AssetIndex } from "./pixelAssets.js";
import {
  defaultWorkplace,
  onWorkplacesChanged,
  readStoredWorkplaces,
  WORKPLACE_OPTIONS,
  writeStoredWorkplaces,
} from "./workplaces.js";
import type { Workplace } from "../office/types.js";
import { readSetting, writeSetting } from "./storage.js";
import { useOfficeSettings } from "./officeSettingsData.js";
import { OfficeSettingsPanel } from "./SettingsPanel.js";
import { DoneTimeline } from "./DoneTimeline.js";
import { MAX_TOASTS, OfficeToasts, type OfficeToast } from "./OfficeToasts.js";
import { LogsPanel } from "./LogsPanel.js";
import { playCheer, playDecisionAlert, playHello } from "./sounds.js";
import { startCheer, startWave } from "../office/engine/cheer.js";
import type { Logins } from "../logins.js";
import type { IssuesDone } from "../issuesDone.js";
import { RAT_HUNT_EVERY_DONE, RatHunt } from "./RatHunt.js";
import { toggleMusic, useHostMusicListening } from "./musicListener.js";
import { GameStatus, GameTab, GameUiStyles, PixelSprite } from "./gameUi.js";
import { AboutPanel } from "./AboutPanel.js";
import { BUBBLE_DECISION_SPRITE } from "../office/sprites/spriteData.js";
import { StatsPanel } from "./StatsPanel.js";
import { stopMusic } from "./musicListener.js";
import type { GameHighScores } from "../worker.js";
import { pickDiversePalette } from "../core/paletteUtils.js";
import { FILLS_HOST_WINDOW, useHostFullscreen } from "./hostExtensions.js";

type CameraRoomData = {
  room: string;
  agents: Array<{
    id: string;
    name: string;
    source?: string | null;
    status?: string | null;
    urlKey?: string | null;
    activityKind?: "coding" | "research" | "writing" | "meeting" | "idle";
    characterIndex?: number;
    lastRun?: LastRun | null;
  }>;
};

type CharacterSettingsData = {
  agents: Array<{
    id: string;
    name: string;
    status?: string | null;
    urlKey?: string | null;
  }>;
};

type CameraId = "office" | "boardroomKitchen" | "overflowOffice";

const CAMERAS: Array<{ id: CameraId; room: string; icon: string }> = [
  { id: "office", room: "Office + Lounge", icon: "🖥️" },
  { id: "boardroomKitchen", room: "Boardroom + Games Room", icon: "☕" },
  { id: "overflowOffice", room: "Office 2 + Lounge", icon: "🛋️" },
];

const CAMERA_REFRESH_MS = 10_000;
/** Auto scan shows each camera for this long before moving on */
const AUTO_SCAN_MS = 30_000;
const AUTO_SCAN_SETTING = "autoScan";
/** The arcade and pool table tooltips show the last week's leaders, refreshed every half minute. */
const GAME_LEADERS_RANGE = "7d";
const GAME_LEADERS_REFRESH_MS = 30_000;
/** The worker caches each PostHog insight for 15 minutes; checking more often than this is wasted. */
const WHITEBOARD_REFRESH_MS = 5 * 60_000;
/** PostHog is checked for new logins once a minute */
const LOGINS_REFRESH_MS = 60_000;
/** Logins older than this when first seen (e.g. while the tab was hidden) are noted, not greeted */
const LOGIN_GREET_WITHIN_MS = 10 * 60_000;

type KanbanBoardData = {
  columns: Array<{ status: string; issues: KanbanNote[] }>;
};


type AttentionItem = {
  subject?: { title?: string | null; metadata?: { agentId?: string | null } | null } | null;
  relatedIssue?: { metadata?: { assigneeAgentId?: string | null } | null } | null;
  snoozedUntil?: string | null;
};

/**
 * What each agent is waiting on a person for, from the same attention feed as Paperclip's Decisions page.
 * Items are credited to the agent that raised them, else the agent assigned to the related issue.
 */
function usePendingDecisions(
  companyId: string | null | undefined,
  /** Called with the agents newly waiting on a decision (not on the first load, which only takes note) */
  onNewDecisions?: (decisions: Array<{ agentId: string } & PendingDecisions>) => void,
): Map<string, PendingDecisions> {
  const [pending, setPending] = useState<Map<string, PendingDecisions>>(() => new Map());
  const onNewRef = useRef(onNewDecisions);
  onNewRef.current = onNewDecisions;

  useEffect(() => {
    setPending(new Map());
    if (!companyId) return;
    let cancelled = false;
    // Agents already waiting on a decision; null until the first load, which only takes note of them
    let waiting: Set<string> | null = null;

    async function load() {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch(`/api/companies/${encodeURIComponent(companyId!)}/attention`, { credentials: "include" });
        if (!response.ok) return;
        const body = (await response.json()) as { items?: AttentionItem[] };
        const next = new Map<string, PendingDecisions>();
        const now = Date.now();
        for (const item of body.items ?? []) {
          if (item.snoozedUntil && new Date(item.snoozedUntil).getTime() > now) continue;
          const agentId = item.subject?.metadata?.agentId ?? item.relatedIssue?.metadata?.assigneeAgentId;
          if (!agentId) continue;
          const existing = next.get(agentId);
          next.set(agentId, {
            count: (existing?.count ?? 0) + 1,
            title: existing?.title ?? item.subject?.title ?? null,
          });
        }
        if (cancelled) return;
        setPending(next);
        // Chime when an agent who wasn't waiting before now needs a decision
        const fresh = waiting ? [...next].filter(([agentId]) => !waiting!.has(agentId)) : [];
        if (fresh.length) {
          playDecisionAlert();
          onNewRef.current?.(fresh.map(([agentId, decisions]) => ({ agentId, ...decisions })));
        }
        waiting = new Set(next.keys());
      } catch {
        // Hosts without the attention API: agents just never show a decision bubble.
      }
    }

    void load();
    const timer = window.setInterval(load, CAMERA_REFRESH_MS);
    // A page opened in a background tab skips its loads, so catch up as soon as it's shown
    const onVisible = () => void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [companyId]);

  return pending;
}

/**
 * Open Paperclip's New Task dialog. The plugin SDK has no API for it and the "c" shortcut can be
 * switched off, so press the host sidebar's own New Task button. Returns false if it isn't there.
 */
function openNewTaskDialog(): boolean {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("nav button")).find(
    (candidate) => candidate.getAttribute("aria-label") === "New Task" || candidate.textContent?.trim() === "New Task",
  );
  button?.click();
  return Boolean(button);
}

/** The office's decision thought bubble, without its blank bottom row, for the Agents tab */
const DECISION_BADGE = BUBBLE_DECISION_SPRITE.filter((row) => row.some(Boolean));

/** The page's nearest scrolling ancestor in the host, or null when the document itself scrolls. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * The height that lets the OfficeSim window fill the host's frame: from where the window starts (as if
 * scrolled to the top) to the bottom of the browser window.
 * Kept up to date as the browser window resizes. null when the host doesn't leave room for it.
 */
function useFrameHeight(windowRef: React.RefObject<HTMLDivElement | null>, enabled: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const measure = () => {
      const element = windowRef.current;
      if (!element) return;
      const scroller = scrollParent(element);
      const scrolled = scroller ? scroller.scrollTop : window.scrollY;
      const scrollerBottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
      const top = element.getBoundingClientRect().top + scrolled;
      const available = Math.floor(Math.min(window.innerHeight, scrollerBottom) - top - FRAME_BOTTOM_GAP_PX);
      setHeight(available >= FRAME_MIN_HEIGHT_PX ? available : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [enabled, windowRef]);
  return enabled ? height : null;
}

/** Room left under the window when it fills the host's frame */
const FRAME_BOTTOM_GAP_PX = 0;
/** Below this the window keeps its usual size rather than squashing the camera */
const FRAME_MIN_HEIGHT_PX = 480;

/** Four corners pointing out (enter full screen) or in (exit), drawn crisp to match the pixel style */
function FullscreenIcon({ exit }: { exit: boolean }) {
  const corners = exit
    ? ["M5 1v4H1", "M11 1v4h4", "M5 15v-4H1", "M11 15v-4h4"]
    : ["M1 5V1h4", "M15 5V1h-4", "M1 11v4h4", "M15 11v4h-4"];
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style={{ display: "block", shapeRendering: "crispEdges" }}>
      {corners.map((d) => (
        <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
      ))}
    </svg>
  );
}

/**
 * Previous / next camera buttons on the view's left and right edges, where there is one to go to.
 * An arrow wears the decision bubble when an agent waiting on a decision is out of view that way.
 */
function CameraArrows({
  camera,
  onSwitch,
  decisionCameras,
}: {
  camera: CameraId;
  onSwitch: (camera: CameraId) => void;
  decisionCameras: CameraId[][];
}) {
  const index = CAMERAS.findIndex((option) => option.id === camera);
  const previous = CAMERAS[index - 1];
  const next = CAMERAS[index + 1];
  const outOfView = decisionCameras.filter((cameras) => cameras.length > 0 && !cameras.includes(camera));
  const waitingThatWay = (before: boolean) =>
    outOfView.filter((cameras) =>
      cameras.some((id) => {
        const at = CAMERAS.findIndex((option) => option.id === id);
        return before ? at < index : at > index;
      }),
    ).length;
  const waitingLeft = waitingThatWay(true);
  const waitingRight = waitingThatWay(false);
  const waitingNote = (count: number) => (count ? ` · ${count === 1 ? "1 agent needs" : `${count} agents need`} a decision` : "");
  const badge = <span className="op-cam-arrow-badge"><PixelSprite sprite={DECISION_BADGE} /></span>;
  return (
    <>
      {previous ? (
        <button
          type="button"
          className="op-button op-cam-arrow"
          data-side="left"
          aria-label={`Previous camera: ${previous.room}${waitingNote(waitingLeft)}`}
          title={`Cam ${index}: ${previous.room}${waitingNote(waitingLeft)}`}
          onClick={() => onSwitch(previous.id)}
        >
          <span aria-hidden="true">◀</span>
          {waitingLeft ? badge : null}
        </button>
      ) : null}
      {next ? (
        <button
          type="button"
          className="op-button op-cam-arrow"
          data-side="right"
          aria-label={`Next camera: ${next.room}${waitingNote(waitingRight)}`}
          title={`Cam ${index + 2}: ${next.room}${waitingNote(waitingRight)}`}
          onClick={() => onSwitch(next.id)}
        >
          <span aria-hidden="true">▶</span>
          {waitingRight ? badge : null}
        </button>
      ) : null}
    </>
  );
}

function IdleOfficeToast({
  erroredAgents,
  onAddTask,
  onViewAgents,
  onDismiss,
}: {
  erroredAgents: number;
  onAddTask: () => void;
  onViewAgents: () => void;
  onDismiss: () => void;
}) {
  const hasErrors = erroredAgents > 0;
  return (
    <div
      role="status"
      className="op-window"
      style={{ position: "absolute", top: "12px", right: "12px", zIndex: 2, width: "min(380px, calc(100% - 24px))" }}
    >
      <div className="op-titlebar" style={{ fontSize: "13px" }}>
        <span>{hasErrors ? "Something's gone wrong" : "The office is quiet"}</span>
        <button type="button" className="op-close" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px" }}>
        <span aria-hidden="true" style={{ fontSize: "22px" }}>{hasErrors ? "⚠️" : "☕"}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: "13px", lineHeight: 1.3 }}>
          {hasErrors
            ? `No agents are working and ${erroredAgents === 1 ? "1 agent has an error" : `${erroredAgents} agents have errors`} that need looking into.`
            : "No agents are working. Add a task to get them moving."}
        </span>
        {hasErrors ? (
          <button type="button" className="op-button" onClick={onViewAgents}>
            View agents
          </button>
        ) : (
          <button type="button" className="op-button" onClick={onAddTask}>
            Add a task
          </button>
        )}
      </div>
    </div>
  );
}

type CharacterLook = { palette: number; hueShift: number };

/**
 * Each agent's character: the one chosen for them, else one picked automatically. Automatic picks
 * favour the least-used characters (hue-shifting repeats) and are kept for the life of the page, so
 * the office and the Agents list show the same person and switching tabs doesn't re-roll them.
 */
function useCharacterLooks(
  agents: Array<{ id: string }> | undefined,
  assignments: Record<string, number>,
  characterCount: number,
): Map<string, CharacterLook> {
  const autoPicks = useRef(new Map<string, CharacterLook>());
  return useMemo(() => {
    const looks = new Map<string, CharacterLook>();
    if (!agents || characterCount === 0) return looks;
    for (const agent of agents) {
      const chosen = assignments[agent.id];
      if (chosen !== undefined) looks.set(agent.id, { palette: chosen, hueShift: 0 });
    }
    for (const agent of agents) {
      if (looks.has(agent.id)) continue;
      let pick = autoPicks.current.get(agent.id);
      if (!pick || pick.palette >= characterCount) {
        const counts = new Array<number>(characterCount).fill(0);
        for (const look of looks.values()) if (look.palette < characterCount) counts[look.palette]++;
        pick = pickDiversePalette(characterCount, counts);
        autoPicks.current.set(agent.id, pick);
      }
      looks.set(agent.id, pick);
    }
    return looks;
  }, [agents, assignments, characterCount]);
}

function cameraPagePath(companyPrefix: string | null): string {
  return companyPrefix ? `/${companyPrefix}/${PAGE_ROUTE}` : `/${PAGE_ROUTE}`;
}

function assignmentsStorageKey(companyId: string | null): string {
  return `character-assignments.${companyId ?? "instance"}`;
}

function readStoredAssignments(companyId: string | null): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(readSetting(assignmentsStorageKey(companyId)) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] =>
        typeof entry[0] === "string" && typeof entry[1] === "number" && Number.isInteger(entry[1]) && entry[1] >= 0,
      ),
    );
  } catch {
    return {};
  }
}

function writeStoredAssignments(companyId: string | null, assignments: Record<string, number>) {
  writeSetting(assignmentsStorageKey(companyId), JSON.stringify(assignments));
}

const styles = {
  link: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 12px",
    fontSize: "13px",
    fontWeight: 500,
    textDecoration: "none",
    borderRadius: "6px",
    color: "var(--foreground)",
  } as React.CSSProperties,
  linkActive: {
    background: "var(--accent)",
  } as React.CSSProperties,
  page: {
    minHeight: "100%",
    color: "#e5e7eb",
    fontFamily: "inherit",
  } as React.CSSProperties,
  camera: {
    position: "relative",
    overflow: "hidden",
    height: "min(725px, calc(100vh - 185px))",
    minHeight: "520px",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "#1f2937",
    imageRendering: "pixelated",
  } as React.CSSProperties,
  scanlines: {
    position: "absolute",
    inset: 0,
    background: "repeating-linear-gradient(0deg, rgba(255,255,255,0.04), rgba(255,255,255,0.04) 1px, transparent 1px, transparent 4px)",
    pointerEvents: "none",
  } as React.CSSProperties,
  floor: {
    position: "absolute",
    inset: "34% 0 0",
    background: "linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), #374151",
    backgroundSize: "32px 32px",
  } as React.CSSProperties,
  desk: {
    position: "absolute",
    width: "132px",
    height: "54px",
    background: "#7c2d12",
    border: "4px solid #431407",
  } as React.CSSProperties,
  agent: {
    display: "none",
  } as React.CSSProperties,
} as const;

export function OfficeSimSidebarLink({ context }: PluginSidebarProps) {
  const href = cameraPagePath(context.companyPrefix);
  const isActive = typeof window !== "undefined" && window.location.pathname.startsWith(href);

  return (
    <a href={href} aria-current={isActive ? "page" : undefined} style={{ ...styles.link, ...(isActive ? styles.linkActive : {}) }}>
      <span aria-hidden="true">▣</span>
      OfficeSim
    </a>
  );
}

export function OfficeSimCameraPage() {
  const pageRef = useRef<HTMLElement>(null);
  /** The OfficeSim window, which the full screen button fills the screen with */
  const windowRef = useRef<HTMLDivElement>(null);
  const [elementFullscreen, setElementFullscreen] = useState(false);
  const hostFullscreen = useHostFullscreen();
  const fullscreen = hostFullscreen ? hostFullscreen.fullscreen : elementFullscreen;
  /** Outside full screen, the window fills the host's frame (the Mac app's window already fills it) */
  const frameHeight = useFrameHeight(windowRef, !FILLS_HOST_WINDOW);
  useEffect(() => {
    const onChange = () => setElementFullscreen(!!windowRef.current && document.fullscreenElement === windowRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const { companyId } = useHostContext();
  const navigation = useHostNavigation();
  const { data, loading, error, refresh } = usePluginData<CameraRoomData>("camera-room", { companyId });
  const wallCharts = usePluginData<{ charts: Partial<Record<WallChartKey, WhiteboardChart>> }>("wall-charts", { companyId });
  const kanban = usePluginData<KanbanBoardData>("kanban-board", { companyId });
  const issuesDone = usePluginData<IssuesDone>("issues-done", { companyId });
  const scorecard = usePluginData<{ scorecard: ScorecardData | null }>("scorecard", { companyId });
  const officeSettings = useOfficeSettings(companyId);
  const seatingRules = officeSettings.data?.settings.workplaces ?? null;
  const recordGame = usePluginAction("record-game");
  // A host that can hear the computer's music itself (the Mac app) does it its own way. It's set
  // up here, where the office is always on, so the DJ booth works from any tab.
  useHostMusicListening();
  // Leaving the page ends any music the DJ booth was listening to, so the browser stops sharing
  useEffect(() => stopMusic, []);
  const gameScores = usePluginData<GameHighScores>("game-high-scores", { companyId, range: GAME_LEADERS_RANGE });
  const gameScoresRefresh = useRef(gameScores.refresh);
  gameScoresRefresh.current = gameScores.refresh;
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") gameScoresRefresh.current();
    }, GAME_LEADERS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  const gameLeaders = useMemo<GameLeaders | null>(
    () =>
      gameScores.data
        ? {
            rangeLabel: "last 7 days",
            arcade: gameScores.data.leaderboards.arcade,
            potters: gameScores.data.topPotters,
            pingPong: gameScores.data.leaderboards.pingpong.map((entry) => ({ agentName: entry.agentName, wins: entry.score, lastPlayed: entry.playedAt })),
          }
        : null,
    [gameScores.data],
  );
  const kanbanColumns = useMemo(
    () => kanban.data?.columns.map((column: { issues: KanbanNote[] }) => column.issues) ?? null,
    [kanban.data],
  );
  const refreshWhiteboardRef = useRef(wallCharts.refresh);
  refreshWhiteboardRef.current = wallCharts.refresh;
  const refreshSettingsRef = useRef(officeSettings.refresh);
  refreshSettingsRef.current = officeSettings.refresh;
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refreshWhiteboardRef.current();
      // Pick up wall art and seating someone else saved
      refreshSettingsRef.current();
    }, WHITEBOARD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  // New settings can change what every board shows, so re-read them rather than wait for the next check
  const settingsKey = officeSettings.data ? JSON.stringify(officeSettings.data.settings) : null;
  const lastSettingsKey = useRef(settingsKey);
  const refreshScorecardRef = useRef(scorecard.refresh);
  refreshScorecardRef.current = scorecard.refresh;
  useEffect(() => {
    if (lastSettingsKey.current === settingsKey) return;
    const first = lastSettingsKey.current === null;
    lastSettingsKey.current = settingsKey;
    if (first) return;
    refreshWhiteboardRef.current();
    refreshScorecardRef.current();
  }, [settingsKey]);
  const [assignments, setAssignments] = useState<Record<string, number>>(() => readStoredAssignments(companyId ?? null));
  const [workplaces, setWorkplaces] = useState<Record<string, Workplace>>(() => readStoredWorkplaces(companyId ?? null));
  const [toasts, setToasts] = useState<OfficeToast[]>([]);
  const addToasts = (next: OfficeToast[]) => setToasts((current) => [...current, ...next].slice(-MAX_TOASTS));
  // Decision toasts name the agent, read from the latest poll of the office
  const agentNamesRef = useRef(new Map<string, string>());
  const pendingDecisions = usePendingDecisions(companyId, (decisions) =>
    addToasts(
      decisions.map((decision) => ({
        key: `decision:${decision.agentId}:${Date.now()}`,
        kind: "decision",
        tag: null,
        title: decision.title ?? (decision.count === 1 ? "Waiting on your decision" : `Waiting on ${decision.count} decisions`),
        detail: agentNamesRef.current.has(decision.agentId) ? `from ${agentNamesRef.current.get(decision.agentId)}` : null,
      })),
    ),
  );
  const agentsAwaitingDecisions = useMemo(
    () => [...pendingDecisions.values()].filter((decisions) => decisions.count > 0).length,
    [pendingDecisions],
  );
  const { assets: characterAssets } = useCharacterAssets();
  const looks = useCharacterLooks(data?.agents, assignments, characterAssets.length);
  const agents = useMemo(
    () =>
      (data?.agents ?? []).map((agent) => ({
        ...agent,
        characterIndex: looks.get(agent.id)?.palette,
        hueShift: looks.get(agent.id)?.hueShift,
        workplace: workplaces[agent.id] ?? defaultWorkplace(agent.name, seatingRules),
        pendingDecisions: pendingDecisions.get(agent.id) ?? null,
      })),
    [looks, workplaces, pendingDecisions, data?.agents, seatingRules],
  );
  const liveAgents = useMemo(() => new Map<string, CameraAgent>(agents.map((agent: CameraAgent) => [agent.id, agent])), [agents]);
  agentNamesRef.current = new Map(agents.map((agent: CameraAgent) => [agent.id, agent.name]));
  const [camera, setCamera] = useState<CameraId>("office");
  /** The cameras each agent waiting on a decision can be seen on, one entry per agent */
  const [decisionCameras, setDecisionCameras] = useState<CameraId[][]>([]);
  const [theme, setTheme] = useState<ThemeId>(() => readStoredTheme());
  const [view, setView] = useState<"camera" | "stats" | "logs" | "settings" | "about">("camera");
  // Panels opened at least once, kept mounted from then on
  const [openedPanels, setOpenedPanels] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (view !== "camera" && !openedPanels.has(view)) setOpenedPanels((opened) => new Set(opened).add(view));
  }, [view, openedPanels]);
  // The About panel holds no fetched state, so it's only mounted while you're looking at it
  const panelOpened = (panel: "stats" | "logs" | "settings") => view === panel || openedPanels.has(panel);
  /** The agent whose character and room are being changed (from their avatar on the Agents tab) */
  const [editingAgent, setEditingAgent] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!editingAgent) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditingAgent(null);
      // M starts and stops the music the DJ booth plays along to
      if (event.key === "m" && !event.metaKey && !event.ctrlKey && !event.altKey && !editingAgent) {
        const target = event.target as HTMLElement | null;
        if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
        event.preventDefault();
        toggleMusic();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingAgent]);
  const [autoScan, setAutoScan] = useState(() => {
    try {
      return readSetting(AUTO_SCAN_SETTING) === "on";
    } catch {
      return false;
    }
  });
  // A rat hunt over the camera, every RAT_HUNT_EVERY_DONE tasks done
  const [ratHunt, setRatHunt] = useState<{ id: number; reason: string | null } | null>(null);
  function startRatHunt(reason: string | null) {
    setView("camera");
    setRatHunt({ id: Date.now(), reason });
  }
  // It runs over the camera: leaving for another tab ends it
  useEffect(() => {
    if (view !== "camera") setRatHunt(null);
  }, [view]);

  // Auto scan moves through each camera then the Agents tab, a while on each; any change of view
  // restarts the wait, and it holds still while an agent's character or the settings are being
  // edited, or during a rat hunt
  useEffect(() => {
    if (!autoScan || editingAgent || view === "settings" || ratHunt) return;
    const timer = window.setTimeout(() => {
      const index = CAMERAS.findIndex((option) => option.id === camera);
      // Back to the first camera from the Agents tab (or Activity, which the scan doesn't visit)
      if (view !== "camera") {
        setView("camera");
        setCamera(CAMERAS[0].id);
      } else if (index === CAMERAS.length - 1) {
        setView("stats");
      } else {
        setCamera(CAMERAS[index + 1].id);
      }
    }, AUTO_SCAN_MS);
    return () => window.clearTimeout(timer);
  }, [autoScan, view, camera, editingAgent, ratHunt]);

  function toggleAutoScan() {
    const next = !autoScan;
    setAutoScan(next);
    try {
      writeSetting(AUTO_SCAN_SETTING, next ? "on" : "off");
    } catch {
      // Storage unavailable: the choice just isn't remembered
    }
  }
  const officeIdle = Boolean(data?.agents.length) && !data!.agents.some((agent) => agent.status === "running" || agent.lastRun?.active);
  const erroredAgents = data?.agents.filter((agent) => agent.status === "error").length ?? 0;
  const [idleToastDismissed, setIdleToastDismissed] = useState(false);
  // A dismissal lasts until the office next gets busy, so the nudge returns when it goes quiet again.
  useEffect(() => {
    if (!officeIdle) setIdleToastDismissed(false);
  }, [officeIdle]);
  // A new error is worth surfacing even if the quiet-office nudge was dismissed.
  useEffect(() => {
    if (erroredAgents > 0) setIdleToastDismissed(false);
  }, [erroredAgents]);

  useEffect(() => {
    setAssignments(readStoredAssignments(companyId ?? null));
    setWorkplaces(readStoredWorkplaces(companyId ?? null));
    return onWorkplacesChanged(() => setWorkplaces(readStoredWorkplaces(companyId ?? null)));
  }, [companyId]);

  // The whole office cheers (out loud too) whenever an issue is done. Issues already done when the
  // page loads, or when switching company, are only noted, not cheered.
  const seenDoneRef = useRef<{ companyId: string | null; ids: Set<string> } | null>(null);
  useEffect(() => {
    const recent = issuesDone.data?.recent;
    if (!recent) return;
    const seen = seenDoneRef.current;
    if (!seen || seen.companyId !== (companyId ?? null)) {
      seenDoneRef.current = { companyId: companyId ?? null, ids: new Set(recent.map((issue) => issue.id)) };
      return;
    }
    const fresh = recent.filter((issue) => !seen.ids.has(issue.id));
    for (const issue of fresh) seen.ids.add(issue.id);
    if (fresh.length) {
      startCheer();
      playCheer();
      // Oldest first, so the newest lands at the bottom of the stack
      addToasts(
        fresh.reverse().map((issue) => ({
          key: `done:${issue.id}`,
          kind: "done",
          tag: issue.identifier,
          title: issue.title,
          detail: issue.doneBy ? `by ${issue.doneBy}` : null,
        })),
      );
    }
  }, [issuesDone.data, companyId]);

  // When the company's done count reaches a multiple of RAT_HUNT_EVERY_DONE, the rats come out. The
  // count when the page loads, or when switching company, is only noted.
  const doneTotalRef = useRef<{ companyId: string | null; total: number } | null>(null);
  useEffect(() => {
    const total = issuesDone.data?.total;
    if (total === undefined) return;
    const last = doneTotalRef.current;
    doneTotalRef.current = { companyId: companyId ?? null, total };
    if (!last || last.companyId !== (companyId ?? null) || total <= last.total) return;
    // The highest multiple reached since the last count (several can land between polls)
    const milestone = Math.floor(total / RAT_HUNT_EVERY_DONE) * RAT_HUNT_EVERY_DONE;
    if (milestone > last.total) startRatHunt(`${milestone} tasks done. The rats smelled the cake!`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startRatHunt only sets state
  }, [issuesDone.data, companyId]);

  // The office waves and says hello when someone logs in to the product. Logins already seen on
  // the first live check, or when switching company, are only noted.
  const logins = usePluginData<Logins>("logins", { companyId });
  const loginsRefresh = useRef(logins.refresh);
  loginsRefresh.current = logins.refresh;
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") loginsRefresh.current();
    }, LOGINS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  const seenLoginsRef = useRef<{ companyId: string | null; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!logins.data?.live) return;
    const recent = logins.data.recent;
    const seen = seenLoginsRef.current;
    if (!seen || seen.companyId !== (companyId ?? null)) {
      seenLoginsRef.current = { companyId: companyId ?? null, ids: new Set(recent.map((login) => login.id)) };
      return;
    }
    const fresh = recent.filter((login) => !seen.ids.has(login.id));
    for (const login of fresh) seen.ids.add(login.id);
    const greet = fresh.filter((login) => Date.now() - new Date(login.at).getTime() < LOGIN_GREET_WITHIN_MS);
    if (greet.length) greetLogins(greet.reverse().map((login) => login.id));
  }, [logins.data, companyId]);

  /** Everyone waves and says hello, with a toast per login (oldest first) */
  function greetLogins(ids: string[]) {
    startWave();
    playHello();
    addToasts(ids.map((id) => ({ key: `login:${id}`, kind: "login", tag: null, title: "Someone has logged in", detail: null })));
  }

  // usePluginData fetches once; poll so agent status and active runs stay live.
  const refreshRef = useRef(refresh);
  refreshRef.current = () => {
    refresh();
    kanban.refresh();
    scorecard.refresh();
    issuesDone.refresh();
  };
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshRef.current();
    }, CAMERA_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  /** The agent's character as the office draws it. */
  function renderCharacter(agentId: string) {
    const look = looks.get(agentId);
    const asset = look ? characterAssets[look.palette] : undefined;
    return asset ? <SpritePreview url={asset.url} scale={2} hueShift={look!.hueShift} /> : null;
  }

  /** Open an issue by its identifier (e.g. "DEL-123") or id. */
  function openIssue(issue: string, newTab: boolean) {
    const path = `/issues/${encodeURIComponent(issue)}`;
    if (newTab) window.open(navigation.resolveHref(path), "_blank", "noopener");
    else navigation.navigate(path);
  }

  function openAgent(agent: CameraAgent, newTab: boolean) {
    const path = `/agents/${encodeURIComponent(agent.urlKey ?? agent.id)}`;
    if (newTab) window.open(navigation.resolveHref(path), "_blank", "noopener");
    else navigation.navigate(path);
  }

  useEffect(() => {
    const hostSlot = pageRef.current?.parentElement;
    const hostBackRow = hostSlot?.previousElementSibling as HTMLElement | null;
    const hostWrapper = hostSlot?.parentElement as HTMLElement | null;
    const previousDisplay = hostBackRow?.style.display;
    const previousGap = hostWrapper?.style.gap;

    if (hostBackRow?.textContent?.includes("Back")) hostBackRow.style.display = "none";
    if (hostWrapper) hostWrapper.style.gap = "0";

    return () => {
      if (hostBackRow && previousDisplay !== undefined) hostBackRow.style.display = previousDisplay;
      if (hostWrapper && previousGap !== undefined) hostWrapper.style.gap = previousGap;
    };
  }, []);

  function toggleFullscreen() {
    if (hostFullscreen) hostFullscreen.toggle();
    else if (document.fullscreenElement) void document.exitFullscreen();
    else void windowRef.current?.requestFullscreen().catch(() => {
      // Refused (e.g. blocked by the browser); the window just stays as it is
    });
  }

  function addTask() {
    if (!openNewTaskDialog()) navigation.navigate("/issues");
  }

  return (
    <main ref={pageRef} style={styles.page} className={FILLS_HOST_WINDOW ? "op-root op-root-fill" : "op-root"}>
      <GameUiStyles />
      <div
        className={
          FILLS_HOST_WINDOW
            ? "op-window op-window-main op-window-fill"
            : frameHeight !== null
              ? "op-window op-window-main op-window-frame"
              : "op-window op-window-main"
        }
        style={frameHeight !== null && !elementFullscreen ? { height: frameHeight } : undefined}
        ref={windowRef}
      >
        <OfficeToasts
          toasts={toasts}
          onExpire={(key) => setToasts((current) => current.filter((toast) => toast.key !== key))}
          onOpen={(toast, newTab) => {
            if (toast.kind === "login") setToasts((current) => current.filter((other) => other.key !== toast.key));
            else if (toast.kind === "done") openIssue(toast.tag ?? toast.key.slice("done:".length), newTab);
            else if (newTab) window.open(navigation.resolveHref("/decisions"), "_blank", "noopener");
            else navigation.navigate("/decisions");
          }}
        />
        <header className="op-titlebar">
          <span>
            OfficeSim{" "}
            <span className="op-titlebar-sub">
              ·{" "}
              {view === "stats"
                ? "Agents"
                : view === "logs"
                  ? "Activity"
                  : view === "settings"
                    ? "Settings"
                    : view === "about"
                      ? "About"
                      : `${CAMERAS.find((option) => option.id === camera)?.room} Camera`}
            </span>
          </span>
          <span className="op-titlebar-actions">
          <button
            type="button"
            className="op-titlebar-button"
            aria-pressed={fullscreen}
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
            title={fullscreen ? "Exit full screen" : "Full screen"}
            onClick={toggleFullscreen}
          >
            <FullscreenIcon exit={fullscreen} />
          </button>
          </span>
        </header>
        <div className="op-toolbar">
          <nav className="op-tabs" aria-label="Views">
            {CAMERAS.map((option, index) => (
              <GameTab
                key={option.id}
                icon={option.icon}
                label={`Cam ${index + 1}`}
                title={option.room}
                pressed={view === "camera" && camera === option.id}
                onClick={() => {
                  setView("camera");
                  setCamera(option.id);
                }}
              />
            ))}
            <GameTab
              icon="🤖"
              label="Agents"
              title={
                agentsAwaitingDecisions
                  ? `${agentsAwaitingDecisions === 1 ? "1 agent needs" : `${agentsAwaitingDecisions} agents need`} a decision`
                  : undefined
              }
              pressed={view === "stats"}
              onClick={() => setView("stats")}
              badge={agentsAwaitingDecisions ? <PixelSprite sprite={DECISION_BADGE} /> : undefined}
            />
            <GameTab icon="📜" label="Activity" title="Done tasks and the git log" pressed={view === "logs"} onClick={() => setView("logs")} />
            <GameTab
              icon="⚙️"
              label="Settings"
              title="Wall charts, wall art, scorecard, seating and characters"
              pressed={view === "settings"}
              onClick={() => setView("settings")}
            />
            <GameTab
              icon="🦙"
              label="About"
              title="Proudly shareware — say hello to the llama"
              pressed={view === "about"}
              onClick={() => setView("about")}
            />
          </nav>
          <div className="op-controls">
            <DoneTimeline data={issuesDone.data ?? null} />
            <button type="button" className="op-button op-button-new" onClick={addTask}>
              ＋ New task
            </button>
            <button
              type="button"
              className="op-button op-button-toggle"
              aria-pressed={autoScan}
              title={autoScan ? "Auto scan is on: moving through the cameras and Agents every 30 seconds" : "Move through the cameras and Agents every 30 seconds"}
              onClick={toggleAutoScan}
            >
              <span className="op-lamp" data-state={autoScan ? "live" : "idle"} aria-hidden="true" />
              Auto scan
            </button>
            <label className="op-dropdown">
              <select
                aria-label="Visual style"
                value={theme}
                onChange={(event) => {
                  const next = event.target.value as ThemeId;
                  setTheme(next);
                  writeStoredTheme(next);
                }}
              >
                {THEME_IDS.map((id) => (
                  <option key={id} value={id}>
                    {THEMES[id].label}
                  </option>
                ))}
              </select>
            </label>
            {/* `loading` is also true during each background poll, so only the first load counts as connecting. */}
            <GameStatus state={error ? "offline" : loading && !data ? "connecting" : "live"} />
          </div>
        </div>
        <div className="op-body">
          {/* The Agents and Activity panels stay mounted (hidden) once opened, so coming back to one shows
              its last numbers straight away while it refreshes */}
          {panelOpened("stats") ? (
            <div hidden={view !== "stats"}>
              <StatsPanel
                active={view === "stats"}
                companyId={companyId ?? null}
                onAgentClick={(agentId) => navigation.navigate(`/agents/${encodeURIComponent(agentId)}`)}
                onAvatarClick={setEditingAgent}
                renderCharacter={renderCharacter}
                liveAgents={liveAgents}
                workplaceFor={(agent) => {
                  const workplace = workplaces[agent.id] ?? defaultWorkplace(agent.name, seatingRules);
                  return WORKPLACE_OPTIONS.find((option) => option.value === workplace)?.label ?? workplace;
                }}
              />
            </div>
          ) : null}
          {panelOpened("logs") ? (
            <div hidden={view !== "logs"}>
              <LogsPanel companyId={companyId ?? null} onIssueClick={openIssue} active={view === "logs"} />
            </div>
          ) : null}
          {view === "about" ? <AboutPanel /> : null}
          {panelOpened("settings") ? (
            <div hidden={view !== "settings"} className="op-settings">
              <OfficeSettingsPanel companyId={companyId ?? null}>
                <section className="op-settings-characters">
                  <h3>Characters</h3>
                  <CharacterAssignmentsPanel
                    companyId={companyId ?? null}
                    assignments={assignments}
                    onAssignmentsChange={setAssignments}
                  />
                </section>
              </OfficeSettingsPanel>
            </div>
          ) : null}
          {view !== "camera" ? null : (
            <section aria-label="OfficeSim office camera" className="op-viewport" style={{ ...styles.camera, border: undefined }}>
              <PixelOfficeCanvas
                camera={camera}
                agents={agents.length ? agents : [{ id: "placeholder", name: "No agents yet", status: "waiting", activityKind: "idle" }]}
                onAgentClick={openAgent}
                wallCharts={wallCharts.data?.charts ?? null}
                kanbanColumns={kanbanColumns}
                onIssueClick={(note, newTab) => openIssue(note.identifier ?? note.id, newTab)}
                theme={theme}
                scorecard={scorecard.data?.scorecard ?? null}
                onScorecardClick={openIssue}
                onDecisionCamerasChange={setDecisionCameras}
                gameLeaders={gameLeaders}
                wallArt={officeSettings.data?.settings.wallArt ?? null}
                onGameUpdate={({ game, gameId, agentId, score, won }) => {
                  if (!companyId) return;
                  recordGame({ companyId, agentId, game, gameId, score, won: won === true }).catch(() => {
                    // A lost score isn't worth interrupting the office for.
                  });
                }}
              />
              <div style={styles.scanlines} />
              <CameraArrows camera={camera} onSwitch={setCamera} decisionCameras={decisionCameras} />
              {ratHunt ? <RatHunt key={ratHunt.id} reason={ratHunt.reason} onEnd={() => setRatHunt(null)} /> : null}
              {officeIdle && !idleToastDismissed ? (
                <IdleOfficeToast
                  erroredAgents={erroredAgents}
                  onAddTask={addTask}
                  onViewAgents={() => setView("stats")}
                  onDismiss={() => setIdleToastDismissed(true)}
                />
              ) : null}
            </section>
          )}
        </div>
        {/* Inside the window, so it still shows when the window is full screen */}
        {editingAgent ? (
          <div className="op-dialog-backdrop" onClick={() => setEditingAgent(null)}>
            <div
              className="op-window op-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={`${editingAgent.name}'s character and room`}
              onClick={(event) => event.stopPropagation()}
            >
              <header className="op-titlebar">
                <span>
                  Character <span className="op-titlebar-sub">· {editingAgent.name}</span>
                </span>
                <button type="button" className="op-close" aria-label="Close" onClick={() => setEditingAgent(null)}>
                  ×
                </button>
              </header>
              <div className="op-dialog-body">
                <AgentCharacterEditor
                  companyId={companyId ?? null}
                  agent={editingAgent}
                  assignments={assignments}
                  assets={characterAssets}
                  onAssignmentsChange={setAssignments}
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function useCharacterAssets() {
  const [assets, setAssets] = useState<Array<{ index: number; path: string; url: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let baseUrl = "";
    getPluginAssetBaseUrl()
      .then((resolved) => {
        baseUrl = resolved;
        return fetch(`${baseUrl}officesim-assets.json`);
      })
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch character index: ${res.status}`);
        return res.json() as Promise<AssetIndex>;
      })
      .then((index) => {
        if (cancelled) return;
        setAssets(index.characters.map((path, index) => ({ index, path, url: `${baseUrl}${path}` })));
        setError(null);
      })
      .catch((nextError: unknown) => {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { assets, error };
}

function SpritePreview({ url, scale = 2, hueShift = 0 }: { url: string; scale?: number; hueShift?: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 16 * scale,
        height: 32 * scale,
        backgroundImage: `url(${url})`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "0 0",
        backgroundSize: `${16 * scale * 7}px ${32 * scale * 3}px`,
        imageRendering: "pixelated",
        filter: hueShift ? `hue-rotate(${hueShift}deg)` : undefined,
      }}
    />
  );
}

/** Each agent's room: the stored choices, kept in step across the page, and a setter */
function useWorkplaces(companyId: string | null) {
  const [stored, setStored] = useState<Record<string, Workplace>>(() => readStoredWorkplaces(companyId));
  const rules = useOfficeSettings(companyId).data?.settings.workplaces ?? null;
  useEffect(() => {
    setStored(readStoredWorkplaces(companyId));
    return onWorkplacesChanged(() => setStored(readStoredWorkplaces(companyId)));
  }, [companyId]);

  function workplaceFor(agent: { id: string; name: string }): Workplace {
    return stored[agent.id] ?? defaultWorkplace(agent.name, rules);
  }

  function updateWorkplace(agent: { id: string; name: string }, workplace: Workplace) {
    const next = { ...stored };
    // Only store choices that differ from the settings' default
    if (workplace === defaultWorkplace(agent.name, rules)) delete next[agent.id];
    else next[agent.id] = workplace;
    writeStoredWorkplaces(companyId, next);
    setStored(next);
  }

  return { workplaceFor, updateWorkplace };
}

/**
 * One agent's look and room: where they work, and which character they appear as (pick one, try a
 * random one, then save; or reset to an automatic pick).
 */
function AgentCharacterEditor({
  companyId,
  agent,
  assignments,
  onAssignmentsChange,
  assets,
}: {
  companyId: string | null;
  agent: { id: string; name: string };
  assignments: Record<string, number>;
  /** Called with every agent's saved characters after a save or reset */
  onAssignmentsChange: (assignments: Record<string, number>) => void;
  assets: Array<{ index: number; path: string; url: string }>;
}) {
  const { workplaceFor, updateWorkplace } = useWorkplaces(companyId);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const selectedIndex = assignments[agent.id];
  const visibleIndex = draftIndex ?? selectedIndex;

  useEffect(() => {
    setDraftIndex(null);
  }, [agent.id, selectedIndex]);

  function updateAssignment(characterIndex: number | null) {
    const next = { ...assignments };
    if (characterIndex === null) delete next[agent.id];
    else next[agent.id] = characterIndex;
    writeStoredAssignments(companyId, next);
    onAssignmentsChange(next);
  }

  function randomIndex(): number | null {
    if (assets.length === 0) return null;
    const used = new Set(Object.values(assignments));
    const open = assets.filter((asset) => !used.has(asset.index) || asset.index === selectedIndex);
    const pool = open.length > 0 ? open : assets;
    return pool[Math.floor(Math.random() * pool.length)]?.index ?? null;
  }

  return (
    <section style={{ display: "grid", gap: "12px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "12px", alignItems: "center" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "15px", fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.name}</div>
          <div style={{ fontSize: "12px", opacity: 0.7 }}>
            {visibleIndex !== undefined && visibleIndex !== null ? `Selected char_${visibleIndex}` : "Using automatic sprite"}
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
          <label style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "12px" }}>
            <span style={{ opacity: 0.7 }}>Works in</span>
            <select
              value={workplaceFor(agent)}
              onChange={(event) => updateWorkplace(agent, event.target.value as Workplace)}
              style={{ padding: "6px 8px", borderRadius: 4, border: "1px solid rgba(148,163,184,0.35)", background: "var(--background, #111827)", color: "inherit", fontFamily: "inherit" }}
            >
              {WORKPLACE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={draftIndex === null}
            onClick={() => updateAssignment(draftIndex)}
            style={{ padding: "7px 10px", borderRadius: 4, border: "1px solid rgba(148,163,184,0.35)", background: "rgba(59,130,246,0.22)", color: "inherit", fontFamily: "inherit", cursor: draftIndex === null ? "default" : "pointer" }}
          >
            Save
          </button>
          <button
            type="button"
            disabled={assets.length === 0}
            onClick={() => {
              const next = randomIndex();
              if (next !== null) setDraftIndex(next);
            }}
            style={{ padding: "7px 10px", borderRadius: 4, border: "1px solid rgba(148,163,184,0.35)", background: "transparent", color: "inherit", fontFamily: "inherit", cursor: "pointer" }}
          >
            Random
          </button>
          {selectedIndex !== undefined ? (
            <button
              type="button"
              onClick={() => updateAssignment(null)}
              style={{ padding: "7px 10px", borderRadius: 4, border: "1px solid rgba(148,163,184,0.35)", background: "transparent", color: "inherit", fontFamily: "inherit", cursor: "pointer" }}
            >
              Reset
            </button>
          ) : null}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(58px, 1fr))",
          gap: "8px",
          maxHeight: "min(610px, 60vh)",
          overflow: "auto",
          padding: "10px",
          border: "1px solid rgba(148,163,184,0.25)",
          borderRadius: 6,
          background: "rgba(15,23,42,0.3)",
        }}
      >
        {assets.map((asset) => (
          <button
            key={asset.path}
            type="button"
            onClick={() => setDraftIndex(asset.index)}
            title={asset.path.replace("characters/", "").replace(".png", "")}
            style={{
              height: 82,
              display: "grid",
              placeItems: "center",
              border: asset.index === visibleIndex ? "2px solid #60a5fa" : "1px solid rgba(148,163,184,0.25)",
              borderRadius: 6,
              background: asset.index === visibleIndex ? "rgba(59,130,246,0.2)" : "rgba(148,163,184,0.08)",
              cursor: "pointer",
            }}
          >
            <SpritePreview url={asset.url} scale={2} />
          </button>
        ))}
      </div>
    </section>
  );
}

/** Every agent's look and room: the agent list beside the editor (in the Settings tab). */
function CharacterAssignmentsPanel({
  companyId,
  assignments,
  onAssignmentsChange,
}: {
  companyId: string | null;
  assignments?: Record<string, number>;
  onAssignmentsChange?: (assignments: Record<string, number>) => void;
}) {
  const { data, loading, error, refresh } = usePluginData<CharacterSettingsData>("character-settings", companyId ? { companyId } : {});
  const { assets, error: assetError } = useCharacterAssets();
  const [storedAssignments, setStoredAssignments] = useState<Record<string, number>>(() => assignments ?? readStoredAssignments(companyId));
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const { workplaceFor } = useWorkplaces(companyId);

  useEffect(() => {
    setStoredAssignments(assignments ?? readStoredAssignments(companyId));
  }, [assignments, companyId]);

  if (loading) return <div style={{ padding: 24, fontSize: 13 }}>Loading OfficeSim settings...</div>;
  if (error) return <div style={{ padding: 24, fontSize: 13 }}>Settings failed: {error.message}</div>;

  const agents = data?.agents ?? [];
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null;

  return (
    <section style={{ padding: "18px", display: "grid", gap: "14px", color: "var(--foreground)", background: "var(--background, #111827)", border: "1px solid rgba(255,255,255,0.14)", fontFamily: "inherit" }}>
      {assetError ? <div style={{ fontSize: "13px", color: "var(--destructive, #ef4444)" }}>{assetError}</div> : null}

      <div style={{ display: "grid", gridTemplateColumns: "280px minmax(0, 1fr)", gap: "16px", alignItems: "start" }}>
        <aside style={{ border: "1px solid rgba(148,163,184,0.25)", borderRadius: 6, overflow: "hidden", background: "rgba(15,23,42,0.35)" }}>
          <div style={{ padding: "12px", fontSize: "18px", fontWeight: 800, borderBottom: "1px solid rgba(148,163,184,0.25)" }}>Agents</div>
          <div style={{ maxHeight: "610px", overflow: "auto" }}>
            {agents.map((agent) => {
              const assigned = storedAssignments[agent.id];
              const assignedAsset = assets[assigned] ?? null;
              const isSelected = selectedAgent?.id === agent.id;
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setSelectedAgentId(agent.id)}
                  style={{
                    width: "100%",
                    display: "grid",
                    gridTemplateColumns: "1fr 42px",
                    gap: "8px",
                    alignItems: "center",
                    padding: "9px 10px",
                    border: 0,
                    borderBottom: "1px solid rgba(148,163,184,0.16)",
                    background: isSelected ? "rgba(59,130,246,0.18)" : "transparent",
                    color: "inherit",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: "13px", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {agent.name}
                    </span>
                    <span style={{ display: "block", fontSize: "11px", opacity: 0.65 }}>
                      {assignedAsset ? `char_${assigned}` : "Auto"} · {WORKPLACE_OPTIONS.find((option) => option.value === workplaceFor(agent))?.label}
                    </span>
                  </span>
                  <span style={{ width: 36, height: 48, display: "grid", placeItems: "center", background: "rgba(148,163,184,0.12)", borderRadius: 4 }}>
                    {assignedAsset ? <SpritePreview url={assignedAsset.url} scale={1.5} /> : <span style={{ fontSize: 10, opacity: 0.65 }}>Auto</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {selectedAgent ? (
          <AgentCharacterEditor
            companyId={companyId}
            agent={selectedAgent}
            assignments={storedAssignments}
            assets={assets}
            onAssignmentsChange={(next) => {
              setStoredAssignments(next);
              onAssignmentsChange?.(next);
              refresh();
            }}
          />
        ) : (
          <div style={{ fontSize: 13, opacity: 0.7 }}>No agents</div>
        )}
      </div>
    </section>
  );
}
