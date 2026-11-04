export {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MATRIX_EFFECT_DURATION_SEC as MATRIX_EFFECT_DURATION,
  MAX_COLS,
  MAX_ROWS,
  TILE_SIZE,
} from '../constants.js';

export const TileType = {
  WALL: 0,
  FLOOR_1: 1,
  FLOOR_2: 2,
  FLOOR_3: 3,
  FLOOR_4: 4,
  FLOOR_5: 5,
  FLOOR_6: 6,
  FLOOR_7: 7,
  FLOOR_8: 8,
  FLOOR_9: 9,
  VOID: 255,
} as const;
export type TileType = (typeof TileType)[keyof typeof TileType];

/** Re-export ColorValue for consumers that import color types from office/types */
export type { ColorValue } from '../components/ui/types.js';
import type { ColorValue } from '../components/ui/types.js';

export const CharacterState = {
  IDLE: 'idle',
  WALK: 'walk',
  TYPE: 'type',
  /** Idle downtime at a pool table, arcade machine or sofa */
  LEISURE: 'leisure',
} as const;
export type CharacterState = (typeof CharacterState)[keyof typeof CharacterState];

export const Direction = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3,
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

/** 2D array of hex color strings: '' = transparent, '#RRGGBB' = opaque, '#RRGGBBAA' = semi-transparent. [row][col] */
export type SpriteData = string[][];

export interface Seat {
  /** Chair furniture uid */
  uid: string;
  /** Tile col where agent sits */
  seatCol: number;
  /** Tile row where agent sits */
  seatRow: number;
  /** Direction character faces when sitting (toward adjacent desk) */
  facingDir: Direction;
  assigned: boolean;
}

export type LeisureKind = 'pool' | 'arcade' | 'sofa' | 'coffee' | 'water' | 'dj' | 'pingpong';

/** Room an agent works from */
export type Workplace = 'main' | 'boardroom' | 'overflow';

/** A presenter stands at the whiteboard; an inspector (a lone boardroom worker) walks between the wall boards. */
export type BoardroomRole = 'presenter' | 'inspector' | null;

export interface LeisureSpot {
  key: string;
  kind: LeisureKind;
  col: number;
  row: number;
  /** Direction the character faces while at the spot */
  facingDir: Direction;
  /** Spot sits on blocked furniture (sofa) and must be unblocked to path onto */
  onFurniture: boolean;
  /** Uid of the pool table, arcade machine or sofa this spot belongs to */
  furnitureUid: string;
}

/** Reservation of leisure spots, owned by OfficeState */
export interface LeisureRegistry {
  claim(ch: Character): LeisureSpot | null;
  release(ch: Character): void;
  get(key: string): LeisureSpot | undefined;
}

export interface FurnitureInstance {
  sprite: SpriteData;
  /** Pixel x (top-left) */
  x: number;
  /** Pixel y (top-left) */
  y: number;
  /** Y value used for depth sorting (typically bottom edge) */
  zY: number;
  /** Render-time horizontal flip flag (for mirrored side variants) */
  mirrored?: boolean;
  /** Catalog type, for furniture drawn specially (e.g. clocks show the time) */
  type?: string;
  /** Layout uid, for telling apart pieces of the same type (e.g. which chart a whiteboard shows) */
  uid?: string;
  /** A computer whose agent is waiting on a long tool call: its screen shows an egg timer */
  waiting?: boolean;
}

export interface ToolActivity {
  toolId: string;
  status: string;
  done: boolean;
  permissionWait?: boolean;
}

export const EditTool = {
  TILE_PAINT: 'tile_paint',
  WALL_PAINT: 'wall_paint',
  FURNITURE_PLACE: 'furniture_place',
  FURNITURE_PICK: 'furniture_pick',
  SELECT: 'select',
  EYEDROPPER: 'eyedropper',
  ERASE: 'erase',
  PETS: 'pets',
  CARPET_PAINT: 'carpet_paint',
  CARPET_PICK: 'carpet_pick',
  AREA_PAINT: 'area_paint',
} as const;
export type EditTool = (typeof EditTool)[keyof typeof EditTool];

export interface FurnitureCatalogEntry {
  type: string; // asset ID from furniture manifest
  label: string;
  footprintW: number;
  footprintH: number;
  sprite: SpriteData;
  isDesk: boolean;
  category?: string;
  /** Orientation from rotation group: 'front' | 'back' | 'left' | 'right' */
  orientation?: string;
  /** Whether this item can be placed on top of desk/table surfaces */
  canPlaceOnSurfaces?: boolean;
  /** Number of tile rows from the top of the footprint that are "background" (allow placement, still block walking). Default 0. */
  backgroundTiles?: number;
  /** Whether this item can be placed on wall tiles */
  canPlaceOnWalls?: boolean;
  /** Whether this is a side-oriented asset that produces a mirrored "left" variant */
  mirrorSide?: boolean;
}

export interface PlacedFurniture {
  uid: string;
  type: string; // asset ID from furniture manifest
  col: number;
  row: number;
  /** Optional color override for furniture */
  color?: ColorValue;
}

