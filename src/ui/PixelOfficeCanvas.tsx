import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { CHARACTER_SITTING_OFFSET_PX } from "../constants.js";
import { TILE_SIZE, type Character, type Workplace } from "../office/types.js";
import { OfficeState } from "../office/engine/officeState.js";
import { isSeated } from "../office/engine/characters.js";
import { startGameLoop } from "../office/engine/gameLoop.js";
import {
  kanbanNoteAt,
  renderFrame,
  setKanbanColumns,
  setKanbanHighlight,
  setScorecard,
  setScorecardHighlight,
  scorecardAt,
  setTerminalColors,
  setWhiteboardHighlight,
  setWhiteboardSeries,
  whiteboardChartAt,
} from "../office/engine/renderer.js";
import { useRunOutput } from "./runOutput.js";
import { WALL_CHART_BOARDS, type WallChartKey } from "./wallCharts.js";
import { buildThemedMap, renderThemeAmbient, renderThemeTrim, type ThemedMap } from "./themeRender.js";
import { THEMES, type RoomKey, type ThemeId } from "./themes.js";
import { activateThemeTiles, themeHasWalls } from "./themeTiles.js";
import { getThemeFurniture, getThemeScreenColors } from "./themeFurniture.js";
import { setFurnitureOverrides, setFurnitureUidOverrides } from "../office/engine/furnitureOverrides.js";
import type { SpriteData } from "../office/types.js";
import type { WallArt } from "../officeSettings.js";
import { loadWallArtSprite, wallArtSlots } from "./wallArt.js";
import { useOfficeSettingsActions } from "./officeSettingsData.js";
import { pourAtStation, setGameListener, type LeisureGame } from "../office/engine/leisureEffects.js";
import { DJ_BOOTH_TYPE, DJ_SPEAKER_TYPE } from "../office/engine/djBooth.js";
import { toggleMusic, useMusicStatus, type MusicStatus } from "./musicListener.js";
import { type CameraBounds, loadPixelAssets } from "./pixelAssets.js";
import {
  readOfficeSnapshot,
  SNAPSHOT_POSITIONS_FRESH_MS,
  SNAPSHOT_SAVE_MS,
  writeOfficeSnapshot,
} from "./officeSnapshot.js";
import { harnessIcon } from "./hostExtensions.js";
import { drawRats, setRatViewport, updateRats } from "../office/engine/rats.js";

export type LastRun = {
  runId: string;
  status: string;
  active: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  lastOutputAt: string | null;
  lastOutputBytes?: number | null;
  summary: string | null;
  error: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
};

export type PendingDecisions = {
  count: number;
  title: string | null;
};

export type WhiteboardChart = {
  title: string | null;
  points: Array<{ label: string; value: number }>;
  /** Trends interval ("week", "month", …) when known, for labelling points. */
  interval?: string | null;
  /** ISO currency code when values are money (in major units, e.g. pounds). */
  currency?: string | null;
  /** Where the numbers came from; the board shows a placeholder climb for "placeholder". */
  source: "posthog" | "stripe" | "placeholder";
};

export type ScorecardData = {
  title: string | null;
  overall: "green" | "yellow" | "red";
  sections: Array<{ name: string; status: "green" | "yellow" | "red"; metric: string }>;
  priorities: string[];
  issueIdentifier: string | null;
  postedAt: string | null;
};

export type KanbanNote = {
  id: string;
  identifier: string | null;
  title: string;
  priority: string;
  /** Name of the agent with a run in progress on this issue, if any. */
  workingAgent?: string | null;
  /** Name of the assigned agent, if an agent is assigned. */
  assigneeAgent?: string | null;
  /** True when a person (e.g. the board) is assigned rather than an agent. */
  assignedToUser?: boolean;
};

/** Boardroom kanban columns, left to right. */
const KANBAN_COLUMN_LABELS = ["Backlog", "To do", "In progress", "In review", "Blocked"];
/** Each column's header-strip colour, as drawn on the KANBAN_BOARD sprite. */
const KANBAN_COLUMN_COLORS = ["#9aa0a6", "#4dabf7", "#fab005", "#9775fa", "#fa5252"];
const KANBAN_BOARD_TYPE = "KANBAN_BOARD";
const WHITEBOARD_TYPE = "WHITEBOARD";
const SCORECARD_BOARD_TYPE = "SCORECARD_BOARD";

export type CameraAgent = {
  id: string;
  name: string;
  /** The harness the agent runs in (e.g. "claude"), when the host knows; shown as an icon before its name. */
  source?: string | null;
  status?: string | null;
  urlKey?: string | null;
  activityKind?: "coding" | "research" | "writing" | "meeting" | "idle";
  characterIndex?: number;
  /** Hue rotation in degrees for the character sprite; only used with characterIndex. */
  hueShift?: number;
  lastRun?: LastRun | null;
  pendingDecisions?: PendingDecisions | null;
  workplace?: Workplace;
};

type Viewport = { offsetX: number; offsetY: number; zoom: number };
type Hover = { characterId: number; x: number; y: number };
/** The scorecard board; `section` is the hovered row, or null for the board as a whole. */
type ScorecardHover = { section: number | null; x: number; y: number };
/** The arcade machine, a pool table or the ping pong table */
type GameHover = { game: "arcade" | "pool" | "pingpong"; x: number; y: number };

/** Leaderboards for the arcade and pool table tooltips, over one time frame. */
export type GameLeaders = {
  /** e.g. "last 7 days" */
  rangeLabel: string;
  arcade: Array<{ agentName: string | null; score: number; playedAt: string | null }>;
  potters: Array<{ agentName: string | null; ballsPotted: number; poolGames: number }>;
  /** Most ping pong matches won */
  pingPong: Array<{ agentName: string | null; wins: number; lastPlayed: string | null }>;
};

/** Loaded harness icons by URL, drawn before agents' names once they've loaded. */
const harnessIconImages = new Map<string, HTMLImageElement>();

/** An agent's harness icon, ready to draw, or null (none, or still loading). */
function harnessIconImage(source: string | null | undefined): HTMLImageElement | null {
  const icon = harnessIcon(source);
  if (!icon) return null;
  let image = harnessIconImages.get(icon.src);
  if (!image) {
    image = new Image();
    image.src = icon.src;
    harnessIconImages.set(icon.src, image);
  }
  return image.complete && image.naturalWidth > 0 ? image : null;
}

/** Harness icons sit on a light tile, so dark ones (Paperclip's black paperclip) read on the dark office. */
const HARNESS_TILE_COLOR = "#f4f4f5";

