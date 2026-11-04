import type { ColorValue } from '../../components/ui/types.js';
import {
  AREA_ACTIVE_ALPHA_MULTIPLIER,
  AREA_LABEL_ALPHA,
  AREA_LABEL_FALLBACK_COLOR,
  AREA_LABEL_FONT_SIZE_PX,
  AREA_LABEL_MIN_FONT_SIZE_PX,
  AREA_LABEL_SHADOW_ALPHA,
  AREA_LABEL_SHADOW_COLOR,
  AREA_OVERLAY_ALPHA,
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  BUTTON_ICON_COLOR,
  BUTTON_ICON_SIZE_FACTOR,
  BUTTON_LINE_WIDTH_MIN,
  BUTTON_LINE_WIDTH_ZOOM_FACTOR,
  BUTTON_MIN_RADIUS,
  BUTTON_RADIUS_ZOOM_FACTOR,
  CARPET_DEFAULT_ACCENT_COLOR,
  CARPET_DEFAULT_COLOR,
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  DELETE_BUTTON_BG,
  FALLBACK_FLOOR_COLOR,
  GHOST_BORDER_HOVER_FILL,
  GHOST_BORDER_HOVER_STROKE,
  GHOST_BORDER_STROKE,
  GHOST_INVALID_TINT,
  GHOST_PREVIEW_SPRITE_ALPHA,
  GHOST_PREVIEW_TINT_ALPHA,
  GHOST_VALID_TINT,
  GRID_LINE_COLOR,
  HEADLESS_CHARACTER_ALPHA,
  HOVERED_OUTLINE_ALPHA,
  OUTLINE_Z_SORT_OFFSET,
  ROTATE_BUTTON_BG,
  SEAT_AVAILABLE_COLOR,
  SEAT_BUSY_COLOR,
  SEAT_OWN_COLOR,
  SELECTED_OUTLINE_ALPHA,
  SELECTION_DASH_PATTERN,
  SELECTION_HIGHLIGHT_COLOR,
  VOID_TILE_DASH_PATTERN,
  VOID_TILE_OUTLINE_COLOR,
} from '../../constants.js';
import { getColorizedFloorSprite, hasFloorSprites, WALL_COLOR } from '../floorTiles.js';
import { mapOffset } from '../projection.js';
import {
  getCarpetJunctionSprite,
  getCarpetPaletteKey,
  hasCarpetSprites,
} from '../sprites/carpetTiles.js';
import { getPetSprites } from '../sprites/petSpriteData.js';
import { getCachedSprite, getOutlineSprite } from '../sprites/spriteCache.js';
import {
  BUBBLE_DECISION_SPRITE,
  BUBBLE_HEART_SPRITE,
  BUBBLE_PERMISSION_SPRITE,
  BUBBLE_WAITING_SPRITE,
  getCharacterSprites,
} from '../sprites/spriteData.js';
import type {
  AreaDefinition,
  CarpetTile,
  Character,
  FurnitureInstance,
  Pet,
  Seat,
  SpriteData,
  TileType as TileTypeVal,
} from '../types.js';
import { CharacterState, Direction, TILE_SIZE, TileType } from '../types.js';
import { getWallInstances, hasWallSprites, wallColorToHex } from '../wallTiles.js';
import { getCharacterSprite, isLanceUp, isSeated, riderFacing } from './characters.js';
import { getCatalogEntry, getRotationVariant } from '../layout/furnitureCatalog.js';
import { getFurnitureOverride, getFurnitureUidOverride } from './furnitureOverrides.js';
import { getLeisureDrawables, type LeisureRenderState } from './leisureEffects.js';
import {
  DJ_BOOTH_TYPE,
  DJ_SPEAKER_TYPE,
  getMusicAudio,
  renderDjBooth,
  renderDjSpeaker,
  renderPartyLights,
} from './djBooth.js';
import { renderMatrixEffect } from './matrixEffect.js';
import { isCheering, isWaving } from './cheer.js';
import { isNightTime, renderNight } from './nightTime.js';
import { getPetSpriteData } from './petEntity.js';

// ── Settings ────────────────────────────────────────────────────

/**
 * "Display headless as ghosts" — whether headless agents render translucent.
 * Module state rather than a render param: the rAF loop reads it every frame,
 * so a toggle takes effect on the next one without threading a 21st argument
 * through renderFrame. Same shape as setProviderCapabilities / setSoundEnabled.
 * Mirrors the server default (off) — the cue is opt-in, so an office looks the
 * same as it did before the setting existed until someone turns it on.
 */
let ghostHeadlessAgents = false;

export function setGhostHeadlessAgents(enabled: boolean): void {
  ghostHeadlessAgents = enabled;
}

export function isGhostHeadlessAgentsEnabled(): boolean {
  return ghostHeadlessAgents;
}

// ── Render functions ────────────────────────────────────────────

/**
 * Render the carpet layer. Called AFTER renderTileGrid and BEFORE seat
 * indicators / characters / furniture.
 *
 * Per junction (cols+1 × rows+1 grid of corners), we gather every
 * (variant, palette) pair from the up-to-4 adjacent tiles. Each pair becomes
 * one local "layer" drawn in ascending `order`, so the highest-order carpet
 * visually wins at overlaps. Sprite anchor: each 16×16 junction sprite is
 * centered on the corner — drawn at (offsetX + jx*s - halfS, offsetY + jy*s - halfS).
 *
 * @internal
 */
export function renderCarpetLayer(
  ctx: CanvasRenderingContext2D,
  carpetTiles: Array<CarpetTile | null>,
  cols: number,
  rows: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (!hasCarpetSprites()) return;
  if (!carpetTiles || carpetTiles.length === 0) return;

  const s = TILE_SIZE * zoom;
  const halfS = s / 2;

  for (let jy = 0; jy <= rows; jy++) {
    for (let jx = 0; jx <= cols; jx++) {
      const localGroups = new Map<
        string,
        {
          variant: number;
          color: ColorValue;
          accentColor: ColorValue;
          paletteKey: string;
          order: number;
        }
      >();

      const adjacent = [
        { col: jx - 1, row: jy - 1 }, // NW
        { col: jx, row: jy - 1 }, // NE
        { col: jx, row: jy }, // SE
        { col: jx - 1, row: jy }, // SW
      ];

      for (const pos of adjacent) {
        if (pos.col < 0 || pos.row < 0 || pos.col >= cols || pos.row >= rows) continue;
        const tile = carpetTiles[pos.row * cols + pos.col];
        if (!tile) continue;
        const color = tile.color ?? CARPET_DEFAULT_COLOR;
        const accentColor = tile.accentColor ?? CARPET_DEFAULT_ACCENT_COLOR;
        const paletteKey = getCarpetPaletteKey(color, accentColor);
        const key = `${tile.variant}:${paletteKey}`;
        const order = tile.order ?? 0;
        const existing = localGroups.get(key);
        if (!existing || order > existing.order) {
          localGroups.set(key, { variant: tile.variant, color, accentColor, paletteKey, order });
        }
      }

      if (localGroups.size === 0) continue;

      // Ascending order → drawn lowest first; highest-order layer ends on top.
      const ordered = [...localGroups.values()].sort((a, b) => a.order - b.order);
      for (const { variant, color, accentColor, paletteKey } of ordered) {
        const sprite = getCarpetJunctionSprite(
          jx,
          jy,
          variant,
          carpetTiles,
          cols,
          rows,
          color,
          accentColor,
          paletteKey,
        );
        if (!sprite) continue;
        const cached = getCachedSprite(sprite, zoom);
        ctx.drawImage(cached, offsetX + jx * s - halfS, offsetY + jy * s - halfS);
      }
    }
  }
}

/**
 * Translucent per-tile color wash for Areas. Runs ABOVE carpets/floor and
 * BELOW seat indicators / characters / furniture. The active area (the one
 * the editor has currently selected) gets a multiplier-bumped alpha so users
 * can see which area they're editing without changing every other area's
 * visibility.
 *
 * @internal
 */
export function renderAreaOverlay(
  ctx: CanvasRenderingContext2D,
  areaTiles: Array<string | null> | undefined,
  areas: AreaDefinition[] | undefined,
  cols: number,
  rows: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
  activeAreaLabel?: string | null,
): void {
  if (!areaTiles || areaTiles.length === 0) return;
  if (!areas || areas.length === 0) return;

  const s = TILE_SIZE * zoom;
  const colorMap = new Map<string, string>();
  for (const a of areas) colorMap.set(a.label, a.color);

  ctx.save();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const label = areaTiles[r * cols + c];
      if (!label) continue;
      const color = colorMap.get(label);
      if (!color) continue;
      ctx.globalAlpha =
        activeAreaLabel === label
          ? AREA_OVERLAY_ALPHA * AREA_ACTIVE_ALPHA_MULTIPLIER
          : AREA_OVERLAY_ALPHA;
      ctx.fillStyle = color;
      ctx.fillRect(offsetX + c * s, offsetY + r * s, s, s);
    }
  }
  ctx.restore();
}

/**
 * Render the centroid label for each Area, ABOVE characters/bubbles. Centroid
 * = arithmetic mean of all tile centers belonging to a given label. Pixel-art
 * drop shadow (no blur) for legibility on light backgrounds.
 *
 * @internal
 */
export function renderAreaLabels(
  ctx: CanvasRenderingContext2D,
  areaTiles: Array<string | null> | undefined,
  areas: AreaDefinition[] | undefined,
  cols: number,
  rows: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (!areaTiles || areaTiles.length === 0) return;
  if (!areas || areas.length === 0) return;

  const s = TILE_SIZE * zoom;
  const colorMap = new Map<string, string>();
  for (const a of areas) colorMap.set(a.label, a.color);

  // Centroid accumulator: label → { sumX, sumY, count }.
  const centroids = new Map<string, { sumX: number; sumY: number; count: number }>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const label = areaTiles[r * cols + c];
      if (!label) continue;
      const acc = centroids.get(label);
      if (acc) {
        acc.sumX += c;
        acc.sumY += r;
        acc.count += 1;
      } else {
        centroids.set(label, { sumX: c, sumY: r, count: 1 });
      }
    }
  }

  if (centroids.size === 0) return;

  const fontSize = Math.max(AREA_LABEL_FONT_SIZE_PX * zoom, AREA_LABEL_MIN_FONT_SIZE_PX);

  ctx.save();
  ctx.font = `bold ${fontSize}px 'FS Pixel Sans'`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const [label, acc] of centroids) {
    const cx = offsetX + (acc.sumX / acc.count + 0.5) * s;
    const cy = offsetY + (acc.sumY / acc.count + 0.5) * s;

    // Pixel-art drop shadow (1px right + down, no blur).
    ctx.globalAlpha = AREA_LABEL_SHADOW_ALPHA;
    ctx.fillStyle = AREA_LABEL_SHADOW_COLOR;
    ctx.fillText(label, cx + 1, cy + 1);

    // Main label — area's own color, falling back to white if missing.
    ctx.globalAlpha = AREA_LABEL_ALPHA;
    ctx.fillStyle = colorMap.get(label) ?? AREA_LABEL_FALLBACK_COLOR;
    ctx.fillText(label, cx, cy);
  }
  ctx.restore();
}

