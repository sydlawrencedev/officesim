import { CHARACTER_Z_SORT_OFFSET } from '../../constants.js';
import type { Character, LeisureSpot, PlacedFurniture, SpriteData } from '../types.js';
import { CharacterState, TILE_SIZE } from '../types.js';
import { finishGame, startGame } from './leisureEffects.js';

/*
 * The games room's ping pong table, and the matches played on it: two players, one at each end,
 * rallying until someone misses. First to 7 wins, by 2 clear. Each match is reported as a game for
 * both players with the points they scored and whether they won.
 */

export const PING_PONG_TYPE = 'PING_PONG_TABLE';
export const PING_PONG_WIDTH = 64;
export const PING_PONG_HEIGHT = 32;

const OUTLINE = '#0f2a4d';
const SURFACE = '#1f5fae';
const LINE = '#e9ecef';
const EDGE = '#163f78';
const LEG = '#3b3f46';
const NET = '#c7ccd3';
const NET_DARK = '#8f97a3';
const BALL = '#ffffff';
const BALL_SHADOW = 'rgba(0, 0, 0, 0.35)';
const PADDLE = '#d9363e';
const PADDLE_OUTLINE = '#5c1015';
const HANDLE = '#a0703d';
const SCORE_BG = '#15171b';
const SCORE_DIGIT = '#f1f3f5';
const SCORE_WIN = '#ffd43b';

/** The playing surface within the sprite, and the net down its middle */
const SURFACE_BOX = { left: 3, top: 7, right: 60, bottom: 21 };
const NET_X = 31;

/** A 64x32 ping pong table seen from the front: blue top with white lines and the net, front edge and legs. */
export function paintPingPongTable(): SpriteData {
  const px: string[][] = Array.from({ length: PING_PONG_HEIGHT }, () => Array<string>(PING_PONG_WIDTH).fill(''));
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (px[yy]?.[xx] !== undefined) px[yy][xx] = color;
  };
  const s = SURFACE_BOX;
  // Legs and the middle support, under the table
  for (const x of [7, 55]) rect(x, 24, 2, 8, LEG);
  rect(NET_X, 24, 2, 5, LEG);
  // Top: outline, blue surface, white border and centre line
  rect(s.left - 1, s.top - 1, s.right - s.left + 3, s.bottom - s.top + 3, OUTLINE);
  rect(s.left, s.top, s.right - s.left + 1, s.bottom - s.top + 1, SURFACE);
  rect(s.left, s.top, s.right - s.left + 1, 1, LINE);
  rect(s.left, s.bottom, s.right - s.left + 1, 1, LINE);
  rect(s.left, s.top, 1, s.bottom - s.top + 1, LINE);
  rect(s.right, s.top, 1, s.bottom - s.top + 1, LINE);
  rect(s.left, Math.round((s.top + s.bottom) / 2), s.right - s.left + 1, 1, LINE);
  // Front edge of the top
  rect(s.left - 1, s.bottom + 2, s.right - s.left + 3, 2, EDGE);
  rect(s.left - 1, s.bottom + 4, s.right - s.left + 3, 1, OUTLINE);
  // The net, standing a little above the surface, with its white tape along the top
  for (let y = s.top - 2; y <= s.bottom + 1; y++) {
    rect(NET_X, y, 2, 1, (y & 1) === 0 ? NET : NET_DARK);
  }
  rect(NET_X, s.top - 3, 2, 1, LINE);
  return px;
}

// ── Matches ─────────────────────────────────────────────────────

const WIN_POINTS = 7;
const WIN_BY = 2;
/** Seconds for the ball to cross the table, the server's wait before serving, and the pauses after a point and a match */
const SHOT_SEC = 0.75;
const SERVE_SEC = 0.9;
const POINT_SEC = 1.1;
const MATCH_OVER_SEC = 3;
/** Most and fewest returns in a rally before someone misses */
const RALLY_MIN = 1;
const RALLY_MAX = 9;
/** How far past the receiver's paddle a missed ball flies, as a fraction of a shot */
const MISS_OVERSHOOT = 0.4;