// ─────────────────────────────────────────────────────────────────────────────
// CARPETS — visual layer between floor and furniture. Walkable, decorative.
// ─────────────────────────────────────────────────────────────────────────────

export interface CarpetTile {
  /** Variant index into the loaded carpet sprite sets (0 .. getCarpetSetCount()-1). */
  variant: number;
  /** Main colorization (lowest-luminance pixels). Defaults to CARPET_DEFAULT_COLOR when omitted. */
  color?: ColorValue;
  /** Accent colorization (highest-luminance pixels). Defaults to CARPET_DEFAULT_ACCENT_COLOR when omitted. */
  accentColor?: ColorValue;
  /** Stacking order at overlapping junctions. Higher draws on top. Defaults to 0. */
  order?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// AREAS — translucent named overlays for workspace folder ↔ seat preference.
// ─────────────────────────────────────────────────────────────────────────────

export interface AreaDefinition {
  /** Stable label used as the FK in `areaTiles` and `OfficeState.areaMappings`. */
  label: string;
  /** Hex color (e.g. "#ff6b6b"). RGB only — alpha applied at render time. */
  color: string;
}

export interface OfficeLayout {
  version: 1;
  cols: number;
  rows: number;
  tiles: TileType[];
  furniture: PlacedFurniture[];
  /** Optional shared tile where characters enter the office on initial load. */
  spawnTile?: { col: number; row: number };
  /** Per-tile color settings, parallel to tiles array. null = wall/no color */
  tileColors?: Array<ColorValue | null>;
  /** Bumped when the bundled default layout changes; forces a reset on existing installs */
  layoutRevision?: number;
  /** Pets placed in the office. Optional for backward-compat; migrateLayout coerces to []. */
  pets?: PlacedPet[];
  /** Per-tile carpet data, parallel to tiles array. null/undefined = no carpet on tile. */
  carpetTiles?: Array<CarpetTile | null>;
  /** Area definitions referenced by `areaTiles` labels. Distinct labels required. */
  areas?: AreaDefinition[];
  /** Per-tile Area label, parallel to tiles array. null = no area assignment. */
  areaTiles?: Array<string | null>;
}

/**
 * Chair jousting: rolled out to one end of the lists, waiting for the charge, charging, meeting in
 * the middle, backing off to go again, and finally rolling home to the desk.
 */
export type JoustPhase = 'roll-out' | 'ready' | 'charge' | 'clash' | 'retreat' | 'roll-home';

export interface ChairJoust {
  /** The other jouster's character id */
  opponent: number;
  phase: JoustPhase;
  /** Which way the opponent is along the lists: 1 = to the right, -1 = to the left */
  side: 1 | -1;
  /** Pixel x of this jouster's end of the lists */
  endX: number;
  /** Seconds left in a timed phase (ready, clash) */
  timer: number;
  /** Knocked round by the last clash: spins on their chair until this time (performance.now ms) */
  spinUntil: number;
  /** Where the lances met (pixel x), while clashing */
  clashX: number | null;
}

/** Where an agent was and what they were doing, to put them back after the page reloads */
export interface CharacterSnapshot {
  seatId: string | null;
  col: number;
  row: number;
  dir: Direction;
  /** At their desk working, at a leisure spot, or anywhere else */
  activity: 'desk' | 'leisure' | 'other';
  leisureSpotKey: string | null;
  /** Seconds left at the leisure spot */
  leisureTimer: number;
}

export interface Character {
  id: number;
  state: CharacterState;
  dir: Direction;
  /** Pixel position */
  x: number;
  y: number;
  /** Current tile column */
  tileCol: number;
  /** Current tile row */
  tileRow: number;
  /** Remaining path steps (tile coords) */
  path: Array<{ col: number; row: number }>;
  /** 0-1 lerp between current tile and next tile */
  moveProgress: number;
  /** Current tool name for typing vs reading animation, or null */
  currentTool: string | null;
  /** Palette index (0-5) */
  palette: number;
  /** Hue shift in degrees (0 = no shift, ≥45 for repeated palettes) */
  hueShift: number;
  /** Animation frame index */
  frame: number;
  /** Time accumulator for animation */
  frameTimer: number;
  /** Timer for idle wander decisions */
  wanderTimer: number;
  /** Number of wander moves completed in current roaming cycle */
  wanderCount: number;
  /** Max wander moves before returning to seat for rest */
  wanderLimit: number;
  /** Whether the agent is actively working */
  isActive: boolean;
  /** Assigned seat uid, or null if no seat */
  seatId: string | null;
  /** Active speech bubble type, or null if none showing */
  bubbleType: 'permission' | 'waiting' | null;
  /** Only meaningful while bubbleType === 'waiting': true when the agent went
   *  idle waiting on the user (surfaces the "Waiting for input" label);
   *  false/undefined when the agent simply finished its turn (checkmark only,
   *  label falls through to idle). */
  waitingAwaitingInput?: boolean;
  /** Countdown timer for bubble (waiting: 2→0, permission: unused) */
  bubbleTimer: number;
  /** Timer to stay seated while inactive after seat reassignment (counts down to 0) */
  seatTimer: number;
  /** Whether this character represents a sub-agent (spawned by Task tool) */
  isSubagent: boolean;
  /** Parent agent ID if this is a sub-agent, null otherwise */
  parentAgentId: number | null;
  /** Active matrix spawn/despawn effect, or null */
  matrixEffect: 'spawn' | 'despawn' | null;
  /** Timer counting up from 0 to MATRIX_EFFECT_DURATION */
  matrixEffectTimer: number;
  /** Per-column random seeds (16 values) for staggered rain timing */
  matrixEffectSeeds: number[];
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string;
  /** Headless agent: adopted from outside the office, so there is no terminal to
   *  focus. Rendered translucent. Teammates and sub-agents are never headless —
   *  clicking them reaches their lead's / parent's terminal. */
  isHeadless?: boolean;
  /** The first-run consent greeter. A MARKER, not a gate: the greeter lives in
   *  OfficeState.greeter, outside the agent map, so seat assignment, palette
   *  diversity, the FSM, hit-testing and seat persistence never see it — no
   *  per-consumer guard reads this flag. It exists for the render/e2e snapshot
   *  (testHooks.getCharacters) to tell the greeter from agents. */
  isGreeter?: boolean;