/** @internal */
export function renderTileGrid(
  ctx: CanvasRenderingContext2D,
  tileMap: TileTypeVal[][],
  offsetX: number,
  offsetY: number,
  zoom: number,
  tileColors?: Array<ColorValue | null>,
  cols?: number,
): void {
  const s = TILE_SIZE * zoom;
  const useSpriteFloors = hasFloorSprites();
  const tmRows = tileMap.length;
  const tmCols = tmRows > 0 ? tileMap[0].length : 0;
  const layoutCols = cols ?? tmCols;

  // Floor tiles + wall base color
  for (let r = 0; r < tmRows; r++) {
    for (let c = 0; c < tmCols; c++) {
      const tile = tileMap[r][c];

      // Skip VOID tiles entirely (transparent)
      if (tile === TileType.VOID) continue;

      if (tile === TileType.WALL || !useSpriteFloors) {
        // Wall tiles or fallback: solid color
        if (tile === TileType.WALL) {
          const colorIdx = r * layoutCols + c;
          const wallColor = tileColors?.[colorIdx];
          ctx.fillStyle = wallColor ? wallColorToHex(wallColor) : WALL_COLOR;
        } else {
          ctx.fillStyle = FALLBACK_FLOOR_COLOR;
        }
        ctx.fillRect(offsetX + c * s, offsetY + r * s, s, s);
        continue;
      }

      // Floor tile: get colorized sprite
      const colorIdx = r * layoutCols + c;
      const color = tileColors?.[colorIdx] ?? { h: 0, s: 0, b: 0, c: 0 };
      const sprite = getColorizedFloorSprite(tile, color);
      const cached = getCachedSprite(sprite, zoom);
      ctx.drawImage(cached, offsetX + c * s, offsetY + r * s);
    }
  }
}

interface ZDrawable {
  zY: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

/** @internal */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  furniture: FurnitureInstance[],
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  selectedAgentId: number | null,
  hoveredAgentId: number | null,
  leisure?: LeisureRenderState,
  pets: Pet[] = [],
): void {
  const drawables: ZDrawable[] = leisure ? getLeisureDrawables(leisure, characters, offsetX, offsetY, zoom) : [];

  // Seats whose agents are riding them (spinning at the desk, or off jousting): drawn with the rider instead
  const riders = new Map<string, Character>();
  for (const ch of characters) {
    if (ch.seatId && !ch.matrixEffect && riderFacing(ch) !== null) riders.set(ch.seatId, ch);
  }
  const riddenChairs = new Map<number, string>();

  // Furniture
  const now = new Date();
  for (const f of furniture) {
    const rider = f.uid ? riders.get(f.uid) : undefined;
    if (rider && f.type) {
      riddenChairs.set(rider.id, f.type);
      continue;
    }
    const isClock = f.type === CLOCK_TYPE;
    const isWhiteboard = f.type === WHITEBOARD_TYPE && !f.mirrored;
    // A company's wall art, then a theme's own furniture, replaces the sprite outright (same size,
    // so placement is unchanged).
    const base = getFurnitureUidOverride(f.uid) ?? getFurnitureOverride(f.type) ?? f.sprite;
    const sprite = isClock ? getBlankClockSprite(base) : isWhiteboard ? getBlankWhiteboardSprite(base) : base;
    const cached = getCachedSprite(sprite, zoom);
    const fx = offsetX + f.x * zoom;
    const fy = offsetY + f.y * zoom;
    // The DJ booth and its speakers draw themselves, so they can move to the music
    if (f.type === DJ_BOOTH_TYPE) {
      const time = now.getTime();
      drawables.push({ zY: f.zY, draw: (c) => renderDjBooth(c, cached, fx, fy, zoom, time) });
      continue;
    }
    if (f.type === DJ_SPEAKER_TYPE) {
      drawables.push({ zY: f.zY, draw: (c) => renderDjSpeaker(c, cached, fx, fy, zoom) });
      continue;
    }
    if (isClock) {
      drawables.push({ zY: f.zY + 0.01, draw: (c) => renderClockHands(c, fx, fy, zoom, now) });
    }
    if (isWhiteboard) {
      const uid = f.uid ?? '';
      drawables.push({ zY: f.zY + 0.01, draw: (c) => renderWhiteboardChart(c, fx, fy, zoom, uid) });
    }
    if (f.type?.startsWith(TERMINAL_TYPE_PREFIX)) {
      const screen = getFurnitureOverride(f.type) ? TERMINAL_SCREENS.themed : TERMINAL_SCREENS.classic;
      const seed = f.x * 31 + f.y * 17;
      const render = f.waiting ? renderEggTimer : renderTerminal;
      drawables.push({ zY: f.zY + 0.01, draw: (c) => render(c, fx, fy, zoom, screen, seed, now.getTime()) });
    }
    if (f.type === SCORECARD_TYPE && !f.mirrored) {
      drawables.push({ zY: f.zY + 0.01, draw: (c) => renderScorecard(c, fx + SCORECARD_INSET * zoom, fy, zoom) });
    }
    if (f.type === KANBAN_TYPE && !f.mirrored) {
      drawables.push({ zY: f.zY + 0.01, draw: (c) => renderKanbanNotes(c, fx, fy, zoom) });
    }
    if (f.mirrored) {
      drawables.push({
        zY: f.zY,
        draw: (c) => {
          c.save();
          c.translate(fx + cached.width, fy);
          c.scale(-1, 1);
          c.drawImage(cached, 0, 0);
          c.restore();
        },
      });
    } else {
      drawables.push({
        zY: f.zY,
        draw: (c) => {
          c.drawImage(cached, fx, fy);
        },
      });
    }
  }

  // Characters
  const music = getMusicAudio();
  const cheering = isCheering();
  const waving = !cheering && isWaving();
  for (const ch of characters) {
    const sprites = getCharacterSprites(ch.palette, ch.hueShift);
    // Waving hello faces the camera like a cheer, so it shares the cheer's place over other poses
    const cheer = cheering && !ch.isSick ? cheerStep(ch, sprites) : waving && !ch.isSick ? waveStep(ch, sprites) : null;
    const dj = !cheer && isDjing(ch) ? djStep(ch, sprites, music) : null;
    const dance = cheer ?? dj ?? (ch.dancing ? danceStep(ch, sprites, music) : null);
    const baseSpriteData = dance?.sprite ?? getCharacterSprite(ch, sprites);
    let posedSpriteData = baseSpriteData;
    if (ch.boardroomRole && !cheer) {
      const colors = poseColors(sprites.walk[Direction.DOWN][1]);
      const bob = handBob();
      if (ch.state === CharacterState.TYPE && ch.boardroomRole === 'inspector') {
        // Now and then points something out on the board they're studying
        if (Math.floor(performance.now() / INSPECT_POINT_MS + ch.id) % 3 === 0) {
          posedSpriteData = raiseArm(posedSpriteData, ch.dir, 'right', colors, bob, true);
        }
      } else if (ch.state === CharacterState.TYPE && ch.boardroomRole === 'presenter') {
        // The whiteboard is up and to the presenter's left as they face the room.
        posedSpriteData = raiseArm(posedSpriteData, ch.dir, 'left', colors, bob, true);
      }
    }
    const spriteData = ch.isSick ? getSickSprite(posedSpriteData) : posedSpriteData;
    const cached = getCachedSprite(spriteData, zoom);
    // Sitting offset: shift character down when seated so they visually sit in the chair
    const sittingOffset = isSeated(ch) ? CHARACTER_SITTING_OFFSET_PX : 0;
    // Sick agents sway queasily, then hunch forward while heaving
    const sway = ch.isSick ? Math.round(Math.sin(ch.sickTimer * 2.2) * 0.8) : (dance?.sway ?? 0);
    const hunch = ch.isSick && vomitPhase(ch) > 0 ? 1 : (dance?.hop ?? 0);
    // Anchor at bottom-center of character — round to integer device pixels
    const drawX = Math.round(offsetX + (ch.x + sway) * zoom - cached.width / 2);
    const drawY = Math.round(offsetY + (ch.y + sittingOffset + hunch) * zoom - cached.height);

    // Sort characters by bottom of their tile (not center) so they render
    // in front of same-row furniture (e.g. chairs) but behind furniture
    // at lower rows (e.g. desks, bookshelves that occlude from below).
    const charZY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET;

    // Headless agents (adopted, no terminal to focus) render translucent while
    // the "Display headless as ghosts" setting is on.
    const alpha = ch.isHeadless && ghostHeadlessAgents ? HEADLESS_CHARACTER_ALPHA : 1;

    // Matrix spawn/despawn effect — skip outline, use per-pixel rendering
    if (ch.matrixEffect) {
      const mDrawX = drawX;
      const mDrawY = drawY;
      const mSpriteData = spriteData;
      const mCh = ch;
      drawables.push({
        zY: charZY,
        draw: (c) => {
          c.save();
          c.globalAlpha = alpha;
          renderMatrixEffect(c, mCh, mSpriteData, mDrawX, mDrawY, zoom);
          c.restore();
        },
      });
      continue;
    }

    // White outline: full opacity for selected, 50% for hover
    const isSelected = selectedAgentId !== null && ch.id === selectedAgentId;
    const isHovered = hoveredAgentId !== null && ch.id === hoveredAgentId;
    if (isSelected || isHovered) {
      const outlineAlpha = isSelected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA;
      const outlineData = getOutlineSprite(spriteData);
      const outlineCached = getCachedSprite(outlineData, zoom);
      const olDrawX = drawX - zoom; // 1 sprite-pixel offset, scaled
      const olDrawY = drawY - zoom; // outline follows sitting offset via drawY
      drawables.push({
        zY: charZY - OUTLINE_Z_SORT_OFFSET, // sort just before character
        draw: (c) => {
          c.save();
          c.globalAlpha = outlineAlpha;
          c.drawImage(outlineCached, olDrawX, olDrawY);
          c.restore();
        },
      });
    }

    drawables.push({
      zY: charZY,
      draw: (c) => {
        if (alpha === 1) {
          c.drawImage(cached, drawX, drawY);
          return;
        }
        c.save();
        c.globalAlpha = alpha;
        c.drawImage(cached, drawX, drawY);
        c.restore();
      },
    });

    // Their swivel chair turns with them: its back hides them when they face away, otherwise they sit in front of it
    const chairType = riddenChairs.get(ch.id);
    const facing = cheer ? Direction.DOWN : riderFacing(ch);
    const chair = chairType && facing !== null ? riddenChairSprite(chairType, facing) : null;
    if (chair) {
      const chairCached = getCachedSprite(chair.sprite, zoom);
      const chairX = Math.round(offsetX + ch.x * zoom - chairCached.width / 2);
      const chairY = Math.round(offsetY + (ch.y + TILE_SIZE / 2) * zoom - chairCached.height);
      drawables.push({
        zY: charZY + (facing === Direction.UP ? OUTLINE_Z_SORT_OFFSET * 2 : -OUTLINE_Z_SORT_OFFSET * 2),
        draw: (c) => {
          if (!chair.mirrored) {
            c.drawImage(chairCached, chairX, chairY);
            return;
          }
          c.save();
          c.translate(chairX + chairCached.width, chairY);
          c.scale(-1, 1);
          c.drawImage(chairCached, 0, 0);
          c.restore();
        },
      });
    }
    if (isLanceUp(ch) && !cheer) {
      const jouster = ch;
      drawables.push({ zY: charZY + OUTLINE_Z_SORT_OFFSET * 3, draw: (c) => renderLance(c, jouster, offsetX, offsetY, zoom) });
    }
    // One spark per clash, from the left-hand jouster
    if (ch.joust?.clashX != null && ch.joust.side === 1) {
      const jouster = ch;
      drawables.push({ zY: charZY + 1, draw: (c) => renderClashSpark(c, jouster, offsetX, offsetY, zoom) });
    }

    if (ch.isSick && ch.state !== CharacterState.WALK) {
      const sickCh = ch;
      drawables.push({
        zY: charZY - OUTLINE_Z_SORT_OFFSET * 2,
        draw: (c) => renderSickPuddle(c, sickCh, offsetX, offsetY, zoom),
      });
      drawables.push({
        zY: charZY + OUTLINE_Z_SORT_OFFSET,
        draw: (c) => renderVomitStream(c, sickCh, offsetX, offsetY, zoom),
      });
    }
  }

  // ── Pets ──────────────────────────────────────────────
  for (const pet of pets) {
    const petSprites = getPetSprites(pet.petType);
    const spriteData = getPetSpriteData(pet, petSprites);
    if (!spriteData) continue;

    const cached = getCachedSprite(spriteData, zoom);
    // Anchor at bottom-center at (pet.x, pet.y) — round to integer device pixels
    const drawX = Math.round(offsetX + pet.x * zoom - cached.width / 2);
    const drawY = Math.round(offsetY + pet.y * zoom - cached.height);

    // Z-sort key: matches the chair/character "row boundary" formula.
    // pet.y is the pixel center, so + TILE_SIZE/2 lifts us to the row's bottom edge.
    const petZY = pet.y + TILE_SIZE / 2;

    drawables.push({
      zY: petZY,
      draw: (c) => {
        c.drawImage(cached, drawX, drawY);
      },
    });
  }

  // Sort by Y (lower = in front = drawn later)
  drawables.sort((a, b) => a.zY - b.zY);

  for (const d of drawables) {
    d.draw(ctx);
  }

  // After dark (6pm to 6am): night time everywhere, then the DJ booth's lasers and disco ball
  // shining through it
  if (isNightTime(now)) {
    renderNight(ctx, furniture, offsetX, offsetY, zoom, now.getTime());
    renderPartyLights(ctx, offsetX, offsetY, zoom, now.getTime());
  }
}

