import {
  JOUST_BOUNCE_SPEED_PX_PER_SEC,
  JOUST_CHARGE_SPEED_PX_PER_SEC,
  JOUST_CLASH_SEC,
  JOUST_CONTACT_PX,
  JOUST_KNOCK_SPIN_MS,
  JOUST_MAX_TILES,
  JOUST_MIN_TILES,
  JOUST_READY_SEC,
  JOUST_RETREAT_SPEED_PX_PER_SEC,
  JOUST_ROLL_SPEED_PX_PER_SEC,
} from '../../constants.js';
import { getCatalogEntry } from '../layout/furnitureCatalog.js';
import { findPath } from '../layout/tileMap.js';
import type { Character, ChairJoust, PlacedFurniture, Seat, TileType as TileTypeVal, Workplace } from '../types.js';
import { CharacterState, Direction, TILE_SIZE } from '../types.js';
import { isQuiet, isWaiting } from './characters.js';

/** What chair jousting needs from the office */
export interface JoustContext {
  characters: Map<number, Character>;
  seats: Map<string, Seat>;
  seatWorkplaces: Map<string, Workplace>;
  walkableTiles: Array<{ col: number; row: number }>;
  tileMap: TileTypeVal[][];
  blockedTiles: Set<string>;
  /** The layout's furniture, so the lists keep clear of anything drawn over the floor */
  furniture: PlacedFurniture[];
  /** A path home to the character's own seat (which is otherwise blocked by its chair) */
  pathToSeat: (ch: Character) => Array<{ col: number; row: number }>;
}

/** A straight run of open floor two jousters charge along: a row, and its two end columns */
interface Lists {
  row: number;
  leftCol: number;
  rightCol: number;
}

const centerX = (col: number) => col * TILE_SIZE + TILE_SIZE / 2;

/**
 * Pair up agents spinning at their desks in the same office and send each pair off to joust.
 * Jousts end (everyone rolls home) as soon as either jouster's run gets going again.
 */
export function startJousts(ctx: JoustContext): void {
  // One joust at a time across the whole office: two people, never more
  for (const ch of ctx.characters.values()) {
    if (ch.joust) return;
  }
  const byWorkplace = new Map<Workplace, Character[]>();
  for (const ch of ctx.characters.values()) {
    if (!isWaiting(ch)) continue;
    const workplace = ctx.seatWorkplaces.get(ch.seatId!);
    if (!workplace || workplace === 'boardroom') continue;
    byWorkplace.set(workplace, [...(byWorkplace.get(workplace) ?? []), ch]);
  }
  // No joust is in progress, so all the floor is free
  const taken = new Set<string>();
  for (const waiting of byWorkplace.values()) {
    waiting.sort((a, b) => a.id - b.id);
    for (let i = 0; i + 1 < waiting.length; i += 2) {
      const [a, b] = [waiting[i], waiting[i + 1]];
      const lists = findLists(ctx, a, b, taken);
      if (!lists) continue;
      // Whoever sits further left takes the left end, so their paths out don't cross
      const [left, right] = seatOf(ctx, a).seatCol <= seatOf(ctx, b).seatCol ? [a, b] : [b, a];
      enterLists(ctx, left, right.id, 1, lists.leftCol, lists.row);
      enterLists(ctx, right, left.id, -1, lists.rightCol, lists.row);
      return;
    }
  }
}

/** Move every jouster along, one frame. */
export function updateJousts(ctx: JoustContext, dt: number): void {
  // Anyone whose run has picked up again, or whose opponent has gone home, heads home too
  for (const ch of ctx.characters.values()) {
    const joust = ch.joust;
    if (!joust || joust.phase === 'roll-home') continue;
    const other = ctx.characters.get(joust.opponent);
    if (!isQuiet(ch) || !other?.joust || other.joust.phase === 'roll-home') sendHome(ctx, ch);
  }

  for (const ch of ctx.characters.values()) {
    const joust = ch.joust;
    if (!joust) continue;
    if (joust.phase === 'roll-home') {
      if (rollAlongPath(ch, dt)) sitBackDown(ctx, ch);
      continue;
    }
    // Each pair moves together, handled once from the lower id
    const other = ctx.characters.get(joust.opponent)!;
    if (ch.id < other.id) updatePair(ch, other, dt);
  }
}

