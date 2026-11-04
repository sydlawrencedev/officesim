import { setRawFloorSprite } from "../office/floorTiles.js";
import type { SpriteData } from "../office/types.js";
import { getBaseWallSet, setWallSetOverride } from "../office/wallTiles.js";
import type { RoomKey, ThemeId } from "./themes.js";

/** A 16x16 floor design: the colour of each pixel. Tiles repeat, so designs should wrap at the edges. */
type FloorPainter = (x: number, y: number) => string;
/**
 * A wall design, traced over the original wall pieces: `part` is what the original pixel was
 * (outline, the cap seen from above, or the face seen from the front); y is within the 16x32 piece.
 */
type WallPainter = (part: "outline" | "cap" | "face", x: number, y: number) => string;

export type ThemeTileSet = {
  floors: Partial<Record<RoomKey, FloorPainter>>;
  wall: WallPainter;
};

/** Stable pseudo-random 0..1 per pixel, for speckle and grain that doesn't shimmer between frames. */
function noise(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const pick = (x: number, y: number, seed: number, base: string, speckle: string, amount: number) =>
  noise(x, y, seed) < amount ? speckle : base;

/** Slab with grout on its top and left edges (so neighbouring tiles close the grid). */
const slab = (grout: string, fill: (x: number, y: number) => string, size = 16): FloorPainter => (x, y) =>
  x % size === 0 || y % size === 0 ? grout : fill(x, y);

// ── Solar Temple: sandstone, gold and lapis ─────────────────────

const SOLAR = {
  sand: "#e6cf9c", sandDark: "#d4b77c", grout: "#b8935a", gold: "#f2c14e", goldDark: "#b8862b",
  lapis: "#1f8f95", lapisDark: "#17737a", limestone: "#efe6cf", terracotta: "#d98a5a",
};

const solarTemple: ThemeTileSet = {
  floors: {
    // Sandstone slabs with a gold stud where four slabs meet.
    office: (x, y) => (x === 0 && y === 0 ? SOLAR.gold : slab(SOLAR.grout, (px, py) => pick(px, py, 1, SOLAR.sand, SOLAR.sandDark, 0.12))(x, y)),
    overflowOffice: (x, y) => (x === 0 && y === 0 ? SOLAR.gold : slab("#a9824c", (px, py) => pick(px, py, 2, "#ddc08a", "#caa96c", 0.12))(x, y)),
    // Turquoise faience tiles in gold grout, 8px squares.
    lounge: slab(SOLAR.gold, (x, y) => pick(x, y, 3, SOLAR.lapis, SOLAR.lapisDark, 0.1), 8),
    overflowLounge: slab(SOLAR.gold, (x, y) => pick(x, y, 4, "#2f5fae", "#264e90", 0.1), 8),
    // Polished limestone with a gold diamond inlay.
    boardroom: (x, y) => {
      const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
      if (d >= 6.5 && d < 7.5) return SOLAR.gold;
      return x === 0 || y === 0 ? "#d8cba8" : pick(x, y, 5, SOLAR.limestone, "#e4d9bd", 0.08);
    },
    kitchen: slab("#a8603a", (x, y) => pick(x, y, 6, SOLAR.terracotta, "#c97b4c", 0.12), 8),
    // A sun disc with rays on gold-flecked sandstone.
    hall: (x, y) => {
      const r = Math.hypot(x - 7.5, y - 7.5);
      if (r < 2.6) return SOLAR.gold;
      if (r < 3.4) return SOLAR.goldDark;
      if (r < 6.5 && (Math.abs(x - 7.5) < 0.6 || Math.abs(y - 7.5) < 0.6)) return SOLAR.gold;
      return slab(SOLAR.grout, (px, py) => pick(px, py, 7, SOLAR.sandDark, SOLAR.sand, 0.15))(x, y);
    },
  },
  wall: (part, x, y) => {
    if (part === "outline") return "#6b4a24";
    if (part === "cap") return pick(x, y, 8, "#c9a86a", "#b8955a", 0.1);
    // Gold frieze with tiny glyphs near the top of the face, sandstone blocks below.
    if (y === 10 || y === 15) return SOLAR.gold;
    if (y > 10 && y < 15) {
      const glyph = x % 5;
      if ((glyph === 2 && y > 11) || (glyph === 1 && y === 12) || (glyph === 3 && y === 12)) return "#7a4e22";
      return "#e9c46a";
    }
    const course = Math.floor((y - 16) / 5);
    const offset = course % 2 === 0 ? 0 : 4;
    if ((y - 16) % 5 === 4 || (x + offset) % 8 === 0) return SOLAR.grout;
    return pick(x, y, 9, SOLAR.sand, SOLAR.sandDark, 0.1);
  },
};

// ── Neon Nile: dark panels and glowing lines ────────────────────

const NEON = { cyan: "#2ef2e0", cyanDim: "#1b7f86", magenta: "#ff3fb4", magentaDim: "#8a2a72", night: "#0f0c22", violet: "#1c1440" };

/** Dark floor with dim grid lines every `step` px and a bright pixel where they cross. */
const neonGrid = (base: string, line: string, bright: string, step = 8): FloorPainter => (x, y) => {
  const onX = x % step === 0;
  const onY = y % step === 0;
  if (onX && onY) return bright;
  if (onX || onY) return line;
  return pick(x, y, 11, base, "#0a0818", 0.06);
};

const neonNile: ThemeTileSet = {
  floors: {
    office: neonGrid(NEON.night, "#1d2a55", NEON.cyan),
    overflowOffice: neonGrid("#120c24", "#2e1f5a", NEON.magenta),
    lounge: neonGrid("#1a0d24", NEON.magentaDim, NEON.magenta, 16),
    overflowLounge: neonGrid("#0a1a22", NEON.cyanDim, NEON.cyan, 16),
    boardroom: (x, y) => (x === 0 || y === 0 ? NEON.cyanDim : x === 8 && y === 8 ? NEON.cyan : pick(x, y, 12, "#0b1630", "#0e1b3a", 0.2)),
    kitchen: (x, y) => ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? "#1b0f2a" : "#241338"),
    hall: (x, y) => {
      const edge = x === 0 || y === 0;
      if (edge) return "#2a1f55";
      return (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? "#0c0a1a" : "#171230";
    },
  },
  wall: (part, x, y) => {
    if (part === "outline") return "#04030a";
    if (part === "cap") return x % 8 === 0 ? "#2a1f55" : "#1a1333";
    // A neon glyph strip across the face, dark panels with seams below.
    if (y === 11) return NEON.cyan;
    if (y === 12) return x % 4 === 1 ? NEON.magenta : "#120d26";
    if (y === 13) return x % 4 === 1 || x % 4 === 2 ? NEON.magenta : "#120d26";
    if (y === 14) return NEON.cyanDim;
    if (x % 8 === 0) return "#241a45";
    return y > 26 ? "#170f30" : NEON.violet;
  },
};

// ── Oasis Solarpunk: oak, grass, stone, water and vines ─────────

const oasis: ThemeTileSet = {
  floors: {
    // Light oak planks, 4px wide, staggered joints and a little grain.
    office: (x, y) => {
      const plank = Math.floor(y / 4);
      if (y % 4 === 0) return "#a98a5c";
      if ((x + plank * 5) % 16 === 0) return "#b0915f";
      return pick(x, y, 21, "#d9b98a", "#cfae7c", 0.18);
    },
    overflowOffice: (x, y) => {
      if (x % 4 === 0) return "#9c8a4a";
      return pick(x, y, 22, "#c8b46a", "#bca75c", 0.2);
    },
    lounge: (x, y) => {
      const blade = noise(x, y, 23);
      return blade < 0.12 ? "#5fa347" : blade > 0.92 ? "#a4d97f" : "#7cbf5a";
    },
    overflowLounge: (x, y) => {
      const blade = noise(x, y, 24);
      return blade < 0.14 ? "#4f9152" : blade > 0.93 ? "#95cf86" : "#6fae62";
    },
    boardroom: slab("#c9c9b3", (x, y) => pick(x, y, 25, "#e4e4d2", "#dadac6", 0.1)),
    kitchen: slab("#a4553a", (x, y) => pick(x, y, 26, "#c96f4a", "#bb6340", 0.12), 8),
    // Water channels: rippling blue with a stone lip at the tile edge.
    hall: (x, y) => {
      if (x === 0 || y === 0) return "#cfd6c4";
      const ripple = Math.sin((x + y * 2) * 0.9) + noise(x, y, 27) * 0.6;
      return ripple > 1.1 ? "#9be3ee" : ripple < -0.9 ? "#3fa7bf" : "#5fc3d6";
    },
  },
  wall: (part, x, y) => {
    if (part === "outline") return "#3d5a3a";
    if (part === "cap") return pick(x, y, 28, "#7fb069", "#5f9a4c", 0.3);
    // Vines hanging from the top of a pale limestone face, a planter strip at the foot.
    const vineLength = [7, 0, 12, 3, 0, 9, 0, 5, 14, 0, 6, 0, 10, 2, 0, 8][x];
    if (y - 8 < vineLength) return noise(x, y, 29) < 0.4 ? "#6fb35a" : "#4c8c3f";
    if (y >= 27) return y === 27 ? "#7a5a3a" : "#5e4630";
    return pick(x, y, 30, "#e6ead8", "#dde2cc", 0.08);
  },
};

const THEME_TILES: Partial<Record<ThemeId, ThemeTileSet>> = { solarTemple, neonNile, oasis };

const ROOM_ORDER: RoomKey[] = ["office", "lounge", "boardroom", "kitchen", "hall", "overflowOffice", "overflowLounge"];
const THEME_ORDER: ThemeId[] = ["classic", "solarTemple", "neonNile", "oasis"];
/** Theme floor designs live at tile numbers above the built-in patterns (1-9). */
const FIRST_THEME_PATTERN = 100;

const builtWallSets = new Map<ThemeId, SpriteData[]>();
const builtFloors = new Set<ThemeId>();

function paintFloor(painter: FloorPainter): SpriteData {
  return Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => painter(x, y)));
}