// ── Terminal on active front-facing computers ───────────────────

/** Front-facing computers in use (their "on" animation frames). */
const TERMINAL_TYPE_PREFIX = 'PC_FRONT_ON';
/** Screen area in sprite pixels: the original monitor, and the themes' redrawn one. */
const TERMINAL_SCREENS = {
  classic: { x: 3, y: 5, w: 10, h: 5 },
  themed: { x: 1, y: 1, w: 14, h: 11 },
};
const TERMINAL_LINE_SEC = 1.4;
const TERMINAL_CURSOR_SEC = 0.5;

let terminalColors = { background: '#0f1f17', text: '#60c677', bright: '#c8ffd4' };

/** Terminal colours for the current look (e.g. a theme's screen colours); null for classic green. */
export function setTerminalColors(colors: { background: string; text: string; bright: string } | null): void {
  terminalColors = colors ?? { background: '#0f1f17', text: '#60c677', bright: '#c8ffd4' };
}

/** 0..1 from integers, stable across frames. */
function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2d);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967295;
}

/** A line of "text": a prompt pixel, then words of 1-4 chars with single gaps, up to `width` chars. */
function terminalLine(seed: number, line: number, width: number): boolean[] {
  const cells: boolean[] = [true, false];
  const length = 4 + Math.floor(hash01(seed, line) * (width - 5));
  let word = 0;
  while (cells.length < length) {
    const size = 1 + Math.floor(hash01(seed + word * 7, line) * 4);
    for (let i = 0; i < size && cells.length < length; i++) cells.push(true);
    if (cells.length < length) cells.push(false);
    word++;
  }
  return cells;
}

/**
 * Scrolling terminal: one text row every 2px, the newest line typing out character by character,
 * older lines scrolled up, and a blinking block cursor. `seed` keeps each computer's text different.
 */
function renderTerminal(
  c: CanvasRenderingContext2D,
  fx: number,
  fy: number,
  zoom: number,
  screen: { x: number; y: number; w: number; h: number },
  seed: number,
  nowMs: number,
): void {
  const pixel = (x: number, y: number, color: string) => {
    c.fillStyle = color;
    c.fillRect(Math.round(fx + (screen.x + x) * zoom), Math.round(fy + (screen.y + y) * zoom), Math.ceil(zoom), Math.ceil(zoom));
  };
  c.fillStyle = terminalColors.background;
  c.fillRect(Math.round(fx + screen.x * zoom), Math.round(fy + screen.y * zoom), Math.ceil(screen.w * zoom), Math.ceil(screen.h * zoom));

  const t = nowMs / 1000 + hash01(seed, 0) * 10;
  const current = Math.floor(t / TERMINAL_LINE_SEC);
  const progress = (t % TERMINAL_LINE_SEC) / TERMINAL_LINE_SEC;
  const rows = Math.ceil(screen.h / 2);
  const width = screen.w - 1;
  for (let row = 0; row < rows; row++) {
    const line = current - (rows - 1 - row);
    if (line < 0) continue;
    const cells = terminalLine(seed, line, width);
    // The newest line types out over most of its slot, then pauses briefly.
    const shown = line === current ? Math.min(cells.length, Math.floor(progress * 1.25 * cells.length)) : cells.length;
    const y = row * 2;
    for (let x = 0; x < shown; x++) {
      if (cells[x]) pixel(x, y, x === 0 ? terminalColors.bright : terminalColors.text);
    }
    if (line === current && Math.floor(t / TERMINAL_CURSOR_SEC) % 2 === 0 && shown < width) {
      pixel(shown, y, terminalColors.bright);
    }
  }
}

// ── Chair jousting ──────────────────────────────────────────────

/** Swivel chair used for riders whose own seat doesn't turn (e.g. a stool) */
const SWIVEL_CHAIR_TYPE = 'CUSHIONED_CHAIR_FRONT';
const ORIENTATION_BY_DIRECTION: Record<Direction, string> = {
  [Direction.DOWN]: 'front',
  [Direction.UP]: 'back',
  [Direction.RIGHT]: 'right',
  [Direction.LEFT]: 'left',
};

/** A ridden chair turned to face `dir`: the seat's own rotated variant, or a swivel chair when it has none. */
function riddenChairSprite(type: string, dir: Direction): { sprite: SpriteData; mirrored: boolean } | null {
  const orientation = ORIENTATION_BY_DIRECTION[dir];
  const variant = getRotationVariant(type, orientation) ?? getRotationVariant(SWIVEL_CHAIR_TYPE, orientation);
  const entry = variant ? getCatalogEntry(variant) : undefined;
  if (!variant || !entry) return null;
  return { sprite: getFurnitureOverride(variant) ?? entry.sprite, mirrored: orientation === 'left' && !!entry.mirrorSide };
}

/** Lance length and height above the seat, in sprite pixels */
const LANCE_LENGTH = 13;
const LANCE_HEIGHT = 10;
const LANCE_SHAFT = '#e9dfc4';
const LANCE_TIP = '#d94841';
const CLASH_COLORS = ['#ffffff', '#ffe066'];

/** A rolled-up poster held out level at the opponent. */
function renderLance(c: CanvasRenderingContext2D, ch: Character, offsetX: number, offsetY: number, zoom: number): void {
  const joust = ch.joust!;
  const px = Math.ceil(zoom);
  const y = Math.round(offsetY + (ch.y + CHARACTER_SITTING_OFFSET_PX - LANCE_HEIGHT) * zoom);
  for (let i = 2; i < 2 + LANCE_LENGTH; i++) {
    const x = Math.round(offsetX + (ch.x + joust.side * i) * zoom);
    c.fillStyle = i >= LANCE_LENGTH ? LANCE_TIP : LANCE_SHAFT;
    c.fillRect(joust.side === 1 ? x : x - px, y, px, px);
  }
}

/** Where the lances meet in a clash: a star of sparks flickering between white and yellow. */
function renderClashSpark(c: CanvasRenderingContext2D, ch: Character, offsetX: number, offsetY: number, zoom: number): void {
  const joust = ch.joust!;
  if (joust.clashX === null) return;
  const px = Math.ceil(zoom);
  const y = Math.round(offsetY + (ch.y + CHARACTER_SITTING_OFFSET_PX - LANCE_HEIGHT) * zoom);
  const cx = Math.round(offsetX + joust.clashX * zoom);
  const flicker = Math.floor(performance.now() / 80) % 2;
  const rays = [[0, 0], [0, -2], [0, 2], [-2, 0], [2, 0], [-1, -1], [1, 1], [-1, 1], [1, -1], [0, -3], [0, 3], [-3, 0], [3, 0]];
  rays.forEach(([dx, dy], i) => {
    c.fillStyle = CLASH_COLORS[(i + flicker) % 2];
    c.fillRect(cx + dx * px, y + dy * px, px, px);
  });
}

// ── Egg timer while an agent waits on a long tool call ──────────

/**
 * Egg timers, upright: `#` glass and frame, `T` sand in the top bulb (drains from its surface down),
 * `B` sand in the bottom bulb (piles up from the floor), `N` the neck, where sand trickles through.
 * The classic monitor's screen is only 5px tall, so it gets a tiny one.
 */
const EGG_TIMERS = {
  small: ['#####', '.#T#.', '..N..', '.#B#.', '#####'],
  large: ['#######', '.#TTT#.', '.#TTT#.', '..#T#..', '...N...', '..#B#..', '.#BBB#.', '.#BBB#.', '#######'],
};
/** Sand runs through for this long, then the timer is turned over. */
const EGG_TIMER_SAND_SEC = 6;
const EGG_TIMER_FLIP_SEC = 0.4;
const EGG_TIMER_SAND = '#f2c14e';

type EggTimerCell = { x: number; y: number; color: string };

/** The egg timer's pixels, upright, `progress` (0..1) of the way through its sand. */
function eggTimerCells(rows: string[], progress: number): EggTimerCell[] {
  const cells: EggTimerCell[] = [];
  const top: Array<{ x: number; y: number }> = [];
  const bottom: Array<{ x: number; y: number }> = [];
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '#') cells.push({ x, y, color: terminalColors.text });
    else if (ch === 'T') top.push({ x, y });
    else if (ch === 'B') bottom.push({ x, y });
    else if (ch === 'N') {
      // A trickle while there's sand to fall; otherwise just the glass
      const falling = progress < 0.95 && Math.floor(performance.now() / 150) % 3 !== 0;
      cells.push({ x, y, color: falling ? EGG_TIMER_SAND : terminalColors.text });
    }
  }));
  // The top drains from its surface; the bottom fills from its floor
  const drained = Math.round(progress * top.length);
  for (const cell of top.slice(drained)) cells.push({ ...cell, color: EGG_TIMER_SAND });
  const filled = Math.round(progress * bottom.length);
  for (const cell of [...bottom].reverse().slice(0, filled)) cells.push({ ...cell, color: EGG_TIMER_SAND });
  return cells;
}