/** Paddles relative to the table: x at each end, and the lanes (y) a shot can travel along */
const PADDLE_X: [number, number] = [-3, PING_PONG_WIDTH + 3];
const LANE_TOP = SURFACE_BOX.top + 2;
const LANE_BOTTOM = SURFACE_BOX.bottom - 2;
/** Height of the ball above the table where it's hit */
const HIT_HEIGHT = 4;
/**
 * A shot's flight as arcs between bounces: each ends this far through the shot, rising this high on
 * the way. A return bounces once, on the far side of the net; a serve bounces on the server's own
 * side first, then on the receiver's.
 */
const RETURN_ARCS = [
  { until: 0.62, peak: 6 },
  { until: 1, peak: 5 },
];
const SERVE_ARCS = [
  { until: 0.27, peak: 1.5 },
  { until: 0.73, peak: 5 },
  { until: 1, peak: 4 },
];

type Side = 0 | 1;

interface Match {
  /** Character ids at the left and right ends */
  players: [number, number];
  gameIds: [string, string];
  scores: [number, number];
  phase: 'serve' | 'rally' | 'point' | 'over';
  phaseTime: number;
  /** Who served this point, and who hit the ball now in the air */
  server: Side;
  hitter: Side;
  /** Returns still to come before someone misses */
  returnsLeft: number;
  /** The current shot runs from one lane to another */
  fromLane: number;
  toLane: number;
  /** The last ball missed, so it flies past the paddle */
  missed: boolean;
  /** The ball in the air is the serve (it bounces on the server's side first) */
  serving: boolean;
  winner: Side | null;
}

interface TableState {
  match: Match | null;
  lastTime: number;
  /** A player waiting alone bounces the ball on their paddle */
  soloLane: number;
  /** How far each player (by character id) has moved from their spot: across the end, and back from the table */
  moves: Map<number, { across: number; back: number; stepTime: number }>;
}

/** How fast players shuffle about, in pixels a second, and how far they step back after a hit */
const SHUFFLE_SPEED = 28;
const STEP_BACK = 3;
const LEAN_IN = 1.5;
/** Feet move this often while shuffling */
const STEP_SEC = 0.14;

const tables = new Map<string, TableState>();

const randomLane = () => LANE_TOP + Math.random() * (LANE_BOTTOM - LANE_TOP);
const randomRally = () => RALLY_MIN + Math.floor(Math.random() * (RALLY_MAX - RALLY_MIN + 1));

function newMatch(players: [number, number], server: Side): Match {
  return {
    players,
    gameIds: [startGame('pingpong', players[0]), startGame('pingpong', players[1])],
    scores: [0, 0],
    phase: 'serve',
    phaseTime: 0,
    server,
    hitter: server,
    returnsLeft: randomRally(),
    fromLane: randomLane(),
    toLane: randomLane(),
    missed: false,
    serving: true,
    winner: null,
  };
}

/** Bank a match: the points each player scored, and who won (no one, if it was abandoned) */
function endMatch(match: Match): void {
  match.players.forEach((id, side) => finishGame('pingpong', match.gameIds[side], id, match.scores[side], match.winner === side));
}

function advance(match: Match, dt: number): void {
  match.phaseTime += dt;
  switch (match.phase) {
    case 'serve':
      if (match.phaseTime < SERVE_SEC) return;
      match.phase = 'rally';
      match.phaseTime = 0;
      match.hitter = match.server;
      match.returnsLeft = randomRally();
      match.fromLane = randomLane();
      match.toLane = randomLane();
      match.missed = false;
      match.serving = true;
      return;
    case 'rally': {
      const t = match.phaseTime / SHOT_SEC;
      if (!match.missed && t >= 1) {
        if (match.returnsLeft > 0) {
          // Returned: the other player hits it back
          match.returnsLeft--;
          match.serving = false;
          match.hitter = (1 - match.hitter) as Side;
          match.fromLane = match.toLane;
          match.toLane = randomLane();
          match.phaseTime -= SHOT_SEC;
        } else {
          match.missed = true;
        }
      }
      if (match.missed && t >= 1 + MISS_OVERSHOOT) {
        // The last shot wasn't returned: a point to whoever hit it
        match.scores[match.hitter]++;
        const [a, b] = match.scores;
        const leader: Side = a > b ? 0 : 1;
        if (Math.max(a, b) >= WIN_POINTS && Math.abs(a - b) >= WIN_BY) {
          match.winner = leader;
          match.phase = 'over';
          endMatch(match);
        } else {
          match.phase = 'point';
          // Serve changes ends every two points
          match.server = (Math.floor((a + b) / 2) % 2) as Side;
        }
        match.phaseTime = 0;
      }
      return;
    }
    case 'point':
      if (match.phaseTime >= POINT_SEC) {
        match.phase = 'serve';
        match.phaseTime = 0;
      }
      return;
    case 'over':
      return;
  }
}

