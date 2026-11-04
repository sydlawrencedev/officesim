import { CHARACTER_Z_SORT_OFFSET } from '../../constants.js';
import {
  coffeePourOverlay,
  COFFEE_MACHINE_TYPE,
  cupOverlay,
  DRINK_SEC,
  isDrinking,
  POUR_SEC,
  WATER_COOLER_TYPE,
  waterPourOverlay,
} from './drinkStations.js';
import { getFurnitureOverride } from './furnitureOverrides.js';
import { getColorizedSprite } from '../colorize.js';
import { getCatalogEntry } from '../layout/furnitureCatalog.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import type { Character, LeisureSpot, PlacedFurniture, SpriteData } from '../types.js';
import { CharacterState, TILE_SIZE } from '../types.js';
import { endAbandonedPingPong, PING_PONG_TYPE, pingPongDrawables } from './pingPong.js';

export interface LeisureRenderState {
  furniture: PlacedFurniture[];
  spots: Map<string, LeisureSpot>;
  /** Walk a player to another spot around the same table between shots */
  moveTo: (ch: Character, spotKey: string) => boolean;
  isFree: (spotKey: string, ch: Character) => boolean;
}

interface ZDrawable {
  zY: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

const Z_EPSILON = 0.0005;

// ── Scores ──────────────────────────────────────────────────────

export type LeisureGame = 'arcade' | 'pool' | 'pingpong';
export interface GameUpdate {
  game: LeisureGame;
  /** Stays the same from a game's start to its end */
  gameId: string;
  /** The character playing */
  characterId: number;
  /** 0 when the game starts, the final score when it ends */
  score: number;
  finished: boolean;
  /** For games with a winner (ping pong): whether this player won */
  won?: boolean;
}

let gameListener: ((update: GameUpdate) => void) | null = null;

/** Be told each time a character starts a game, and again with their score when it ends */
export function setGameListener(listener: ((update: GameUpdate) => void) | null): void {
  gameListener = listener;
}

/** Report a new game and return its id */
export function startGame(game: LeisureGame, characterId: number): string {
  const gameId = crypto.randomUUID();
  gameListener?.({ game, gameId, characterId, score: 0, finished: false });
  return gameId;
}

export function finishGame(game: LeisureGame, gameId: string, characterId: number, score: number, won?: boolean): void {
  gameListener?.({ game, gameId, characterId, score, finished: true, ...(won === undefined ? {} : { won }) });
}

// ── Pixel helpers (all coordinates in sprite pixels) ────────────

function px(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, zoom: number): void {
  c.fillRect(Math.round(x * zoom), Math.round(y * zoom), Math.ceil(w * zoom), Math.ceil(h * zoom));
}

/** Draw a 1px line by sampling along it, snapped to the sprite pixel grid */
function pixelLine(
  c: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  zoom: number,
): void {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    px(c, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), 1, 1, zoom);
  }
}

// ── Pool ────────────────────────────────────────────────────────

/** Felt bounds and pockets within the 80x48 POOL_TABLE sprite */
const FELT = { left: 10, top: 11, right: 69, bottom: 32 };
const FELT_KEEP_COLORS = new Set(['#1c7c4e', '#0e261c', '#2e9362', '#3aa671', '#104a2f']);
const FELT_COLOR = '#1c7c4e';
const BALL_RADIUS = 2;
/** Sample pixel of plain felt, used to pick up any colour override */
const FELT_SAMPLE = { x: 20, y: 20 };
const POCKETS = [
  { x: 9, y: 10 },
  { x: 40, y: 10 },
  { x: 70, y: 10 },
  { x: 9, y: 33 },
  { x: 40, y: 33 },
  { x: 70, y: 33 },
];
const POCKET_RADIUS = 3;
/**
 * How near a pocket a ball's centre must come to drop. The cushions keep centres a ball's radius
 * inside the felt, which is further than POCKET_RADIUS from every pocket, so a ball drops as it
 * rolls into the pocket's mouth, before the cushion would turn it back.
 */
const POCKET_CAPTURE = POCKET_RADIUS + 1.5;
const CUE_BALL_COLOR = '#f5f5eb';
const OBJECT_BALL_COLORS = ['#db2d2d', '#f5d437', '#3662da', '#37b45a', '#e8862a', '#161616'];
const BALL_OUTLINE = '#0a0a0a';
const CUE_COLOR = '#dcb06c';
const CUE_TIP_COLOR = '#f5f5eb';
const CUE_LENGTH = 22;
const AIM_SEC = 1.1;
/** How far behind the cue ball (sprite px) the shooter wants to stand */
const STANCE_DISTANCE = 16;
const REPOSITION_TIMEOUT_SEC = 10;
const FRICTION_PER_SEC = 1.4;
const STOP_SPEED = 2;

interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  cue: boolean;
}

interface PoolState {
  balls: Ball[];
  phase: 'aim' | 'rolling' | 'reposition';
  phaseTime: number;
  shooterId: number | null;
  /** Spot the shooter is walking to while repositioning */
  targetSpotKey: string | null;
  /** Unit direction of the current shot */
  aimX: number;
  aimY: number;
  lastTime: number;
  /** Each player's game (one visit to the table) and the balls they've potted in it, by character id */
  visits: Map<number, { gameId: string; potted: number }>;
}

const poolStates = new Map<string, PoolState>();
const cleanTableSprites = new WeakMap<SpriteData, SpriteData>();

function rackBalls(): Ball[] {
  const balls: Ball[] = [{ x: 24, y: 22, vx: 0, vy: 0, color: CUE_BALL_COLOR, cue: true }];
  let i = 0;
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row <= col; row++) {
      balls.push({
        x: 50 + col * 4,
        y: 22 + (row - col / 2) * 4.4,
        vx: 0,
        vy: 0,
        color: OBJECT_BALL_COLORS[i++ % OBJECT_BALL_COLORS.length],
        cue: false,
      });
    }
  }
  return balls;
}

/** The table sprite (with any colour override) with its painted balls and cue replaced by bare felt */
function getCleanTableSprite(table: PlacedFurniture, base: SpriteData): SpriteData {
  // A theme's own table comes with a ball-free version.
  const themed = getFurnitureOverride('POOL_TABLE#clean');
  if (themed) return themed;
  let sprite = base;
  if (table.color) {
    const { h, s, b, c } = table.color;
    sprite = getColorizedSprite(`furn-${table.type}-${h}-${s}-${b}-${c}-${table.color.colorize ? 1 : 0}`, base, table.color);
  }
  let clean = cleanTableSprites.get(sprite);
  if (!clean) {
    const felt = sprite[FELT_SAMPLE.y]?.[FELT_SAMPLE.x] || FELT_COLOR;
    clean = sprite.map((row, y) =>
      row.map((color, x) => {
        const original = base[y][x];
        const onFelt = x >= FELT.left && x <= FELT.right && y >= FELT.top && y <= FELT.bottom;
        return onFelt && original && !FELT_KEEP_COLORS.has(original.slice(0, 7)) ? felt : color;
      }),
    );
    cleanTableSprites.set(sprite, clean);
  }
  return clean;
}

/** Where a player's hands are, relative to the table origin */
function handPosition(ch: Character, tableX: number, tableY: number): { x: number; y: number } {
  return { x: ch.x - tableX, y: ch.y - 10 - tableY };
}

function chooseShot(state: PoolState, shooter: Character, tableX: number, tableY: number): void {
  const cueBall = state.balls.find((b) => b.cue);
  if (!cueBall) return;
  const hand = handPosition(shooter, tableX, tableY);
  let awayX = cueBall.x - hand.x;
  let awayY = cueBall.y - hand.y;
  const awayLen = Math.hypot(awayX, awayY) || 1;
  awayX /= awayLen;
  awayY /= awayLen;
  // Aim at the object ball that lines up best with where the player stands
  let best = { x: awayX, y: awayY, score: 0.3 };
  for (const ball of state.balls) {
    if (ball.cue) continue;
    const dx = ball.x - cueBall.x;
    const dy = ball.y - cueBall.y;
    const len = Math.hypot(dx, dy) || 1;
    const score = (dx / len) * awayX + (dy / len) * awayY;
    if (score > best.score) best = { x: dx / len, y: dy / len, score };
  }
  state.aimX = best.x;
  state.aimY = best.y;
}