/**
 * An egg timer in place of the terminal: the sand runs through, then it's turned over (shown on its
 * side for a moment) and starts again. `seed` keeps each computer's timer out of step with the rest.
 */
function renderEggTimer(
  c: CanvasRenderingContext2D,
  fx: number,
  fy: number,
  zoom: number,
  screen: { x: number; y: number; w: number; h: number },
  seed: number,
  nowMs: number,
): void {
  c.fillStyle = terminalColors.background;
  c.fillRect(Math.round(fx + screen.x * zoom), Math.round(fy + screen.y * zoom), Math.ceil(screen.w * zoom), Math.ceil(screen.h * zoom));

  const rows = screen.h >= EGG_TIMERS.large.length ? EGG_TIMERS.large : EGG_TIMERS.small;
  const cycle = EGG_TIMER_SAND_SEC + EGG_TIMER_FLIP_SEC;
  const t = (nowMs / 1000 + hash01(seed, 1) * cycle) % cycle;
  const turning = t >= EGG_TIMER_SAND_SEC;
  // Mid-turn it lies on its side with all its sand in what was the bottom bulb
  const cells = eggTimerCells(rows, turning ? 1 : t / EGG_TIMER_SAND_SEC);
  const h = rows.length;
  const w = rows[0].length;
  const [drawW, drawH] = turning ? [h, w] : [w, h];
  const left = Math.floor((screen.w - drawW) / 2);
  const top = Math.floor((screen.h - drawH) / 2);
  for (const cell of cells) {
    // A quarter turn clockwise: the bottom bulb swings round to the left
    const x = turning ? h - 1 - cell.y : cell.x;
    const y = turning ? cell.x : cell.y;
    c.fillStyle = cell.color;
    c.fillRect(
      Math.round(fx + (screen.x + left + x) * zoom),
      Math.round(fy + (screen.y + top + y) * zoom),
      Math.ceil(zoom),
      Math.ceil(zoom),
    );
  }
}

// ── Wall clocks ─────────────────────────────────────────────────

const CLOCK_TYPE = 'CLOCK';
/** Centre of the clock face in sprite pixels (the face spans cols 3–12, rows 12–19). */
const CLOCK_CENTER = { x: 8, y: 16 };
/** Painted-on hands are cleared within this radius, leaving the rim alone. */
const CLOCK_FACE_RADIUS = 3.6;
const CLOCK_HANDS = {
  hour: { length: 2.4, color: '#394449' },
  minute: { length: 3.6, color: '#394449' },
  second: { length: 3.6, color: '#eb4c3f' },
};

const blankClockCache = new WeakMap<SpriteData, SpriteData>();

/** The clock sprite with its painted hands wiped, so the real time can be drawn over it. */
function getBlankClockSprite(sprite: SpriteData): SpriteData {
  let blank = blankClockCache.get(sprite);
  if (!blank) {
    const face = sprite[CLOCK_CENTER.y]?.[CLOCK_CENTER.x - 4] || '#ededed';
    blank = sprite.map((row, y) =>
      row.map((color, x) => {
        const inFace = Math.hypot(x + 0.5 - CLOCK_CENTER.x, y + 0.5 - CLOCK_CENTER.y) < CLOCK_FACE_RADIUS;
        return inFace && color ? face : color;
      }),
    );
    blankClockCache.set(sprite, blank);
  }
  return blank;
}

