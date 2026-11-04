import { setFloorSprites } from "../office/floorTiles.js";
import { buildDynamicCatalog } from "../office/layout/furnitureCatalog.js";
import type { RoomKey } from "./themes.js";
import { setCharacterTemplates } from "../office/sprites/spriteData.js";
import type { OfficeLayout, SpriteData, TileType } from "../office/types.js";
import { setWallSprites } from "../office/wallTiles.js";
import { setCarpetSprites } from "../office/sprites/carpetTiles.js";
import { setPetTemplates } from "../office/sprites/petSpriteData.js";
import { PLUGIN_ID } from "../manifest.js";
import { MAIN_OFFICE_KANBAN_UID } from "./wallCharts.js";
import {
  DJ_BOOTH_HEIGHT,
  DJ_BOOTH_TYPE,
  DJ_BOOTH_WIDTH,
  DJ_SPEAKER_HEIGHT,
  DJ_SPEAKER_TYPE,
  DJ_SPEAKER_WIDTH,
  paintDjBooth,
  paintDjSpeaker,
} from "../office/engine/djBooth.js";
import { paintPingPongTable, PING_PONG_HEIGHT, PING_PONG_TYPE, PING_PONG_WIDTH } from "../office/engine/pingPong.js";

type CharacterDirectionSprites = {
  down: SpriteData[];
  up: SpriteData[];
  right: SpriteData[];
};

export type AssetIndex = {
  characters: string[];
  floors: string[];
  walls: string[];
  /** Optional so an index built before pets and carpets still loads */
  carpets?: string[];
  pets?: Array<{ id: string; name: string; path: string }>;
  furniture: Array<{
    id: string;
    label: string;
    category: string;
    width: number;
    height: number;
    footprintW: number;
    footprintH: number;
    isDesk: boolean;
    groupId?: string;
    orientation?: string;
    state?: string;
    rotationScheme?: string;
    animationGroup?: string;
    frame?: number;
    canPlaceOnSurfaces?: boolean;
    backgroundTiles?: number;
    canPlaceOnWalls?: boolean;
    mirrorSide?: boolean;
    furniturePath: string;
  }>;
  layouts?: {
    office: string;
    boardroomKitchen: string;
  };
  defaultLayout: string;
};

type DecodedPng = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type LoadedPixelAssets = {
  layouts: {
    office: OfficeLayout;
    boardroomKitchen: OfficeLayout;
    combined: OfficeLayout;
    /** Room per combined-layout tile; see combineLayouts. */
    rooms: Array<RoomKey | null>;
  };
  cameraBounds: {
    office: CameraBounds;
    boardroomKitchen: CameraBounds;
    overflowOffice: CameraBounds;
  };
};

export type CameraBounds = {
  col: number;
  row: number;
  cols: number;
  rows: number;
};

const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_FRAMES_PER_ROW = 7;
const FLOOR_TILE_SIZE = 16;
const WALL_PIECE_WIDTH = 16;
const WALL_PIECE_HEIGHT = 32;
const WALL_GRID_COLS = 4;
const WALL_BITMASK_COUNT = 16;

let loadPromise: Promise<LoadedPixelAssets> | null = null;

export function trimLayoutToVisibleRoom(layout: OfficeLayout): OfficeLayout {
  const occupied: Array<{ col: number; row: number }> = [];
  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.cols; col++) {
      if (layout.tiles[row * layout.cols + col] !== 255) occupied.push({ col, row });
    }
  }

  if (occupied.length === 0) return layout;

  const minCol = Math.max(0, Math.min(...occupied.map((tile) => tile.col)) - 1);
  const maxCol = Math.min(layout.cols - 1, Math.max(...occupied.map((tile) => tile.col)) + 1);
  const minRow = Math.max(0, Math.min(...occupied.map((tile) => tile.row)) - 1);
  const maxRow = Math.min(layout.rows - 1, Math.max(...occupied.map((tile) => tile.row)) + 1);
  const cols = maxCol - minCol + 1;
  const rows = maxRow - minRow + 1;

  const tiles: TileType[] = [];
  const tileColors: OfficeLayout["tileColors"] = layout.tileColors ? [] : undefined;
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      const index = row * layout.cols + col;
      tiles.push(layout.tiles[index]);
      tileColors?.push(layout.tileColors?.[index] ?? null);
    }
  }

  return {
    ...layout,
    cols,
    rows,
    tiles,
    tileColors,
    furniture: layout.furniture.map((item) => ({
      ...item,
      col: item.col - minCol,
      row: item.row - minRow,
    })),
  };
}

