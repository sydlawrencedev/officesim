import { TILE_SIZE, TileType } from "../types.js";

/*
 * The rats of a rat hunt (src/ui/RatHunt.tsx), living in the office itself: they scurry about the
 * rooms on the camera, tile to tile like the agents do but faster, pausing to sniff about. Any floor
 * will do, including under desks, chairs and tables, so they're drawn under the furniture (in the
 * renderer's underlay) and hide beneath it, where they can't be hit. A hit rat stays where it fell,
 * on its back in a pool of blood, until the hunt ends.
 *
 * Positions are office pixels (a tile is TILE_SIZE across); the canvas draws them at its zoom.
 */

type Bounds = { col: number; row: number; cols: number; rows: number };
type Tile = { col: number; row: number };

type Rat = {
  id: number;
  /** Its middle, in office pixels. */
  x: number;
  y: number;
  /** Tiles still to run through. */
  path: Tile[];
  /** Where in each tile it runs to, so rats don't all keep to tile centres. */
  jitter: { x: number; y: number };
  /** Seconds left sniffing before it runs off again. */
  pause: number;
  /** Office pixels per second. */
  speed: number;
  /** Which way it last ran. */
  facing: "left" | "right" | "up" | "down";
  /** Running legs' phase. */
  stride: number;
  alive: boolean;
  blood: Array<{ x: number; y: number; color: string }>;
};

/** How long a hunt lasts. */
export const RAT_HUNT_MS = 20_000;
const MAX_RUNNING = 10;
const SPAWN_SECONDS: [number, number] = [0.45, 1.0];
/** Office pixels per second: a bit quicker than the agents walk (48). */
const SPEED: [number, number] = [55, 90];
/** How far a rat runs before pausing, in tiles. */
const RUN_TILES: [number, number] = [2, 9];
const PAUSE_SECONDS: [number, number] = [0.15, 1.1];
/** How much a rat's chance of being hit reaches past its body, in office pixels. */
const HIT_PAD = 3;
/** New rats mostly come out from under the furniture. */
const FROM_UNDER_FURNITURE = 0.65;

// Sprites are rows of palette keys; "." is see-through. Side views face right (flipped for left).
const PALETTE: Record<string, string> = { g: "#8b8f97", d: "#4b4f57", l: "#c9ccd2", p: "#f0a3b4", k: "#111111" };
const SIDE: string[][] = [
  ["......ggd.", "..gggggggk", "ppggggggg.", "...d..d..."],
  ["......ggd.", "..gggggggk", ".pggggggg.", "..d....d.."],
];
const DOWN: string[][] = [
  ["..p..", "..p..", ".ggg.", "dgggd", ".ggg.", ".ggg.", "..k.."],
  ["..p..", ".p...", ".ggg.", ".ggg.", "dgggd", ".ggg.", "..k.."],
];
const DEAD = ["...d..d...", "..gggggg..", "pplllllggk", "..gggggg.."];
const BLOOD = ["#5c0b0b", "#7f1d1d", "#b91c1c", "#dc2626"];

const state = {
  active: false,
  spawning: false,
  /** Time's up: the rest run for it, faster, and are gone at the end of their run. */
  bolting: false,
  rats: [] as Rat[],
  nextId: 1,
  untilSpawn: 0,
  elapsed: 0,
  /** Where the camera drew the office last, for turning clicks into office pixels. */
  viewport: null as { offsetX: number; offsetY: number; zoom: number; canvas: HTMLCanvasElement } | null,
  /** Furniture-covered tiles, where a rat is hidden. */
  covered: new Set<string>(),
};

function between([low, high]: [number, number]): number {
  return low + Math.random() * (high - low);
}

export function startRats(): void {
  Object.assign(state, { active: true, spawning: true, bolting: false, rats: [], untilSpawn: 0, elapsed: 0 });
}

/** Time's up: no more rats, and the rest run for it. */
export function boltRats(): void {
  state.spawning = false;
  state.bolting = true;
}

export function stopRats(): void {
  Object.assign(state, { active: false, spawning: false, bolting: false, rats: [] });
}

export function ratsActive(): boolean {
  return state.active;
}

/** Where the camera drew the office this frame (device pixels), so clicks can be aimed. */
export function setRatViewport(offsetX: number, offsetY: number, zoom: number, canvas: HTMLCanvasElement): void {
  state.viewport = { offsetX, offsetY, zoom, canvas };
}

const isFloor = (tileMap: TileType[][], col: number, row: number) => {
  const tile = tileMap[row]?.[col];
  return tile !== undefined && tile !== TileType.WALL && tile !== TileType.VOID;
};