/** Hour, minute and second hands for the viewer's local time, snapped to the sprite's pixel grid. */
function renderClockHands(c: CanvasRenderingContext2D, fx: number, fy: number, zoom: number, now: Date): void {
  const seconds = now.getSeconds();
  const minutes = now.getMinutes() + seconds / 60;
  const hours = (now.getHours() % 12) + minutes / 60;
  const hand = (turns: number, { length, color }: { length: number; color: string }) => {
    const angle = turns * Math.PI * 2;
    const dx = Math.sin(angle);
    const dy = -Math.cos(angle);
    c.fillStyle = color;
    const drawn = new Set<string>();
    for (let t = 0; t <= length; t += 0.25) {
      const px = Math.floor(CLOCK_CENTER.x + dx * t);
      const py = Math.floor(CLOCK_CENTER.y + dy * t);
      const key = `${px},${py}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      c.fillRect(Math.round(fx + px * zoom), Math.round(fy + py * zoom), Math.ceil(zoom), Math.ceil(zoom));
    }
  };
  hand(seconds / 60, CLOCK_HANDS.second);
  hand(minutes / 60, CLOCK_HANDS.minute);
  hand(hours / 12, CLOCK_HANDS.hour);
}

// ── Whiteboard chart ────────────────────────────────────────────

const WHITEBOARD_TYPE = 'WHITEBOARD';
/** Writable area of the whiteboard sprite, in sprite pixels (inclusive). */
const WHITEBOARD_AREA = { left: 5, right: 26, top: 12, bottom: 20 };
/** A dark surface like the kanban board's, so the bright columns stand out. */
const WHITEBOARD_COLORS = {
  surface: '#1f232a',
  axis: '#8a8f94',
  bar: '#40c057',
  latest: '#8ce99a',
  highlight: '#ffffff',
};
/** A gentle climb shown until real data arrives. */
const PLACEHOLDER_SERIES = [2, 3, 5, 4, 7, 9];

/** Column values per whiteboard (by furniture uid), oldest first; boards without any show a placeholder. */
let whiteboardSeries = new Map<string, number[]>();
let whiteboardHighlight: { uid: string; index: number } | null = null;
const blankWhiteboardCache = new WeakMap<SpriteData, SpriteData>();

export function setWhiteboardSeries(seriesByUid: Record<string, number[] | null>): void {
  whiteboardSeries = new Map(
    Object.entries(seriesByUid).filter((entry): entry is [string, number[]] => !!entry[1] && entry[1].length >= 2),
  );
}

function seriesFor(uid: string): number[] {
  return whiteboardSeries.get(uid) ?? PLACEHOLDER_SERIES;
}

/** Draw one column (by index into that board's series) highlighted, e.g. while hovered; or none. */
export function setWhiteboardHighlight(highlight: { uid: string; index: number } | null): void {
  whiteboardHighlight = highlight;
}

/** The whiteboard with its writing area wiped to a dark surface, ready for the chart. */
function getBlankWhiteboardSprite(sprite: SpriteData): SpriteData {
  let blank = blankWhiteboardCache.get(sprite);
  if (!blank) {
    const { left, right, top, bottom } = WHITEBOARD_AREA;
    blank = sprite.map((row, y) =>
      row.map((color, x) => (x >= left && x <= right && y >= top && y <= bottom && color ? WHITEBOARD_COLORS.surface : color)),
    );
    blankWhiteboardCache.set(sprite, blank);
  }
  return blank;
}

/**
 * Chart geometry in whiteboard sprite pixels: axes, plus a column per value scaled from zero so
 * growth reads as growth. Columns share the plot width with 1px gaps; if there are more values
 * than fit, the most recent are kept. `index` is each column's position in the full series.
 */
function whiteboardLayout(series: number[]) {
  const { left, right, top, bottom } = WHITEBOARD_AREA;
  const axisX = left + 1;
  const axisY = bottom - 1;
  const plot = { left: axisX + 2, right: right - 2, top: top + 1, bottom: axisY - 1 };
  const plotWidth = plot.right - plot.left + 1;
  const plotHeight = plot.bottom - plot.top + 1;
  const values = series.slice(-Math.ceil(plotWidth / 2));
  const firstIndex = series.length - values.length;
  const barWidth = Math.max(1, Math.floor((plotWidth - (values.length - 1)) / values.length));
  const used = values.length * barWidth + (values.length - 1);
  const startX = plot.left + Math.floor((plotWidth - used) / 2);
  const max = Math.max(...values, 1);
  const bars = values.map((value, i) => {
    const height = value > 0 ? Math.max(1, Math.round((value / max) * plotHeight)) : 0;
    return { index: firstIndex + i, x: startX + i * (barWidth + 1), y: plot.bottom - height + 1, width: barWidth, height };
  });
  return { axisX, axisY, plot, bars };
}

/**
 * What's under a point on a whiteboard (in its sprite's pixels, from the top-left): the column
 * (index into the series) whose slot it's over, `bar: null` elsewhere on the chart, or null off it.
 */
export function whiteboardChartAt(uid: string, x: number, y: number): { bar: number | null } | null {
  const { left, right, top, bottom } = WHITEBOARD_AREA;
  if (x < left || x >= right + 1 || y < top || y >= bottom + 1) return null;
  const { plot, axisY, bars } = whiteboardLayout(seriesFor(uid));
  // The whole slot counts, not just the coloured part, so short columns are easy to hover.
  const bar = bars.find((b) => x >= b.x - 0.5 && x < b.x + b.width + 0.5 && y >= plot.top && y < axisY);
  return { bar: bar ? bar.index : null };
}

function renderWhiteboardChart(c: CanvasRenderingContext2D, fx: number, fy: number, zoom: number, uid: string): void {
  const { right, top } = WHITEBOARD_AREA;
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    c.fillStyle = color;
    c.fillRect(Math.round(fx + x * zoom), Math.round(fy + y * zoom), Math.ceil(w * zoom), Math.ceil(h * zoom));
  };
  const series = seriesFor(uid);
  const { axisX, axisY, bars } = whiteboardLayout(series);
  rect(axisX, top + 1, 1, axisY - top, WHITEBOARD_COLORS.axis);
  rect(axisX, axisY, right - axisX, 1, WHITEBOARD_COLORS.axis);
  const latest = series.length - 1;
  const highlighted = whiteboardHighlight?.uid === uid ? whiteboardHighlight.index : null;
  for (const bar of bars) {
    if (!bar.height) continue;
    const color = bar.index === highlighted
      ? WHITEBOARD_COLORS.highlight
      : bar.index === latest ? WHITEBOARD_COLORS.latest : WHITEBOARD_COLORS.bar;
    rect(bar.x, bar.y, bar.width, bar.height, color);
  }
}

// ── Scorecard board ─────────────────────────────────────────────

const SCORECARD_TYPE = 'SCORECARD_BOARD';
/** The 48px board sits this far into its 64px-wide sprite, centred between its wall neighbours. */
const SCORECARD_INSET = 9;
type Rag = 'green' | 'yellow' | 'red';
/** Layout on the scorecard board itself (48x32, inset within its sprite), in sprite pixels. */
const SCORECARD_LAYOUT = {
  light: { x: 5, y: 9, w: 7, h: 15 },
  lamps: { red: 11.5, yellow: 16, green: 20.5 } as Record<Rag, number>,
  rows: { x: 14, lampW: 2, barX: 18, maxBarX: 42, top: 9, pitch: 2, max: 8 },
};
const RAG_COLORS: Record<Rag, { lit: string; dim: string }> = {
  red: { lit: '#ff4d4d', dim: '#4a1f24' },
  yellow: { lit: '#ffd43b', dim: '#4a4320' },
  green: { lit: '#51cf66', dim: '#1f4a2a' },
};

/** Overall status and each section's status, with how long each section's label is (for its bar). */
let scorecard: { overall: Rag; sections: Array<{ status: Rag; labelLength: number }> } | null = null;
let scorecardHighlight: number | null = null;

export function setScorecard(data: typeof scorecard): void {
  scorecard = data;
}

/** Highlight one section row (e.g. while hovered); null for none. */
export function setScorecardHighlight(index: number | null): void {
  scorecardHighlight = index;
}

function scorecardRowY(index: number, count: number): number {
  const { top, pitch, max } = SCORECARD_LAYOUT.rows;
  // Fewer rows sit centred in the space for `max`.
  return top + index * pitch + Math.floor(((max - Math.min(count, max)) * pitch) / 2);
}

/** What's under a point on the scorecard sprite (sprite pixels): a section row, or the board as a whole. */
export function scorecardAt(spriteX: number, y: number): { section: number | null } | null {
  const x = spriteX - SCORECARD_INSET;
  if (x < 3 || x >= 45 || y < 8 || y >= 25) return null;
  const count = Math.min(scorecard?.sections.length ?? 0, SCORECARD_LAYOUT.rows.max);
  const { x: rowX, maxBarX, pitch } = SCORECARD_LAYOUT.rows;
  for (let i = 0; i < count; i++) {
    const rowY = scorecardRowY(i, count);
    if (x >= rowX - 0.5 && x < maxBarX + 1 && y >= rowY - pitch / 4 && y < rowY + pitch * 0.75) return { section: i };
  }
  return { section: null };
}

function renderScorecard(c: CanvasRenderingContext2D, fx: number, fy: number, zoom: number): void {
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    c.fillStyle = color;
    c.fillRect(Math.round(fx + x * zoom), Math.round(fy + y * zoom), Math.ceil(w * zoom), Math.ceil(h * zoom));
  };
  const { light, lamps, rows } = SCORECARD_LAYOUT;
  // Traffic light: a housing with three lamps, the overall status lit.
  rect(light.x, light.y, light.w, light.h, '#0b0d10');
  rect(light.x + 1, light.y + 1, light.w - 2, light.h - 2, '#16191e');
  for (const rag of ['red', 'yellow', 'green'] as const) {
    const lit = scorecard?.overall === rag;
    const cx = light.x + light.w / 2;
    const color = lit ? RAG_COLORS[rag].lit : RAG_COLORS[rag].dim;
    rect(cx - 1.5, lamps[rag] - 1.5, 3, 3, color);
    rect(cx - 1, lamps[rag] - 2, 2, 4, color);
    if (lit) rect(cx - 1, lamps[rag] - 1, 1, 1, '#ffffff');
  }
  // One row per section: its lamp, then a bar standing in for the label.
  const sections = (scorecard?.sections ?? []).slice(0, rows.max);
  sections.forEach((section, i) => {
    const y = scorecardRowY(i, sections.length);
    rect(rows.x, y, rows.lampW, 1, RAG_COLORS[section.status].lit);
    const barLength = Math.min(rows.maxBarX - rows.barX, 6 + section.labelLength);
    rect(rows.barX, y, barLength, 1, i === scorecardHighlight ? '#ffffff' : '#6b7280');
  });
}

// ── Kanban board ────────────────────────────────────────────────

const KANBAN_TYPE = 'KANBAN_BOARD';
/**
 * Where notes go on the KANBAN_BOARD sprite, in sprite pixels: five 10px-wide columns
 * (backlog, todo, in progress, in review, blocked) under their coloured header strips.
 */
const KANBAN_LAYOUT = { firstColumnX: 5, columnPitch: 11, notesTop: 11, notePitch: 3, noteSize: 2, perRow: 3, rows: 5 };
const KANBAN_NOTE_COLORS: Record<string, string> = {
  critical: '#ff6b6b',
  high: '#ffa94d',
  medium: '#ffe066',
  low: '#b2f2bb',
};
const KANBAN_OVERFLOW_COLOR = '#c9ced6';
const KANBAN_HIGHLIGHT_COLOR = '#ffffff';
const KANBAN_CAPACITY = KANBAN_LAYOUT.perRow * KANBAN_LAYOUT.rows;

/** Each column's open issues as priorities, most urgent first; one post-it per issue. */
let kanbanColumns: string[][] = [];
let kanbanHighlight: { column: number; index: number } | null = null;

export function setKanbanColumns(columns: string[][] | null): void {
  kanbanColumns = columns ?? [];
}

/** Outline one post-it (e.g. while it's hovered), or none. */
export function setKanbanHighlight(slot: { column: number; index: number } | null): void {
  kanbanHighlight = slot;
}

/** Top-left of a post-it slot, in the board sprite's pixels. */
function kanbanSlotOrigin(column: number, index: number): { x: number; y: number } {
  const { firstColumnX, columnPitch, notesTop, notePitch, perRow } = KANBAN_LAYOUT;
  return {
    x: firstColumnX + column * columnPitch + 1 + (index % perRow) * notePitch,
    y: notesTop + Math.floor(index / perRow) * notePitch,
  };
}

/** Number of post-its drawn in a column; when it overflows, the last slot is an "and more" dot. */
function kanbanShown(count: number): number {
  return count > KANBAN_CAPACITY ? KANBAN_CAPACITY - 1 : count;
}

/**
 * The post-it under a point on a KANBAN_BOARD (in its sprite's pixels, from the top-left).
 * `overflow` is the "and more" dot, standing in for issues from `index` onward.
 */
export function kanbanNoteAt(x: number, y: number): { column: number; index: number; overflow: boolean } | null {
  const { noteSize } = KANBAN_LAYOUT;
  for (let column = 0; column < Math.min(5, kanbanColumns.length); column++) {
    const count = kanbanColumns[column].length;
    const slots = count > KANBAN_CAPACITY ? KANBAN_CAPACITY : count;
    for (let index = 0; index < slots; index++) {
      const origin = kanbanSlotOrigin(column, index);
      // Pad by half the gap so the pointer doesn't flicker between neighbouring notes.
      if (x >= origin.x - 0.5 && x < origin.x + noteSize + 0.5 && y >= origin.y - 0.5 && y < origin.y + noteSize + 0.5) {
        return { column, index, overflow: index >= kanbanShown(count) };
      }
    }
  }
  return null;
}

function renderKanbanNotes(c: CanvasRenderingContext2D, fx: number, fy: number, zoom: number): void {
  const { noteSize } = KANBAN_LAYOUT;
  const size = Math.ceil(noteSize * zoom);
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    c.fillStyle = color;
    c.fillRect(Math.round(fx + x * zoom), Math.round(fy + y * zoom), Math.ceil(w * zoom), Math.ceil(h * zoom));
  };
  kanbanColumns.slice(0, 5).forEach((priorities, column) => {
    const shown = kanbanShown(priorities.length);
    for (let i = 0; i < shown; i++) {
      const { x, y } = kanbanSlotOrigin(column, i);
      if (kanbanHighlight?.column === column && kanbanHighlight.index === i) {
        rect(x - 1, y - 1, noteSize + 2, noteSize + 2, KANBAN_HIGHLIGHT_COLOR);
      }
      c.fillStyle = KANBAN_NOTE_COLORS[priorities[i]] ?? KANBAN_NOTE_COLORS.medium;
      c.fillRect(Math.round(fx + x * zoom), Math.round(fy + y * zoom), size, size);
    }
    if (priorities.length > KANBAN_CAPACITY) {
      // More than fit: the last slot becomes a small "and more" dot.
      const { x, y } = kanbanSlotOrigin(column, KANBAN_CAPACITY - 1);
      rect(x + 0.5, y + 0.5, 1, 1, KANBAN_OVERFLOW_COLOR);
    }
  });
}

// ── Poses: raised hand, pointing ───────────────────────────────
//
// Poses are drawn onto copies of the character's sprite. Coordinates are in the original
// 16px-wide frame and relative to the top of the head, since sitting frames sit lower in
// the frame than standing ones.

const SPRITE_W = 16;
const HAND_BOB_SEC = 0.45;
/** Where outline, sleeve and hand colours sit on every character's front-facing standing frame. */
const POSE_COLOR_PIXELS = { outline: [20, 2], sleeve: [20, 3], hand: [22, 2] } as const;
/** How long a boardroom inspector points at the board, or just studies it, at a time */
const INSPECT_POINT_MS = 2500;

type PoseColors = { outline: string; sleeve: string; hand: string };
type PoseCanvas = {
  rows: SpriteData;
  top: number;
  set: (row: number, col: number, color: string, onlyIfEmpty?: boolean) => void;
};

const poseCache = new WeakMap<SpriteData, Map<string, SpriteData>>();

/**
 * One step of a dance to the DJ booth's music: a move per beat (each dancer a few beats out from the next,
 * so they don't all move together), stepping feet, arms in dance shapes, a hop on the beat and a sway.
 */
function danceStep(
  ch: Character,
  sprites: ReturnType<typeof getCharacterSprites>,
  music: ReturnType<typeof getMusicAudio>,
): { sprite: SpriteData; hop: number; sway: number } {
  const move = DANCE_MOVES[(music.beats + ch.id) % DANCE_MOVES.length];
  // Between beats the arms swap to the move's off-beat shape, so they keep pumping
  const offBeat = music.beat < 0.45;
  const [left, right] = offBeat && move.offBeat ? move.offBeat : move.arms;
  let sprite = sprites.walk[move.dir][offBeat ? move.frame : (move.frame + 2) % 4];
  if (move.dir === Direction.DOWN) {
    const colors = poseColors(sprites.walk[Direction.DOWN][1]);
    sprite = danceArm(danceArm(sprite, 'right', right, colors), 'left', left, colors);
  }
  return {
    sprite,
    hop: -Math.round(music.beat * 2),
    sway: Math.round(Math.sin(performance.now() / 180 + ch.id) * 0.8),
  };
}

/** Cheering an issue done: facing out with both arms thrown up and pumping, hopping on each pump. */
function cheerStep(ch: Character, sprites: ReturnType<typeof getCharacterSprites>): { sprite: SpriteData; hop: number; sway: number } {
  const up = Math.floor(performance.now() / 220 + ch.id * 0.7) % 2 === 0;
  const colors = poseColors(sprites.walk[Direction.DOWN][1]);
  const shape: ArmShape = up ? 'high' : 'up';
  const sprite = danceArm(danceArm(sprites.walk[Direction.DOWN][1], 'right', shape, colors), 'left', shape, colors);
  return { sprite, hop: up ? -2 : 0, sway: 0 };
}

/** Waving hello: facing out, one hand up and rocking side to side, the other at their side. */
function waveStep(ch: Character, sprites: ReturnType<typeof getCharacterSprites>): { sprite: SpriteData; hop: number; sway: number } {
  const out = Math.floor(performance.now() / 200 + ch.id * 0.7) % 2 === 0;
  const colors = poseColors(sprites.walk[Direction.DOWN][1]);
  // Some wave with the left hand, some with the right
  const side = ch.id % 3 === 0 ? 'left' : 'right';
  const sprite = danceArm(sprites.walk[Direction.DOWN][1], side, out ? 'waveOut' : 'waveIn', colors);
  return { sprite, hop: 0, sway: 0 };
}

/** On the decks: in the DJ spot, behind the booth */
function isDjing(ch: Character): boolean {
  return ch.state === CharacterState.LEISURE && !!ch.leisureSpotKey?.startsWith('dj:');
}

/** What the DJ's doing for a stretch: nodding along, cueing a record on either deck, or riding the mixer */
type DjMove = 'groove' | 'leftDeck' | 'rightDeck' | 'mixer' | 'handUp';
const DJ_MOVE_MS = 1600;

/**
 * The DJ behind the booth, facing the room: mostly nodding along (hopping on the beat while music
 * plays), now and then reaching to a deck to scratch the record or bringing both hands in to the
 * mixer, and with music on, the odd hand in the air.
 */
function djStep(
  ch: Character,
  sprites: ReturnType<typeof getCharacterSprites>,
  music: ReturnType<typeof getMusicAudio>,
): { sprite: SpriteData; hop: number; sway: number } {
  const now = performance.now();
  const stretch = Math.floor(now / DJ_MOVE_MS + ch.id * 0.37);
  const roll = hash01Int(stretch, ch.id);
  const move: DjMove =
    roll < 0.38 ? 'groove' : roll < 0.56 ? 'leftDeck' : roll < 0.74 ? 'rightDeck' : roll < 0.92 ? 'mixer' : music.playing ? 'handUp' : 'groove';
  // Scratching wiggles the hand on the record
  const scratch = Math.floor(now / 130) % 2 === 0;
  const colors = poseColors(sprites.walk[Direction.DOWN][1]);
  let sprite = sprites.walk[Direction.DOWN][1];
  // The DJ's left is the screen's right: they face us
  if (move === 'leftDeck') sprite = danceArm(sprite, 'right', scratch ? 'deck' : 'deckIn', colors);
  else if (move === 'rightDeck') sprite = danceArm(sprite, 'left', scratch ? 'deck' : 'deckIn', colors);
  else if (move === 'mixer') sprite = danceArm(danceArm(sprite, 'right', 'fader', colors), 'left', 'fader', colors);
  else if (move === 'handUp') sprite = danceArm(sprite, now % 1000 < 500 ? 'right' : 'left', 'high', colors);
  // Nodding along: on the beat with music, a slow bob without
  const hop = music.playing ? -Math.round(music.beat * 1.5) : Math.floor(now / 600 + ch.id) % 2 === 0 ? 0 : -1;
  return { sprite, hop, sway: 0 };
}

/** 0..1 from two integers, stable for the same pair */
function hash01Int(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2d);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967295;
}

type ArmShape = 'down' | 'out' | 'up' | 'high' | 'pump' | 'point' | 'hip' | 'deck' | 'deckIn' | 'fader' | 'waveIn' | 'waveOut';

/**
 * Each arm shape as a path from the shoulder to the hand, in the front-facing frame's pixels for
 * the arm on the right of the screen (the left arm is the same, mirrored). Kept about as long as
 * the hanging arm, so arms don't look stretched.
 */
const ARM_PATHS: Record<Exclude<ArmShape, 'down'>, Array<[number, number]>> = {
  out: [[12, 20], [15, 20]],
  up: [[12, 20], [14, 17]],
  high: [[12, 19], [14, 17], [14, 14]],
  pump: [[12, 20], [14, 20], [14, 17]],
  point: [[12, 20], [15, 16]],
  hip: [[12, 20], [14, 22], [12, 23]],
  // Reaching down and out to a turntable on the booth, and the same hand pulled back a touch (scratching)
  deck: [[12, 20], [15, 22], [16, 24]],
  deckIn: [[12, 20], [14, 22], [15, 24]],
  // Hand brought in to the mixer in front of the body
  fader: [[12, 20], [12, 23], [10, 24]],
  // Forearm raised from the elbow, the hand rocking upright and then out (waving hello)
  waveIn: [[12, 20], [14, 18], [14, 14]],
  waveOut: [[12, 20], [14, 18], [16, 15]],
};

/**
 * Redraw one arm of a front-facing frame in a dance shape: the hanging arm is cleared, then a
 * 2px sleeve with an outline runs along the shape's path to a hand at its end.
 */
function danceArm(sprite: SpriteData, side: 'left' | 'right', shape: ArmShape, colors: PoseColors): SpriteData {
  if (shape === 'down') return sprite;
  const path = ARM_PATHS[shape];
  return posed(sprite, `dance:${side}:${shape}`, 6, side === 'left', ({ set }) => {
    // The hanging arm and hand, beside the torso (which ends at column 11)
    for (let row = 20; row <= 24; row++) for (let col = 12; col <= 14; col++) set(row, col, '');

    // Sleeve pixels along the path, two wide across the direction of travel
    const sleeve = new Map<string, [number, number]>();
    for (let i = 1; i < path.length; i++) {
      const [x0, y0] = path[i - 1];
      const [x1, y1] = path[i];
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
      const across: [number, number] = Math.abs(x1 - x0) > Math.abs(y1 - y0) ? [0, 1] : [1, 0];
      for (let t = 0; t <= steps; t++) {
        const x = Math.round(x0 + ((x1 - x0) * t) / steps);
        const y = Math.round(y0 + ((y1 - y0) * t) / steps);
        for (const [cx, cy] of [[x, y], [x + across[0], y + across[1]]]) sleeve.set(`${cx},${cy}`, [cx, cy]);
      }
    }
    // Hand: a 2x2 block at the end of the path
    const [hx, hy] = path[path.length - 1];
    const hand: Array<[number, number]> = [[hx, hy], [hx + 1, hy], [hx, hy - 1], [hx + 1, hy - 1]];
    for (const [x, y] of hand) sleeve.delete(`${x},${y}`);

    // Outline around the arm first (only where nothing's drawn), then the arm and hand over it
    for (const [x, y] of [...sleeve.values(), ...hand]) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) set(y + dy, x + dx, colors.outline, true);
    }
    for (const [x, y] of sleeve.values()) set(y, x, colors.sleeve);
    for (const [x, y] of hand) set(y, x, colors.hand);
  });
}

/** The moves dancers cycle through, one per beat: arms [left, right], and a shape to swap to off the beat */
const DANCE_MOVES: Array<{ dir: Direction; frame: number; arms: [ArmShape, ArmShape]; offBeat?: [ArmShape, ArmShape] }> = [
  { dir: Direction.DOWN, frame: 0, arms: ['up', 'up'], offBeat: ['out', 'out'] },
  { dir: Direction.DOWN, frame: 1, arms: ['hip', 'point'], offBeat: ['hip', 'out'] },
  { dir: Direction.DOWN, frame: 2, arms: ['pump', 'pump'], offBeat: ['out', 'out'] },
  { dir: Direction.LEFT, frame: 0, arms: ['down', 'down'] },
  { dir: Direction.DOWN, frame: 3, arms: ['point', 'hip'], offBeat: ['out', 'hip'] },
  { dir: Direction.DOWN, frame: 0, arms: ['high', 'down'], offBeat: ['up', 'down'] },
  { dir: Direction.RIGHT, frame: 2, arms: ['down', 'down'] },
  { dir: Direction.DOWN, frame: 1, arms: ['out', 'out'], offBeat: ['up', 'up'] },
];

function handBob(): boolean {
  return Math.floor(performance.now() / 1000 / HAND_BOB_SEC) % 2 === 1;
}

function poseColors(colorSource: SpriteData): PoseColors {
  const pixel = ([row, col]: readonly [number, number]) => colorSource[row]?.[col] || '#000000';
  return {
    outline: pixel(POSE_COLOR_PIXELS.outline),
    sleeve: pixel(POSE_COLOR_PIXELS.sleeve),
    hand: pixel(POSE_COLOR_PIXELS.hand),
  };
}

/**
 * Cached copy of `sprite`, widened by `pad` each side and mirrored while drawing when `mirror`
 * is set (so poses only need drawing for one side).
 */
function posed(sprite: SpriteData, key: string, pad: number, mirror: boolean, draw: (canvas: PoseCanvas) => void): SpriteData {
  let variants = poseCache.get(sprite);
  if (!variants) {
    variants = new Map();
    poseCache.set(sprite, variants);
  }
  const cached = variants.get(key);
  if (cached) return cached;

  const blank = Array<string>(pad).fill('');
  const rows = sprite.map((row) => [...blank, ...(mirror ? [...row].reverse() : row), ...blank]);
  // Earlier poses may already have widened the sprite; the original frame stays centred.
  const x0 = (rows[0].length - SPRITE_W) / 2;
  // Top of the head, looking only at the middle of the frame so an arm already raised doesn't count.
  const headTop = sprite.findIndex((row) => row.slice(x0 - pad + 2, x0 - pad + 13).some(Boolean));
  const canvas: PoseCanvas = {
    rows,
    top: Math.max(3, headTop),
    set: (row, col, color, onlyIfEmpty = false) => {
      const c = col + x0;
      if (row < 0 || row >= rows.length || c < 0 || c >= rows[row].length) return;
      if (onlyIfEmpty && rows[row][c]) return;
      rows[row][c] = color;
    },
  };
  draw(canvas);

  const result = mirror ? rows.map((row) => [...row].reverse()) : rows;
  variants.set(key, result);
  return result;
}

/**
 * Raise the arm on one side of the screen beside the head. With `point`, the forearm leans
 * outward and a finger points up and away (used to point at the boardroom whiteboard).
 */
function raiseArm(
  sprite: SpriteData,
  dir: Direction,
  side: 'left' | 'right',
  colors: PoseColors,
  bob: boolean,
  point = false,
): SpriteData {
  return posed(sprite, `arm:${dir}:${side}:${bob ? 1 : 0}:${point ? 1 : 0}`, point ? 6 : 2, side === 'left', ({ top, set }) => {
    // Front and back views show the hanging hand beside the torso; drop it so the arm isn't doubled.
    if (dir === Direction.DOWN || dir === Direction.UP) {
      for (let row = top + 18; row < top + 29; row++) {
        for (let col = 12; col <= 15; col++) set(row, col, '');
      }
    }

    const handTop = top - (bob ? 0 : 1) + (point ? 1 : 0);
    for (let row = handTop; row <= top + 17; row++) {
      const lean = point && row < top + 6 ? 1 : 0;
      const color = row < handTop + 3 ? colors.hand : colors.sleeve;
      set(row, 15 + lean, color);
      set(row, 16 + lean, color);
      set(row, 14 + lean, colors.outline, true);
      set(row, 17 + lean, colors.outline);
    }
    const tipLean = point ? 1 : 0;
    set(handTop - 1, 15 + tipLean, colors.outline);
    set(handTop - 1, 16 + tipLean, colors.outline);
    if (point) {
      // Index finger, up and outward from the top of the hand; it taps while bobbing.
      const reach = bob ? 3 : 2;
      for (let i = 1; i <= reach; i++) {
        set(handTop - i, 17 + i, colors.hand);
        set(handTop - i - 1, 17 + i, colors.outline, true);
        set(handTop - i, 18 + i, colors.outline, true);
      }
    }
    // Shoulder joining the arm to the body.
    for (let row = top + 15; row <= top + 17; row++) {
      set(row, 13, colors.sleeve);
      set(row, 14, colors.sleeve);
    }
    for (let col = 12; col <= 17; col++) set(top + 18, col, colors.outline, true);
  });
}

// ── Sick agents (error status) ──────────────────────────────────// ── Sick agents (error status) ──────────────────────────────────

const SICK_TINT = { r: 128, g: 196, b: 72 };
const SICK_TINT_AMOUNT = 0.4;
const VOMIT_CYCLE_SEC = 3.2;
const VOMIT_HEAVE_START_SEC = 2.0;
const VOMIT_DROPS = 7;
const VOMIT_COLORS = ['#9bc53d', '#7da82a', '#c3d95b'];
/** Mouth height above the character anchor, in sprite pixels */
const MOUTH_OFFSET_PX = 20;
/** Extra drop applied to where the vomit stream starts, in on-screen CSS pixels */
const VOMIT_START_DROP_CSS_PX = 20;

const sickSpriteCache = new WeakMap<SpriteData, SpriteData>();

function tintSick(hex: string): string {
  if (!hex) return hex;
  const mix = (value: number, target: number) =>
    Math.round(value + (target - value) * SICK_TINT_AMOUNT).toString(16).padStart(2, '0');
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `#${mix(r, SICK_TINT.r)}${mix(g, SICK_TINT.g)}${mix(b, SICK_TINT.b)}${hex.slice(7)}`;
}

function getSickSprite(sprite: SpriteData): SpriteData {
  let tinted = sickSpriteCache.get(sprite);
  if (!tinted) {
    tinted = sprite.map((row) => row.map(tintSick));
    sickSpriteCache.set(sprite, tinted);
  }
  return tinted;
}

/** 0 while queasy, rising 0→1 through the heave at the end of each cycle */
function vomitPhase(ch: Character): number {
  const t = ch.sickTimer % VOMIT_CYCLE_SEC;
  if (t < VOMIT_HEAVE_START_SEC) return 0;
  return (t - VOMIT_HEAVE_START_SEC) / (VOMIT_CYCLE_SEC - VOMIT_HEAVE_START_SEC);
}

function renderSickPuddle(c: CanvasRenderingContext2D, ch: Character, offsetX: number, offsetY: number, zoom: number): void {
  const radius = Math.min(6, 2 + ch.sickTimer / 5);
  c.save();
  c.fillStyle = VOMIT_COLORS[1];
  c.globalAlpha = 0.85;
  c.beginPath();
  c.ellipse(offsetX + ch.x * zoom, offsetY + (ch.y + 1) * zoom, radius * zoom, radius * 0.4 * zoom, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = VOMIT_COLORS[2];
  c.fillRect(
    Math.round(offsetX + (ch.x - radius * 0.4) * zoom),
    Math.round(offsetY + ch.y * zoom),
    Math.max(1, Math.round(zoom)),
    Math.max(1, Math.round(zoom)),
  );
  c.restore();
}

function renderVomitStream(c: CanvasRenderingContext2D, ch: Character, offsetX: number, offsetY: number, zoom: number): void {
  const phase = vomitPhase(ch);
  if (phase <= 0) return;
  const mouthX = ch.x;
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const mouthY = Math.min(ch.y - 2, ch.y - MOUTH_OFFSET_PX + 1 + (VOMIT_START_DROP_CSS_PX * dpr) / zoom);
  const floorY = ch.y + 1;
  const size = Math.max(1, Math.round(zoom * 1.5));
  c.save();
  for (let i = 0; i < VOMIT_DROPS; i++) {
    // Each drop trails the previous one along an arc from mouth to puddle
    const progress = phase * 1.6 - i * 0.12;
    if (progress <= 0 || progress >= 1) continue;
    const x = mouthX + Math.sin(i * 1.7) * 1.5 * progress;
    const y = mouthY + (floorY - mouthY) * progress * progress - Math.sin(progress * Math.PI) * 2;
    c.fillStyle = VOMIT_COLORS[i % VOMIT_COLORS.length];
    c.fillRect(Math.round(offsetX + x * zoom - size / 2), Math.round(offsetY + y * zoom), size, size);
  }
  c.restore();
}

// ── Seat indicators ─────────────────────────────────────────────

function renderSeatIndicators(
  ctx: CanvasRenderingContext2D,
  seats: Map<string, Seat>,
  characters: Map<number, Character>,
  selectedAgentId: number | null,
  hoveredTile: { col: number; row: number } | null,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (selectedAgentId === null || !hoveredTile) return;
  const selectedChar = characters.get(selectedAgentId);
  if (!selectedChar) return;

  // Only show indicator for the hovered seat tile
  for (const [uid, seat] of seats) {
    if (seat.seatCol !== hoveredTile.col || seat.seatRow !== hoveredTile.row) continue;

    const s = TILE_SIZE * zoom;
    const x = offsetX + seat.seatCol * s;
    const y = offsetY + seat.seatRow * s;

    if (selectedChar.seatId === uid) {
      // Selected agent's own seat — blue
      ctx.fillStyle = SEAT_OWN_COLOR;
    } else if (!seat.assigned) {
      // Available seat — green
      ctx.fillStyle = SEAT_AVAILABLE_COLOR;
    } else {
      // Busy (assigned to another agent) — red
      ctx.fillStyle = SEAT_BUSY_COLOR;
    }
    ctx.fillRect(x, y, s, s);
    break;
  }
}

// ── Edit mode overlays ──────────────────────────────────────────

/** @internal */
export function renderGridOverlay(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
  tileMap?: TileTypeVal[][],
): void {
  const s = TILE_SIZE * zoom;
  ctx.strokeStyle = GRID_LINE_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Vertical lines — offset by 0.5 for crisp 1px lines
  for (let c = 0; c <= cols; c++) {
    const x = offsetX + c * s + 0.5;
    ctx.moveTo(x, offsetY);
    ctx.lineTo(x, offsetY + rows * s);
  }
  // Horizontal lines
  for (let r = 0; r <= rows; r++) {
    const y = offsetY + r * s + 0.5;
    ctx.moveTo(offsetX, y);
    ctx.lineTo(offsetX + cols * s, y);
  }
  ctx.stroke();

  // Draw faint dashed outlines on VOID tiles
  if (tileMap) {
    ctx.save();
    ctx.strokeStyle = VOID_TILE_OUTLINE_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash(VOID_TILE_DASH_PATTERN);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (tileMap[r]?.[c] === TileType.VOID) {
          ctx.strokeRect(offsetX + c * s + 0.5, offsetY + r * s + 0.5, s - 1, s - 1);
        }
      }
    }
    ctx.restore();
  }
}

/** Draw faint expansion placeholders 1 tile outside grid bounds (ghost border). */
function renderGhostBorder(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
  ghostHoverCol: number,
  ghostHoverRow: number,
): void {
  const s = TILE_SIZE * zoom;
  ctx.save();

  // Collect ghost border tiles: one ring around the grid
  const ghostTiles: Array<{ c: number; r: number }> = [];
  // Top and bottom rows
  for (let c = -1; c <= cols; c++) {
    ghostTiles.push({ c, r: -1 });
    ghostTiles.push({ c, r: rows });
  }
  // Left and right columns (excluding corners already added)
  for (let r = 0; r < rows; r++) {
    ghostTiles.push({ c: -1, r });
    ghostTiles.push({ c: cols, r });
  }

  for (const { c, r } of ghostTiles) {
    const x = offsetX + c * s;
    const y = offsetY + r * s;
    const isHovered = c === ghostHoverCol && r === ghostHoverRow;
    if (isHovered) {
      ctx.fillStyle = GHOST_BORDER_HOVER_FILL;
      ctx.fillRect(x, y, s, s);
    }
    ctx.strokeStyle = isHovered ? GHOST_BORDER_HOVER_STROKE : GHOST_BORDER_STROKE;
    ctx.lineWidth = 1;
    ctx.setLineDash(VOID_TILE_DASH_PATTERN);
    ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
  }

  ctx.restore();
}

/** @internal */
export function renderGhostPreview(
  ctx: CanvasRenderingContext2D,
  sprite: SpriteData,
  col: number,
  row: number,
  valid: boolean,
  offsetX: number,
  offsetY: number,
  zoom: number,
  mirrored: boolean = false,
): void {
  const cached = getCachedSprite(sprite, zoom);
  const x = offsetX + col * TILE_SIZE * zoom;
  const y = offsetY + row * TILE_SIZE * zoom;
  ctx.save();
  ctx.globalAlpha = GHOST_PREVIEW_SPRITE_ALPHA;
  if (mirrored) {
    ctx.translate(x + cached.width, y);
    ctx.scale(-1, 1);
    ctx.drawImage(cached, 0, 0);
  } else {
    ctx.drawImage(cached, x, y);
  }
  // Tint overlay — reset transform for correct fill position
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = GHOST_PREVIEW_TINT_ALPHA;
  ctx.fillStyle = valid ? GHOST_VALID_TINT : GHOST_INVALID_TINT;
  ctx.fillRect(x, y, cached.width, cached.height);
  ctx.restore();
}

/** @internal */
export function renderSelectionHighlight(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  w: number,
  h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const s = TILE_SIZE * zoom;
  const x = offsetX + col * s;
  const y = offsetY + row * s;
  ctx.save();
  ctx.strokeStyle = SELECTION_HIGHLIGHT_COLOR;
  ctx.lineWidth = 2;
  ctx.setLineDash(SELECTION_DASH_PATTERN);
  ctx.strokeRect(x + 1, y + 1, w * s - 2, h * s - 2);
  ctx.restore();
}

/** @internal */
export function renderDeleteButton(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  w: number,
  _h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): DeleteButtonBounds {
  const s = TILE_SIZE * zoom;
  // Position at top-right corner of selected furniture
  const cx = offsetX + (col + w) * s + 1;
  const cy = offsetY + row * s - 1;
  const radius = Math.max(BUTTON_MIN_RADIUS, zoom * BUTTON_RADIUS_ZOOM_FACTOR);

  // Circle background
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = DELETE_BUTTON_BG;
  ctx.fill();

  // X mark
  ctx.strokeStyle = BUTTON_ICON_COLOR;
  ctx.lineWidth = Math.max(BUTTON_LINE_WIDTH_MIN, zoom * BUTTON_LINE_WIDTH_ZOOM_FACTOR);
  ctx.lineCap = 'round';
  const xSize = radius * BUTTON_ICON_SIZE_FACTOR;
  ctx.beginPath();
  ctx.moveTo(cx - xSize, cy - xSize);
  ctx.lineTo(cx + xSize, cy + xSize);
  ctx.moveTo(cx + xSize, cy - xSize);
  ctx.lineTo(cx - xSize, cy + xSize);
  ctx.stroke();
  ctx.restore();

  return { cx, cy, radius };
}

function renderRotateButton(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  _w: number,
  _h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): RotateButtonBounds {
  const s = TILE_SIZE * zoom;
  // Position to the left of the delete button (which is at top-right corner)
  const radius = Math.max(BUTTON_MIN_RADIUS, zoom * BUTTON_RADIUS_ZOOM_FACTOR);
  const cx = offsetX + col * s - 1;
  const cy = offsetY + row * s - 1;

  // Circle background
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = ROTATE_BUTTON_BG;
  ctx.fill();

  // Circular arrow icon
  ctx.strokeStyle = BUTTON_ICON_COLOR;
  ctx.lineWidth = Math.max(BUTTON_LINE_WIDTH_MIN, zoom * BUTTON_LINE_WIDTH_ZOOM_FACTOR);
  ctx.lineCap = 'round';
  const arcR = radius * BUTTON_ICON_SIZE_FACTOR;
  ctx.beginPath();
  // Draw a 270-degree arc
  ctx.arc(cx, cy, arcR, -Math.PI * 0.8, Math.PI * 0.7);
  ctx.stroke();
  // Draw arrowhead at the end of the arc
  const endAngle = Math.PI * 0.7;
  const endX = cx + arcR * Math.cos(endAngle);
  const endY = cy + arcR * Math.sin(endAngle);
  const arrowSize = radius * 0.35;
  ctx.beginPath();
  ctx.moveTo(endX + arrowSize * 0.6, endY - arrowSize * 0.3);
  ctx.lineTo(endX, endY);
  ctx.lineTo(endX + arrowSize * 0.7, endY + arrowSize * 0.5);
  ctx.stroke();
  ctx.restore();

  return { cx, cy, radius };
}

// ── Speech bubbles ──────────────────────────────────────────────

function renderBubbles(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const ch of characters) {
    if (!ch.bubbleType && !ch.needsDecision) continue;
    // The green checkmark bubble only represents "done" (turn finished). The
    // idle "Waiting for input" state communicates via its overlay label, not a
    // bubble, so skip the bubble for it.
    if (ch.bubbleType === 'waiting' && ch.waitingAwaitingInput) continue;

    // A pending decision wins over the other bubbles: it's what needs a person's attention.
    const sprite = ch.needsDecision
      ? BUBBLE_DECISION_SPRITE
      : ch.bubbleType === 'permission'
        ? BUBBLE_PERMISSION_SPRITE
        : BUBBLE_WAITING_SPRITE;

    // Compute opacity: permission/decision = full, waiting = fade in last 0.5s
    let alpha = 1.0;
    if (!ch.needsDecision && ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC) {
      alpha = ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC;
    }

    const cached = getCachedSprite(sprite, zoom);
    // Position: centered above the character's head
    // Character is anchored bottom-center at (ch.x, ch.y), sprite is 16x24
    // Place bubble above head with a small gap; follow sitting offset
    const sittingOff = isSeated(ch) ? BUBBLE_SITTING_OFFSET_PX : 0;
    const bubbleX = Math.round(offsetX + ch.x * zoom - cached.width / 2);
    // Thought bubbles drift up and down a pixel so they catch the eye.
    const float = ch.needsDecision && handBob() ? 1 : 0;
    const bubbleY = Math.round(
      offsetY + (ch.y + sittingOff - BUBBLE_VERTICAL_OFFSET_PX - float) * zoom - cached.height - 1 * zoom,
    );

    ctx.save();
    if (alpha < 1.0) ctx.globalAlpha = alpha;
    ctx.drawImage(cached, bubbleX, bubbleY);
    ctx.restore();
  }
}