  // -- Agent Teams --
  /** Team name this agent belongs to */
  teamName?: string;
  /** Role name within the team (null for lead) */
  agentName?: string;
  /** Whether this agent is the team lead */
  isTeamLead?: boolean;
  /** ID of the lead agent (set on teammates) */
  leadAgentId?: number;
  /** True when lead spawns teammates via tmux (run_in_background Agent calls) */
  teamUsesTmux?: boolean;
  /** Special role while working in the boardroom: alone studying the wall boards, or presenting at the whiteboard */
  boardroomRole: BoardroomRole;
  /** Dancing to the DJ booth's music: an idle agent in its room while music plays */
  dancing: boolean;
  /** Whether the agent is waiting on a person to decide something (rendered with a red question-mark thought bubble) */
  needsDecision: boolean;
  /** Whether the agent is in an error state (rendered as being sick) */
  isSick: boolean;
  /** Epoch ms of the working run's last output (or its start), or null when no run is in progress */
  quietSince: number | null;
  /** Chair jousting with another waiting agent, or null */
  joust: ChairJoust | null;
  /** At a leisure spot that has them moving about (ping pong): the walk frame to show, or null to stand still */
  leisureStep: number | null;
  /** Seconds spent sick, drives the queasy sway and vomit cycle */
  sickTimer: number;
  /** Sick agents make one move off the spawn tile, then stay put */
  sickSettled: boolean;
  /** Claimed leisure spot key, or null */
  leisureSpotKey: string | null;
  /** Seconds left at the current leisure spot */
  leisureTimer: number;
  /** Room this agent works from */
  workplace: Workplace;

  // -- Context gauge --
  /** Tokens in the agent's context as of its newest turn; 0 until reported.
   *  Sub-agents have no session of their own and stay at 0. */
  contextTokens: number;
  /** Window `contextTokens` is measured against. */
  maxContextTokens: number;
}

export const PetState = { IDLE: 'idle', WALK: 'walk', FOLLOW: 'follow' } as const;
export type PetState = (typeof PetState)[keyof typeof PetState];

/** Runtime pet (mutated by FSM tick). */
export interface Pet {
  /** Stable identifier; matches PlacedPet.id in the layout. */
  id: string;
  /** Display name from sprite manifest (e.g. "Claudio", "Gitcat"). */
  name: string;
  /** Index into the loaded PetSpriteFrames[] array. */
  petType: number;
  state: PetState;
  dir: Direction;
  /** Pixel position (bottom-center anchor). */
  x: number;
  y: number;
  /** Current tile column / row (integer). */
  tileCol: number;
  tileRow: number;
  /** Remaining path steps (tile coords). */
  path: Array<{ col: number; row: number }>;
  /** 0..1 lerp progress between current tile and next tile. */
  moveProgress: number;
  /** Animation cycle index 0..3. */
  frame: number;
  frameTimer: number;
  /** Countdown for next IDLE→WALK/FOLLOW decision. */
  wanderTimer: number;
  /** ID of the character being followed, or null. */
  followTargetId: number | null;
  /** Countdown until next path re-computation while following. */
  followRecalcTimer: number;
  /** Time spent in current FOLLOW episode. */
  followDuration: number;
  /** Random [5, 15] limit; FOLLOW exits when followDuration >= this. */
  followDurationLimit: number;
  /** Pet's heart-bubble overlay (set on click), or null. */
  bubbleType: 'heart' | null;
  /** Countdown timer for the heart bubble (mirrors character waiting bubble). */
  bubbleTimer: number;
}

/** Persisted record (lives on OfficeLayout). */
export interface PlacedPet {
  /** crypto.randomUUID() generated when first toggled on. */
  id: string;
  /** Index into the loaded pet sprite array. */
  petType: number;
}