/** Move the balls on; returns how many object balls dropped into pockets */
function stepPool(state: PoolState, dt: number): number {
  const friction = Math.exp(-FRICTION_PER_SEC * dt);
  // Pockets first (a sunk cue ball is respotted once the table settles)
  const before = state.balls.filter((ball) => !ball.cue).length;
  state.balls = state.balls.filter((ball) => {
    const x = ball.x + ball.vx * dt;
    const y = ball.y + ball.vy * dt;
    return !POCKETS.some((p) => Math.hypot(x - p.x, y - p.y) < POCKET_CAPTURE);
  });
  const potted = before - state.balls.filter((ball) => !ball.cue).length;
  for (const ball of state.balls) {
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.vx *= friction;
    ball.vy *= friction;
    if (Math.hypot(ball.vx, ball.vy) < STOP_SPEED) {
      ball.vx = 0;
      ball.vy = 0;
    }
    const minX = FELT.left + BALL_RADIUS;
    const maxX = FELT.right - BALL_RADIUS;
    const minY = FELT.top + BALL_RADIUS;
    const maxY = FELT.bottom - BALL_RADIUS;
    if (ball.x < minX || ball.x > maxX) {
      ball.x = Math.min(maxX, Math.max(minX, ball.x));
      ball.vx = -ball.vx * 0.8;
    }
    if (ball.y < minY || ball.y > maxY) {
      ball.y = Math.min(maxY, Math.max(minY, ball.y));
      ball.vy = -ball.vy * 0.8;
    }
  }

  // Equal-mass elastic collisions
  for (let i = 0; i < state.balls.length; i++) {
    for (let j = i + 1; j < state.balls.length; j++) {
      const a = state.balls[i];
      const b = state.balls[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist === 0 || dist >= BALL_RADIUS * 2) continue;
      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = BALL_RADIUS * 2 - dist;
      a.x -= (nx * overlap) / 2;
      a.y -= (ny * overlap) / 2;
      b.x += (nx * overlap) / 2;
      b.y += (ny * overlap) / 2;
      const relative = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      if (relative <= 0) continue;
      a.vx -= relative * nx;
      a.vy -= relative * ny;
      b.vx += relative * nx;
      b.vy += relative * ny;
    }
  }
  return potted;
}

/** Pick who shoots next and, if needed, walk them to the spot that lines up the shot */
function planNextShot(
  state: PoolState,
  table: PlacedFurniture,
  members: Character[],
  tableSpots: LeisureSpot[],
  leisure: LeisureRenderState,
): void {
  state.phaseTime = 0;
  state.targetSpotKey = null;
  const ready = members.filter((m) => m.state === CharacterState.LEISURE);
  if (ready.length === 0) {
    state.shooterId = null;
    state.phase = 'aim';
    return;
  }
  const currentIndex = ready.findIndex((m) => m.id === state.shooterId);
  const shooter = ready[(currentIndex + 1) % ready.length];
  state.shooterId = shooter.id;

  const tableX = table.col * TILE_SIZE;
  const tableY = table.row * TILE_SIZE;
  const cueBall = state.balls.find((b) => b.cue);
  const targets = state.balls.filter((b) => !b.cue);
  if (cueBall && targets.length > 0) {
    const target = targets[Math.floor(Math.random() * targets.length)];
    const dx = target.x - cueBall.x;
    const dy = target.y - cueBall.y;
    const len = Math.hypot(dx, dy) || 1;
    // Stand behind the cue ball, on the far side from the target
    const standX = tableX + cueBall.x - (dx / len) * STANCE_DISTANCE;
    const standY = tableY + cueBall.y - (dy / len) * STANCE_DISTANCE;
    let best: LeisureSpot | null = null;
    let bestDist = Infinity;
    for (const spot of tableSpots) {
      if (!leisure.isFree(spot.key, shooter)) continue;
      const dist = Math.hypot(spot.col * TILE_SIZE + TILE_SIZE / 2 - standX, spot.row * TILE_SIZE + TILE_SIZE / 2 - standY);
      if (dist < bestDist) {
        best = spot;
        bestDist = dist;
      }
    }
    if (best && best.key !== shooter.leisureSpotKey && leisure.moveTo(shooter, best.key)) {
      state.phase = 'reposition';
      state.targetSpotKey = best.key;
      return;
    }
  }
  state.phase = 'aim';
  chooseShot(state, shooter, tableX, tableY);
}