const inBounds = (bounds: Bounds, col: number, row: number) =>
  col >= bounds.col && col < bounds.col + bounds.cols && row >= bounds.row && row < bounds.row + bounds.rows;

/** Floor tiles reachable from a tile within the camera, nearest first (by steps), with each's path. */
function reachable(tileMap: TileType[][], bounds: Bounds, from: Tile, maxSteps: number): Array<{ tile: Tile; path: Tile[] }> {
  const key = (col: number, row: number) => `${col},${row}`;
  const seen = new Map<string, Tile | null>([[key(from.col, from.row), null]]);
  const found: Array<{ tile: Tile; path: Tile[] }> = [];
  let frontier: Tile[] = [from];
  for (let step = 0; step < maxSteps && frontier.length; step++) {
    const next: Tile[] = [];
    for (const tile of frontier) {
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const col = tile.col + dc;
        const row = tile.row + dr;
        if (seen.has(key(col, row)) || !isFloor(tileMap, col, row) || !inBounds(bounds, col, row)) continue;
        seen.set(key(col, row), tile);
        next.push({ col, row });
      }
    }
    for (const tile of next) {
      const path: Tile[] = [];
      for (let at: Tile | null | undefined = tile; at && !(at.col === from.col && at.row === from.row); at = seen.get(key(at.col, at.row))) {
        path.unshift(at);
      }
      found.push({ tile, path });
    }
    frontier = next;
  }
  return found;
}

function spawn(tileMap: TileType[][], bounds: Bounds): void {
  const floor: Tile[] = [];
  const underFurniture: Tile[] = [];
  for (let row = bounds.row; row < bounds.row + bounds.rows; row++) {
    for (let col = bounds.col; col < bounds.col + bounds.cols; col++) {
      if (!isFloor(tileMap, col, row)) continue;
      floor.push({ col, row });
      if (state.covered.has(`${col},${row}`)) underFurniture.push({ col, row });
    }
  }
  const pool = underFurniture.length && Math.random() < FROM_UNDER_FURNITURE ? underFurniture : floor;
  const tile = pool[Math.floor(Math.random() * pool.length)];
  if (!tile) return;
  const jitter = { x: (Math.random() - 0.5) * 8, y: (Math.random() - 0.5) * 6 };
  state.rats.push({
    id: state.nextId++,
    x: (tile.col + 0.5) * TILE_SIZE + jitter.x,
    y: (tile.row + 0.5) * TILE_SIZE + jitter.y,
    path: [],
    jitter,
    pause: Math.random() * 0.3,
    // Quicker as the hunt goes on, up to half as fast again by the end
    speed: between(SPEED) * (1 + Math.min(0.5, (state.elapsed * 1000) / RAT_HUNT_MS / 2)),
    facing: Math.random() < 0.5 ? "left" : "right",
    stride: 0,
    alive: true,
    blood: [],
  });
}

/** Moves the rats on. `covered` is the furniture-covered tiles; `bounds` the camera's view. */
export function updateRats(dt: number, tileMap: TileType[][], covered: Set<string>, bounds: Bounds): void {
  if (!state.active) return;
  state.covered = covered;
  state.elapsed += dt;
  if (state.spawning) {
    state.untilSpawn -= dt;
    if (state.untilSpawn <= 0) {
      if (state.rats.filter((rat) => rat.alive).length < MAX_RUNNING) spawn(tileMap, bounds);
      state.untilSpawn = between(SPAWN_SECONDS) * (1 - 0.35 * Math.min(1, (state.elapsed * 1000) / RAT_HUNT_MS));
    }
  }
  for (const rat of state.rats) {
    if (!rat.alive) continue;
    if (!rat.path.length) {
      if (state.bolting && rat.pause <= 0) {
        // Bolted out of sight
        rat.alive = false;
        rat.blood = [];
        rat.x = Number.NaN;
        continue;
      }
      rat.pause -= dt;
      if (rat.pause > 0) continue;
      const here = { col: Math.floor(rat.x / TILE_SIZE), row: Math.floor(rat.y / TILE_SIZE) };
      const options = reachable(tileMap, bounds, here, RUN_TILES[1]).filter(({ path }) => path.length >= RUN_TILES[0]);
      const choice = options[Math.floor(Math.random() * options.length)];
      rat.path = choice ? choice.path : [];
      rat.pause = state.bolting ? 0 : between(PAUSE_SECONDS);
      if (!rat.path.length) continue;
    }
    const next = rat.path[0];
    const targetX = (next.col + 0.5) * TILE_SIZE + rat.jitter.x;
    const targetY = (next.row + 0.5) * TILE_SIZE + rat.jitter.y;
    const dx = targetX - rat.x;
    const dy = targetY - rat.y;
    const distance = Math.hypot(dx, dy);
    const step = rat.speed * (state.bolting ? 2.2 : 1) * dt;
    if (distance <= step) {
      rat.x = targetX;
      rat.y = targetY;
      rat.path.shift();
    } else {
      rat.x += (dx / distance) * step;
      rat.y += (dy / distance) * step;
    }
    rat.facing = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
    rat.stride += dt * 14;
  }
  // Rats that got away are gone; the dead stay
  state.rats = state.rats.filter((rat) => !Number.isNaN(rat.x));
}