function updatePair(a: Character, b: Character, dt: number): void {
  const ja = a.joust!;
  const jb = b.joust!;
  for (const [ch, joust] of [[a, ja], [b, jb]] as const) {
    if (joust.phase === 'roll-out' && rollAlongPath(ch, dt)) {
      joust.phase = 'ready';
      joust.timer = JOUST_READY_SEC;
    }
    if (joust.phase !== 'roll-out') ch.dir = joust.side === 1 ? Direction.RIGHT : Direction.LEFT;
  }
  if (ja.phase !== jb.phase) return;

  switch (ja.phase) {
    case 'ready':
      ja.timer -= dt;
      if (ja.timer <= 0) ja.phase = jb.phase = 'charge';
      break;
    case 'charge':
      for (const ch of [a, b]) moveX(ch, ch.joust!.side * JOUST_CHARGE_SPEED_PX_PER_SEC * dt);
      if (Math.abs(b.x - a.x) <= JOUST_CONTACT_PX) {
        ja.phase = jb.phase = 'clash';
        ja.timer = JOUST_CLASH_SEC;
        ja.clashX = jb.clashX = (a.x + b.x) / 2;
        // One of them takes the hit and is spun round on their chair
        const loser = Math.random() < 0.5 ? ja : jb;
        loser.spinUntil = performance.now() + JOUST_KNOCK_SPIN_MS;
      }
      break;
    case 'clash':
      for (const ch of [a, b]) moveX(ch, -ch.joust!.side * JOUST_BOUNCE_SPEED_PX_PER_SEC * dt);
      ja.timer -= dt;
      if (ja.timer <= 0) {
        ja.phase = jb.phase = 'retreat';
        ja.clashX = jb.clashX = null;
      }
      break;
    case 'retreat': {
      // Back off to their ends, still facing each other
      let home = true;
      for (const ch of [a, b]) {
        const gap = ch.joust!.endX - ch.x;
        const step = JOUST_RETREAT_SPEED_PX_PER_SEC * dt;
        moveX(ch, Math.abs(gap) <= step ? gap : Math.sign(gap) * step);
        if (ch.x !== ch.joust!.endX) home = false;
      }
      if (home) {
        ja.phase = jb.phase = 'ready';
        ja.timer = JOUST_READY_SEC;
      }
      break;
    }
  }
}

function seatOf(ctx: JoustContext, ch: Character): Seat {
  return ctx.seats.get(ch.seatId!)!;
}

/**
 * The best stretch of open floor for two jousters: a straight run along a row, JOUST_MIN_TILES to
 * JOUST_MAX_TILES long, both of them can roll out to, as close to their desks as possible.
 */
function findLists(ctx: JoustContext, a: Character, b: Character, taken: Set<string>): Lists | null {
  const seatA = seatOf(ctx, a);
  const seatB = seatOf(ctx, b);
  const midCol = (seatA.seatCol + seatB.seatCol) / 2;
  const midRow = (seatA.seatRow + seatB.seatRow) / 2;
  const covered = coveredTiles(ctx.furniture);
  const open = new Set(
    ctx.walkableTiles
      .map((t) => `${t.col},${t.row}`)
      .filter((key) => !taken.has(key) && !ctx.blockedTiles.has(key) && !covered.has(key)),
  );

  const candidates: Array<Lists & { score: number }> = [];
  const rows = [...new Set(ctx.walkableTiles.map((t) => t.row))];
  for (const row of rows) {
    const cols = ctx.walkableTiles.filter((t) => t.row === row && open.has(`${t.col},${row}`)).map((t) => t.col).sort((x, y) => x - y);
    let start = 0;
    for (let i = 1; i <= cols.length; i++) {
      if (i < cols.length && cols[i] === cols[i - 1] + 1) continue;
      const runStart = cols[start];
      const runLength = cols[i - 1] - runStart + 1;
      start = i;
      if (runLength < JOUST_MIN_TILES) continue;
      // The run's middle stretch, as long as it's allowed to be
      const length = Math.min(runLength, JOUST_MAX_TILES);
      const leftCol = runStart + Math.floor((runLength - length) / 2);
      const rightCol = leftCol + length - 1;
      const score = Math.abs(row - midRow) + Math.abs((leftCol + rightCol) / 2 - midCol) * 0.5;
      candidates.push({ row, leftCol, rightCol, score });
    }
  }
  candidates.sort((x, y) => x.score - y.score);

  const [left, right] = seatA.seatCol <= seatB.seatCol ? [a, b] : [b, a];
  for (const lists of candidates.slice(0, 5)) {
    const reach = (ch: Character, col: number) =>
      findPath(ch.tileCol, ch.tileRow, col, lists.row, ctx.tileMap, ctx.blockedTiles).length > 0;
    if (reach(left, lists.leftCol) && reach(right, lists.rightCol)) return lists;
  }
  return null;
}

