import type { ColorValue } from "../components/ui/types.js";
import { TILE_SIZE, type TileType } from "../office/types.js";
import type { RoomKey, Theme } from "./themes.js";

const WALL_ROOMS = new Set<RoomKey>(["wall", "overflowWall"]);

/** What a theme changes on the map: floor patterns, tile colours and where its light strips run. */
export type ThemedMap = {
  tileMap: TileType[][];
  tileColors: Array<ColorValue | null>;
  /** Floor tiles (col,row) along the foot of a back wall, where light strips are drawn. */
  trimTiles: Array<{ col: number; row: number }>;
  /** Every tile that belongs to a room, so the ambient light stays off the empty space around them. */
  roomTiles: Array<{ col: number; row: number }>;
};

/**
 * Restyle rooms for a theme without touching the office's own state: walls keep their shape and
 * floors only swap between floor patterns, so walking and seating are unaffected.
 */
export function buildThemedMap(
  tileMap: TileType[][],
  tileColors: Array<ColorValue | null> | undefined,
  rooms: Array<RoomKey | null>,
  cols: number,
  theme: Theme,
  /** Tile numbers of the theme's own floor designs per room (drawn as they are, not colourised). */
  floorPatterns: Partial<Record<RoomKey, number>> = {},
  /** Whether the theme brings its own wall set, which is drawn uncoloured. */
  ownWalls = false,
): ThemedMap {
  const themedMap = tileMap.map((row) => [...row]);
  const themedColors = [...(tileColors ?? Array<ColorValue | null>(rooms.length).fill(null))];
  const trimTiles: ThemedMap["trimTiles"] = [];
  const roomTiles: ThemedMap["roomTiles"] = [];
  const roomAt = (col: number, row: number) => (row >= 0 && col >= 0 && col < cols ? rooms[row * cols + col] : null);

  for (let row = 0; row < tileMap.length; row++) {
    for (let col = 0; col < cols; col++) {
      const room = roomAt(col, row);
      if (!room) continue;
      roomTiles.push({ col, row });
      const style = theme.rooms[room];
      const ownFloor = floorPatterns[room];
      if (WALL_ROOMS.has(room) && ownWalls) {
        themedColors[row * cols + col] = null;
      } else if (ownFloor !== undefined) {
        themedMap[row][col] = ownFloor as TileType;
      } else if (style) {
        themedColors[row * cols + col] = style.color;
        if (style.pattern && !WALL_ROOMS.has(room)) themedMap[row][col] = style.pattern as TileType;
      }
      if (!WALL_ROOMS.has(room)) {
        const above = roomAt(col, row - 1);
        if (above && WALL_ROOMS.has(above)) trimTiles.push({ col, row });
      }
    }
  }
  return { tileMap: themedMap, tileColors: themedColors, trimTiles, roomTiles };
}

/** The theme's ambient light: a wash over the rooms, drawn on top of everything so it lights the whole scene. */
export function renderThemeAmbient(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  map: ThemedMap,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (!theme.ambient) return;
  const size = TILE_SIZE * zoom;
  ctx.save();
  ctx.globalCompositeOperation = theme.ambient.mode;
  ctx.globalAlpha = theme.ambient.alpha;
  ctx.fillStyle = theme.ambient.color;
  ctx.beginPath();
  for (const { col, row } of map.roomTiles) ctx.rect(offsetX + col * size, offsetY + row * size, size, size);
  ctx.fill();
  ctx.restore();
}

/**
 * The theme's glowing strips where floors meet the back walls. Drawn with the floor (under walls,
 * furniture and characters) so people and plants standing by the wall stay in front of them.
 */
export function renderThemeTrim(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  map: ThemedMap,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (!theme.trim) return;
  const size = TILE_SIZE * zoom;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = theme.trim.color;
  ctx.shadowColor = theme.trim.color;
  ctx.shadowBlur = theme.trim.glow * zoom;
  const height = Math.max(1, Math.round(zoom));
  for (const { col, row } of map.trimTiles) {
    ctx.fillRect(Math.round(offsetX + col * size), Math.round(offsetY + row * size), Math.ceil(size), height);
  }
  ctx.restore();
}