export function combineLayouts(office: OfficeLayout, boardroomKitchen: OfficeLayout, pets?: AssetIndex["pets"]): {
  layout: OfficeLayout;
  /** The room each tile belongs to (parallel to layout.tiles), so themes can restyle rooms. */
  rooms: Array<RoomKey | null>;
  cameraBounds: LoadedPixelAssets["cameraBounds"];
} {
  const gap = 5;
  const overflowOffice = recolorLayout(office, { h: 145, s: 16, b: -8, c: -35 }, { h: 270, s: 18, b: -20, c: -45 });
  const boardOffsetCol = office.cols + gap;
  const overflowOffsetCol = boardOffsetCol + boardroomKitchen.cols + gap;
  const cols = office.cols + gap + boardroomKitchen.cols + gap + overflowOffice.cols;
  const rows = Math.max(office.rows, boardroomKitchen.rows);
  const tiles = Array<TileType>(cols * rows).fill(255 as TileType);
  const tileColors: NonNullable<OfficeLayout["tileColors"]> = Array(cols * rows).fill(null);
  const rooms: Array<RoomKey | null> = Array(cols * rows).fill(null);
  const carpetTiles: NonNullable<OfficeLayout["carpetTiles"]> = Array(cols * rows).fill(null);
  const wallColor = { h: 214, s: 30, b: -100, c: -55 };
  const hallColor = { h: 209, s: 0, b: -16, c: -8 };
  const hallFloor = 9 as TileType;
  const boardOffsetRow = Math.max(0, Math.floor((office.rows - boardroomKitchen.rows) / 2));

  function copyLayout(source: OfficeLayout, offsetCol: number, offsetRow: number, roomOf: Partial<Record<number, RoomKey>>) {
    for (let row = 0; row < source.rows; row++) {
      for (let col = 0; col < source.cols; col++) {
        const sourceIndex = row * source.cols + col;
        const targetIndex = (row + offsetRow) * cols + col + offsetCol;
        tiles[targetIndex] = source.tiles[sourceIndex];
        tileColors[targetIndex] = source.tileColors?.[sourceIndex] ?? null;
        carpetTiles[targetIndex] = source.carpetTiles?.[sourceIndex] ?? null;
        rooms[targetIndex] = roomOf[source.tiles[sourceIndex]] ?? null;
      }
    }
  }

  // Rooms by floor pattern in each source layout (0 is wall).
  copyLayout(office, 0, 0, { 0: "wall", 7: "office", 1: "lounge", 9: "hall" });
  copyLayout(boardroomKitchen, boardOffsetCol, boardOffsetRow, { 0: "wall", 3: "boardroom", 1: "kitchen", 8: "hall" });
  copyLayout(overflowOffice, overflowOffsetCol, 0, { 0: "overflowWall", 7: "overflowOffice", 1: "overflowLounge", 9: "hall" });

  const hallRow = Math.floor(rows / 2);
  const spawnTile = { col: office.cols - 1, row: hallRow };
  function drawHall(startCol: number, endCol: number) {
    for (let row = hallRow - 1; row <= hallRow + 1; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const index = row * cols + col;
        tiles[index] = hallFloor;
        tileColors[index] = hallColor;
        rooms[index] = "hall";
      }
    }

    for (let row = hallRow - 2; row <= hallRow + 2; row++) {
      for (const col of [startCol + 1, startCol + 2, endCol - 1, endCol]) {
        const index = row * cols + col;
        tiles[index] = hallFloor;
        tileColors[index] = hallColor;
        rooms[index] = "hall";
      }
    }
  }

  drawHall(office.cols - 2, boardOffsetCol + 1);
  drawHall(boardOffsetCol + boardroomKitchen.cols - 2, overflowOffsetCol + 1);
  tileColors[spawnTile.row * cols + spawnTile.col] = { h: 204, s: 10, b: -42, c: -32 };

  for (let row = hallRow - 2; row <= hallRow + 2; row++) {
    for (const col of [
      office.cols - 3,
      boardOffsetCol + 2,
      boardOffsetCol + boardroomKitchen.cols - 3,
      overflowOffsetCol + 2,
    ]) {
      const index = row * cols + col;
      if (tiles[index] === 255) {
        tiles[index] = 0;
        tileColors[index] = wallColor;
        rooms[index] = "wall";
      }
    }
  }

  return {
    rooms,
    layout: {
      version: 1,
      cols,
      rows,
      layoutRevision: 1,
      tiles,
      tileColors,
      carpetTiles,
      // Upstream pixel-agents' office pets, wandering the whole building
      pets: (pets ?? []).map((pet, petType) => ({ id: pet.id, petType })),
      spawnTile,
      furniture: [
        ...mainOfficeWall(office.furniture).map((item) => ({ ...item, uid: `camera1-${item.uid}` })),
        ...boardroomKitchen.furniture.map((item) => ({
          ...item,
          uid: `camera2-${item.uid}`,
          col: item.col + boardOffsetCol,
          row: item.row + boardOffsetRow,
        })),
        ...overflowOffice.furniture.map((item) => ({
          ...item,
          uid: `camera3-${item.uid}`,
          col: item.col + overflowOffsetCol,
        })),
      ],
    },
    cameraBounds: {
      office: { col: 0, row: 0, cols: office.cols, rows: office.rows },
      boardroomKitchen: {
        col: boardOffsetCol,
        row: boardOffsetRow - 1,
        cols: boardroomKitchen.cols,
        rows: boardroomKitchen.rows + 1,
      },
      overflowOffice: { col: overflowOffsetCol, row: 0, cols: overflowOffice.cols, rows: overflowOffice.rows },
    },
  };
}