/**
 * Floor tiles any furniture sprite is drawn over, including the walk-behind rows at the back of
 * tall pieces (a table's far edge, a monitor's top): jousters there would vanish behind them.
 */
function coveredTiles(furniture: PlacedFurniture[]): Set<string> {
  const covered = new Set<string>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    const rows = Math.ceil(entry.sprite.length / TILE_SIZE);
    const cols = Math.ceil((entry.sprite[0]?.length ?? 0) / TILE_SIZE);
    for (let dr = 0; dr < rows; dr++) {
      for (let dc = 0; dc < cols; dc++) covered.add(`${item.col + dc},${item.row + dr}`);
    }
  }
  return covered;
}

function enterLists(ctx: JoustContext, ch: Character, opponent: number, side: 1 | -1, col: number, row: number): void {
  const joust: ChairJoust = {
    opponent,
    phase: 'roll-out',
    side,
    endX: centerX(col),
    timer: 0,
    spinUntil: 0,
    clashX: null,
  };
  ch.joust = joust;
  ch.path = findPath(ch.tileCol, ch.tileRow, col, row, ctx.tileMap, ctx.blockedTiles);
  ch.moveProgress = 0;
}

function sendHome(ctx: JoustContext, ch: Character): void {
  const joust = ch.joust!;
  joust.phase = 'roll-home';
  joust.clashX = null;
  // Out on the lists they can be between tiles: start home from the nearest one
  ch.tileCol = Math.floor(ch.x / TILE_SIZE);
  ch.path = ctx.pathToSeat(ch);
  ch.moveProgress = 0;
}

function sitBackDown(ctx: JoustContext, ch: Character): void {
  const seat = ctx.seats.get(ch.seatId ?? '');
  if (seat) {
    ch.tileCol = seat.seatCol;
    ch.tileRow = seat.seatRow;
    ch.x = centerX(seat.seatCol);
    ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
    ch.dir = seat.facingDir;
  }
  ch.joust = null;
  ch.state = CharacterState.TYPE;
  ch.frame = 0;
  ch.frameTimer = 0;
}

/** Roll along the character's path on their chair; true once they've arrived. */
function rollAlongPath(ch: Character, dt: number): boolean {
  const next = ch.path[0];
  if (!next) return true;
  ch.dir =
    next.col > ch.tileCol ? Direction.RIGHT : next.col < ch.tileCol ? Direction.LEFT : next.row > ch.tileRow ? Direction.DOWN : Direction.UP;
  ch.moveProgress += (JOUST_ROLL_SPEED_PX_PER_SEC / TILE_SIZE) * dt;
  const t = Math.min(ch.moveProgress, 1);
  const fromX = centerX(ch.tileCol);
  const fromY = ch.tileRow * TILE_SIZE + TILE_SIZE / 2;
  ch.x = fromX + (centerX(next.col) - fromX) * t;
  ch.y = fromY + (next.row * TILE_SIZE + TILE_SIZE / 2 - fromY) * t;
  if (ch.moveProgress >= 1) {
    ch.tileCol = next.col;
    ch.tileRow = next.row;
    ch.path.shift();
    ch.moveProgress = 0;
  }
  return ch.path.length === 0;
}

/** Slide along the lists, keeping the character's tile in step with where they are. */
function moveX(ch: Character, dx: number): void {
  ch.x += dx;
  ch.tileCol = Math.floor(ch.x / TILE_SIZE);
}