/** An agent's harness icon before its name in the tooltip and the Agents tab. */
export function HarnessMark({ source, size = 12 }: { source: string | null | undefined; size?: number }) {
  const icon = harnessIcon(source);
  if (!icon) return null;
  return (
    <img
      src={icon.src}
      alt={icon.label}
      title={icon.label}
      width={size}
      height={size}
      style={{ verticalAlign: "-2px", marginRight: 5, flex: "none", padding: 1, borderRadius: 3, background: HARNESS_TILE_COLOR }}
    />
  );
}

/** Agents' name labels on the canvas, in the page's monospace */
const NAME_LABEL_FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const ARCADE_TYPE_PREFIX = "ARCADE_MACHINE";
/** Drinks stations pour when clicked */
const DRINK_STATION_TYPES = new Set(["COFFEE_MACHINE", "WATER_COOLER"]);
const POOL_TABLE_TYPE_PREFIX = "POOL_TABLE";
const PING_PONG_TABLE_TYPE = "PING_PONG_TABLE";
const CLOCK_TYPE = "CLOCK";
/** A post-it on the kanban board; `overflow` is the "and more" dot standing in for issues from `index` on. */
type NoteHover = { column: number; index: number; overflow: boolean; x: number; y: number };
/** A whiteboard chart (by furniture uid); `bar` is the hovered column's index in its series, or null elsewhere on it. */
type ChartHover = { uid: string; bar: number | null; x: number; y: number };

type PixelOfficeCanvasProps = {
  agents: CameraAgent[];
  camera: "office" | "boardroomKitchen" | "overflowOffice";
  /** Called when an agent is clicked; `newTab` for cmd/ctrl/middle-click. */
  onAgentClick?: (agent: CameraAgent, newTab: boolean) => void;
  /** Charts for the whiteboards that show them; a board shows a placeholder climb when its chart is absent or not live. */
  wallCharts?: Partial<Record<WallChartKey, WhiteboardChart>> | null;
  /** Open issues per boardroom kanban column (backlog → blocked), most urgent first. */
  kanbanColumns?: KanbanNote[][] | null;
  /** Called when a kanban post-it is clicked; `newTab` for cmd/ctrl/middle-click. */
  onIssueClick?: (note: KanbanNote, newTab: boolean) => void;
  /** Visual theme for floors, walls, furniture colours and lighting. */
  theme?: ThemeId;
  /** The latest business scorecard, for the boardroom's traffic-light board. */
  scorecard?: ScorecardData | null;
  /** Called when the scorecard board is clicked, to open the issue it was posted on. */
  onScorecardClick?: (issueIdentifier: string, newTab: boolean) => void;
  /** Leaderboards shown when hovering the arcade machine and pool tables. */
  gameLeaders?: GameLeaders | null;
  /** The company's own pictures for wall frames, by furniture uid (from the office settings). */
  wallArt?: Record<string, WallArt> | null;
  /**
   * Called (when it changes) with the cameras each agent waiting on a decision can be seen on,
   * one entry per agent, so the page can point to ones out of view.
   */
  onDecisionCamerasChange?: (cameras: CameraKey[][]) => void;
  /** Called when an agent starts a game at the arcade, pool or ping pong table (score 0), and again when it ends. */
  onGameUpdate?: (update: { game: LeisureGame; gameId: string; agentId: string; score: number; won?: boolean }) => void;
};

type CameraKey = PixelOfficeCanvasProps["camera"];
/** How often to recheck which cameras show the agents waiting on decisions */
const DECISION_CAMERA_CHECK_MS = 1000;

function stableNumericId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

/** Hit box around the visible part of a 16x32 sprite, anchored bottom-centre at (ch.x, ch.y). */
function hitTest(characters: Iterable<Character>, worldX: number, worldY: number): Character | null {
  let best: Character | null = null;
  for (const ch of characters) {
    const bottom = ch.y + (isSeated(ch) ? CHARACTER_SITTING_OFFSET_PX : 0);
    if (Math.abs(worldX - ch.x) > 6 || worldY > bottom || worldY < bottom - 28) continue;
    // Prefer the character drawn in front (lower on screen).
    if (!best || ch.y > best.y) best = ch;
  }
  return best;
}