function renderPetBubbles(
  ctx: CanvasRenderingContext2D,
  pets: Pet[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const pet of pets) {
    if (!pet.bubbleType) continue;

    const sprite = BUBBLE_HEART_SPRITE;

    // Fade in the last BUBBLE_FADE_DURATION_SEC of the lifetime
    let alpha = 1.0;
    if (pet.bubbleTimer < BUBBLE_FADE_DURATION_SEC) {
      alpha = Math.max(0, pet.bubbleTimer / BUBBLE_FADE_DURATION_SEC);
    }

    const cached = getCachedSprite(sprite, zoom);
    // Anchor: centered above the pet's head. Pet is anchored bottom-center at
    // (pet.x, pet.y); sprite is ~16 tall, so back up TILE_SIZE pixels and add
    // a 1-sprite-pixel gap (scaled by zoom).
    const bubbleX = Math.round(offsetX + pet.x * zoom - cached.width / 2);
    const bubbleY = Math.round(offsetY + (pet.y - TILE_SIZE) * zoom - cached.height - 1 * zoom);

    ctx.save();
    if (alpha < 1.0) ctx.globalAlpha = alpha;
    ctx.drawImage(cached, bubbleX, bubbleY);
    ctx.restore();
  }
}

export interface ButtonBounds {
  /** Center X in device pixels */
  cx: number;
  /** Center Y in device pixels */
  cy: number;
  /** Radius in device pixels */
  radius: number;
}

