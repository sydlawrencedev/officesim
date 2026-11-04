import type { SpriteData } from '../types.js';

/**
 * Replacement furniture sprites (e.g. a visual theme's own furniture), by furniture type without any
 * ":left"-style variant suffix. Replacements keep the original's size so layout, seating and
 * z-sorting are unchanged; mirrored variants are still flipped at draw time.
 */
let overrides: ReadonlyMap<string, SpriteData> | null = null;

export function setFurnitureOverrides(sprites: ReadonlyMap<string, SpriteData> | null): void {
  overrides = sprites;
}

export function getFurnitureOverride(type: string | undefined): SpriteData | undefined {
  return type ? overrides?.get(type.split(':')[0]) : undefined;
}

/**
 * Replacement sprites for single pieces of furniture by layout uid (e.g. a company's own picture
 * on one wall frame). Checked before the by-type overrides; same size rule applies.
 */
let uidOverrides: ReadonlyMap<string, SpriteData> | null = null;

export function setFurnitureUidOverrides(sprites: ReadonlyMap<string, SpriteData> | null): void {
  uidOverrides = sprites;
}

export function getFurnitureUidOverride(uid: string | undefined): SpriteData | undefined {
  return uid ? uidOverrides?.get(uid) : undefined;
}
