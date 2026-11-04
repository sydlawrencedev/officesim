import { paintCoffeeMachine, paintWaterCooler } from "../office/engine/drinkStations.js";
import type { SpriteData } from "../office/types.js";
import type { ThemeId } from "./themes.js";

/*
 * Each visual theme's own furniture, drawn in code. One set of "office of the future" shapes
 * (slab desks on pillars, floating monitors, shell chairs, pod armchairs, modular sofas) is drawn
 * with each theme's materials and details. Every sprite keeps the original's size and footprint,
 * and the pieces other code draws onto keep their places: the pool table's felt and pockets, the
 * arcade screen, the clock face and the whiteboard's chart area.
 */

type Style = "neon" | "solar" | "oasis";

type Materials = {
  style: Style;
  outline: string;
  /** Structure: legs, pillars, shells, cabinet bodies. */
  frame: string;
  frameLight: string;
  frameDark: string;
  /** Table and desk tops. */
  top: string;
  topLight: string;
  topDark: string;
  cushion: string;
  cushionLight: string;
  cushionDark: string;
  /** Trim: neon light, gold inlay or pale oak. */
  accent: string;
  accentDark: string;
  screen: string;
  screenLine: string;
  screenBright: string;
  pot: string;
  potLight: string;
  potDark: string;
  leaf: string;
  leafLight: string;
  leafDark: string;
  felt: string;
  feltDark: string;
  paper: string;
};

const MATERIALS: Record<Exclude<ThemeId, "classic">, Materials> = {
  neonNile: {
    style: "neon",
    outline: "#05040c",
    frame: "#221c40", frameLight: "#342b5e", frameDark: "#130f26",
    top: "#1c1736", topLight: "#2c2552", topDark: "#120e24",
    cushion: "#b0206e", cushionLight: "#e03a92", cushionDark: "#6e1450",
    accent: "#2ef2e0", accentDark: "#1b7f86",
    screen: "#061a22", screenLine: "#2ef2e0", screenBright: "#b8fff7",
    pot: "#221c40", potLight: "#342b5e", potDark: "#130f26",
    leaf: "#23b86a", leafLight: "#6dfcc4", leafDark: "#136b3d",
    felt: "#12294a", feltDark: "#0a1a30",
    paper: "#2ef2e0",
  },
  solarTemple: {
    style: "solar",
    outline: "#5a3d1e",
    frame: "#c9a86a", frameLight: "#e3c48a", frameDark: "#9c7a45",
    top: "#efe3c4", topLight: "#fbf3dd", topDark: "#d4c39c",
    cushion: "#1f8f95", cushionLight: "#3cb6b8", cushionDark: "#146a6f",
    accent: "#f2c14e", accentDark: "#b8862b",
    screen: "#12475a", screenLine: "#f2c14e", screenBright: "#fff1c2",
    pot: "#c9713f", potLight: "#e08b55", potDark: "#9a532c",
    leaf: "#6aa84f", leafLight: "#a4d46a", leafDark: "#3d7a33",
    felt: "#1f8f95", feltDark: "#146a6f",
    paper: "#fbf3dd",
  },
  oasis: {
    style: "oasis",
    outline: "#3d4a33",
    frame: "#b08655", frameLight: "#d0a878", frameDark: "#87623b",
    top: "#e8ecdf", topLight: "#f7f9f2", topDark: "#cdd4c0",
    cushion: "#7cae5a", cushionLight: "#a3cf7a", cushionDark: "#557d3c",
    accent: "#f2d16b", accentDark: "#b89a3c",
    screen: "#10302a", screenLine: "#9be38a", screenBright: "#e4ffd6",
    pot: "#e8ecdf", potLight: "#f7f9f2", potDark: "#b9c2aa",
    leaf: "#4c9a3f", leafLight: "#86d06a", leafDark: "#2f6b2a",
    felt: "#3f8f5a", feltDark: "#2c6b42",
    paper: "#f7f9f2",
  },
};

// ── A tiny pixel canvas ──────────────────────────────────────────

class Pixels {
  readonly px: string[][];

  constructor(readonly w: number, readonly h: number) {
    this.px = Array.from({ length: h }, () => Array<string>(w).fill(""));
  }

  set(x: number, y: number, color: string): void {
    if (color && x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y][x] = color;
  }