/** Where the ball is (table-relative x, lane y, height above the table) during a shot */
function ballInFlight(match: Match): { x: number; lane: number; z: number } {
  const t = Math.min(match.phaseTime / SHOT_SEC, 1 + MISS_OVERSHOOT);
  const from = PADDLE_X[match.hitter];
  const to = PADDLE_X[(1 - match.hitter) as Side];
  const x = from + (to - from) * t;
  const lane = match.fromLane + (match.toLane - match.fromLane) * Math.min(t, 1);
  const arcs = match.serving ? SERVE_ARCS : RETURN_ARCS;
  let start = 0;
  let z = HIT_HEIGHT;
  for (let i = 0; i < arcs.length; i++) {
    const arc = arcs[i];
    const last = i === arcs.length - 1;
    if (t > arc.until && !last) {
      start = arc.until;
      continue;
    }
    // From paddle height (first arc) or the table (after a bounce), to the table or back up to the paddle
    const u = (t - start) / (arc.until - start);
    const from = i === 0 ? HIT_HEIGHT : 0;
    const to = last ? HIT_HEIGHT : 0;
    // Past the receiver's paddle a missed ball keeps falling, off the end of the table
    z = u <= 1 ? from + (to - from) * u + 4 * arc.peak * u * (1 - u) : HIT_HEIGHT - (u - 1) * 14;
    break;
  }
  return { x, lane, z };
}

// ── Drawing ─────────────────────────────────────────────────────