function updatePool(
  state: PoolState,
  table: PlacedFurniture,
  members: Character[],
  tableSpots: LeisureSpot[],
  leisure: LeisureRenderState,
  now: number,
): void {
  const dt = Math.min(0.05, Math.max(0, (now - state.lastTime) / 1000));
  state.lastTime = now;
  state.phaseTime += dt;
  const shooter = members.find((m) => m.id === state.shooterId);

  if (state.phase === 'rolling') {
    const potted = stepPool(state, dt);
    const visit = state.shooterId !== null ? state.visits.get(state.shooterId) : undefined;
    if (visit) visit.potted += potted;
    if (state.balls.some((b) => b.vx !== 0 || b.vy !== 0)) return;
    // Respot the cue ball if it went down; re-rack once the table is cleared
    if (!state.balls.some((b) => b.cue)) {
      state.balls.push({ x: 24, y: 22, vx: 0, vy: 0, color: CUE_BALL_COLOR, cue: true });
    }
    if (!state.balls.some((b) => !b.cue)) state.balls = rackBalls();
    planNextShot(state, table, members, tableSpots, leisure);
    return;
  }

  if (state.phase === 'reposition') {
    const arrived = shooter?.state === CharacterState.LEISURE && shooter.leisureSpotKey === state.targetSpotKey;
    if (arrived) {
      state.phase = 'aim';
      state.phaseTime = 0;
      chooseShot(state, shooter, table.col * TILE_SIZE, table.row * TILE_SIZE);
    } else if (!shooter || shooter.state === CharacterState.IDLE || state.phaseTime > REPOSITION_TIMEOUT_SEC) {
      planNextShot(state, table, members, tableSpots, leisure);
    }
    return;
  }

  // Aiming: needs a shooter who is at the table
  if (!shooter || shooter.state !== CharacterState.LEISURE) {
    planNextShot(state, table, members, tableSpots, leisure);
    return;
  }
  if (state.phaseTime >= AIM_SEC) {
    const cueBall = state.balls.find((b) => b.cue);
    if (cueBall) {
      const speed = 70 + Math.random() * 40;
      cueBall.vx = state.aimX * speed;
      cueBall.vy = state.aimY * speed;
    }
    state.phase = 'rolling';
    state.phaseTime = 0;
  }
}

function drawBall(c: CanvasRenderingContext2D, ball: Ball, zoom: number): void {
  const x = Math.round(ball.x);
  const y = Math.round(ball.y);
  c.fillStyle = BALL_OUTLINE;
  px(c, x - 2, y - 1, 5, 3, zoom);
  px(c, x - 1, y - 2, 3, 5, zoom);
  c.fillStyle = ball.color;
  px(c, x - 1, y - 1, 3, 3, zoom);
}

function drawCue(c: CanvasRenderingContext2D, tipX: number, tipY: number, dirX: number, dirY: number, zoom: number): void {
  c.fillStyle = CUE_COLOR;
  pixelLine(c, tipX, tipY, tipX - dirX * CUE_LENGTH, tipY - dirY * CUE_LENGTH, zoom);
  c.fillStyle = CUE_TIP_COLOR;
  px(c, Math.round(tipX), Math.round(tipY), 1, 1, zoom);
}