/** Traces a theme's wall painter over every base wall piece, keeping their shapes and edges. */
function paintWallSet(base: SpriteData[], painter: WallPainter): SpriteData[] {
  return base.map((piece) =>
    piece.map((row, y) =>
      row.map((pixel, x) => {
        if (!pixel) return pixel;
        const grey = parseInt(pixel.slice(1, 3), 16);
        const part = grey < 125 ? "outline" : grey < 228 ? "cap" : "face";
        return painter(part, x, y);
      }),
    ),
  );
}

/**
 * Make a theme's own tiles current: registers its floor designs and switches the wall set.
 * Returns the tile number for each room that has a design (rooms without one keep the layout's).
 */
export function activateThemeTiles(theme: ThemeId): Partial<Record<RoomKey, number>> {
  const tiles = THEME_TILES[theme];
  if (!tiles) {
    setWallSetOverride(null);
    return {};
  }
  const patterns: Partial<Record<RoomKey, number>> = {};
  ROOM_ORDER.forEach((room, index) => {
    const painter = tiles.floors[room];
    if (!painter) return;
    const pattern = FIRST_THEME_PATTERN + THEME_ORDER.indexOf(theme) * ROOM_ORDER.length + index;
    if (!builtFloors.has(theme)) setRawFloorSprite(pattern, paintFloor(painter));
    patterns[room] = pattern;
  });
  builtFloors.add(theme);

  const base = getBaseWallSet();
  if (base) {
    let set = builtWallSets.get(theme);
    if (!set) {
      set = paintWallSet(base, tiles.wall);
      builtWallSets.set(theme, set);
    }
    setWallSetOverride(set);
  }
  return patterns;
}

/** Whether a theme brings its own wall set (its walls are then drawn uncoloured). */
export function themeHasWalls(theme: ThemeId): boolean {
  return !!THEME_TILES[theme];
}