  rect(x: number, y: number, w: number, h: number, color: string): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, color);
  }

  hline(x0: number, x1: number, y: number, color: string): void {
    for (let x = x0; x <= x1; x++) this.set(x, y, color);
  }

  vline(x: number, y0: number, y1: number, color: string): void {
    for (let y = y0; y <= y1; y++) this.set(x, y, color);
  }

  /** Filled box with a 1px outline; `round` trims the corner pixels. */
  box(x: number, y: number, w: number, h: number, fill: string, outline: string, round = false): void {
    this.rect(x, y, w, h, outline);
    this.rect(x + 1, y + 1, w - 2, h - 2, fill);
    if (round) {
      for (const [cx, cy] of [[x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1]]) this.px[cy][cx] = "";
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, color: string): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) this.set(x, y, color);
      }
    }
  }

  sprite(): SpriteData {
    return this.px.map((row) => [...row]);
  }
}

/** Stable per-pixel 0..1 value for grain and speckle. */
function noise(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// ── Shared pieces ────────────────────────────────────────────────

/** A flat top seen from above with a light back edge, plus its front edge and trim. */
function slabTop(p: Pixels, m: Materials, x: number, y: number, w: number, h: number, edge = 3): void {
  // Neon tops are edge-lit so dark furniture still reads against dark floors.
  p.box(x, y, w, h, m.top, m.style === "neon" ? m.accentDark : m.outline);
  p.hline(x + 1, x + w - 2, y + 1, m.topLight);
  if (m.style === "oasis") {
    // Pale composite with a thin oak border.
    p.hline(x + 1, x + w - 2, y + h - 2, m.frameLight);
  } else if (m.style === "solar") {
    for (let xx = x + 3; xx < x + w - 3; xx += 6) p.set(xx, y + 2, m.accent);
  }
  // Front edge: frame colour with a trim line.
  p.rect(x, y + h, w, edge, m.frame);
  p.hline(x, x + w - 1, y + h + edge - 1, m.outline);
  p.hline(x + 1, x + w - 2, y + h + 1, m.accent);
  p.vline(x, y + h, y + h + edge - 1, m.outline);
  p.vline(x + w - 1, y + h, y + h + edge - 1, m.outline);
}

/** Slim pillar legs, with a glowing foot (neon), gold cap (solar) or plain oak (oasis). */
function pillar(p: Pixels, m: Materials, x: number, y0: number, y1: number, w = 3): void {
  p.rect(x, y0, w, y1 - y0 + 1, m.frameDark);
  p.vline(x, y0, y1, m.outline);
  p.vline(x + w - 1, y0, y1, m.outline);
  if (m.style === "neon") p.hline(x, x + w - 1, y1, m.accent);
  if (m.style === "solar") p.hline(x, x + w - 1, y0, m.accent);
}

/** A potted plant whose pot sits in rows potTop..potBottom; `kind` picks the foliage. */
function plant(p: Pixels, m: Materials, cx: number, potTop: number, potBottom: number, potHalf: number, kind: "fronds" | "spikes" | "bush", foliageTop: number): void {
  // Foliage first so the pot's rim sits over the stems.
  if (kind === "spikes") {
    for (let i = -3; i <= 3; i++) {
      const tipY = foliageTop + Math.abs(i) * 2;
      const x = cx + i;
      for (let y = tipY; y < potTop; y++) p.set(x, y, y < tipY + 2 ? m.leafLight : Math.abs(i) % 2 ? m.leafDark : m.leaf);
    }
  } else if (kind === "fronds") {
    for (let i = 0; i < 7; i++) {
      const angle = -1.2 + i * 0.4;
      for (let t = 0; t < 11; t++) {
        const x = Math.round(cx + Math.sin(angle) * t * 0.8);
        const y = Math.round(potTop - 1 - Math.cos(angle) * t * (potTop - foliageTop) / 11);
        p.set(x, y, t > 8 ? m.leafLight : t % 3 === 0 ? m.leafDark : m.leaf);
        if (t > 3) p.set(x + (angle < 0 ? -1 : 1), y, m.leaf);
      }
    }
  } else {
    const r = (potTop - foliageTop) / 2;
    p.ellipse(cx, foliageTop + r, r + 2, r, m.leafDark);
    p.ellipse(cx - 1, foliageTop + r - 1, r + 1, r - 1, m.leaf);
    for (let i = 0; i < 12; i++) p.set(cx - r + Math.floor(noise(i, 1, 3) * r * 2), foliageTop + 1 + Math.floor(noise(i, 2, 3) * r * 1.6), m.leafLight);
  }
  // Pot: tapered, with the style's band.
  for (let y = potTop; y <= potBottom; y++) {
    const inset = Math.floor((y - potTop) / 3);
    p.hline(cx - potHalf + inset, cx + potHalf - 1 - inset, y, m.pot);
    p.set(cx - potHalf + inset, y, m.outline);
    p.set(cx + potHalf - 1 - inset, y, m.outline);
  }
  p.hline(cx - potHalf, cx + potHalf - 1, potTop, m.potLight);
  p.hline(cx - potHalf + 1, cx + potHalf - 2, potBottom, m.outline);
  const band = m.style === "neon" ? m.accent : m.style === "solar" ? m.accent : m.frame;
  p.hline(cx - potHalf + 1, cx + potHalf - 2, potTop + 1, band);
}

// ── Furniture ────────────────────────────────────────────────────

type Painter = (m: Materials) => SpriteData;

const DESK_FRONT: Painter = (m) => {
  const p = new Pixels(48, 32);
  slabTop(p, m, 2, 11, 44, 13);
  pillar(p, m, 6, 27, 31);
  pillar(p, m, 39, 27, 31);
  if (m.style === "oasis") {
    // A trough of greenery slung between the pillars.
    p.rect(14, 27, 20, 3, m.frameDark);
    for (let x = 15; x < 33; x++) p.set(x, 27 + (noise(x, 0, 5) < 0.5 ? 0 : 1), noise(x, 1, 5) < 0.5 ? m.leaf : m.leafLight);
  } else {
    p.hline(10, 38, 28, m.frameDark);
    if (m.style === "neon") p.hline(12, 36, 29, m.accentDark);
  }
  return p.sprite();
};

const DESK_SIDE: Painter = (m) => {
  const p = new Pixels(16, 64);
  slabTop(p, m, 0, 11, 16, 41);
  pillar(p, m, 6, 55, 58, 4);
  return p.sprite();
};

/** A floating monitor on a slim stand, with a keyboard and mouse in front. `frame` animates the screen. */
function monitor(m: Materials, state: "on" | "off", frame: number): SpriteData {
  const p = new Pixels(16, 32);
  p.box(0, 0, 16, 13, m.frameDark, m.outline, true);
  p.rect(1, 1, 14, 11, m.screen);
  if (state === "on") {
    for (let row = 0; row < 4; row++) {
      const y = 2 + row * 2 + ((frame + row) % 2 === 0 ? 0 : 1) * 0;
      const length = 3 + Math.floor(noise(row, frame, 7) * 9);
      p.hline(2, 2 + length, y, row === (frame % 4) ? m.screenBright : m.screenLine);
    }
    if (m.style === "solar") p.ellipse(12, 3, 1, 1, m.accent);
    if (m.style === "oasis") {
      p.set(12, 3, m.screenBright);
      p.set(11, 4, m.screenLine);
      p.set(13, 4, m.screenLine);
    }
  } else {
    p.set(2, 2, m.frameLight);
    p.set(3, 2, m.frameLight);
  }
  if (m.style === "neon") p.hline(1, 14, 12, m.accent);
  if (m.style === "solar") p.hline(1, 14, 0, m.accent);
  // Stand.
  p.rect(7, 13, 2, 3, m.frameDark);
  p.hline(5, 10, 16, m.frame);
  // Keyboard and mouse.
  p.box(0, 18, 12, 4, m.frameLight, m.outline);
  for (let x = 2; x < 10; x += 2) p.set(x, 19, m.frameDark);
  p.box(13, 18, 3, 4, m.frameLight, m.outline, true);
  if (m.style === "neon") p.hline(1, 10, 21, m.accentDark);
  return p.sprite();
}

const PC_BACK: Painter = (m) => {
  const p = new Pixels(16, 32);
  p.box(0, 6, 16, 11, m.frame, m.outline, true);
  p.hline(1, 14, 7, m.frameLight);
  p.rect(6, 10, 4, 3, m.frameDark);
  if (m.style !== "oasis") p.hline(2, 13, 15, m.accent);
  p.rect(7, 17, 2, 3, m.frameDark);
  p.hline(5, 10, 20, m.frame);
  p.hline(4, 11, 21, m.outline);
  return p.sprite();
};

const PC_SIDE: Painter = (m) => {
  const p = new Pixels(16, 32);
  // Thin monitor seen edge-on, angled towards the right.
  p.rect(9, 3, 3, 12, m.outline);
  p.rect(10, 4, 1, 10, m.frame);
  p.vline(11, 4, 13, m.style === "oasis" ? m.frameLight : m.accent);
  p.rect(9, 15, 2, 3, m.frameDark);
  p.hline(6, 12, 18, m.frame);
  // Keyboard edge-on.
  p.box(1, 19, 8, 3, m.frameLight, m.outline);
  return p.sprite();
};

/** Ergonomic shell chair on a star base. */
const DESK_CHAIR_FRONT: Painter = (m) => {
  const p = new Pixels(16, 32);
  p.box(3, 9, 10, 13, m.cushion, m.outline, true);
  p.rect(4, 10, 8, 2, m.cushionLight);
  p.vline(3, 12, 20, m.frame);
  p.vline(12, 12, 20, m.frame);
  p.box(2, 21, 12, 5, m.cushion, m.outline, true);
  p.hline(3, 12, 22, m.cushionLight);
  p.rect(7, 26, 2, 3, m.frameDark);
  p.hline(3, 12, 29, m.frame);
  p.hline(3, 12, 30, m.outline);
  if (m.style === "neon") p.hline(4, 11, 31, m.accent);
  else p.set(3, 31, m.outline), p.set(12, 31, m.outline);
  return p.sprite();
};

const DESK_CHAIR_BACK: Painter = (m) => {
  const p = new Pixels(16, 32);
  p.box(3, 15, 10, 11, m.frame, m.outline, true);
  p.rect(4, 16, 8, 1, m.frameLight);
  p.hline(4, 11, 20, m.style === "oasis" ? m.frameLight : m.accent);
  p.rect(7, 26, 2, 3, m.frameDark);
  p.hline(3, 12, 29, m.frame);
  p.hline(3, 12, 30, m.outline);
  if (m.style === "neon") p.hline(4, 11, 31, m.accent);
  return p.sprite();
};

const DESK_CHAIR_SIDE: Painter = (m) => {
  const p = new Pixels(16, 32);
  p.box(1, 10, 4, 14, m.cushion, m.outline, true);
  p.vline(2, 11, 22, m.cushionLight);
  p.box(1, 20, 11, 4, m.cushion, m.outline, true);
  p.hline(2, 10, 21, m.cushionLight);
  p.rect(6, 24, 2, 5, m.frameDark);
  p.hline(2, 11, 29, m.frame);
  p.hline(2, 11, 30, m.outline);
  if (m.style === "neon") p.hline(3, 10, 31, m.accent);
  return p.sprite();
};

/** A pod armchair: a rounded shell with a deep cushion. */
const POD_FRONT: Painter = (m) => {
  const p = new Pixels(16, 16);
  p.ellipse(7.5, 6.5, 6, 6.5, m.outline);
  p.ellipse(7.5, 6.5, 5, 5.5, m.frame);
  p.ellipse(7.5, 7.5, 3.5, 4, m.cushion);
  p.ellipse(7, 6.5, 2, 2, m.cushionLight);
  p.hline(4, 11, 13, m.frameDark);
  p.hline(5, 10, 14, m.outline);
  p.hline(6, 9, 15, m.style === "neon" ? m.accent : m.frameDark);
  if (m.style !== "oasis") p.set(7, 1, m.accent), p.set(8, 1, m.accent);
  return p.sprite();
};

const POD_BACK: Painter = (m) => {
  const p = new Pixels(16, 16);
  p.ellipse(7.5, 9, 6, 5.5, m.outline);
  p.ellipse(7.5, 9, 5, 4.5, m.frame);
  p.hline(4, 11, 6, m.frameLight);
  if (m.style !== "oasis") p.hline(5, 10, 10, m.accent);
  p.hline(5, 10, 15, m.outline);
  return p.sprite();
};

const POD_SIDE: Painter = (m) => {
  const p = new Pixels(16, 16);
  p.ellipse(5.5, 7, 5, 6.5, m.outline);
  p.ellipse(5.5, 7, 4, 5.5, m.frame);
  p.ellipse(7, 8.5, 3.5, 3, m.cushion);
  p.hline(6, 9, 7, m.cushionLight);
  p.hline(2, 9, 14, m.outline);
  if (m.style === "neon") p.hline(3, 8, 15, m.accent);
  return p.sprite();
};

/** A backless pouf: cushion top, trimmed sides. */
const POUF: Painter = (m) => {
  const p = new Pixels(16, 16);
  p.box(2, 4, 12, 7, m.cushion, m.outline, true);
  p.hline(3, 12, 5, m.cushionLight);
  p.box(2, 10, 12, 5, m.frame, m.outline);
  p.hline(3, 12, 11, m.style === "oasis" ? m.frameLight : m.accent);
  return p.sprite();
};

const SOFA_FRONT: Painter = (m) => {
  const p = new Pixels(32, 16);
  p.box(0, 0, 32, 7, m.cushionDark, m.outline, true);
  p.hline(1, 30, 1, m.cushion);
  p.box(0, 5, 32, 7, m.cushion, m.outline);
  p.hline(1, 30, 6, m.cushionLight);
  p.vline(15, 6, 10, m.cushionDark);
  p.vline(16, 6, 10, m.cushionDark);
  p.box(0, 3, 3, 10, m.frame, m.outline, true);
  p.box(29, 3, 3, 10, m.frame, m.outline, true);
  p.box(1, 11, 30, 4, m.frame, m.outline);
  p.hline(2, 29, 12, m.style === "oasis" ? m.frameLight : m.accent);
  return p.sprite();
};

const SOFA_BACK: Painter = (m) => {
  const p = new Pixels(32, 16);
  p.box(0, 2, 32, 12, m.frame, m.outline, true);
  p.hline(1, 30, 3, m.frameLight);
  p.hline(2, 29, 9, m.style === "oasis" ? m.frameLight : m.accent);
  p.hline(1, 30, 14, m.outline);
  p.hline(2, 29, 15, m.style === "neon" ? m.accentDark : m.frameDark);
  return p.sprite();
};

const SOFA_SIDE: Painter = (m) => {
  const p = new Pixels(16, 32);
  p.box(0, 1, 5, 30, m.cushionDark, m.outline, true);
  p.vline(1, 2, 29, m.cushion);
  p.box(4, 2, 7, 28, m.cushion, m.outline);
  p.vline(5, 3, 28, m.cushionLight);
  p.box(0, 0, 13, 4, m.frame, m.outline, true);
  p.box(0, 28, 13, 4, m.frame, m.outline, true);
  p.vline(11, 4, 27, m.frame);
  p.vline(12, 4, 27, m.outline);
  if (m.style !== "oasis") p.hline(1, 11, 29, m.accent);
  return p.sprite();
};

const TABLE_FRONT: Painter = (m) => {
  const p = new Pixels(48, 64);
  slabTop(p, m, 0, 11, 48, 44);
  pillar(p, m, 5, 58, 63, 4);
  pillar(p, m, 39, 58, 63, 4);
  return p.sprite();
};

const SMALL_TABLE_FRONT: Painter = (m) => {
  const p = new Pixels(32, 32);
  slabTop(p, m, 0, 11, 32, 14);
  pillar(p, m, 14, 28, 31, 4);
  p.hline(9, 22, 31, m.style === "neon" ? m.accent : m.frameDark);
  return p.sprite();
};

const SMALL_TABLE_SIDE: Painter = (m) => {
  const p = new Pixels(16, 48);
  slabTop(p, m, 0, 10, 16, 31);
  pillar(p, m, 6, 44, 47, 4);
  return p.sprite();
};

const COFFEE_TABLE: Painter = (m) => {
  const p = new Pixels(32, 32);
  p.ellipse(15.5, 22, 13, 5.5, m.outline);
  p.ellipse(15.5, 21, 13, 5.5, m.frame);
  p.ellipse(15.5, 15, 13, 8.5, m.outline);
  p.ellipse(15.5, 15, 12, 7.5, m.top);
  p.ellipse(13, 12.5, 7, 3.5, m.topLight);
  const trim = m.style === "oasis" ? m.frameLight : m.accent;
  for (let a = 0; a < Math.PI; a += 0.05) p.set(Math.round(15.5 + Math.cos(a) * 12), Math.round(15 + Math.sin(a) * 7.5), trim);
  p.rect(13, 27, 6, 3, m.frameDark);
  p.hline(10, 21, 30, m.style === "neon" ? m.accent : m.outline);
  return p.sprite();
};

const BOARDROOM_TABLE: Painter = (m) => {
  const p = new Pixels(48, 80);
  p.box(3, 4, 42, 69, m.top, m.style === "neon" ? m.accentDark : m.outline, true);
  p.hline(4, 43, 5, m.topLight);
  // A trim line running round the top, inset from the edge.
  const trim = m.style === "oasis" ? m.frameLight : m.accent;
  p.hline(6, 41, 8, trim);
  p.hline(6, 41, 68, trim);
  p.vline(6, 8, 68, trim);
  p.vline(41, 8, 68, trim);
  // A slate and a cup where the originals had paper and a mug.
  p.box(11, 14, 6, 7, m.style === "neon" ? m.screen : m.paper, m.outline);
  p.hline(12, 15, 16, m.screenLine);
  p.hline(12, 14, 18, m.screenLine);
  p.ellipse(32, 55, 2, 2, m.outline);
  p.ellipse(32, 55, 1, 1, m.style === "solar" ? m.accent : m.topLight);
  p.rect(3, 73, 42, 3, m.frame);
  p.hline(3, 44, 75, m.outline);
  p.hline(4, 43, 74, trim);
  pillar(p, m, 9, 76, 79, 5);
  pillar(p, m, 34, 76, 79, 5);
  return p.sprite();
};

/** Pockets and felt match the originals so the pool game lines up. */
const POOL_FELT = { left: 10, top: 11, right: 69, bottom: 32 };
const POOL_POCKETS = [[9, 10], [40, 10], [70, 10], [9, 33], [40, 33], [70, 33]];

function poolTable(m: Materials, withBalls: boolean): SpriteData {
  const p = new Pixels(80, 48);
  p.box(4, 5, 72, 34, m.frame, m.outline, true);
  p.hline(5, 74, 6, m.frameLight);
  p.rect(POOL_FELT.left, POOL_FELT.top, POOL_FELT.right - POOL_FELT.left + 1, POOL_FELT.bottom - POOL_FELT.top + 1, m.felt);
  const trim = m.style === "oasis" ? m.frameLight : m.accent;
  p.hline(POOL_FELT.left - 1, POOL_FELT.right + 1, POOL_FELT.top - 1, m.feltDark);
  p.hline(POOL_FELT.left - 1, POOL_FELT.right + 1, POOL_FELT.bottom + 1, trim);
  p.vline(POOL_FELT.left - 1, POOL_FELT.top, POOL_FELT.bottom, m.feltDark);
  p.vline(POOL_FELT.right + 1, POOL_FELT.top, POOL_FELT.bottom, m.feltDark);
  for (const [x, y] of POOL_POCKETS) p.ellipse(x, y, 1.6, 1.6, m.outline);
  if (m.style === "neon") for (const [x, y] of POOL_POCKETS) p.set(x, y, m.accentDark);
  // Front face and legs.
  p.rect(4, 39, 72, 2, m.frameDark);
  p.hline(4, 75, 40, m.outline);
  p.hline(8, 71, 39, trim);
  pillar(p, m, 9, 41, 44, 5);
  pillar(p, m, 66, 41, 44, 5);
  if (withBalls) {
    const colours = ["#f8f8f8", "#e63946", "#f4d35e", "#3a86ff", "#111111"];
    const rack = [[52, 21], [55, 19], [55, 23], [58, 17], [58, 21]];
    rack.forEach(([x, y], i) => p.ellipse(x, y, 1, 1, colours[(i + 1) % colours.length]));
    p.ellipse(24, 21, 1, 1, colours[0]);
  }
  return p.sprite();
}

/** The arcade's screen matches the original so the space invaders game lands on it. */
const ARCADE_SCREEN = { x: 10, y: 15, w: 12, h: 9 };

const ARCADE_MACHINE: Painter = (m) => {
  const p = new Pixels(32, 48);
  p.box(3, 2, 26, 46, m.frame, m.outline, true);
  // Side panels with a light strip.
  p.rect(4, 3, 3, 44, m.frameDark);
  p.rect(25, 3, 3, 44, m.frameDark);
  p.vline(5, 4, 45, m.style === "oasis" ? m.frameLight : m.accent);
  p.vline(26, 4, 45, m.style === "oasis" ? m.frameLight : m.accent);
  // Marquee.
  p.box(7, 4, 18, 7, m.style === "neon" ? m.cushion : m.accentDark, m.outline);
  p.hline(8, 23, 5, m.style === "neon" ? m.cushionLight : m.accent);
  for (let x = 10; x < 22; x += 3) p.set(x, 7, m.screenBright);
  // Screen with bezel.
  p.box(ARCADE_SCREEN.x - 2, ARCADE_SCREEN.y - 2, ARCADE_SCREEN.w + 4, ARCADE_SCREEN.h + 4, m.frameDark, m.outline);
  p.rect(ARCADE_SCREEN.x, ARCADE_SCREEN.y, ARCADE_SCREEN.w, ARCADE_SCREEN.h, m.screen);
  p.hline(ARCADE_SCREEN.x + 2, ARCADE_SCREEN.x + 9, ARCADE_SCREEN.y + 3, m.screenLine);
  p.hline(ARCADE_SCREEN.x + 4, ARCADE_SCREEN.x + 7, ARCADE_SCREEN.y + 5, m.screenBright);
  // Control deck.
  p.box(7, 27, 18, 5, m.frameLight, m.outline);
  p.set(10, 29, m.outline);
  p.set(10, 28, "#e63946");
  for (const [x, colour] of [[15, "#f4d35e"], [18, "#3a86ff"], [21, m.accent]] as const) p.set(x, 29, colour);
  // Coin slot and kick plate.
  p.box(13, 36, 6, 4, m.frameDark, m.outline);
  p.hline(15, 16, 37, m.accent);
  p.hline(7, 24, 45, m.style === "neon" ? m.accent : m.frameDark);
  return p.sprite();
};

const PLANT: Painter = (m) => {
  const p = new Pixels(16, 32);
  plant(p, m, 8, 22, 30, 5, m.style === "solar" ? "fronds" : "fronds", 1);
  return p.sprite();
};

const PLANT_2: Painter = (m) => {
  const p = new Pixels(16, 32);
  plant(p, m, 8, 22, 30, 5, "spikes", 4);
  return p.sprite();
};

const LARGE_PLANT: Painter = (m) => {
  const p = new Pixels(32, 48);
  plant(p, m, 16, 36, 46, 7, m.style === "solar" ? "fronds" : "bush", 8);
  if (m.style === "solar") {
    // Papyrus heads.
    for (const [x, y] of [[9, 10], [16, 8], [23, 11]]) p.ellipse(x, y, 2, 1.2, m.leafLight);
  }
  return p.sprite();
};

const HANGING_PLANT: Painter = (m) => {
  const p = new Pixels(16, 32);
  p.vline(7, 2, 7, m.style === "oasis" ? m.frame : m.accentDark);
  p.vline(8, 2, 7, m.style === "oasis" ? m.frame : m.accentDark);
  p.box(3, 8, 10, 6, m.pot, m.outline, true);
  p.hline(4, 11, 9, m.style === "oasis" ? m.frame : m.accent);
  for (let x = 2; x < 14; x++) {
    const length = 4 + Math.floor(noise(x, 3, 9) * 14);
    for (let y = 13; y < 13 + length && y < 32; y++) p.set(x, y, (y + x) % 4 === 0 ? m.leafLight : x % 2 ? m.leaf : m.leafDark);
  }
  return p.sprite();
};

const POT: Painter = (m) => {
  const p = new Pixels(16, 16);
  plant(p, m, 8, 8, 14, 5, "bush", 3);
  return p.sprite();
};

const BIN: Painter = (m) => {
  const p = new Pixels(16, 16);
  p.box(3, 3, 10, 12, m.frame, m.outline, true);
  p.box(3, 2, 10, 3, m.frameLight, m.outline, true);
  p.hline(4, 11, 3, m.frameDark);
  p.hline(4, 11, 9, m.style === "oasis" ? m.leaf : m.accent);
  return p.sprite();
};

const COFFEE: Painter = (m) => {
  const p = new Pixels(16, 16);
  p.box(9, 2, 5, 5, m.style === "solar" ? m.accent : m.topLight, m.outline, true);
  p.hline(10, 12, 3, m.frameDark);
  p.set(14, 4, m.outline);
  if (m.style === "neon") p.set(11, 0, m.accentDark);
  return p.sprite();
};

/** Clock: a ring round a plain face centred at (8,16), which the renderer draws hands over. */
const CLOCK: Painter = (m) => {
  const p = new Pixels(16, 32);
  // The renderer samples the face at (4,16) when wiping it, so the face must reach that far.
  p.ellipse(8, 16, 6, 6, m.outline);
  p.ellipse(8, 16, 5.1, 5.1, m.style === "oasis" ? m.frame : m.accent);
  p.ellipse(8, 16, 4.3, 4.3, m.style === "neon" ? m.screen : m.topLight);
  if (m.style === "neon") p.set(8, 11, m.accent);
  return p.sprite();
};

/** The frame shared by the wall boards (charts, kanban, scorecard), with the board surface inside. */
function wallBoard(p: Pixels, m: Materials, x: number, y: number, w: number, h: number): void {
  p.box(x, y, w, h, m.style === "oasis" ? m.frame : m.frameDark, m.outline);
  const trim = m.style === "oasis" ? m.frameLight : m.accent;
  p.hline(x + 1, x + w - 2, y + 1, trim);
  p.hline(x + 1, x + w - 2, y + h - 2, trim);
  p.rect(x + 2, y + 3, w - 4, h - 5, m.screen);
}

/** Whiteboard frame; its writing area (x5-26, y12-20) is wiped and charted by the renderer. */
const WHITEBOARD: Painter = (m) => {
  const p = new Pixels(32, 32);
  wallBoard(p, m, 2, 8, 28, 16);
  return p.sprite();
};

/** Kanban board: the wall-board frame with the five column headers the renderer's notes sit under. */
const KANBAN_HEADERS = ["#9aa0a6", "#4dabf7", "#fab005", "#9775fa", "#fa5252"];
const KANBAN_BOARD: Painter = (m) => {
  const p = new Pixels(64, 32);
  wallBoard(p, m, 0, 4, 64, 24);
  KANBAN_HEADERS.forEach((colour, i) => {
    const x0 = 5 + i * 11;
    p.hline(x0, x0 + 9, 9, colour);
    if (i < 4) p.vline(x0 + 10, 9, 24, m.frameDark);
  });
  return p.sprite();
};

/** Scorecard board: the wall-board frame, inset 9px in its 64px sprite like the classic one. */
const SCORECARD_BOARD: Painter = (m) => {
  const p = new Pixels(64, 32);
  wallBoard(p, m, 9, 4, 48, 24);
  return p.sprite();
};

/** Drinks stations share their geometry with the pour animations, so they're drawn by drinkStations. */
const COFFEE_MACHINE: Painter = (m) => paintCoffeeMachine({
  outline: m.outline, body: m.frameDark, bodyLight: m.frameLight, bodyDark: m.frame,
  cabinet: m.frame, cabinetDark: m.frameDark, accent: m.accent,
});
const WATER_COOLER: Painter = (m) => paintWaterCooler({
  outline: m.outline, body: m.top, bodyLight: m.topLight, bodyDark: m.topDark,
  cabinet: m.top, cabinetDark: m.topDark, accent: m.accent,
});

const PAINTERS: Record<string, Painter> = {
  DESK_FRONT,
  DESK_SIDE,
  PC_FRONT_ON_1: (m) => monitor(m, "on", 0),
  PC_FRONT_ON_2: (m) => monitor(m, "on", 1),
  PC_FRONT_ON_3: (m) => monitor(m, "on", 2),
  PC_FRONT_OFF: (m) => monitor(m, "off", 0),
  PC_BACK,
  PC_SIDE,
  WOODEN_CHAIR_FRONT: DESK_CHAIR_FRONT,
  WOODEN_CHAIR_BACK: DESK_CHAIR_BACK,
  WOODEN_CHAIR_SIDE: DESK_CHAIR_SIDE,
  CUSHIONED_CHAIR_FRONT: POD_FRONT,
  CUSHIONED_CHAIR_BACK: POD_BACK,
  CUSHIONED_CHAIR_SIDE: POD_SIDE,
  CUSHIONED_BENCH: POUF,
  WOODEN_BENCH: POUF,
  SOFA_FRONT,
  SOFA_BACK,
  SOFA_SIDE,
  TABLE_FRONT,
  SMALL_TABLE_FRONT,
  SMALL_TABLE_SIDE,
  COFFEE_TABLE,
  BOARDROOM_TABLE,
  POOL_TABLE: (m) => poolTable(m, true),
  "POOL_TABLE#clean": (m) => poolTable(m, false),
  ARCADE_MACHINE,
  PLANT,
  PLANT_2,
  LARGE_PLANT,
  HANGING_PLANT,
  POT,
  BIN,
  COFFEE,
  CLOCK,
  WHITEBOARD,
  KANBAN_BOARD,
  SCORECARD_BOARD,
  COFFEE_MACHINE,
  WATER_COOLER,
};

const built = new Map<ThemeId, ReadonlyMap<string, SpriteData>>();

/** A theme's furniture sprites by type, drawn once and reused; null for the classic look. */
export function getThemeFurniture(theme: ThemeId): ReadonlyMap<string, SpriteData> | null {
  if (theme === "classic") return null;
  let sprites = built.get(theme);
  if (!sprites) {
    const materials = MATERIALS[theme];
    sprites = new Map(Object.entries(PAINTERS).map(([type, paint]) => [type, paint(materials)]));
    built.set(theme, sprites);
  }
  return sprites;
}

/** A theme's screen colours for the live terminal on active computers; null for the classic look. */
export function getThemeScreenColors(theme: ThemeId): { background: string; text: string; bright: string } | null {
  if (theme === "classic") return null;
  const materials = MATERIALS[theme];
  return { background: materials.screen, text: materials.screenLine, bright: materials.screenBright };
}