function poolDrawables(
  table: PlacedFurniture,
  members: Character[],
  leisure: LeisureRenderState,
  offsetX: number,
  offsetY: number,
  zoom: number,
  now: number,
): ZDrawable[] {
  const entry = getCatalogEntry(table.type);
  if (!entry) return [];
  const tableX = table.col * TILE_SIZE;
  const tableY = table.row * TILE_SIZE;
  const tableZY = tableY + entry.sprite.length;
  const tableSpots = [...leisure.spots.values()].filter((spot) => spot.kind === 'pool' && spot.furnitureUid === table.uid);

  let state = poolStates.get(table.uid);
  if (!state) {
    state = {
      balls: rackBalls(),
      phase: 'aim',
      phaseTime: 0,
      shooterId: null,
      targetSpotKey: null,
      aimX: 1,
      aimY: 0,
      lastTime: now,
      visits: new Map(),
    };
    poolStates.set(table.uid, state);
  }
  // A game starts when a player reaches the table and ends, with what they potted, when they leave
  for (const member of members) {
    if (member.state === CharacterState.LEISURE && !state.visits.has(member.id)) {
      state.visits.set(member.id, { gameId: startGame('pool', member.id), potted: 0 });
    }
  }
  for (const [id, visit] of state.visits) {
    if (members.some((m) => m.id === id)) continue;
    finishGame('pool', visit.gameId, id, visit.potted);
    state.visits.delete(id);
  }
  updatePool(state, table, members, tableSpots, leisure, now);

  const poolState = state;
  const originX = offsetX + tableX * zoom;
  const originY = offsetY + tableY * zoom;
  const cleanSprite = getCleanTableSprite(table, entry.sprite);
  const clean = getCachedSprite(cleanSprite, zoom);
  const feltColor = cleanSprite[FELT_SAMPLE.y]?.[FELT_SAMPLE.x] || FELT_COLOR;
  const drawables: ZDrawable[] = [
    {
      zY: tableZY + Z_EPSILON,
      draw: (c) => {
        c.save();
        c.translate(Math.round(originX), Math.round(originY));
        // Solid felt underneath: at fractional zoom the sprite's pixel seams are
        // translucent and would let the painted balls and cue show through
        c.fillStyle = feltColor;
        px(c, FELT.left, FELT.top, FELT.right - FELT.left + 1, FELT.bottom - FELT.top + 1, zoom);
        c.drawImage(clean, 0, 0);
        for (const ball of poolState.balls) drawBall(c, ball, zoom);
        c.restore();
      },
    },
  ];

  for (const player of members) {
    // Players walking round the table carry their cue out of sight
    if (player.state !== CharacterState.LEISURE) continue;
    const charZY = player.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET;
    if (player.id === poolState.shooterId && poolState.phase === 'aim') {
      const cueBall = poolState.balls.find((b) => b.cue);
      if (!cueBall) continue;
      // Draw back slowly, then thrust through the cue ball
      const t = poolState.phaseTime / AIM_SEC;
      const gap = t < 0.8 ? 2 + (t / 0.8) * 5 + Math.sin(t * 30) * 0.5 : 7 * (1 - (t - 0.8) / 0.2);
      const tipX = cueBall.x - poolState.aimX * (BALL_RADIUS + gap);
      const tipY = cueBall.y - poolState.aimY * (BALL_RADIUS + gap);
      drawables.push({
        zY: Math.max(charZY, tableZY) + Z_EPSILON * 2,
        draw: (c) => {
          c.save();
          c.translate(Math.round(originX), Math.round(originY));
          drawCue(c, tipX, tipY, poolState.aimX, poolState.aimY, zoom);
          c.restore();
        },
      });
    } else {
      // Waiting players rest their cue upright beside them
      const cueX = player.x + 5;
      drawables.push({
        zY: charZY + Z_EPSILON,
        draw: (c) => {
          c.save();
          c.translate(Math.round(offsetX), Math.round(offsetY));
          drawCue(c, cueX, player.y - 20, 0, -1, zoom);
          c.restore();
        },
      });
    }
  }
  return drawables;
}

// ── Arcade space invaders ───────────────────────────────────────

/** Screen area within the 32x48 ARCADE_MACHINE sprite */
const SCREEN = { x: 10, y: 15, w: 12, h: 9 };
/** The game runs on a half-pixel grid so the invaders have room for a shape */
const CELL = 0.5;
const GRID = { w: SCREEN.w / CELL, h: SCREEN.h / CELL };
const TICK_SEC = 0.05;
const FLEET_COLS = 5;
const FLEET_ROWS = 3;
const INVADER_W = 3;
const INVADER_H = 2;
const INVADER_PITCH_X = 4;
const INVADER_PITCH_Y = 3;
/** Invader art, two frames so the legs shuffle as the fleet marches */
const INVADER_FRAMES = [
  ['###', '#.#'],
  ['###', '.#.'],
];
const CANNON = ['.#.', '###'];
const CANNON_Y = GRID.h - CANNON.length;
const INVADERS_BG = '#0c1022';
const INVADER_COLORS = ['#f06595', '#4dabf7', '#e9ecef'];
const CANNON_COLOR = '#51cf66';
const SHOT_COLOR = '#f8f9fa';
const BOMB_COLOR = '#ffa94d';

interface Cell {
  x: number;
  y: number;
}

interface InvadersState {
  /** alive[row][col] */
  alive: boolean[][];
  fleet: Cell;
  dir: 1 | -1;
  frame: number;
  cannonX: number;
  shot: Cell | null;
  bombs: Cell[];
  /** Ticks until the fleet next steps; it speeds up as invaders fall */
  fleetTimer: number;
  tickTimer: number;
  lastTime: number;
  /** The character at the controls, and their current game */
  playerId: number;
  gameId: string;
  score: number;
  /** Waves cleared so far; each new one starts lower down */
  wave: number;
}

/** Points per invader by fleet row, top row first */
const INVADER_POINTS = [30, 20, 10];
const WAVE_BONUS = 100;
/** Rows lower each new wave starts, up to a limit so it can still be cleared */
const WAVE_DROP = 2;
const MAX_WAVE_DROP = 4;