interface ZDrawable {
  zY: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

const Z_EPSILON = 0.0005;

/** 3x5 digits for the scoreboard */
const DIGITS = [
  '###,#.#,#.#,#.#,###', '.#.,##.,.#.,.#.,###', '###,..#,###,#..,###', '###,..#,.##,..#,###', '#.#,#.#,###,..#,..#',
  '###,#..,###,..#,###', '###,#..,###,#.#,###', '###,..#,..#,.#.,.#.', '###,#.#,###,#.#,###', '###,#.#,###,..#,###',
].map((digit) => digit.split(','));

function drawNumber(c: CanvasRenderingContext2D, value: number, rightX: number, y: number, zoom: number, color: string): void {
  const text = String(value);
  let x = rightX - text.length * 4 + 1;
  for (const ch of text) {
    const art = DIGITS[Number(ch)];
    c.fillStyle = color;
    art.forEach((row, dy) => {
      for (let dx = 0; dx < 3; dx++) if (row[dx] === '#') c.fillRect(Math.round((x + dx) * zoom), Math.round((y + dy) * zoom), Math.ceil(zoom), Math.ceil(zoom));
    });
    x += 4;
  }
}

function rectAt(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, zoom: number, color: string): void {
  c.fillStyle = color;
  c.fillRect(Math.round(x * zoom), Math.round(y * zoom), Math.ceil(w * zoom), Math.ceil(h * zoom));
}

/** A paddle held out at (x, y), table-relative: a round red face on a short handle */
function drawPaddle(c: CanvasRenderingContext2D, x: number, y: number, zoom: number): void {
  rectAt(c, x - 1, y + 2, 1, 2, zoom, HANDLE);
  rectAt(c, x - 2, y - 2, 4, 4, zoom, PADDLE_OUTLINE);
  rectAt(c, x - 1, y - 2, 2, 4, zoom, PADDLE);
  rectAt(c, x - 2, y - 1, 4, 2, zoom, PADDLE);
}

/**
 * The game at a table: its two players' paddles, the ball and a scoreboard above the net. Plays the match on
 * as it draws: needs both ends manned (a lone player bounces the ball on their paddle while waiting).
 */
export function pingPongDrawables(
  table: PlacedFurniture,
  players: Character[],
  spots: LeisureSpot[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  now: number,
): ZDrawable[] {
  const tableX = table.col * TILE_SIZE;
  const tableY = table.row * TILE_SIZE;
  const tableZY = tableY + PING_PONG_HEIGHT;
  let state = tables.get(table.uid);
  if (!state) {
    state = { match: null, lastTime: now, soloLane: randomLane(), moves: new Map() };
    tables.set(table.uid, state);
  }
  const dt = Math.min(0.05, Math.max(0, (now - state.lastTime) / 1000));
  state.lastTime = now;

  // Who's at which end, ready to play
  const sideOf = (ch: Character): Side | null => {
    const spot = spots.find((candidate) => candidate.key === ch.leisureSpotKey);
    return spot ? (spot.col < table.col ? 0 : 1) : null;
  };
  const atTable: [Character | null, Character | null] = [null, null];
  for (const ch of players) {
    const side = sideOf(ch);
    if (side !== null && ch.state === CharacterState.LEISURE) atTable[side] = ch;
  }
  const [left, right] = atTable;
  let match = state.match;
  // A player leaving ends the match (scores banked, no winner); a new pair starts a new one
  if (match && (!left || !right || match.players[0] !== left.id || match.players[1] !== right.id)) {
    if (match.phase !== 'over') endMatch(match);
    match = state.match = null;
  }
  if (!match && left && right) match = state.match = newMatch([left.id, right.id], Math.random() < 0.5 ? 0 : 1);
  if (match) {
    advance(match, dt);
    if (match.phase === 'over' && match.phaseTime >= MATCH_OVER_SEC) {
      // Rematch, loser serves
      match = state.match = newMatch(match.players, (1 - (match.winner ?? 0)) as Side);
    }
  }

  const originX = offsetX + tableX * zoom;
  const originY = offsetY + tableY * zoom;
  const inTableSpace = (draw: (c: CanvasRenderingContext2D) => void) => (c: CanvasRenderingContext2D) => {
    c.save();
    c.translate(Math.round(originX), Math.round(originY));
    draw(c);
    c.restore();
  };
  // The table itself is drawn as furniture; this adds the game on and around it
  const drawables: ZDrawable[] = [];
  // Over the players at the ends, so the ball and paddles are never hidden behind them
  const overZY = tableZY + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET + Z_EPSILON * 4;

  // Scoreboard above the net: each player's points on their side, the winner's flashing at the end
  const current = match;
  if (current) {
    drawables.push({
      zY: tableZY + Z_EPSILON,
      draw: inTableSpace((c) => {
        rectAt(c, NET_X - 9, -1, 20, 7, zoom, SCORE_BG);
        const flash = current.phase === 'over' && Math.floor(current.phaseTime * 4) % 2 === 0;
        drawNumber(c, current.scores[0], NET_X - 2, 0, zoom, flash && current.winner === 0 ? SCORE_WIN : SCORE_DIGIT);
        drawNumber(c, current.scores[1], NET_X + 2 + String(current.scores[1]).length * 4, 0, zoom, flash && current.winner === 1 ? SCORE_WIN : SCORE_DIGIT);
      }),
    });
  }

  // Players move with the play: the receiver shuffles across to the ball's lane and leans in as it
  // arrives; the hitter steps back with the shot, then drifts back to the middle. Paddles stay in hand.
  const laneMid = (LANE_TOP + LANE_BOTTOM) / 2;
  const paddles: Array<{ x: number; y: number }> = [];
  atTable.forEach((ch, side) => {
    if (!ch) return;
    const spot = spots.find((candidate) => candidate.key === ch.leisureSpotKey);
    if (!spot) return;
    let targetAcross = 0;
    let targetBack = 0;
    let lift = 0;
    if (current?.phase === 'rally') {
      const t = current.phaseTime / SHOT_SEC;
      if (current.hitter === side) {
        targetAcross = (current.fromLane - laneMid) * Math.max(0, 1 - t * 2);
        targetBack = t < 0.35 ? STEP_BACK : 0;
        if (current.phaseTime < 0.15) lift = -2;
      } else {
        targetAcross = current.toLane - laneMid;
        targetBack = t > 0.7 && !current.missed ? -LEAN_IN : 0;
      }
    } else if (!current) {
      targetAcross = state.soloLane - laneMid;
    }
    const move = state.moves.get(ch.id) ?? { across: 0, back: 0, stepTime: 0 };
    state.moves.set(ch.id, move);
    const ease = (from: number, to: number) => from + Math.max(-SHUFFLE_SPEED * dt, Math.min(SHUFFLE_SPEED * dt, to - from));
    const before = move.across;
    move.across = ease(move.across, targetAcross);
    move.back = ease(move.back, targetBack);
    // Stepping feet while shuffling across, standing still otherwise
    const moving = Math.abs(move.across - before) > 0.01;
    move.stepTime = moving ? move.stepTime + dt : 0;
    ch.leisureStep = moving ? (Math.floor(move.stepTime / STEP_SEC) % 2 === 0 ? 0 : 2) : null;
    // Away from the table is left for the left-hand player, right for the right-hand one
    ch.x = spot.col * TILE_SIZE + TILE_SIZE / 2 + (side === 0 ? -move.back : move.back);
    ch.y = spot.row * TILE_SIZE + TILE_SIZE / 2 + move.across;
    const x = ch.x - tableX + (side === 0 ? 5 : -5);
    paddles[side] = { x, y: laneMid + move.across - HIT_HEIGHT + lift };
  });
  // Anyone who's left the table stands normally again
  for (const id of state.moves.keys()) {
    if (!atTable.some((ch) => ch?.id === id)) {
      const gone = players.find((ch) => ch.id === id);
      if (gone) gone.leisureStep = null;
      state.moves.delete(id);
    }
  }
  drawables.push({
    zY: overZY,
    draw: inTableSpace((c) => {
      for (const paddle of paddles) if (paddle) drawPaddle(c, paddle.x, paddle.y, zoom);
      let ball: { x: number; y: number; shadowY: number | null } | null = null;
      if (current?.phase === 'rally') {
        const flight = ballInFlight(current);
        const overTable = flight.x >= SURFACE_BOX.left && flight.x <= SURFACE_BOX.right;
        ball = { x: flight.x, y: flight.lane - flight.z, shadowY: overTable ? flight.lane : null };
      } else if (current?.phase === 'serve') {
        // Tossed up from the server's paddle
        const paddle = paddles[current.server];
        const toss = Math.abs(Math.sin((current.phaseTime / SERVE_SEC) * Math.PI)) * 6;
        if (paddle) ball = { x: paddle.x, y: paddle.y - 3 - toss, shadowY: null };
      } else if (!current) {
        // Waiting for an opponent: bouncing the ball on the paddle
        const paddle = paddles.find(Boolean);
        const bounce = Math.abs(Math.sin(now / 260)) * 5;
        if (paddle) ball = { x: paddle.x, y: paddle.y - 2 - bounce, shadowY: null };
      }
      if (ball) {
        if (ball.shadowY !== null) rectAt(c, ball.x - 1, ball.shadowY, 2, 1, zoom, BALL_SHADOW);
        rectAt(c, ball.x - 1, ball.y - 1, 2, 2, zoom, BALL);
      }
    }),
  });
  return drawables;
}

/** Bank the matches at tables everyone has walked away from */
export function endAbandonedPingPong(playedTables: Set<string>): void {
  for (const [uid, state] of tables) {
    if (playedTables.has(uid)) continue;
    if (state.match && state.match.phase !== 'over') endMatch(state.match);
    tables.delete(uid);
  }
}