function drawSprite(ctx: CanvasRenderingContext2D, rows: string[], left: number, top: number, zoom: number, flipX: boolean, flipY: boolean) {
  const height = rows.length;
  const width = rows[0].length;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const color = PALETTE[rows[row][column]];
      if (!color) continue;
      const x = flipX ? width - 1 - column : column;
      const y = flipY ? height - 1 - row : row;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(left + x * zoom), Math.round(top + y * zoom), Math.ceil(zoom), Math.ceil(zoom));
    }
  }
}

/** Draws the rats on the floor; the renderer draws walls, furniture and agents over them. */
export function drawRats(ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number, zoom: number): void {
  if (!state.active) return;
  const at = (x: number, y: number) => ({ left: offsetX + x * zoom, top: offsetY + y * zoom });
  // The dead first, so the living run over them
  for (const rat of state.rats) {
    if (rat.alive) continue;
    for (const drop of rat.blood) {
      const { left, top } = at(rat.x + drop.x, rat.y + drop.y);
      ctx.fillStyle = drop.color;
      ctx.fillRect(Math.round(left), Math.round(top), Math.ceil(zoom), Math.ceil(zoom));
    }
    const { left, top } = at(rat.x - DEAD[0].length / 2, rat.y - DEAD.length / 2);
    drawSprite(ctx, DEAD, left, top, zoom, rat.facing === "left", false);
  }
  for (const rat of [...state.rats].filter((rat) => rat.alive).sort((a, b) => a.y - b.y)) {
    const frame = Math.floor(rat.stride) % 2;
    const vertical = rat.facing === "up" || rat.facing === "down";
    const sprite = vertical ? DOWN[frame] : SIDE[frame];
    const { left, top } = at(rat.x - sprite[0].length / 2, rat.y - sprite.length / 2);
    drawSprite(ctx, sprite, left, top, zoom, rat.facing === "left", rat.facing === "up");
  }
}

/** A splash of blood around a fallen rat: a rough pool under it and a few spatters, in office pixels. */
function bloodFor(id: number): Rat["blood"] {
  let seed = id * 7919 + 17;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const pixels: Rat["blood"] = [];
  for (let y = -3; y <= 4; y++) {
    for (let x = -8; x <= 8; x++) {
      const distance = (x / 8) ** 2 + (y / 3.6) ** 2;
      if (distance < 1 - random() * 0.4) {
        pixels.push({ x, y, color: BLOOD[distance < 0.3 ? 0 : distance < 0.6 ? 1 : random() < 0.5 ? 2 : 1] });
      }
    }
  }
  for (let i = 0; i < 7; i++) {
    pixels.push({ x: Math.round((random() - 0.5) * 26), y: Math.round((random() - 0.5) * 12), color: BLOOD[2 + Math.round(random())] });
  }
  return pixels;
}

/**
 * Shoots at a point on the page. Returns whether a rat was hit: the nearest living one under the
 * shot that isn't hiding under furniture.
 */
export function shootRatAt(clientX: number, clientY: number): boolean {
  const viewport = state.viewport;
  if (!state.active || !viewport) return false;
  const rect = viewport.canvas.getBoundingClientRect();
  const scale = viewport.canvas.width / Math.max(1, rect.width);
  const x = ((clientX - rect.left) * scale - viewport.offsetX) / viewport.zoom;
  const y = ((clientY - rect.top) * scale - viewport.offsetY) / viewport.zoom;
  let best: Rat | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const rat of state.rats) {
    if (!rat.alive) continue;
    if (state.covered.has(`${Math.floor(rat.x / TILE_SIZE)},${Math.floor(rat.y / TILE_SIZE)}`)) continue;
    const dx = Math.abs(x - rat.x);
    const dy = Math.abs(y - rat.y);
    if (dx > 5 + HIT_PAD || dy > 4 + HIT_PAD) continue;
    if (dx + dy < bestDistance) {
      best = rat;
      bestDistance = dx + dy;
    }
  }
  if (!best) return false;
  best.alive = false;
  best.path = [];
  best.blood = bloodFor(best.id);
  return true;
}
