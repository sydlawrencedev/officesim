import { getCatalogEntry } from "../office/layout/furnitureCatalog.js";
import type { OfficeLayout, SpriteData } from "../office/types.js";

/** Wall pieces that draw live content (charts, the scorecard, the kanban, the clock) rather than a picture. */
const NOT_ART = new Set(["WHITEBOARD", "SCORECARD_BOARD", "KANBAN_BOARD", "CLOCK"]);

const ROOM_LABELS: Record<string, string> = {
  camera1: "Office + Lounge",
  camera2: "Boardroom + Games Room",
  camera3: "Office 2 + Lounge",
};

export type WallArtSlot = {
  /** Combined-layout furniture uid, the key in the office settings' wallArt */
  uid: string;
  type: string;
  /** e.g. "Office + Lounge: Large Painting" */
  label: string;
  width: number;
  height: number;
  /** The picture it hangs with by default */
  sprite: SpriteData;
  /** Where the default picture is drawn within its sprite; replacements fill the same area. */
  bounds: ArtBounds;
};

export type ArtBounds = { x: number; y: number; width: number; height: number };

/** The box around a sprite's visible pixels (the whole sprite when it's empty). */
function visibleBounds(sprite: SpriteData): ArtBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  sprite.forEach((row, y) =>
    row.forEach((color, x) => {
      if (!color) return;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }),
  );
  const width = sprite[0]?.length ?? 0;
  if (maxX < 0) return { x: 0, y: 0, width, height: sprite.length };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** The pictures on the office walls (paintings, portraits, the logo) that can be swapped for a company's own. */
export function wallArtSlots(layout: OfficeLayout): WallArtSlot[] {
  const slots: WallArtSlot[] = [];
  for (const item of layout.furniture) {
    const baseType = item.type.split(":")[0];
    // Hanging plants hang on the walls too, but aren't pictures
    if (!item.uid || NOT_ART.has(baseType) || baseType.includes("PLANT")) continue;
    const entry = getCatalogEntry(item.type);
    if (!entry || (entry.category !== "wall" && !entry.canPlaceOnWalls)) continue;
    const room = ROOM_LABELS[item.uid.split("-")[0]] ?? "Office";
    slots.push({
      uid: item.uid,
      type: item.type,
      label: `${room}: ${entry.label}`,
      width: entry.sprite[0]?.length ?? 0,
      height: entry.sprite.length,
      sprite: entry.sprite,
      bounds: visibleBounds(entry.sprite),
    });
  }
  return slots;
}

function hex(r: number, g: number, b: number, a: number): string {
  if (a < 128) return "";
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A picture scaled down for a wall slot: a sprite of the slot's size with the picture cropped to
 * fill `area` (like CSS `cover`) and averaged down so it reads as pixel art. See-through pixels
 * stay see-through.
 */
export async function imageToSprite(blob: Blob, width: number, height: number, area: ArtBounds = { x: 0, y: 0, width, height }): Promise<SpriteData> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not draw the image");
    const scale = Math.max(area.width / bitmap.width, area.height / bitmap.height);
    const sw = area.width / scale;
    const sh = area.height / scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, area.x, area.y, area.width, area.height);
    const { data } = ctx.getImageData(0, 0, width, height);
    return Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => {
        const i = (y * width + x) * 4;
        return hex(data[i], data[i + 1], data[i + 2], data[i + 3]);
      }),
    );
  } finally {
    bitmap.close();
  }
}

export function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

type FetchWallImage = (params: { url: string }) => Promise<{ contentType?: string; base64?: string }>;

const spriteCache = new Map<string, Promise<SpriteData>>();

/** A wall slot's replacement sprite from an image URL, fetched through the worker and cached per URL and slot shape. */
export function loadWallArtSprite(fetchImage: FetchWallImage, url: string, slot: Pick<WallArtSlot, "width" | "height" | "bounds">): Promise<SpriteData> {
  const { width, height, bounds } = slot;
  const key = `${width}x${height}@${bounds.x},${bounds.y},${bounds.width}x${bounds.height}|${url}`;
  let sprite = spriteCache.get(key);
  if (!sprite) {
    sprite = fetchImage({ url }).then((image) => {
      if (!image?.base64 || !image.contentType) throw new Error("The image came back empty");
      return imageToSprite(base64ToBlob(image.base64, image.contentType), width, height, bounds);
    });
    // A failed fetch can be retried (e.g. after fixing the URL's host)
    sprite.catch(() => spriteCache.delete(key));
    spriteCache.set(key, sprite);
  }
  return sprite;
}
