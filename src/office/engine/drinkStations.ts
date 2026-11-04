import type { Character, SpriteData } from '../types.js';
import { CharacterState } from '../types.js';

/*
 * Drinks stations: a drip coffee machine and a water cooler that idle agents visit. They pour for a
 * few seconds facing the machine (the machine animates), then turn round and drink from a cup.
 * The sprites and the animation overlays share the geometry below so they always line up.
 */

export const COFFEE_MACHINE_TYPE = 'COFFEE_MACHINE';
export const WATER_COOLER_TYPE = 'WATER_COOLER';

/** Seconds spent pouring at the machine, then drinking. */
export const POUR_SEC = 4;
export const DRINK_SEC = 8;
/** Share of agents who'd rather have water. */
const WATER_DRINKER_SHARE = 0.35;

export type DrinkKind = 'coffee' | 'water';

export function isDrinkKind(kind: string): kind is DrinkKind {
  return kind === 'coffee' || kind === 'water';
}

/** Whether a character prefers water; fixed per character so they're consistent. */
export function prefersWater(characterId: number): boolean {
  const h = Math.imul(characterId ^ 0x5bd1e995, 0x27d4eb2d) >>> 0;
  return h / 4294967295 < WATER_DRINKER_SHARE;
}

/** Whether a character at a drinks station has finished pouring and is drinking. */
export function isDrinking(ch: Character): boolean {
  return ch.state === CharacterState.LEISURE && !!ch.leisureSpotKey && isDrinkKind(ch.leisureSpotKey.split(':')[0]) && ch.leisureTimer <= DRINK_SEC;
}

// ── Sprites (16x32; the top tile is background, the machine stands on the bottom one) ──

export type StationPalette = {
  outline: string;
  body: string;
  bodyLight: string;
  bodyDark: string;
  cabinet: string;
  cabinetDark: string;
  accent: string;
};

const COFFEE = { spoutX: 7, spoutY: 13, carafe: { x: 5, y: 15, w: 6, h: 4 }, steamY: 5 };
const COOLER = { bottle: { x: 5, y: 5, w: 6, h: 9 }, neckY: 14, tapX: 5, tapY: 20, trayY: 25 };

class Pixels {
  readonly px: string[][] = Array.from({ length: 32 }, () => Array<string>(16).fill(''));
  rect(x: number, y: number, w: number, h: number, c: string): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && yy >= 0 && xx < 16 && yy < 32) this.px[yy][xx] = c;
  }
  box(x: number, y: number, w: number, h: number, fill: string, outline: string): void {
    this.rect(x, y, w, h, outline);
    this.rect(x + 1, y + 1, w - 2, h - 2, fill);
  }
}

/** A drip coffee machine on a small cabinet: reservoir, brew head with spout, glass carafe. */
export function paintCoffeeMachine(p: StationPalette): SpriteData {
  const s = new Pixels();
  // Cabinet with a counter top.
  s.box(2, 20, 12, 12, p.cabinet, p.outline);
  s.rect(3, 21, 10, 1, p.bodyLight);
  s.rect(3, 26, 10, 1, p.cabinetDark);
  s.rect(7, 23, 2, 1, p.cabinetDark);
  // Machine body.
  s.box(3, 6, 10, 15, p.body, p.outline);
  s.rect(4, 7, 8, 3, p.bodyDark);
  s.rect(4, 7, 8, 1, p.bodyLight);
  s.rect(4, 10, 8, 3, p.body);
  s.rect(COFFEE.spoutX, COFFEE.spoutY, 2, 1, p.outline);
  s.rect(11, 11, 1, 1, p.accent);
  // Carafe: glass with a little coffee in it.
  const { x, y, w, h } = COFFEE.carafe;
  s.rect(x, y - 1, w, h + 1, p.outline);
  s.rect(x + 1, y, w - 2, h - 1, '#cfe3ea');
  s.rect(x + 1, y + h - 2, w - 2, 1, '#5a3620');
  s.rect(x + w, y + 1, 1, 2, p.outline);
  return s.px;
}