const invaderStates = new Map<string, InvadersState>();

/** A new game for the player, or the next wave of their game when it's given */
function newInvaders(now: number, playerId: number, next?: { gameId: string; score: number; wave: number }): InvadersState {
  const wave = next?.wave ?? 0;
  return {
    alive: Array.from({ length: FLEET_ROWS }, () => Array<boolean>(FLEET_COLS).fill(true)),
    fleet: { x: 0, y: 1 + Math.min(wave * WAVE_DROP, MAX_WAVE_DROP) },
    dir: 1,
    frame: 0,
    cannonX: Math.floor((GRID.w - CANNON[0].length) / 2),
    shot: null,
    bombs: [],
    fleetTimer: 0,
    tickTimer: 0,
    lastTime: now,
    playerId,
    gameId: next?.gameId ?? startGame('arcade', playerId),
    score: next?.score ?? 0,
    wave,
  };
}

function finishInvaders(state: InvadersState): void {
  finishGame('arcade', state.gameId, state.playerId, state.score);
}

function livingInvaders(state: InvadersState): Cell[] {
  const cells: Cell[] = [];
  state.alive.forEach((row, r) =>
    row.forEach((alive, c) => {
      if (alive) cells.push({ x: state.fleet.x + c * INVADER_PITCH_X, y: state.fleet.y + r * INVADER_PITCH_Y });
    }),
  );
  return cells;
}

/** Advance one tick: the wave is cleared, the game is over (fleet landed or cannon hit), or play goes on. */
function stepInvaders(state: InvadersState): 'playing' | 'cleared' | 'over' {
  if (livingInvaders(state).length === 0) return 'cleared';

  // March: sideways until an edge, then drop a row and turn around
  if (--state.fleetTimer <= 0) {
    const invaders = livingInvaders(state);
    state.fleetTimer = 2 + Math.ceil((invaders.length / (FLEET_ROWS * FLEET_COLS)) * 6);
    const minX = Math.min(...invaders.map((i) => i.x));
    const maxX = Math.max(...invaders.map((i) => i.x)) + INVADER_W;
    if ((state.dir > 0 && maxX >= GRID.w) || (state.dir < 0 && minX <= 0)) {
      state.fleet.y += 1;
      state.dir = state.dir > 0 ? -1 : 1;
    } else {
      state.fleet.x += state.dir;
    }
    state.frame ^= 1;
  }
  const invaders = livingInvaders(state);
  if (Math.max(...invaders.map((i) => i.y)) + INVADER_H > CANNON_Y) return 'over';

  // The cannon hunts the invader nearest the front, with the odd hesitation so it looks hand-played
  const target = invaders.reduce((best, i) => (i.y > best.y || (i.y === best.y && Math.abs(i.x - state.cannonX) < Math.abs(best.x - state.cannonX)) ? i : best));
  const aimX = target.x; // both the barrel and the invader's centre are their middle column
  const threat = state.bombs.find((b) => b.y >= CANNON_Y - 5 && b.x >= state.cannonX - 1 && b.x <= state.cannonX + CANNON[0].length);
  if (threat) state.cannonX += threat.x > state.cannonX + 1 || state.cannonX + CANNON[0].length >= GRID.w ? -1 : 1;
  else if (Math.random() > 0.15) state.cannonX += Math.sign(aimX - state.cannonX);
  state.cannonX = Math.max(0, Math.min(GRID.w - CANNON[0].length, state.cannonX));
  if (!state.shot && state.cannonX === aimX && Math.random() < 0.5) state.shot = { x: state.cannonX + 1, y: CANNON_Y - 1 };

  if (state.shot) {
    state.shot.y -= 1;
    const shot = state.shot;
    const hit = invaders.find((i) => shot.x >= i.x && shot.x < i.x + INVADER_W && shot.y >= i.y && shot.y < i.y + INVADER_H);
    if (hit) {
      const row = (hit.y - state.fleet.y) / INVADER_PITCH_Y;
      state.alive[row][(hit.x - state.fleet.x) / INVADER_PITCH_X] = false;
      state.score += INVADER_POINTS[row] ?? INVADER_POINTS[INVADER_POINTS.length - 1];
      state.shot = null;
    } else if (shot.y < 0) {
      state.shot = null;
    }
  }

  // Bottom invaders now and then drop a bomb; one reaching the cannon ends the round
  if (Math.random() < 0.03) {
    const bottoms = invaders.filter((i) => !invaders.some((o) => o.x === i.x && o.y > i.y));
    const bomber = bottoms[Math.floor(Math.random() * bottoms.length)];
    state.bombs.push({ x: bomber.x + 1, y: bomber.y + INVADER_H });
  }
  for (const bomb of state.bombs) bomb.y += 1;
  if (state.bombs.some((b) => b.y >= CANNON_Y + (b.x === state.cannonX + 1 ? 0 : 1) && b.x >= state.cannonX && b.x < state.cannonX + CANNON[0].length)) {
    return 'over';
  }
  state.bombs = state.bombs.filter((b) => b.y < GRID.h);
  return 'playing';
}