/**
 * The main office shares its layout with Office 2 but hangs the kanban in place of its left chart
 * board. The kanban is twice as wide, so the clock beside it moves along to the gap after it.
 */
const KANBAN_WIDTH_TILES = 4;

function mainOfficeWall(furniture: OfficeLayout["furniture"]): OfficeLayout["furniture"] {
  const board = furniture.find((item) => item.uid === MAIN_OFFICE_KANBAN_UID);
  if (!board) return furniture;
  const kanbanEnd = board.col + KANBAN_WIDTH_TILES;
  return furniture.map((item) => {
    if (item === board) return { ...item, type: "KANBAN_BOARD" };
    if (item.type === "CLOCK" && item.row === board.row && item.col >= board.col && item.col < kanbanEnd) {
      return { ...item, col: kanbanEnd };
    }
    return item;
  });
}

function recolorLayout(layout: OfficeLayout, floorColor: NonNullable<OfficeLayout["tileColors"]>[number], wallColor: NonNullable<OfficeLayout["tileColors"]>[number]): OfficeLayout {
  return {
    ...layout,
    tileColors: layout.tiles.map((tile, index) => {
      if (tile === 0) return wallColor;
      if (tile === 255) return null;
      return layout.tileColors?.[index] ? floorColor : floorColor;
    }),
    furniture: layout.furniture.map((item) => {
      if (!["DESK_FRONT", "TABLE_FRONT", "SMALL_TABLE_FRONT", "SMALL_TABLE_SIDE", "COFFEE_TABLE"].includes(item.type)) {
        return item;
      }
      return {
        ...item,
        color: { h: 150, s: 18, b: -10, c: -20 },
      };
    }),
  };
}

let assetBaseUrlPromise: Promise<string> | null = null;