/** A water cooler: an upturned blue bottle on a cabinet with two taps and a drip tray. */
export function paintWaterCooler(p: StationPalette): SpriteData {
  const s = new Pixels();
  s.box(3, 16, 10, 16, p.cabinet, p.outline);
  s.rect(4, 17, 8, 1, p.bodyLight);
  s.rect(COOLER.tapX, COOLER.tapY, 1, 2, '#3a86ff');
  s.rect(10, COOLER.tapY, 1, 2, '#e63946');
  s.rect(4, COOLER.trayY, 8, 1, p.cabinetDark);
  s.rect(4, 29, 8, 1, p.cabinetDark);
  // Bottle.
  const { x, y, w, h } = COOLER.bottle;
  s.rect(x - 1, y - 2, w + 2, h + 3, p.outline);
  s.rect(x, y - 1, w, h + 1, '#8fcdf0');
  s.rect(x, y - 1, w, 2, '#bfe6fa');
  s.rect(x + 1, y + 1, 1, h - 2, '#d8f1fc');
  s.rect(x + 1, COOLER.neckY, w - 2, 2, p.outline);
  s.rect(x + 2, COOLER.neckY, w - 4, 2, '#8fcdf0');
  s.px[y - 2][x - 1] = '';
  s.px[y - 2][x + w] = '';
  return s.px;
}

// ── Animation overlays ───────────────────────────────────────────

type Draw = (c: CanvasRenderingContext2D) => void;

function pixel(c: CanvasRenderingContext2D, ox: number, oy: number, zoom: number, x: number, y: number, w: number, h: number, color: string): void {
  c.fillStyle = color;
  c.fillRect(Math.round(ox + x * zoom), Math.round(oy + y * zoom), Math.ceil(w * zoom), Math.ceil(h * zoom));
}

/** Coffee dripping from the spout, the carafe filling and steam rising, while someone pours. */
export function coffeePourOverlay(ox: number, oy: number, zoom: number, progress: number, now: number): Draw {
  return (c) => {
    const { carafe } = COFFEE;
    const drop = Math.floor(now / 120) % 2;
    pixel(c, ox, oy, zoom, COFFEE.spoutX + drop, COFFEE.spoutY + 1, 1, 1, '#6b4226');
    const level = Math.min(carafe.h - 1, 1 + Math.floor(progress * (carafe.h - 1)));
    pixel(c, ox, oy, zoom, carafe.x + 1, carafe.y + carafe.h - 1 - level, carafe.w - 2, level, '#5a3620');
    for (let i = 0; i < 3; i++) {
      const t = ((now / 700 + i / 3) % 1);
      const sx = 6 + i + Math.round(Math.sin(t * 6 + i) * 0.8);
      pixel(c, ox, oy, zoom, sx, COFFEE.steamY - Math.floor(t * 4), 1, 1, `rgba(235,235,235,${(1 - t) * 0.8})`);
    }
  };
}

/** Bubbles glugging up the bottle and water running from the tap, while someone fills a cup. */
export function waterPourOverlay(ox: number, oy: number, zoom: number, now: number): Draw {
  return (c) => {
    const { bottle } = COOLER;
    for (let i = 0; i < 3; i++) {
      const t = ((now / 900 + i / 3) % 1);
      const bx = bottle.x + 1 + ((i * 2) % (bottle.w - 2));
      const by = bottle.y + bottle.h - 1 - Math.floor(t * (bottle.h - 1));
      pixel(c, ox, oy, zoom, bx, by, 1, 1, '#ffffff');
    }
    const flow = Math.floor(now / 100) % 3;
    for (let y = COOLER.tapY + 2; y < COOLER.trayY; y++) {
      if ((y + flow) % 3 !== 0) pixel(c, ox, oy, zoom, COOLER.tapX, y, 1, 1, '#9fd8f7');
    }
  };
}

/**
 * A cup in the drinker's hand; every few seconds they lift it for a sip. `ox`/`oy` are the screen
 * position of the character's anchor (bottom centre of their sprite).
 */
export function cupOverlay(ox: number, oy: number, zoom: number, kind: DrinkKind, now: number, seed: number): Draw {
  return (c) => {
    const sipping = ((now / 1000 + seed) % 2.6) < 0.7;
    const x = sipping ? 1 : 4;
    const y = sipping ? -15 : -10;
    const [body, top] = kind === 'coffee' ? ['#f4f1ea', '#6b4226'] : ['#e6f5ff', '#7cc7ee'];
    pixel(c, ox, oy, zoom, x, y, 3, 3, body);
    pixel(c, ox, oy, zoom, x, y, 3, 1, top);
    if (kind === 'coffee') pixel(c, ox, oy, zoom, x + 3, y + 1, 1, 1, body);
  };
}