export type DeleteButtonBounds = ButtonBounds;
export type RotateButtonBounds = ButtonBounds;

export interface EditorRenderState {
  showGrid: boolean;
  ghostSprite: SpriteData | null;
  ghostMirrored: boolean;
  ghostCol: number;
  ghostRow: number;
  ghostValid: boolean;
  selectedCol: number;
  selectedRow: number;
  selectedW: number;
  selectedH: number;
  hasSelection: boolean;
  isRotatable: boolean;
  /** Updated each frame by renderDeleteButton */
  deleteButtonBounds: DeleteButtonBounds | null;
  /** Updated each frame by renderRotateButton */
  rotateButtonBounds: RotateButtonBounds | null;
  /** Whether to show ghost border (expansion tiles outside grid) */
  showGhostBorder: boolean;
  /** Hovered ghost border tile col (-1 to cols) */
  ghostBorderHoverCol: number;
  /** Hovered ghost border tile row (-1 to rows) */
  ghostBorderHoverRow: number;
}

export interface SelectionRenderState {
  selectedAgentId: number | null;
  hoveredAgentId: number | null;
  hoveredTile: { col: number; row: number } | null;
  seats: Map<string, Seat>;
  characters: Map<number, Character>;
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  tileMap: TileTypeVal[][],
  furniture: FurnitureInstance[],
  characters: Character[],
  zoom: number,
  panX: number,
  panY: number,
  selection?: SelectionRenderState,
  editor?: EditorRenderState,
  tileColors?: Array<ColorValue | null>,
  layoutCols?: number,
  layoutRows?: number,
  leisure?: LeisureRenderState,
  /** Drawn over the floor but under walls, furniture and characters (e.g. a theme's floor lighting). */
  underlay?: (ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number) => void,
  carpetTiles?: Array<CarpetTile | null>,
  areas?: AreaDefinition[],
  areaTiles?: Array<string | null>,
  showAreas?: boolean,
  activeAreaLabel?: string | null,
  pets?: Pet[],
): { offsetX: number; offsetY: number } {
  // Clear
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Use layout dimensions (fallback to tileMap size)
  const cols = layoutCols ?? (tileMap.length > 0 ? tileMap[0].length : 0);
  const rows = layoutRows ?? tileMap.length;

  // Center map in viewport + pan offset (integer device pixels). Shared with
  // the DOM overlays so a label lands exactly on the sprite it belongs to.
  const { offsetX, offsetY } = mapOffset(canvasWidth, canvasHeight, cols, rows, zoom, panX, panY);

  // Draw tiles (floor + wall base color)
  renderTileGrid(ctx, tileMap, offsetX, offsetY, zoom, tileColors, layoutCols);
  underlay?.(ctx, offsetX, offsetY);

  // Carpet layer (above floor, below seat indicators / furniture / characters)
  if (carpetTiles && carpetTiles.length > 0) {
    renderCarpetLayer(ctx, carpetTiles, cols, rows, offsetX, offsetY, zoom);
  }

  // Area overlay (translucent color wash) — above carpets, below seat indicators
  if (showAreas) {
    renderAreaOverlay(ctx, areaTiles, areas, cols, rows, offsetX, offsetY, zoom, activeAreaLabel);
  }

  // Seat indicators (below furniture/characters, on top of floor)
  if (selection) {
    renderSeatIndicators(
      ctx,
      selection.seats,
      selection.characters,
      selection.selectedAgentId,
      selection.hoveredTile,
      offsetX,
      offsetY,
      zoom,
    );
  }

  // Build wall instances for z-sorting with furniture and characters
  const wallInstances = hasWallSprites() ? getWallInstances(tileMap, tileColors, layoutCols) : [];
  const allFurniture = wallInstances.length > 0 ? [...wallInstances, ...furniture] : furniture;

  // Draw walls + furniture + characters (z-sorted)
  const selectedId = selection?.selectedAgentId ?? null;
  const hoveredId = selection?.hoveredAgentId ?? null;
  renderScene(
    ctx,
    allFurniture,
    characters,
    offsetX,
    offsetY,
    zoom,
    selectedId,
    hoveredId,
    leisure,
    pets ?? [],
  );

  // Speech bubbles (always on top of characters)
  renderBubbles(ctx, characters, offsetX, offsetY, zoom);
  // Pet heart bubbles (same overlay pass)
  if (pets && pets.length > 0) {
    renderPetBubbles(ctx, pets, offsetX, offsetY, zoom);
  }

  // Area labels (above bubbles + characters, below editor overlays)
  if (showAreas) {
    renderAreaLabels(ctx, areaTiles, areas, cols, rows, offsetX, offsetY, zoom);
  }

  // Editor overlays
  if (editor) {
    if (editor.showGrid) {
      renderGridOverlay(ctx, offsetX, offsetY, zoom, cols, rows, tileMap);
    }
    if (editor.showGhostBorder) {
      renderGhostBorder(
        ctx,
        offsetX,
        offsetY,
        zoom,
        cols,
        rows,
        editor.ghostBorderHoverCol,
        editor.ghostBorderHoverRow,
      );
    }
    if (editor.ghostSprite && editor.ghostCol >= 0) {
      renderGhostPreview(
        ctx,
        editor.ghostSprite,
        editor.ghostCol,
        editor.ghostRow,
        editor.ghostValid,
        offsetX,
        offsetY,
        zoom,
        editor.ghostMirrored,
      );
    }
    if (editor.hasSelection) {
      renderSelectionHighlight(
        ctx,
        editor.selectedCol,
        editor.selectedRow,
        editor.selectedW,
        editor.selectedH,
        offsetX,
        offsetY,
        zoom,
      );
      editor.deleteButtonBounds = renderDeleteButton(
        ctx,
        editor.selectedCol,
        editor.selectedRow,
        editor.selectedW,
        editor.selectedH,
        offsetX,
        offsetY,
        zoom,
      );
      if (editor.isRotatable) {
        editor.rotateButtonBounds = renderRotateButton(
          ctx,
          editor.selectedCol,
          editor.selectedRow,
          editor.selectedW,
          editor.selectedH,
          offsetX,
          offsetY,
          zoom,
        );
      } else {
        editor.rotateButtonBounds = null;
      }
    } else {
      editor.deleteButtonBounds = null;
      editor.rotateButtonBounds = null;
    }
  }

  return { offsetX, offsetY };
}