function drawArt(c: CanvasRenderingContext2D, art: string[], x: number, y: number, zoom: number): void {
  art.forEach((line, dy) => {
    for (let dx = 0; dx < line.length; dx++) {
      if (line[dx] === '#') px(c, (x + dx) * CELL, (y + dy) * CELL, CELL, CELL, zoom);
    }
  });
}

function arcadeDrawable(arcade: PlacedFurniture, playerId: number, offsetX: number, offsetY: number, zoom: number, now: number): ZDrawable | null {
  const entry = getCatalogEntry(arcade.type);
  if (!entry) return null;
  let state = invaderStates.get(arcade.uid);
  if (!state || state.playerId !== playerId) {
    // Someone new at the controls: whoever had them walked away mid-game
    if (state) finishInvaders(state);
    state = newInvaders(now, playerId);
  }
  const dt = Math.min(0.1, Math.max(0, (now - state.lastTime) / 1000));
  state.lastTime = now;
  state.tickTimer += dt;
  while (state.tickTimer >= TICK_SEC) {
    state.tickTimer -= TICK_SEC;
    const outcome = stepInvaders(state);
    if (outcome === 'cleared') {
      state = newInvaders(now, playerId, { gameId: state.gameId, score: state.score + WAVE_BONUS, wave: state.wave + 1 });
    } else if (outcome === 'over') {
      finishInvaders(state);
      state = newInvaders(now, playerId);
    }
  }
  invaderStates.set(arcade.uid, state);

  const game = state;
  const screenX = offsetX + (arcade.col * TILE_SIZE + SCREEN.x) * zoom;
  const screenY = offsetY + (arcade.row * TILE_SIZE + SCREEN.y) * zoom;
  return {
    zY: arcade.row * TILE_SIZE + entry.sprite.length + Z_EPSILON,
    draw: (c) => {
      c.save();
      c.translate(Math.round(screenX), Math.round(screenY));
      c.fillStyle = INVADERS_BG;
      px(c, 0, 0, SCREEN.w, SCREEN.h, zoom);
      game.alive.forEach((row, r) => {
        c.fillStyle = INVADER_COLORS[r % INVADER_COLORS.length];
        row.forEach((alive, col) => {
          if (alive) drawArt(c, INVADER_FRAMES[game.frame], game.fleet.x + col * INVADER_PITCH_X, game.fleet.y + r * INVADER_PITCH_Y, zoom);
        });
      });
      c.fillStyle = BOMB_COLOR;
      for (const bomb of game.bombs) px(c, bomb.x * CELL, bomb.y * CELL, CELL, CELL, zoom);
      if (game.shot) {
        c.fillStyle = SHOT_COLOR;
        px(c, game.shot.x * CELL, game.shot.y * CELL, CELL, CELL, zoom);
      }
      c.fillStyle = CANNON_COLOR;
      drawArt(c, CANNON, game.cannonX, CANNON_Y, zoom);
      c.restore();
    },
  };
}

// ── Entry point ─────────────────────────────────────────────────