export function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function duration(startIso: string | null, endIso: string | null): string | null {
  if (!startIso || !endIso) return null;
  const seconds = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000);
  if (seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Names and tooltip copy for agents waiting on someone to decide something. */
const DECISION_COLOR = "#22d3ee";

const RUN_STATUS_COLORS: Record<string, string> = {
  running: "#60a5fa",
  succeeded: "#4ade80",
  failed: "#f87171",
  timed_out: "#fbbf24",
  cancelled: "#9ca3af",
};

/** Keeps a tooltip inside the camera: it flips left of the cursor near the right edge. */
function tooltipPosition(x: number, y: number, width: number, bounds: DOMRect | null) {
  return {
    left: bounds && x + 16 + width > bounds.width ? Math.max(8, x - 16 - width) : x + 16,
    top: Math.max(8, y - 12),
  };
}

const TOOLTIP_STYLE: React.CSSProperties = {
  position: "absolute",
  padding: "10px 12px",
  background: "rgba(10, 14, 22, 0.94)",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 6,
  boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
  color: "#e5e7eb",
  fontSize: 12,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
  pointerEvents: "none",
  zIndex: 5,
};

/**
 * Dates by interval: "Sep 2026" for months, "week of 28 Sep" for weeks, "28 Sep" for days.
 * Without an interval, first-of-month dates read as months. Other labels are shown as they are.
 */
function formatChartLabel(label: string, interval: string | null | undefined): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(label)) return label;
  const date = new Date(`${label.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return label;
  const unit = interval ?? (date.getUTCDate() === 1 ? "month" : "day");
  if (unit === "month") return date.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  const day = date.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  return unit === "week" ? `week of ${day}` : day;
}

/** "▲ 25%" / "▼ 4.5%" relative to the previous value; a rise from nothing has no percentage. */
function describeChange(change: number, previous: number): string {
  if (change === 0) return "No change";
  const arrow = change > 0 ? "▲" : "▼";
  if (previous === 0) return `${arrow} up`;
  const percent = Math.abs((change / Math.abs(previous)) * 100);
  return `${arrow} ${percent.toLocaleString(undefined, { maximumFractionDigits: percent < 10 ? 1 : 0 })}%`;
}

const RAG_LABELS = { green: "On track", yellow: "Watch", red: "Off track" } as const;
const RAG_DOTS = { green: "#51cf66", yellow: "#ffd43b", red: "#ff4d4d" } as const;

function RagDot({ status }: { status: keyof typeof RAG_DOTS }) {
  return <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: RAG_DOTS[status], marginRight: 6 }} />;
}

function ScorecardTooltip({ hover, scorecard, bounds, clickable }: { hover: ScorecardHover; scorecard: ScorecardData | null; bounds: DOMRect | null; clickable: boolean }) {
  const section = hover.section !== null ? scorecard?.sections[hover.section] : undefined;
  // The whole-board view lists each section's key stat, so it needs the extra room
  const width = section || !scorecard ? 280 : 360;
  return (
    <div role="tooltip" style={{ ...TOOLTIP_STYLE, ...tooltipPosition(hover.x, hover.y, width, bounds), width }}>
      {!scorecard ? (
        <div>No business scorecard has been posted yet.</div>
      ) : section ? (
        <>
          <strong style={{ color: "#f9fafb" }}><RagDot status={section.status} />{section.name}</strong>
          <div style={{ marginTop: 4, color: RAG_DOTS[section.status] }}>{RAG_LABELS[section.status]}</div>
          {section.metric ? <div style={{ marginTop: 4 }}>{section.metric}</div> : null}
        </>
      ) : (
        <>
          <strong style={{ color: "#f9fafb" }}><RagDot status={scorecard.overall} />{scorecard.title ?? "Business scorecard"}</strong>
          <div style={{ marginTop: 4, color: RAG_DOTS[scorecard.overall] }}>Overall: {RAG_LABELS[scorecard.overall]}</div>
          <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 10px", fontSize: 11 }}>
            {scorecard.sections.map((s) => (
              <Fragment key={s.name}>
                <div style={{ whiteSpace: "nowrap" }}><RagDot status={s.status} />{s.name}</div>
                <div style={{ opacity: 0.8 }}>{s.metric}</div>
              </Fragment>
            ))}
          </div>
          {scorecard.priorities.length ? (
            <div style={{ marginTop: 6, fontSize: 11 }}>
              <div style={{ opacity: 0.6 }}>Top priorities</div>
              {scorecard.priorities.slice(0, 3).map((p, i) => (
                <div key={i} style={{ marginTop: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{i + 1}. {p}</div>
              ))}
            </div>
          ) : null}
        </>
      )}
      {scorecard ? (
        <div style={{ marginTop: 6, fontSize: 11, opacity: 0.5 }}>
          {scorecard.issueIdentifier ? `From ${scorecard.issueIdentifier}` : "From an issue comment"}
          {scorecard.postedAt ? ` · ${timeAgo(scorecard.postedAt)}` : ""}
          {clickable && scorecard.issueIdentifier ? " · click to open" : ""}
        </div>
      ) : null}
    </div>
  );
}

function ChartTooltip({ hover, chart, bounds }: { hover: ChartHover; chart: WhiteboardChart | null; bounds: DOMRect | null }) {
  const width = 240;
  const live = !!chart && chart.source !== "placeholder" && chart.points.length >= 2;
  const format = (value: number) =>
    chart?.currency
      ? value.toLocaleString(undefined, { style: "currency", currency: chart.currency.toUpperCase(), maximumFractionDigits: 0 })
      : value.toLocaleString();
  const points = live ? chart.points : [];
  const index = hover.bar ?? points.length - 1;
  const point = points[index];
  const previous = points[index - 1];
  const change = point && previous ? point.value - previous.value : null;
  return (
    <div role="tooltip" style={{ ...TOOLTIP_STYLE, ...tooltipPosition(hover.x, hover.y, width, bounds), width }}>
      <strong style={{ color: "#f9fafb" }}>{live ? chart.title ?? "Whiteboard chart" : "Whiteboard chart"}</strong>
      {point ? (
        <div style={{ marginTop: 6 }}>
          <span style={{ color: "#8ce99a", fontSize: 14, fontWeight: 600 }}>{format(point.value)}</span>
          <span style={{ opacity: 0.7 }}> in {formatChartLabel(point.label, chart?.interval)}</span>
          {change !== null ? (
            <div style={{ fontSize: 11, opacity: 0.7 }}>
              {describeChange(change, previous.value)} from {formatChartLabel(previous.label, chart?.interval)}
            </div>
          ) : null}
        </div>
      ) : null}
      <div style={{ marginTop: 6, fontSize: 11, opacity: 0.5 }}>
        {live ? `Live from ${chart.source === "stripe" ? "Stripe" : "PostHog"}` : "Placeholder data: not connected"}
      </div>
    </div>
  );
}

function GameTooltip({ hover, leaders, bounds }: { hover: GameHover; leaders: GameLeaders | null; bounds: DOMRect | null }) {
  const width = 250;
  const rows =
    hover.game === "arcade"
      ? (leaders?.arcade ?? []).map((entry) => ({
          name: entry.agentName ?? "Former agent",
          value: `${entry.score.toLocaleString("en")} pts`,
          detail: timeAgo(entry.playedAt),
        }))
      : hover.game === "pingpong"
        ? (leaders?.pingPong ?? []).map((entry) => ({
            name: entry.agentName ?? "Former agent",
            value: `${entry.wins.toLocaleString("en")} ${entry.wins === 1 ? "win" : "wins"}`,
            detail: timeAgo(entry.lastPlayed),
          }))
        : (leaders?.potters ?? []).map((entry) => ({
            name: entry.agentName ?? "Former agent",
            value: `${entry.ballsPotted.toLocaleString("en")} ${entry.ballsPotted === 1 ? "ball" : "balls"}`,
            detail: `${entry.poolGames} ${entry.poolGames === 1 ? "game" : "games"}`,
          }));
  const title = hover.game === "arcade" ? "Arcade high scores" : hover.game === "pingpong" ? "Ping pong champions" : "Most balls potted";
  const empty = hover.game === "arcade" ? "No scores yet." : hover.game === "pingpong" ? "No matches won yet." : "No balls potted yet.";
  return (
    <div role="tooltip" style={{ ...TOOLTIP_STYLE, ...tooltipPosition(hover.x, hover.y, width, bounds), width }}>
      <strong style={{ color: "#f9fafb" }}>{title}</strong>
      {leaders ? <span style={{ opacity: 0.6 }}> · {leaders.rangeLabel}</span> : null}
      {rows.length === 0 ? (
        <div style={{ marginTop: 6, opacity: 0.7 }}>{leaders ? empty : "Loading…"}</div>
      ) : (
        <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {rows.map((row, i) => (
            <li key={i} style={{ marginTop: i ? 2 : 0 }}>
              <span style={{ display: "flex", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: i === 0 ? "#f5d547" : undefined }}>
                  {row.name}
                </span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{row.value}</span>
                {row.detail ? <span style={{ opacity: 0.5, fontSize: 11, alignSelf: "center" }}>{row.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The wall clocks: the time and date right now, by the viewer's own clock, ticking each second. */
function ClockTooltip({ x, y, bounds }: { x: number; y: number; bounds: DOMRect | null }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const width = 220;
  return (
    <div role="tooltip" style={{ ...TOOLTIP_STYLE, ...tooltipPosition(x, y, width, bounds), width }}>
      <strong style={{ color: "#f9fafb", fontSize: 16, fontVariantNumeric: "tabular-nums" }}>
        {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </strong>
      <div style={{ marginTop: 4 }}>{now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div>
    </div>
  );
}

function DjBoothTooltip({ x, y, status, bounds }: { x: number; y: number; status: MusicStatus; bounds: DOMRect | null }) {
  const width = 300;
  return (
    <div role="tooltip" style={{ ...TOOLTIP_STYLE, ...tooltipPosition(x, y, width, bounds), width }}>
      <strong style={{ color: "#f9fafb" }}>DJ booth</strong>
      {status.state === "on" ? (
        <>
          {status.hearing ? (
            <div style={{ marginTop: 4 }}>Playing along to your music.</div>
          ) : (
            <div style={{ marginTop: 4, color: "#fcd34d" }}>
              Connected, but hearing silence. Check that what you shared is playing, and that “Share audio” (for a tab) or
              “Also share system audio” (for a screen) was on. Click to disconnect and try again.
            </div>
          )}
          <div style={{ marginTop: 6, fontSize: 11, opacity: 0.5 }}>Click to disconnect</div>
        </>
      ) : status.state === "connecting" ? (
        <div style={{ marginTop: 4 }}>Choose what to share in your browser's picker…</div>
      ) : (
        <>
          {status.state === "error" ? <div style={{ marginTop: 4, color: "#fca5a5" }}>{status.message}</div> : null}
          <div style={{ marginTop: 4 }}>Click to have the DJ play along to your music.</div>
          <div style={{ marginTop: 4 }}>
            For the Spotify or Apple Music app, choose <em>Entire screen</em> and turn on “Also share system audio”. For music in a browser tab,
            choose that tab and tick “Share audio”.
          </div>
          <div style={{ marginTop: 6, fontSize: 11, opacity: 0.5 }}>
            Your music keeps playing as normal: the DJ booth only listens for the beat, and nothing leaves your browser.
          </div>
        </>
      )}
    </div>
  );
}

function NoteTooltip({ hover, notes, bounds, clickable }: { hover: NoteHover; notes: KanbanNote[]; bounds: DOMRect | null; clickable: boolean }) {
  const width = 260;
  const column = KANBAN_COLUMN_LABELS[hover.column] ?? "";
  const note = notes[hover.index];
  const columnColor = KANBAN_COLUMN_COLORS[hover.column];
  return (
    <div
      role="tooltip"
      style={{ ...TOOLTIP_STYLE, ...tooltipPosition(hover.x, hover.y, width, bounds), width, ...(columnColor ? { borderTop: `3px solid ${columnColor}` } : null) }}
    >
      {hover.overflow ? (
        <div>{notes.length - hover.index} more in {column}</div>
      ) : note ? (
        <>
          {note.identifier ? <div style={{ opacity: 0.6, fontSize: 11 }}>{note.identifier}</div> : null}
          <div style={{ color: "#f9fafb", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{note.title}</div>
          <div style={{ marginTop: 4, opacity: 0.6, fontSize: 11 }}>{column} · {note.priority} priority</div>
          <div style={{ marginTop: 4, fontSize: 11 }}>
            {note.assigneeAgent ? (
              <>Assigned to <strong style={{ color: "#f9fafb" }}>{note.assigneeAgent}</strong></>
            ) : note.assignedToUser ? (
              "Assigned to a person, not an agent"
            ) : (
              <span style={{ opacity: 0.6 }}>Unassigned</span>
            )}
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: note.workingAgent ? "#60a5fa" : undefined, opacity: note.workingAgent ? 1 : 0.6 }}>
            {note.workingAgent ? `● Being worked on by ${note.workingAgent}` : "Not being worked on right now"}
          </div>
          {clickable ? <div style={{ marginTop: 6, fontSize: 11, opacity: 0.5 }}>Click to open issue</div> : null}
        </>
      ) : null}
    </div>
  );
}

/** The hover card for an agent: what they are working on now, or how their last run went. */
export function RunTooltip({ agent, x, y, bounds, clickable }: { agent: CameraAgent; x: number; y: number; bounds: DOMRect | null; clickable: boolean }) {
  const run = agent.lastRun;
  const decisions = agent.pendingDecisions;
  const width = 280;
  const active = !!run?.active;
  const when = run ? timeAgo(active ? run.startedAt : run.finishedAt) : null;
  const took = run && !active ? duration(run.startedAt, run.finishedAt) : null;
  const lastOutput = active && run ? timeAgo(run.lastOutputAt) : null;
  const output = useRunOutput(active && run ? run.runId : null, run?.lastOutputBytes);
  return (
    <div role="tooltip" style={{ ...TOOLTIP_STYLE, ...tooltipPosition(x, y, width, bounds), width }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <strong style={{ fontSize: 13, color: "#f9fafb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <HarnessMark source={agent.source} />
          {agent.name}
        </strong>
        {run ? (
          <span style={{ color: RUN_STATUS_COLORS[run.status] ?? "#93c5fd", whiteSpace: "nowrap", fontSize: 11 }}>
            {active ? "● running" : run.status.replace(/_/g, " ")}
          </span>
        ) : null}
      </div>
      {decisions?.count ? (
        <div style={{ marginTop: 4, color: DECISION_COLOR }}>
          ✋ {decisions.count === 1 ? "Waiting on your decision" : `Waiting on ${decisions.count} decisions`}
          {decisions.title ? (
            <div style={{ marginTop: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{decisions.title}</div>
          ) : null}
        </div>
      ) : null}
      {!run ? (
        <div style={{ marginTop: 4, opacity: 0.7 }}>No finished runs yet.</div>
      ) : (
        <>
          <div style={{ opacity: 0.6, fontSize: 11 }}>
            {active
              ? `Working now${when ? ` · started ${when}` : ""}${lastOutput ? ` · last output ${lastOutput}` : ""}`
              : `Last run${when ? ` · ${when}` : ""}${took ? ` · took ${took}` : ""}`}
          </div>
          {run.issueTitle ? (
            <div style={{ marginTop: 6, color: "#bfdbfe", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {run.issueIdentifier ? <span style={{ opacity: 0.75 }}>{run.issueIdentifier} </span> : null}
              {run.issueTitle}
            </div>
          ) : null}
          {active && output?.message ? (
            <div style={{ marginTop: 6, display: "-webkit-box", WebkitLineClamp: 6, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{output.message}</div>
          ) : null}
          {active && output?.actions.length ? (
            <div style={{ marginTop: 4, opacity: 0.7, fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
              {output.actions.map((action, i) => (
                <div key={i} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>› {action}</div>
              ))}
            </div>
          ) : null}
          {run.summary ? (
            <div style={{ marginTop: 6, display: "-webkit-box", WebkitLineClamp: 6, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{run.summary}</div>
          ) : null}
          {run.error && run.status !== "succeeded" ? (
            <div style={{ marginTop: 6, color: "#fca5a5" }}>{run.error}</div>
          ) : null}
          {!active && !run.summary && !run.error ? <div style={{ marginTop: 6, opacity: 0.7 }}>No summary recorded for this run.</div> : null}
          {active && !run.issueTitle ? <div style={{ marginTop: 6, opacity: 0.7 }}>Not linked to an issue.</div> : null}
        </>
      )}
      {clickable ? <div style={{ marginTop: 8, fontSize: 11, opacity: 0.5 }}>Click to open agent</div> : null}
    </div>
  );
}

/**
 * The office outlives the canvas: the camera unmounts while the Agents or Activity tab is open, and
 * coming back carries on with everyone where they were rather than seating them afresh.
 */
let liveOffice: {
  office: OfficeState;
  cameraBounds: Record<CameraKey, CameraBounds>;
  rooms: Array<RoomKey | null>;
  /** Agents have been put in place (or restored) on first load */
  settled: boolean;
} | null = null;

export function PixelOfficeCanvas({
  agents,
  camera,
  onAgentClick,
  wallCharts,
  kanbanColumns,
  onIssueClick,
  theme = "classic",
  scorecard,
  onScorecardClick,
  onGameUpdate,
  onDecisionCamerasChange,
  gameLeaders,
  wallArt,
}: PixelOfficeCanvasProps) {
  useEffect(
    () => setScorecard(scorecard
      ? { overall: scorecard.overall, sections: scorecard.sections.map((s) => ({ status: s.status, labelLength: s.name.length })) }
      : null),
    [scorecard],
  );
  /** Each chart-showing whiteboard's chart, by furniture uid. */
  const chartsByBoard = useMemo(
    () => new Map(
      (Object.entries(WALL_CHART_BOARDS) as Array<[WallChartKey, string]>).map(([key, uid]) => [uid, wallCharts?.[key] ?? null]),
    ),
    [wallCharts],
  );
  useEffect(
    () => setWhiteboardSeries(Object.fromEntries(
      [...chartsByBoard].map(([uid, chart]) => [uid, chart && chart.source !== "placeholder" ? chart.points.map((point) => point.value) : null]),
    )),
    [chartsByBoard],
  );
  useEffect(
    () => setKanbanColumns(kanbanColumns?.map((notes) => notes.map((note) => note.priority)) ?? null),
    [kanbanColumns],
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const officeRef = useRef<OfficeState | null>(null);
  const cameraBoundsRef = useRef<Record<CameraKey, CameraBounds> | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const hoveredIdRef = useRef<number | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  /** Agents present on first load start in place; later arrivals walk in from the entrance. */
  const settledRef = useRef(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const hoveredNoteKeyRef = useRef<string | null>(null);
  const [noteHover, setNoteHover] = useState<NoteHover | null>(null);
  const hoveredChartKeyRef = useRef<string | null>(null);
  const [chartHover, setChartHover] = useState<ChartHover | null>(null);
  const hoveredGameRef = useRef<GameHover["game"] | null>(null);
  /** The drinks station (furniture uid) under the pointer, if any */
  const hoveredStationRef = useRef<string | null>(null);
  const hoveredDjBoothRef = useRef(false);
  const [djBoothHover, setDjBoothHover] = useState<{ x: number; y: number } | null>(null);
  const hoveredClockRef = useRef(false);
  const [clockHover, setClockHover] = useState<{ x: number; y: number } | null>(null);
  const musicStatus = useMusicStatus();
  const [stationHover, setStationHover] = useState<string | null>(null);
  const [gameHover, setGameHover] = useState<GameHover | null>(null);
  const hoveredScorecardKeyRef = useRef<string | null>(null);
  const [scorecardHover, setScorecardHover] = useState<ScorecardHover | null>(null);
  const roomsRef = useRef<Array<RoomKey | null> | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  // The render loop reads the camera through a ref so switching doesn't restart it (and blank the canvas).
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  /** The map as the current theme draws it; null for the layout's own look. */
  const themedMapRef = useRef<ThemedMap | null>(null);
  // The render loop's hover check outlives renders, so it reads the boards through a ref.
  const chartsByBoardRef = useRef(chartsByBoard);
  chartsByBoardRef.current = chartsByBoard;
  const agentMeta = useMemo(
    () => new Map(agents.map((agent) => [stableNumericId(agent.id), agent] as const)),
    [agents],
  );
  const agentMetaRef = useRef(agentMeta);
  agentMetaRef.current = agentMeta;
  const onDecisionCamerasRef = useRef(onDecisionCamerasChange);
  onDecisionCamerasRef.current = onDecisionCamerasChange;
  useEffect(() => {
    if (!ready) return;
    let last = "";
    const check = () => {
      const office = officeRef.current;
      const bounds = cameraBoundsRef.current;
      if (!office || !bounds) return;
      const cameras = [...office.characters.values()]
        .filter((ch) => ch.needsDecision && ch.matrixEffect !== "despawn")
        .map((ch) =>
          (Object.entries(bounds) as Array<[CameraKey, CameraBounds]>)
            .filter(([, b]) => ch.tileCol >= b.col && ch.tileCol < b.col + b.cols && ch.tileRow >= b.row && ch.tileRow < b.row + b.rows)
            .map(([key]) => key),
        );
      const key = JSON.stringify(cameras);
      if (key === last) return;
      last = key;
      onDecisionCamerasRef.current?.(cameras);
    };
    check();
    const timer = window.setInterval(check, DECISION_CAMERA_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [ready]);
  const onGameUpdateRef = useRef(onGameUpdate);
  onGameUpdateRef.current = onGameUpdate;
  useEffect(() => {
    setGameListener(({ game, gameId, characterId, score, won }) => {
      // Subagents and the placeholder aren't agents with scores of their own
      const agent = agentMetaRef.current.get(characterId);
      if (agent && agent.id !== "placeholder") onGameUpdateRef.current?.({ game, gameId, agentId: agent.id, score, won });
    });
    return () => setGameListener(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (liveOffice) {
      officeRef.current = liveOffice.office;
      cameraBoundsRef.current = liveOffice.cameraBounds;
      roomsRef.current = liveOffice.rooms;
      settledRef.current = liveOffice.settled;
      setReady(true);
      return;
    }

    void loadPixelAssets()
      .then(({ layouts, cameraBounds }) => {
        if (cancelled) return;
        const office = liveOffice?.office ?? new OfficeState(layouts.combined);
        liveOffice ??= { office, cameraBounds, rooms: layouts.rooms, settled: false };
        cameraBoundsRef.current = cameraBounds;
        roomsRef.current = layouts.rooms;
        officeRef.current = office;
        settledRef.current = liveOffice.settled;
        setReady(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const { fetchWallImage } = useOfficeSettingsActions(null);
  const fetchWallImageRef = useRef(fetchWallImage);
  fetchWallImageRef.current = fetchWallImage;
  const wallArtKey = JSON.stringify(wallArt ?? {});
  useEffect(() => {
    const office = officeRef.current;
    if (!office || !ready) return;
    let cancelled = false;
    const slots = new Map(wallArtSlots(office.getLayout()).map((slot) => [slot.uid, slot]));
    const wanted = Object.entries(wallArt ?? {}).filter(([uid]) => slots.has(uid));
    if (!wanted.length) {
      setFurnitureUidOverrides(null);
      return;
    }
    void Promise.all(
      wanted.map(async ([uid, art]): Promise<[string, SpriteData] | null> => {
        const slot = slots.get(uid)!;
        try {
          return [uid, await loadWallArtSprite(fetchWallImageRef.current, art.imageUrl, slot)];
        } catch (error) {
          console.warn(`OfficeSim: could not load wall art for ${slot.label}`, error);
          return null;
        }
      }),
    ).then((sprites) => {
      if (!cancelled) setFurnitureUidOverrides(new Map(sprites.filter((entry): entry is [string, SpriteData] => !!entry)));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the art's contents, not its identity
  }, [wallArtKey, ready]);

  useEffect(() => {
    const office = officeRef.current;
    const rooms = roomsRef.current;
    const themeDef = THEMES[theme];
    setFurnitureOverrides(getThemeFurniture(theme));
    setTerminalColors(getThemeScreenColors(theme));
    const floorPatterns = activateThemeTiles(theme);
    if (!office || !rooms || !ready || theme === "classic") {
      themedMapRef.current = null;
      return;
    }
    const layout = office.getLayout();
    themedMapRef.current = buildThemedMap(
      office.tileMap, layout.tileColors, rooms, layout.cols, themeDef, floorPatterns, themeHasWalls(theme),
    );
  }, [theme, ready]);

  useEffect(() => {
    const office = officeRef.current;
    if (!office || !ready) return;

    const incoming = new Set(agents.map((agent) => stableNumericId(agent.id)));
    // On first load, everyone goes back to the seat they had before the page was reloaded; those with
    // a saved seat are added first so nobody else is given it
    const snapshot = settledRef.current ? null : readOfficeSnapshot();
    const saved = (agent: CameraAgent) => snapshot?.agents[agent.id];
    const ordered = snapshot ? [...agents].sort((a, b) => Number(!saved(a)) - Number(!saved(b))) : agents;
    for (const agent of ordered) {
      const id = stableNumericId(agent.id);
      office.addAgent(id, agent.characterIndex, agent.hueShift ?? 0, saved(agent)?.seatId ?? undefined, true);
      office.setAgentWorkplace(id, agent.workplace ?? "main");
      const character = office.characters.get(id);
      if (character && agent.characterIndex !== undefined) {
        if (character.palette !== agent.characterIndex) character.palette = agent.characterIndex;
        if (character.hueShift !== (agent.hueShift ?? 0)) character.hueShift = agent.hueShift ?? 0;
      }
      if (character) {
        character.isSick = agent.status === "error";
        character.needsDecision = !!agent.pendingDecisions?.count;
        // A run in progress that has gone quiet is waiting on something slow (tests, a build…)
        const run = agent.lastRun;
        const quietSince = run?.active ? Date.parse(run.lastOutputAt ?? run.startedAt ?? "") : NaN;
        character.quietSince = Number.isNaN(quietSince) ? null : quietSince;
      }
      const activity = agent.activityKind ?? "idle";
      const isWorking = activity !== "idle";
      if (character && character.isActive !== isWorking) office.setAgentActive(id, isWorking);
      const nextTool = activity === "research" ? "Read" : isWorking ? "Edit" : null;
      if (character && character.currentTool !== nextTool) office.setAgentTool(id, nextTool);
    }
    for (const id of office.characters.keys()) {
      if (!incoming.has(id)) office.removeAgent(id);
    }
    const isPlaceholder = agents.length === 1 && agents[0].id === "placeholder";
    if (!settledRef.current && !isPlaceholder) {
      settledRef.current = true;
      if (liveOffice) liveOffice.settled = true;
      // A recent save also puts them back where they were (at their desk, mid-game...); anyone it
      // can't place is settled as usual
      const positionsFresh = !!snapshot && Date.now() - snapshot.savedAt < SNAPSHOT_POSITIONS_FRESH_MS;
      const unplaced = agents
        .filter((agent) => {
          const entry = saved(agent);
          return !(positionsFresh && entry && office.restoreCharacter(stableNumericId(agent.id), entry));
        })
        .map((agent) => stableNumericId(agent.id));
      office.settleAgents(unplaced);
    }
  }, [agents, ready]);

  // Save where everyone is, so a reload puts them back
  useEffect(() => {
    if (!ready) return;
    const save = () => {
      const office = officeRef.current;
      if (!office || !settledRef.current) return;
      const agentIds = new Map<number, string>();
      for (const [characterId, agent] of agentMetaRef.current) if (agent.id !== "placeholder") agentIds.set(characterId, agent.id);
      writeOfficeSnapshot(office, agentIds);
    };
    const timer = window.setInterval(save, SNAPSHOT_SAVE_MS);
    window.addEventListener("pagehide", save);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [ready]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const office = officeRef.current;
    const cameraBounds = cameraBoundsRef.current;
    if (!canvas || !wrap || !office || !cameraBounds || !ready) return;

    const activeCanvas = canvas;
    const activeWrap = wrap;

    function resize() {
      const rect = activeWrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      activeCanvas.style.width = `${rect.width}px`;
      activeCanvas.style.height = `${rect.height}px`;
      // Assigning width/height wipes the canvas, so only do it on a real size change and redraw at once.
      if (activeCanvas.width === width && activeCanvas.height === height) return;
      activeCanvas.width = width;
      activeCanvas.height = height;
      stop?.redraw();
    }

    let stop: ReturnType<typeof startGameLoop> | null = null;
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(activeWrap);

    stop = startGameLoop(canvas, {
      update: (dt) => {
        office.update(dt);
        // A rat hunt's rats, about the rooms on the camera
        updateRats(dt, office.tileMap, office.blockedTiles, cameraBounds[cameraRef.current]);
      },
      render: (ctx) => {
        const layout = office.getLayout();
        const focus = cameraBounds[cameraRef.current];
        const dpr = window.devicePixelRatio || 1;
        const fitZoom = Math.min(
          canvas.width / (focus.cols * TILE_SIZE),
          canvas.height / (focus.rows * TILE_SIZE),
        ) * 0.92;
        const zoom = Math.max(dpr, fitZoom);
        const mapCenterCol = layout.cols / 2;
        const mapCenterRow = layout.rows / 2;
        const focusCenterCol = focus.col + focus.cols / 2;
        const focusCenterRow = focus.row + focus.rows / 2;
        const panX = (mapCenterCol - focusCenterCol) * TILE_SIZE * zoom;
        const panY = (mapCenterRow - focusCenterRow) * TILE_SIZE * zoom;

        const themedMap = themedMapRef.current;
        const { offsetX, offsetY } = renderFrame(
          ctx,
          canvas.width,
          canvas.height,
          themedMap?.tileMap ?? office.tileMap,
          office.furniture,
          Array.from(office.characters.values()),
          zoom,
          panX,
          panY,
          {
            selectedAgentId: null,
            hoveredAgentId: hoveredIdRef.current,
            hoveredTile: null,
            seats: office.seats,
            characters: office.characters,
          },
          undefined,
          themedMap?.tileColors ?? layout.tileColors,
          layout.cols,
          layout.rows,
          {
            furniture: layout.furniture,
            spots: office.leisureSpots,
            moveTo: (ch, key) => office.moveToLeisureSpot(ch, key),
            isFree: (key, ch) => office.isLeisureSpotFree(key, ch),
          },
          (underlayCtx, x, y) => {
            if (themedMap) renderThemeTrim(underlayCtx, THEMES[themeRef.current], themedMap, x, y, zoom);
            // On the floor, so they run under the furniture
            drawRats(underlayCtx, x, y, zoom);
          },
          layout.carpetTiles,
          undefined,
          undefined,
          false,
          null,
          office.pets,
        );
        viewportRef.current = { offsetX, offsetY, zoom };
        setRatViewport(offsetX, offsetY, zoom, canvas);
        if (themedMap) renderThemeAmbient(ctx, THEMES[themeRef.current], themedMap, offsetX, offsetY, zoom);
        // Characters keep walking under a still cursor, so re-check what's hovered each frame.
        updateHover();

        ctx.save();
        const fontSize = Math.max(10, Math.floor(5 * zoom));
        ctx.font = `${fontSize}px ${NAME_LABEL_FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.strokeStyle = "#000";
        ctx.lineWidth = Math.max(2, zoom);
        for (const character of office.characters.values()) {
          const agent = agentMetaRef.current.get(character.id);
          const name = agent?.name;
          if (!name) continue;
          let x = offsetX + character.x * zoom;
          const y = offsetY + (character.y + 8) * zoom;
          // The harness icon goes before the name, the two centred together under the character
          const icon = harnessIconImage(agent.source);
          if (icon) {
            const gap = Math.max(2, Math.round(zoom));
            const width = fontSize + gap + ctx.measureText(name).width;
            const left = Math.round(x - width / 2);
            const top = Math.round(y);
            const inset = Math.max(1, Math.round(fontSize / 10));
            ctx.fillStyle = HARNESS_TILE_COLOR;
            ctx.beginPath();
            ctx.roundRect(left, top, fontSize, fontSize, Math.max(2, fontSize / 5));
            ctx.fill();
            ctx.drawImage(icon, left + inset, top + inset, fontSize - inset * 2, fontSize - inset * 2);
            x = left + fontSize + gap + (width - fontSize - gap) / 2;
          }
          ctx.fillStyle = character.needsDecision ? DECISION_COLOR : character.isSick ? "#ef4444" : "#f9fafb";
          ctx.strokeText(name, x, y);
          ctx.fillText(name, x, y);
        }
        ctx.restore();
      },
    });

    return () => {
      observer.disconnect();
      stop?.();
    };
  }, [ready]);

  function updateHover(moved = false) {
    const office = officeRef.current;
    const viewport = viewportRef.current;
    const pointer = pointerRef.current;
    let id: number | null = null;
    let note: ReturnType<typeof kanbanNoteAt> = null;
    let chart: { uid: string; bar: number | null } | null = null;
    let card: ReturnType<typeof scorecardAt> = null;
    let game: GameHover["game"] | null = null;
    let station: string | null = null;
    let djBooth = false;
    let clock = false;
    if (office && viewport && pointer) {
      const dpr = window.devicePixelRatio || 1;
      const worldX = (pointer.x * dpr - viewport.offsetX) / viewport.zoom;
      const worldY = (pointer.y * dpr - viewport.offsetY) / viewport.zoom;
      const hit = hitTest(office.characters.values(), worldX, worldY);
      id = hit && agentMetaRef.current.has(hit.id) ? hit.id : null;
      // Agents stand in front of the boards, so only look at the walls when no one's in the way.
      if (id === null) {
        for (const item of office.furniture) {
          if (item.mirrored) continue;
          if (item.type === KANBAN_BOARD_TYPE) note = kanbanNoteAt(worldX - item.x, worldY - item.y);
          else if (item.type === SCORECARD_BOARD_TYPE) card = scorecardAt(worldX - item.x, worldY - item.y);
          else if (item.type === WHITEBOARD_TYPE && item.uid && chartsByBoardRef.current.has(item.uid)) {
            const hit = whiteboardChartAt(item.uid, worldX - item.x, worldY - item.y);
            if (hit) chart = { uid: item.uid, ...hit };
          }
          if (note || chart || card) break;
        }
      }
      // Then the arcade machine, pool tables, drinks stations and clocks, by their painted pixels
      if (id === null && !note && !chart && !card) {
        for (const item of office.furniture) {
          const isStation = !!item.type && DRINK_STATION_TYPES.has(item.type);
          const isDjBooth = item.type === DJ_BOOTH_TYPE || item.type === DJ_SPEAKER_TYPE;
          const kind = item.type?.startsWith(ARCADE_TYPE_PREFIX)
            ? "arcade"
            : item.type?.startsWith(POOL_TABLE_TYPE_PREFIX)
              ? "pool"
              : item.type === PING_PONG_TABLE_TYPE
                ? "pingpong"
                : null;
          const isClock = item.type === CLOCK_TYPE;
          if (!kind && !isStation && !isDjBooth && !isClock) continue;
          const x = Math.floor(worldX - item.x);
          const y = Math.floor(worldY - item.y);
          if (!item.sprite[y]?.[item.mirrored ? item.sprite[y].length - 1 - x : x]) continue;
          if (isStation) station = item.uid ?? null;
          else if (isDjBooth) djBooth = true;
          else if (isClock) clock = true;
          else game = kind;
          break;
        }
      }
    }
    const noteKey = note ? `${note.column}:${note.index}` : null;
    const chartKey = chart ? `${chart.uid}:${chart.bar}` : null;
    const cardKey = card ? String(card.section) : null;
    if (
      id === hoveredIdRef.current && noteKey === hoveredNoteKeyRef.current && chartKey === hoveredChartKeyRef.current &&
      cardKey === hoveredScorecardKeyRef.current && game === hoveredGameRef.current &&
      station === hoveredStationRef.current && djBooth === hoveredDjBoothRef.current &&
      clock === hoveredClockRef.current && !moved
    ) {
      return;
    }
    hoveredGameRef.current = game;
    hoveredStationRef.current = station;
    setStationHover(station);
    hoveredDjBoothRef.current = djBooth;
    setDjBoothHover(!djBooth || !pointer ? null : { x: pointer.x, y: pointer.y });
    hoveredClockRef.current = clock;
    setClockHover(!clock || !pointer ? null : { x: pointer.x, y: pointer.y });
    setGameHover(!game || !pointer ? null : { game, x: pointer.x, y: pointer.y });
    hoveredScorecardKeyRef.current = cardKey;
    setScorecardHighlight(card?.section ?? null);
    setScorecardHover(!card || !pointer ? null : { ...card, x: pointer.x, y: pointer.y });
    hoveredIdRef.current = id;
    hoveredNoteKeyRef.current = noteKey;
    hoveredChartKeyRef.current = chartKey;
    setKanbanHighlight(note && !note.overflow ? note : null);
    setWhiteboardHighlight(chart && chart.bar !== null ? { uid: chart.uid, index: chart.bar } : null);
    setHover(id === null || !pointer ? null : { characterId: id, x: pointer.x, y: pointer.y });
    setNoteHover(!note || !pointer ? null : { ...note, x: pointer.x, y: pointer.y });
    setChartHover(!chart || !pointer ? null : { ...chart, x: pointer.x, y: pointer.y });
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    pointerRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    updateHover(true);
  }

  function handlePointerLeave() {
    pointerRef.current = null;
    updateHover();
  }

  // onClick covers plain/cmd/ctrl clicks; onAuxClick covers middle-click.
  function handleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (event.type === "auxclick" && event.button !== 1) return;
    const newTab = event.type === "auxclick" || event.metaKey || event.ctrlKey;
    // Find what's under the click itself (a click can arrive without a pointer move first), then
    // read the refs, which update at once, rather than hover state that hasn't re-rendered yet
    const rect = event.currentTarget.getBoundingClientRect();
    pointerRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    updateHover(true);
    if (hoveredDjBoothRef.current && event.type === "click") {
      toggleMusic();
      return;
    }
    if (hoveredStationRef.current && event.type === "click") {
      pourAtStation(hoveredStationRef.current);
      return;
    }
    if (scorecardHover && scorecard?.issueIdentifier && onScorecardClick) {
      event.preventDefault();
      onScorecardClick(scorecard.issueIdentifier, newTab);
      return;
    }
    const hoveredNote = noteHover && !noteHover.overflow ? kanbanColumns?.[noteHover.column]?.[noteHover.index] : undefined;
    if (hoveredNote && onIssueClick) {
      event.preventDefault();
      onIssueClick(hoveredNote, newTab);
      return;
    }
    const id = hoveredIdRef.current;
    const agent = id === null ? undefined : agentMeta.get(id);
    if (!agent || agent.id === "placeholder" || !onAgentClick) return;
    event.preventDefault();
    onAgentClick(agent, newTab);
  }

  const hoveredAgent = hover ? agentMeta.get(hover.characterId) : undefined;
  const pointerOverLink = !!hoveredAgent || (!!noteHover && !noteHover.overflow && !!onIssueClick) ||
    (!!scorecardHover && !!scorecard?.issueIdentifier && !!onScorecardClick) || !!stationHover || !!djBoothHover;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height: "min(725px, calc(100vh - 185px))", minHeight: "520px" }}>
      {!ready && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
          {loadError ? `Camera failed: ${loadError}` : "Loading office..."}
        </div>
      )}
      <canvas
        ref={canvasRef}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
        onAuxClick={handleClick}
        style={{ display: "block", width: "100%", height: "100%", imageRendering: "pixelated", cursor: pointerOverLink ? "pointer" : "default" }}
      />
      {hover && hoveredAgent && hoveredAgent.id !== "placeholder" ? (
        <RunTooltip agent={hoveredAgent} x={hover.x} y={hover.y} bounds={wrapRef.current?.getBoundingClientRect() ?? null} clickable={!!onAgentClick} />
      ) : null}
      {scorecardHover ? (
        <ScorecardTooltip
          hover={scorecardHover}
          scorecard={scorecard ?? null}
          bounds={wrapRef.current?.getBoundingClientRect() ?? null}
          clickable={!!onScorecardClick}
        />
      ) : null}
      {chartHover ? (
        <ChartTooltip hover={chartHover} chart={chartsByBoard.get(chartHover.uid) ?? null} bounds={wrapRef.current?.getBoundingClientRect() ?? null} />
      ) : null}
      {djBoothHover ? (
        <DjBoothTooltip x={djBoothHover.x} y={djBoothHover.y} status={musicStatus} bounds={wrapRef.current?.getBoundingClientRect() ?? null} />
      ) : null}
      {clockHover ? <ClockTooltip x={clockHover.x} y={clockHover.y} bounds={wrapRef.current?.getBoundingClientRect() ?? null} /> : null}
      {gameHover ? (
        <GameTooltip hover={gameHover} leaders={gameLeaders ?? null} bounds={wrapRef.current?.getBoundingClientRect() ?? null} />
      ) : null}
      {noteHover && kanbanColumns?.[noteHover.column] ? (
        <NoteTooltip
          hover={noteHover}
          notes={kanbanColumns[noteHover.column]}
          bounds={wrapRef.current?.getBoundingClientRect() ?? null}
          clickable={!!onIssueClick}
        />
      ) : null}
    </div>
  );
}