// The host loads plugin UI from a blob: URL, so import.meta.url can't locate our
// assets. Resolve the installed plugin ID by key instead: Paperclip's static route
// is meant to accept the key too, but currently 500s on non-UUID IDs.
export function getPluginAssetBaseUrl(): Promise<string> {
  assetBaseUrlPromise ??= (async () => {
    const metaUrl = import.meta.url;
    if (metaUrl && !metaUrl.startsWith("blob:")) {
      return new URL("./assets/", metaUrl).toString();
    }

    const pluginMatch = window.location.pathname.match(/\/_plugins\/[^/]+\/ui\//);
    if (pluginMatch) return `${pluginMatch[0]}assets/`;

    try {
      const res = await fetch("/api/plugins/ui-contributions", { credentials: "include" });
      if (res.ok) {
        const contributions = (await res.json()) as Array<{ pluginId: string; pluginKey: string }>;
        const self = contributions.find((entry) => entry.pluginKey === PLUGIN_ID);
        if (self) return `/_plugins/${self.pluginId}/ui/assets/`;
      }
    } catch {
      // Fall through to the key-based path.
    }

    return `/_plugins/${PLUGIN_ID}/ui/assets/`;
  })();
  return assetBaseUrlPromise;
}

function rgbaToHex(r: number, g: number, b: number, a: number): string {
  if (a < 2) return "";
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b
    .toString(16)
    .padStart(2, "0")}${a === 255 ? "" : a.toString(16).padStart(2, "0")}`;
}

function pixelAt(png: DecodedPng, x: number, y: number): string {
  const idx = (y * png.width + x) * 4;
  return rgbaToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]);
}

function readSprite(png: DecodedPng, width: number, height: number, offsetX = 0, offsetY = 0): SpriteData {
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => pixelAt(png, offsetX + x, offsetY + y)),
  );
}

async function decodePng(url: string): Promise<DecodedPng> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not decode PNG");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: imageData.data };
}

async function decodeCharacters(baseUrl: string, index: AssetIndex): Promise<CharacterDirectionSprites[]> {
  return Promise.all(index.characters.map(async (path) => {
    const png = await decodePng(`${baseUrl}${path}`);
    return {
      down: Array.from({ length: CHAR_FRAMES_PER_ROW }, (_, frame) =>
        readSprite(png, CHAR_FRAME_W, CHAR_FRAME_H, frame * CHAR_FRAME_W, 0),
      ),
      up: Array.from({ length: CHAR_FRAMES_PER_ROW }, (_, frame) =>
        readSprite(png, CHAR_FRAME_W, CHAR_FRAME_H, frame * CHAR_FRAME_W, CHAR_FRAME_H),
      ),
      right: Array.from({ length: CHAR_FRAMES_PER_ROW }, (_, frame) =>
        readSprite(png, CHAR_FRAME_W, CHAR_FRAME_H, frame * CHAR_FRAME_W, CHAR_FRAME_H * 2),
      ),
    };
  }));
}

async function decodeFloors(baseUrl: string, index: AssetIndex): Promise<SpriteData[]> {
  return Promise.all(index.floors.map(async (path) => readSprite(await decodePng(`${baseUrl}${path}`), FLOOR_TILE_SIZE, FLOOR_TILE_SIZE)));
}

async function decodeWalls(baseUrl: string, index: AssetIndex): Promise<SpriteData[][]> {
  return Promise.all(index.walls.map(async (path) => {
    const png = await decodePng(`${baseUrl}${path}`);
    return Array.from({ length: WALL_BITMASK_COUNT }, (_, mask) =>
      readSprite(
        png,
        WALL_PIECE_WIDTH,
        WALL_PIECE_HEIGHT,
        (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH,
        Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT,
      ),
    );
  }));
}

// Carpet sheets: 16 marching-squares cases of 16x16 in a 4-wide grid (upstream core/src/assets).
const CARPET_TILE_SIZE = 16;
const CARPET_GRID_COLS = 4;
const CARPET_MARCHING_SQUARES_COUNT = 16;

async function decodeCarpets(baseUrl: string, index: AssetIndex): Promise<SpriteData[][]> {
  return Promise.all((index.carpets ?? []).map(async (path) => {
    const png = await decodePng(`${baseUrl}${path}`);
    return Array.from({ length: CARPET_MARCHING_SQUARES_COUNT }, (_, msCase) =>
      readSprite(
        png,
        CARPET_TILE_SIZE,
        CARPET_TILE_SIZE,
        (msCase % CARPET_GRID_COLS) * CARPET_TILE_SIZE,
        Math.floor(msCase / CARPET_GRID_COLS) * CARPET_TILE_SIZE,
      ),
    );
  }));
}

// Pet sheets (96x96): walk then idle facing down, the same facing up, three wide frames walking right.
const PET_FRAME_W_SMALL = 16;
const PET_FRAME_W_LARGE = 32;
const PET_FRAME_H = 32;
const PET_FRAMES = 3;

async function decodePets(baseUrl: string, index: AssetIndex): Promise<Parameters<typeof setPetTemplates>[0]> {
  return Promise.all((index.pets ?? []).map(async (pet) => {
    const png = await decodePng(`${baseUrl}${pet.path}`);
    const frames = (row: number, first: number, width: number) =>
      Array.from({ length: PET_FRAMES }, (_, f) => readSprite(png, width, PET_FRAME_H, (first + f) * width, row * PET_FRAME_H));
    return {
      walkDown: frames(0, 0, PET_FRAME_W_SMALL),
      idleDown: frames(0, PET_FRAMES, PET_FRAME_W_SMALL),
      walkUp: frames(1, 0, PET_FRAME_W_SMALL),
      idleUp: frames(1, PET_FRAMES, PET_FRAME_W_SMALL),
      walkRight: frames(2, 0, PET_FRAME_W_LARGE),
    };
  }));
}

async function decodeFurniture(baseUrl: string, index: AssetIndex): Promise<Record<string, SpriteData>> {
  const entries = await Promise.all(index.furniture.map(async (asset) => {
    const png = await decodePng(`${baseUrl}${asset.furniturePath}`);
    return [asset.id, readSprite(png, asset.width, asset.height)] as const;
  }));
  return Object.fromEntries(entries);
}

export function loadPixelAssets(): Promise<LoadedPixelAssets> {
  loadPromise ??= (async () => {
    const baseUrl = await getPluginAssetBaseUrl();
    const indexUrl = `${baseUrl}officesim-assets.json`;
    const index = (await fetch(indexUrl).then((res) => res.json())) as AssetIndex;

    const layoutPaths = index.layouts ?? {
      office: index.defaultLayout,
      boardroomKitchen: index.defaultLayout,
    };

    const [characters, floors, walls, carpets, pets, furnitureSprites, officeLayout, boardroomKitchenLayout] = await Promise.all([
      decodeCharacters(baseUrl, index),
      decodeFloors(baseUrl, index),
      decodeWalls(baseUrl, index),
      decodeCarpets(baseUrl, index),
      decodePets(baseUrl, index),
      decodeFurniture(baseUrl, index),
      fetch(`${baseUrl}${layoutPaths.office}`)
        .then((res) => res.json())
        .then(trimLayoutToVisibleRoom) as Promise<OfficeLayout>,
      fetch(`${baseUrl}${layoutPaths.boardroomKitchen}`)
        .then((res) => res.json())
        .then(trimLayoutToVisibleRoom) as Promise<OfficeLayout>,
    ]);

    setCharacterTemplates(characters);
    setFloorSprites(floors);
    setWallSprites(walls);
    setCarpetSprites(carpets);
    setPetTemplates(pets, (index.pets ?? []).map((pet) => pet.name));
    // The DJ booth, its speakers and the ping pong table are drawn in code rather than shipped as PNGs,
    // so their overlays line up exactly. Their back rows are open floor (the DJ stands behind the decks).
    buildDynamicCatalog({
      catalog: [
        ...index.furniture,
        {
          id: DJ_BOOTH_TYPE,
          label: "DJ booth",
          category: "decor",
          width: DJ_BOOTH_WIDTH,
          height: DJ_BOOTH_HEIGHT,
          footprintW: DJ_BOOTH_WIDTH / 16,
          footprintH: DJ_BOOTH_HEIGHT / 16,
          backgroundTiles: 1,
          isDesk: false,
        },
        {
          id: DJ_SPEAKER_TYPE,
          label: "DJ speaker",
          category: "decor",
          width: DJ_SPEAKER_WIDTH,
          height: DJ_SPEAKER_HEIGHT,
          footprintW: DJ_SPEAKER_WIDTH / 16,
          footprintH: DJ_SPEAKER_HEIGHT / 16,
          backgroundTiles: 1,
          isDesk: false,
        },
        {
          id: PING_PONG_TYPE,
          label: "Ping pong table",
          category: "decor",
          width: PING_PONG_WIDTH,
          height: PING_PONG_HEIGHT,
          footprintW: PING_PONG_WIDTH / 16,
          footprintH: PING_PONG_HEIGHT / 16,
          backgroundTiles: 1,
          isDesk: false,
        },
      ],
      sprites: {
        ...furnitureSprites,
        [DJ_BOOTH_TYPE]: paintDjBooth(),
        [DJ_SPEAKER_TYPE]: paintDjSpeaker(),
        [PING_PONG_TYPE]: paintPingPongTable(),
      },
    });

    const combined = combineLayouts(officeLayout, boardroomKitchenLayout, index.pets);

    return {
      layouts: {
        office: officeLayout,
        boardroomKitchen: boardroomKitchenLayout,
        combined: combined.layout,
        rooms: combined.rooms,
      },
      cameraBounds: combined.cameraBounds,
    };
  })();

  return loadPromise;
}