/** Animated overlays for pool tables and arcade machines currently in use */
export function getLeisureDrawables(
  leisure: LeisureRenderState,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): ZDrawable[] {
  const playersByFurniture = new Map<string, Character[]>();
  for (const ch of characters) {
    if (!ch.leisureSpotKey || (ch.state !== CharacterState.LEISURE && ch.state !== CharacterState.WALK)) continue;
    const spot = leisure.spots.get(ch.leisureSpotKey);
    if (!spot || spot.kind === 'sofa') continue;
    const players = playersByFurniture.get(spot.furnitureUid) ?? [];
    players.push(ch);
    playersByFurniture.set(spot.furnitureUid, players);
  }

  const now = performance.now();
  const drawables: ZDrawable[] = [];
  const playedArcades = new Set<string>();
  const playedPingPong = new Set<string>();
  for (const item of leisure.furniture) {
    const players = playersByFurniture.get(item.uid);
    if (!players) {
      // A station someone clicked pours on its own
      if (clickedPours.has(item.uid)) drawables.push(...drinkStationDrawables(item, [], offsetX, offsetY, zoom, now));
      continue;
    }
    if (item.type.startsWith('POOL_TABLE')) {
      players.sort((a, b) => a.id - b.id);
      drawables.push(...poolDrawables(item, players, leisure, offsetX, offsetY, zoom, now));
    } else if (item.type.startsWith('ARCADE_MACHINE')) {
      const player = players.find((p) => p.state === CharacterState.LEISURE);
      if (!player) continue;
      playedArcades.add(item.uid);
      const drawable = arcadeDrawable(item, player.id, offsetX, offsetY, zoom, now);
      if (drawable) drawables.push(drawable);
    } else if (item.type === COFFEE_MACHINE_TYPE || item.type === WATER_COOLER_TYPE) {
      drawables.push(...drinkStationDrawables(item, players, offsetX, offsetY, zoom, now));
    } else if (item.type === PING_PONG_TYPE) {
      playedPingPong.add(item.uid);
      const spots = [...leisure.spots.values()].filter((spot) => spot.kind === 'pingpong' && spot.furnitureUid === item.uid);
      drawables.push(...pingPongDrawables(item, players, spots, offsetX, offsetY, zoom, now));
    }
  }
  endAbandonedGames(playersByFurniture, playedArcades);
  endAbandonedPingPong(playedPingPong);
  return drawables;
}

/** Bank the scores of games whose players have all walked away */
function endAbandonedGames(playersByFurniture: Map<string, Character[]>, playedArcades: Set<string>): void {
  for (const [uid, state] of invaderStates) {
    if (playedArcades.has(uid)) continue;
    finishInvaders(state);
    invaderStates.delete(uid);
  }
  for (const [uid, state] of poolStates) {
    if (playersByFurniture.has(uid) || state.visits.size === 0) continue;
    for (const [id, visit] of state.visits) finishGame('pool', visit.gameId, id, visit.potted);
    state.visits.clear();
  }
}

/** When each drinks station (by furniture uid) was clicked to pour, by performance.now() */
const clickedPours = new Map<string, number>();

/** Start a drinks station's pour animation, as if someone were filling a cup */
export function pourAtStation(uid: string): void {
  clickedPours.set(uid, performance.now());
}

/** The machine animating while someone pours, and a cup in the hand of anyone drinking. */
function drinkStationDrawables(
  station: PlacedFurniture,
  users: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  now: number,
): ZDrawable[] {
  const entry = getCatalogEntry(station.type);
  if (!entry) return [];
  const coffee = station.type === COFFEE_MACHINE_TYPE;
  const drawables: ZDrawable[] = [];
  const pourer = users.find((u) => u.state === CharacterState.LEISURE && !isDrinking(u));
  const clickedAt = clickedPours.get(station.uid);
  const clickedProgress = clickedAt === undefined ? null : (now - clickedAt) / 1000 / POUR_SEC;
  if (clickedProgress !== null && clickedProgress >= 1) clickedPours.delete(station.uid);
  const progress = pourer
    ? Math.min(1, (POUR_SEC + DRINK_SEC - pourer.leisureTimer) / POUR_SEC)
    : clickedProgress !== null && clickedProgress < 1
      ? clickedProgress
      : null;
  if (progress !== null) {
    const originX = offsetX + station.col * TILE_SIZE * zoom;
    const originY = offsetY + station.row * TILE_SIZE * zoom;
    drawables.push({
      zY: station.row * TILE_SIZE + entry.sprite.length + Z_EPSILON,
      draw: coffee ? coffeePourOverlay(originX, originY, zoom, progress, now) : waterPourOverlay(originX, originY, zoom, now),
    });
  }
  for (const user of users) {
    if (!isDrinking(user)) continue;
    drawables.push({
      zY: user.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET + Z_EPSILON,
      draw: cupOverlay(offsetX + user.x * zoom, offsetY + user.y * zoom, zoom, coffee ? 'coffee' : 'water', now, user.id % 7),
    });
  }
  return drawables;
}
