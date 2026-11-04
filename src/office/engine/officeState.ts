import { pickDiversePalette } from '../../core/paletteUtils.js';
import {
  AUTO_ON_FACING_DEPTH,
  AUTO_ON_SIDE_DEPTH,
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  CHARACTER_SITTING_OFFSET_PX,
  DISMISS_BUBBLE_FAST_FADE_SEC,
  FURNITURE_ANIM_INTERVAL_SEC,
  GREETER_ID,
  GREETER_TILE_MARGIN,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC,
  MAX_PET_ID_LENGTH,
  PET_HIT_HALF_WIDTH,
  PET_HIT_HEIGHT,
  WAITING_BUBBLE_DURATION_SEC,
  MAX_POOL_PLAYERS,
  BUSY_LEISURE_ARCADE_PLAYERS,
  BUSY_LEISURE_CHECK_SEC,
  BUSY_LEISURE_MIN_IDLE,
  BUSY_LEISURE_POOL_PLAYERS,
  DANCE_HOLD_SEC,
  JOUST_CHECK_SEC,
  DJ_SILENCE_LEAVE_SEC,
} from '../../constants.js';
import { getAnimationFrames, getCatalogEntry, getOnStateType } from '../layout/furnitureCatalog.js';
import {
  createDefaultLayout,
  getBlockedTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
} from '../layout/layoutSerializer.js';
import { findPath, getWalkableTiles, isWalkable } from '../layout/tileMap.js';
import { getPetCount, getPetName } from '../sprites/petSpriteData.js';
import { getLoadedCharacterCount } from '../sprites/spriteData.js';
import type {
  CharacterSnapshot,
  LeisureRegistry,
  LeisureSpot,
  Character,
  FurnitureInstance,
  OfficeLayout,
  Pet,
  PlacedFurniture,
  PlacedPet,
  Seat,
  TileType as TileTypeVal,
  Workplace,
} from '../types.js';
import { CharacterState, Direction, PetState, TILE_SIZE, TileType } from '../types.js';
import { createCharacter, isSeated, isWaiting, startLeisure, updateCharacter } from './characters.js';
import { DJ_BOOTH_TYPE, DJ_SPEAKER_TYPE, getMusicAudio, setPartyRoom } from './djBooth.js';
import { PING_PONG_TYPE } from './pingPong.js';
import { type JoustContext, startJousts, updateJousts } from './chairJoust.js';
import { COFFEE_MACHINE_TYPE, isDrinking, isDrinkKind, prefersWater, WATER_COOLER_TYPE } from './drinkStations.js';
import { advanceMatrixEffect, startMatrixEffect } from './matrixEffectState.js';
import { createPet, updatePet } from './petEntity.js';
import { anchorTile, closestFreeSeat } from './seatPlacement.js';

/** combineLayouts prefixes overflow-office furniture uids with this */
const OVERFLOW_OFFICE_UID_PREFIX = 'camera3-';
/** Chance that an idle agent's next move (wander or leisure) may take them to another room */
const ROOM_CHANGE_CHANCE = 0.1;
/** Furniture that idle agents sit on like a bench when it's outside the offices */
const BENCH_TYPES = new Set(['SMALL_TABLE_FRONT']);
/** Floor in a strip at most this many tiles across, open at both ends, is a hall or doorway to pass through */
const PASSAGE_MAX_WIDTH = 5;
/** Rooms smaller than this (halls, doorways) aren't somewhere to hang about */
const MIN_ROOM_TILES_TO_STAY = 12;
/** The boardroom wall boards a lone worker walks between, left to right */
const INSPECTED_BOARD_TYPES = ['KANBAN_BOARD', 'SCORECARD_BOARD', 'WHITEBOARD'];
/** Seconds a lone boardroom worker spends studying each board */
const INSPECT_MIN_SEC = 8;
const INSPECT_MAX_SEC = 16;

export class OfficeState {
  layout: OfficeLayout;
  tileMap: TileTypeVal[][];
  seats: Map<string, Seat>;
  blockedTiles: Set<string>;
  furniture: FurnitureInstance[];
  walkableTiles: Array<{ col: number; row: number }>;
  characters: Map<number, Character> = new Map();
  pets: Pet[] = [];
  /** Accumulated time for furniture animation frame cycling */
  furnitureAnimTimer = 0;
  selectedAgentId: number | null = null;
  cameraFollowId: number | null = null;
  hoveredAgentId: number | null = null;
  hoveredTile: { col: number; row: number } | null = null;
  /** Maps "parentId:toolId" → sub-agent character ID (negative) */
  subagentIdMap: Map<string, number> = new Map();
  /** Reverse lookup: sub-agent character ID → parent info */
  subagentMeta: Map<number, { parentAgentId: number; parentToolId: string }> = new Map();
  private nextSubagentId = -1;
  leisureSpots: Map<string, LeisureSpot> = new Map();
  /** Floor tiles of rooms with desks or the boardroom table; idle agents stay out of these */
  officeTiles: Set<string> = new Set();
  /** Work seat uid → the room it belongs to (PC desks and boardroom chairs) */
  seatWorkplaces: Map<string, Workplace> = new Map();
  /** Office work seats at a computer whose screen faces the camera */
  private frontScreenSeats: Set<string> = new Set();
  /** Room index per floor tile ("col,row"): connected floor of one tile pattern */
  private tileRooms: Map<string, number> = new Map();
  /** Tile count per room index */
  private roomSizes: number[] = [];
  /** Halls and doorways: idle agents pass through but don't stop in them */
  private passageTiles: Set<string> = new Set();
  /** Behind the DJ booth and its speakers: only the DJ stays there */
  private backstageTiles: Set<string> = new Set();
  /** Where people stand to play or get a drink: only for whoever's doing that, not to hang about on */
  private gameSpotTiles: Set<string> = new Set();
  /** Idle wander targets per room */
  private idleTilesByRoom: Map<number, Array<{ col: number; row: number }>> = new Map();
  /** True while agents are being placed on first load, when nobody starts mid-drink */
  private settling = false;
  /** Characters whose next idle move may go to another room */
  private roamingNext: Set<number> = new Set();
  /** Where the boardroom presenter stands: beside the whiteboard, facing the room */
  private presenterSpot: { col: number; row: number } | null = null;
  /** Where a lone boardroom worker stands to study each wall board, facing it */
  private inspectStops: Array<{ col: number; row: number }> = [];
  /** A boardroom inspector's current board (index into inspectStops) and time left at it */
  private inspecting = new Map<number, { stop: number; timer: number }>();
  /** Tile each sick agent is heading to (or standing on) near their seat */
  private sickTargets: Map<number, string> = new Map();
  /** Walkable tiles outside the offices, used as idle wander targets */
  idleTiles: Array<{ col: number; row: number }> = [];
  /** Leisure spot key → claiming character id */
  private leisureClaims: Map<string, number> = new Map();
  /** The DJ booth's room: null until looked up */
  private djRoomCache: number | undefined | null = null;
  /** Time until the office next looks for an idle agent in the games room to DJ */
  private djTimer = 0;
  /** The agent being sent to the decks: the only one who may claim the DJ spot */
  private djPending: number | null = null;
  /** Time until the office next looks for idle agents to make up a ping pong pair */
  private pingPongTimer = 0;
  /** The agent being sent to the ping pong table: the only one who may claim an end of it */
  private pingPongPending: number | null = null;
  /** Seconds since music was last playing (the DJ leaves after a while without it) */
  private silenceSec = Infinity;
  /** Time until the office next checks the pool table and arcade have their players */
  private busyLeisureTimer = 0;
  /** Time until the office next looks for waiting agents to pair up for chair jousting */
  private joustTimer = 0;
  private readonly leisure: LeisureRegistry = {
    claim: (ch) => this.claimLeisureSpot(ch),
    release: (ch) => this.releaseLeisureSpot(ch),
    get: (key) => this.leisureSpots.get(key),
  };

  /**
   * folderName → list of Area labels that workspace folder belongs to.
   * Populated by useExtensionMessages on `areaMappingsLoaded`. Consulted by
   * `findFreeSeat()` to bias new agents toward seats inside their folder's Area.
   */
  areaMappings: Record<string, string[]> = {};

  /**
   * The first-run consent greeter, deliberately NOT in `characters`.
   *
   * `characters` means "agents": everything that iterates it — seat
   * assignment, palette diversity, the wander FSM, hit-testing, the seat
   * payload the webview persists — is asking an agent question the greeter has
   * no answer to. Holding it here instead of tagging it with a flag makes
   * every one of those loops correct by default, rather than correct as long
   * as each remembers an `isGreeter` guard. It is drawn because
   * `getCharacters()` appends it, and that is the only place it joins the
   * others.
   */
  greeter: Character | null = null;

  /** World-space point the camera drifts to while the greeter is up
   *  (the bubble overlay recomputes it every frame: the combined center of the
   *  character and its speech bubble). An explicit cameraFollowId outranks it. */
  greeterCameraTarget: { x: number; y: number } | null = null;
  /** Latched by a manual pan during the ask: the user took the camera, so the
   *  overlay's per-frame updates stop re-centering. Reset on spawn/despawn. */
  private greeterCameraCancelled = false;

  setAreaMappings(mappings: Record<string, string[]>): void {
    this.areaMappings = mappings;
  }

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout();
    this.tileMap = layoutToTileMap(this.layout);
    this.seats = layoutToSeats(this.layout.furniture);
    this.blockedTiles = getBlockedTiles(this.layout.furniture);
    this.furniture = layoutToFurnitureInstances(this.layout.furniture);
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
    // Office tiles first: leisure spots (e.g. benches) are only outside the offices
    this.officeTiles = this.buildOfficeTiles();
    this.leisureSpots = this.buildLeisureSpots();
    this.passageTiles = this.findPassageTiles();
    this.backstageTiles = this.findBackstageTiles();
    this.gameSpotTiles = this.findGameSpotTiles();
    this.idleTiles = this.walkableTiles.filter((t) => {
      const key = `${t.col},${t.row}`;
      return !this.officeTiles.has(key) && !this.passageTiles.has(key) && !this.backstageTiles.has(key) && !this.gameSpotTiles.has(key);
    });
    this.idleTilesByRoom = this.groupIdleTilesByRoom();
    this.seatWorkplaces = this.buildSeatWorkplaces();
    this.frontScreenSeats = this.buildFrontScreenSeats();
    this.presenterSpot = this.findPresenterSpot();
    this.inspectStops = this.findInspectStops();
    setPartyRoom(this.findPartyRoom());
    // Pets are built last because they need walkableTiles populated for spawn.
    this.rebuildPetsFromLayout(this.layout);
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters.
   *  @param shift Optional pixel shift to apply when grid expands left/up */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    this.layout = layout;
    this.tileMap = layoutToTileMap(layout);
    this.seats = layoutToSeats(layout.furniture);
    this.blockedTiles = getBlockedTiles(layout.furniture);
    this.rebuildFurnitureInstances();
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
    // Office tiles first: leisure spots (e.g. benches) are only outside the offices
    this.officeTiles = this.buildOfficeTiles();
    this.leisureSpots = this.buildLeisureSpots();
    this.passageTiles = this.findPassageTiles();
    this.backstageTiles = this.findBackstageTiles();
    this.gameSpotTiles = this.findGameSpotTiles();
    this.idleTiles = this.walkableTiles.filter((t) => {
      const key = `${t.col},${t.row}`;
      return !this.officeTiles.has(key) && !this.passageTiles.has(key) && !this.backstageTiles.has(key) && !this.gameSpotTiles.has(key);
    });
    this.idleTilesByRoom = this.groupIdleTilesByRoom();
    this.seatWorkplaces = this.buildSeatWorkplaces();
    this.frontScreenSeats = this.buildFrontScreenSeats();
    this.presenterSpot = this.findPresenterSpot();
    this.inspectStops = this.findInspectStops();
    setPartyRoom(this.findPartyRoom());
    this.djRoomCache = null;
    this.inspecting.clear();
    this.leisureClaims.clear();

    // Shift character positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const ch of this.characters.values()) {
        ch.tileCol += shift.col;
        ch.tileRow += shift.row;
        ch.x += shift.col * TILE_SIZE;
        ch.y += shift.row * TILE_SIZE;
        // Clear path since tile coords changed
        ch.path = [];
        ch.moveProgress = 0;
      }
    }

    // Shift pet positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const pet of this.pets) {
        pet.tileCol += shift.col;
        pet.tileRow += shift.row;
        pet.x += shift.col * TILE_SIZE;
        pet.y += shift.row * TILE_SIZE;
        pet.path = [];
        pet.moveProgress = 0;
      }
    }

    // Reassign characters to new seats, preserving existing assignments when possible
    for (const seat of this.seats.values()) {
      seat.assigned = false;
    }

    // First pass: try to keep characters at their existing seats
    for (const ch of this.characters.values()) {
      if (ch.seatId && this.seats.has(ch.seatId)) {
        const seat = this.seats.get(ch.seatId)!;
        if (!seat.assigned) {
          seat.assigned = true;
          // Snap character to seat position
          ch.tileCol = seat.seatCol;
          ch.tileRow = seat.seatRow;
          const cx = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
          const cy = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
          ch.x = cx;
          ch.y = cy;
          ch.dir = seat.facingDir;
          continue;
        }
      }
      ch.seatId = null; // will be reassigned below
    }

    // Second pass: assign remaining characters to free seats
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue;
      const seatId = this.findFreeSeat(ch.folderName);
      if (seatId) {
        this.seats.get(seatId)!.assigned = true;
        ch.seatId = seatId;
        const seat = this.seats.get(seatId)!;
        ch.tileCol = seat.seatCol;
        ch.tileRow = seat.seatRow;
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
        ch.dir = seat.facingDir;
      }
    }

    // Relocate any characters that ended up outside bounds or on non-walkable tiles
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue; // seated characters are fine
      if (
        ch.tileCol < 0 ||
        ch.tileCol >= layout.cols ||
        ch.tileRow < 0 ||
        ch.tileRow >= layout.rows
      ) {
        this.relocateCharacterToWalkable(ch);
      }
    }

    // Relocate any pets that ended up outside bounds or on non-walkable tiles
    for (const pet of this.pets) {
      if (
        pet.tileCol < 0 ||
        pet.tileCol >= layout.cols ||
        pet.tileRow < 0 ||
        pet.tileRow >= layout.rows ||
        !isWalkable(pet.tileCol, pet.tileRow, this.tileMap, this.blockedTiles)
      ) {
        if (this.walkableTiles.length > 0) {
          const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
          pet.tileCol = spawn.col;
          pet.tileRow = spawn.row;
          pet.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
          pet.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
          pet.path = [];
          pet.moveProgress = 0;
          pet.state = PetState.IDLE;
          pet.frame = 0;
          pet.frameTimer = 0;
          pet.followTargetId = null;
        }
      }
    }

    // Reconcile pets against the layout roster (handles editor add/remove)
    this.rebuildPetsFromLayout(layout);
  }

  /** Move a character to a random walkable tile */
  private relocateCharacterToWalkable(ch: Character): void {
    if (this.walkableTiles.length === 0) return;
    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.path = [];
    ch.moveProgress = 0;
  }

  private getSpawnTile(): { col: number; row: number } {
    const spawn = this.layout.spawnTile;
    if (spawn && isWalkable(spawn.col, spawn.row, this.tileMap, this.blockedTiles)) {
      return spawn;
    }
    return this.walkableTiles[0] ?? { col: 1, row: 1 };
  }

  private moveCharacterToSpawn(ch: Character): void {
    const spawn = this.getSpawnTile();
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.path = [];
    ch.moveProgress = 0;
    ch.state = CharacterState.IDLE;
    ch.dir = Direction.DOWN;
    ch.frame = 0;
    ch.frameTimer = 0;
    ch.wanderTimer = Math.random() * 3;
  }

  getLayout(): OfficeLayout {
    return this.layout;
  }

  /** Floor tiles of the room holding the boardroom table */
  private boardroomTiles: Set<string> = new Set();

  /** Rooms (connected floor of one tile type) with a desk, PC or boardroom table count as offices */
  private buildOfficeTiles(): Set<string> {
    const rows = this.tileMap.length;
    const cols = rows > 0 ? this.tileMap[0].length : 0;
    const roomOf = new Map<string, number>();
    const rooms: string[][] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const type = this.tileMap[row][col];
        if (type === TileType.WALL || type === TileType.VOID || roomOf.has(`${col},${row}`)) continue;
        const room: string[] = [];
        const stack = [{ col, row }];
        roomOf.set(`${col},${row}`, rooms.length);
        while (stack.length > 0) {
          const tile = stack.pop()!;
          room.push(`${tile.col},${tile.row}`);
          for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nc = tile.col + dc;
            const nr = tile.row + dr;
            const key = `${nc},${nr}`;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols || roomOf.has(key) || this.tileMap[nr][nc] !== type) continue;
            roomOf.set(key, rooms.length);
            stack.push({ col: nc, row: nr });
          }
        }
        rooms.push(room);
      }
    }
    this.tileRooms = roomOf;
    this.roomSizes = rooms.map((room) => room.length);

    const officeTiles = new Set<string>();
    this.boardroomTiles = new Set();
    for (const item of this.layout.furniture) {
      const isBoardroom = item.type.startsWith('BOARDROOM_TABLE');
      if (!isBoardroom && !/^(DESK|PC)_/.test(item.type)) continue;
      // Furniture blocks its own tiles, so look for the room under any footprint tile
      const entry = getCatalogEntry(item.type);
      let room: number | undefined;
      for (let dr = 0; dr < (entry?.footprintH ?? 1) && room === undefined; dr++) {
        for (let dc = 0; dc < (entry?.footprintW ?? 1) && room === undefined; dc++) {
          room = roomOf.get(`${item.col + dc},${item.row + dr}`);
        }
      }
      if (room === undefined) continue;
      for (const key of rooms[room]) {
        officeTiles.add(key);
        if (isBoardroom) this.boardroomTiles.add(key);
      }
    }
    return officeTiles;
  }

  /** Pool table sides, arcade fronts and sofa seats where idle agents hang out */
  private buildLeisureSpots(): Map<string, LeisureSpot> {
    const spots = new Map<string, LeisureSpot>();
    const add = (
      kind: LeisureSpot['kind'],
      furnitureUid: string,
      col: number,
      row: number,
      facingDir: Direction,
      onFurniture = false,
    ) => {
      const key = `${kind}:${col},${row}`;
      if (!onFurniture && !isWalkable(col, row, this.tileMap, this.blockedTiles)) return;
      spots.set(key, { key, kind, col, row, facingDir, onFurniture, furnitureUid });
    };

    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry) continue;
      const top = item.row + (entry.backgroundTiles ?? 0);
      const bottom = item.row + entry.footprintH - 1;
      const left = item.col;
      const right = item.col + entry.footprintW - 1;

      if (item.type.startsWith('POOL_TABLE')) {
        for (let col = left; col <= right; col++) {
          add('pool', item.uid, col, top - 1, Direction.DOWN);
          add('pool', item.uid, col, bottom + 1, Direction.UP);
        }
        for (let row = top; row <= bottom; row++) {
          add('pool', item.uid, left - 1, row, Direction.RIGHT);
          add('pool', item.uid, right + 1, row, Direction.LEFT);
        }
      } else if (item.type.startsWith('ARCADE_MACHINE')) {
        for (let col = left; col <= right; col++) add('arcade', item.uid, col, bottom + 1, Direction.UP);
      } else if (item.type === COFFEE_MACHINE_TYPE) {
        add('coffee', item.uid, left, bottom + 1, Direction.UP);
      } else if (item.type === WATER_COOLER_TYPE) {
        add('water', item.uid, left, bottom + 1, Direction.UP);
      } else if (item.type === PING_PONG_TYPE) {
        // One end each, level with the table's front row, facing across it
        add('pingpong', item.uid, left - 1, bottom, Direction.RIGHT);
        add('pingpong', item.uid, right + 1, bottom, Direction.LEFT);
      } else if (item.type === DJ_BOOTH_TYPE) {
        // Behind the middle of the decks, on the booth's open back row, facing the room
        add('dj', item.uid, left + Math.floor(entry.footprintW / 2), item.row, Direction.DOWN);
      }
    }

    const sofaUids = new Set(this.layout.furniture.filter((f) => f.type.startsWith('SOFA')).map((f) => f.uid));
    for (const seat of this.seats.values()) {
      const furnitureUid = seat.uid.split(':')[0];
      if (sofaUids.has(furnitureUid)) add('sofa', furnitureUid, seat.seatCol, seat.seatRow, seat.facingDir, true);
    }

    // Low tables outside the offices (the games room's, the lounges') double as benches: sit along
    // their front row, facing the room, wherever nothing's been put on top.
    const surfaceTiles = new Set<string>();
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry?.canPlaceOnSurfaces) continue;
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) surfaceTiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
    for (const item of this.layout.furniture) {
      if (!BENCH_TYPES.has(item.type)) continue;
      const entry = getCatalogEntry(item.type);
      if (!entry) continue;
      const row = item.row + entry.footprintH - 1;
      for (let col = item.col; col < item.col + entry.footprintW; col++) {
        const key = `${col},${row}`;
        if (this.officeTiles.has(key) || surfaceTiles.has(key)) continue;
        add('sofa', item.uid, col, row, Direction.DOWN, true);
      }
    }
    return spots;
  }

  private claimLeisureSpot(ch: Character): LeisureSpot | null {
    this.releaseLeisureSpot(ch);
    // Sofa seats that double as someone's working seat are off limits while they work
    const busySeatTiles = new Set<string>();
    for (const other of this.characters.values()) {
      if (!other.isActive || !other.seatId) continue;
      const seat = this.seats.get(other.seatId);
      if (seat) busySeatTiles.add(`${seat.seatCol},${seat.seatRow}`);
    }
    // Count players per pool table so a third player can't join a game
    const poolPlayers = this.poolPlayerCounts();
    // An end of the ping pong table only goes to whoever fillPingPong is sending there
    if (this.pingPongPending === ch.id) {
      const end = [...this.leisureSpots.values()].find((spot) => spot.kind === 'pingpong' && !this.leisureClaims.has(spot.key));
      if (!end) return null;
      this.leisureClaims.set(end.key, ch.id);
      ch.leisureSpotKey = end.key;
      return end;
    }
    // The decks only go to whoever fillDjBooth is sending there
    if (this.djPending === ch.id) {
      const decks = [...this.leisureSpots.values()].find((spot) => spot.kind === 'dj' && !this.leisureClaims.has(spot.key));
      if (!decks) return null;
      this.leisureClaims.set(decks.key, ch.id);
      ch.leisureSpotKey = decks.key;
      return decks;
    }
    const free = [...this.leisureSpots.values()].filter(
      (spot) =>
        spot.kind !== 'dj' &&
        spot.kind !== 'pingpong' &&
        !this.leisureClaims.has(spot.key) &&
        // A drink is a quick break taken while the camera's watching, not somewhere to start out
        !(this.settling && isDrinkKind(spot.kind)) &&
        !busySeatTiles.has(`${spot.col},${spot.row}`) &&
        (spot.kind !== 'pool' || (poolPlayers.get(spot.furnitureUid) ?? 0) < MAX_POOL_PLAYERS),
    );
    if (free.length === 0) return null;
    // A busy office keeps a pool game and the arcade going, whichever room they're in
    const needed = this.neededLeisureSpot(free, poolPlayers);
    if (needed) {
      this.leisureClaims.set(needed.key, ch.id);
      ch.leisureSpotKey = needed.key;
      return needed;
    }
    // Only somewhere in the room this agent should be idling in, so the breakout rooms stay balanced;
    // if nothing's free there they wander about the room instead
    const room = this.idleRoomFor(ch);
    const pool = room === undefined ? free : free.filter((spot) => this.leisureSpotRoom(spot) === room);
    if (pool.length === 0) return null;
    // Pick an activity first so the many pool-side tiles don't crowd out the arcade. Coffee and water
    // count as one activity, a drink: agents go for the one they prefer, or the other if it's taken.
    const activity = (kind: LeisureSpot['kind']) => (isDrinkKind(kind) ? 'drink' : kind);
    const kinds = [...new Set(pool.map((spot) => activity(spot.kind)))];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    let options = pool.filter((spot) => activity(spot.kind) === kind);
    if (kind === 'drink') {
      const preferred = prefersWater(ch.id) ? 'water' : 'coffee';
      const favourite = options.filter((spot) => spot.kind === preferred);
      if (favourite.length > 0) options = favourite;
    }
    const spot = options[Math.floor(Math.random() * options.length)];
    this.leisureClaims.set(spot.key, ch.id);
    ch.leisureSpotKey = spot.key;
    return spot;
  }

  /**
   * While the DJ booth plays, idle agents in its room dance: those standing about or drinking (not
   * walking, sitting, playing pool or working). Standing dancers stay on the floor rather than wander.
   */
  private updateDancers(): void {
    const playing = getMusicAudio().playing;
    const room = playing ? this.djRoom() : undefined;
    for (const ch of this.characters.values()) {
      const eligible =
        room !== undefined &&
        !ch.isActive &&
        !ch.isSick &&
        !ch.matrixEffect &&
        (ch.state === CharacterState.IDLE || isDrinking(ch)) &&
        !this.backstageTiles.has(`${ch.tileCol},${ch.tileRow}`) &&
        // Not on the spot by a game or the drinks: they'd be dancing in someone's way
        !(ch.state === CharacterState.IDLE && this.gameSpotTiles.has(`${ch.tileCol},${ch.tileRow}`)) &&
        this.tileRooms.get(`${ch.tileCol},${ch.tileRow}`) === room;
      ch.dancing = eligible;
      if (eligible && ch.state === CharacterState.IDLE) ch.wanderTimer = Math.max(ch.wanderTimer, DANCE_HOLD_SEC);
    }
  }

  /** The room the DJ booth plays in (found once), or undefined without one */
  private djRoom(): number | undefined {
    if (this.djRoomCache !== null) return this.djRoomCache;
    const spot = [...this.leisureSpots.values()].find((candidate) => candidate.kind === 'dj');
    const room = spot ? this.tileRooms.get(`${spot.col},${spot.row}`) : undefined;
    this.djRoomCache = room;
    return room;
  }

  /**
   * Keep someone on the decks while music plays: when nobody's DJing and an idle agent is hanging
   * about in the games room (standing, dancing or wandering, not playing or drinking), send the
   * nearest one over. Once the music's been off a while, whoever's DJing (or on their way) stops.
   */
  private fillDjBooth(dt: number): void {
    this.silenceSec = getMusicAudio().playing ? 0 : this.silenceSec + dt;
    this.djTimer -= dt;
    if (this.djTimer > 0) return;
    this.djTimer = BUSY_LEISURE_CHECK_SEC;
    if (this.silenceSec > 0) {
      if (this.silenceSec >= DJ_SILENCE_LEAVE_SEC) this.sendDjHome();
      return;
    }
    const spot = [...this.leisureSpots.values()].find((candidate) => candidate.kind === 'dj');
    const room = this.djRoom();
    if (!spot || room === undefined || this.leisureClaims.has(spot.key)) return;
    // Wait for the last DJ to step out from behind the booth before the next goes in
    if ([...this.characters.values()].some((ch) => this.backstageTiles.has(`${ch.tileCol},${ch.tileRow}`))) return;
    const loitering = [...this.characters.values()].filter(
      (ch) =>
        ch.state === CharacterState.IDLE &&
        !ch.isActive &&
        !ch.isSick &&
        !ch.isSubagent &&
        !ch.matrixEffect &&
        !ch.leisureSpotKey &&
        this.tileRooms.get(`${ch.tileCol},${ch.tileRow}`) === room,
    );
    const distance = (ch: Character) => Math.abs(ch.tileCol - spot.col) + Math.abs(ch.tileRow - spot.row);
    for (const ch of loitering.sort((a, b) => distance(a) - distance(b))) {
      this.djPending = ch.id;
      const started = startLeisure(ch, this.leisure, this.tileMap, this.blockedTiles);
      this.djPending = null;
      if (started) return;
    }
  }

  /**
   * Keep a game of ping pong going: the nearest idle agent standing about goes to a free end of the
   * table, one at a time. The first waits there, bouncing the ball, until the next joins them.
   */
  private fillPingPong(dt: number): void {
    this.pingPongTimer -= dt;
    if (this.pingPongTimer > 0) return;
    this.pingPongTimer = BUSY_LEISURE_CHECK_SEC;
    const ends = [...this.leisureSpots.values()].filter((spot) => spot.kind === 'pingpong');
    if (ends.length < 2) return;
    const open = ends.filter((spot) => !this.leisureClaims.has(spot.key));
    if (open.length === 0) return;
    const standing = [...this.characters.values()].filter(
      (ch) =>
        ch.state === CharacterState.IDLE &&
        !ch.isActive &&
        !ch.isSick &&
        !ch.isSubagent &&
        !ch.matrixEffect &&
        !ch.leisureSpotKey,
    );
    const table = open[0];
    const distance = (ch: Character) => Math.abs(ch.tileCol - table.col) + Math.abs(ch.tileRow - table.row);
    for (const ch of standing.sort((a, b) => distance(a) - distance(b))) {
      this.pingPongPending = ch.id;
      const started = startLeisure(ch, this.leisure, this.tileMap, this.blockedTiles);
      this.pingPongPending = null;
      if (started) return;
    }
  }

  /** No music: the DJ's turn ends (and anyone heading for the decks goes back to idling) */
  private sendDjHome(): void {
    for (const ch of this.characters.values()) {
      if (!ch.leisureSpotKey?.startsWith('dj:')) continue;
      if (ch.state === CharacterState.LEISURE) ch.leisureTimer = 0;
      else this.releaseLeisureSpot(ch);
    }
  }

  /** Tiles of the spots for games and drinks (not sofas, which are seats) */
  private findGameSpotTiles(): Set<string> {
    const tiles = new Set<string>();
    for (const spot of this.leisureSpots.values()) if (spot.kind !== 'sofa') tiles.add(`${spot.col},${spot.row}`);
    return tiles;
  }

  /** Tiles behind the DJ booth and its speakers: the DJ's way in, not somewhere to hang about */
  private findBackstageTiles(): Set<string> {
    const tiles = new Set<string>();
    for (const item of this.layout.furniture) {
      if (item.type !== DJ_BOOTH_TYPE && item.type !== DJ_SPEAKER_TYPE) continue;
      const entry = getCatalogEntry(item.type);
      for (let dr = 0; dr < (entry?.footprintH ?? 1); dr++) {
        for (let dc = 0; dc < (entry?.footprintW ?? 1); dc++) tiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
    return tiles;
  }

  /**
   * Where the DJ booth's lights go: the floor of its room and the wall above it, the lasers on the
   * back wall above the booth's ends, and the disco ball hanging in the middle of the room.
   */
  private findPartyRoom(): Parameters<typeof setPartyRoom>[0] {
    const booth = this.layout.furniture.find((item) => item.type === DJ_BOOTH_TYPE);
    const entry = booth ? getCatalogEntry(booth.type) : undefined;
    if (!booth || !entry) return null;
    const room = this.tileRooms.get(`${booth.col + 1},${booth.row}`);
    if (room === undefined) return null;
    let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
    for (const [key, tileRoom] of this.tileRooms) {
      if (tileRoom !== room) continue;
      const [col, row] = key.split(',').map(Number);
      minCol = Math.min(minCol, col);
      maxCol = Math.max(maxCol, col);
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
    }
    const wallTop = minRow * TILE_SIZE - TILE_SIZE * 1.5;
    const emitterY = minRow * TILE_SIZE - TILE_SIZE * 0.6;
    return {
      x: minCol * TILE_SIZE,
      y: wallTop,
      w: (maxCol - minCol + 1) * TILE_SIZE,
      h: (maxRow + 1) * TILE_SIZE - wallTop,
      emitters: [
        { x: booth.col * TILE_SIZE + 3, y: emitterY },
        { x: (booth.col + entry.footprintW) * TILE_SIZE - 3, y: emitterY },
      ],
      ball: { x: ((minCol + maxCol + 1) / 2) * TILE_SIZE, y: (minRow + 2.5) * TILE_SIZE },
    };
  }

  /** Players (including any on their way) per pool table uid */
  private poolPlayerCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const key of this.leisureClaims.keys()) {
      const claimed = this.leisureSpots.get(key);
      if (claimed?.kind === 'pool') counts.set(claimed.furnitureUid, (counts.get(claimed.furnitureUid) ?? 0) + 1);
    }
    return counts;
  }

  /** Agents with nothing to do: not working, sick or leaving */
  private idleAgentCount(): number {
    let idle = 0;
    for (const ch of this.characters.values()) {
      if (!ch.isActive && !ch.isSick && !ch.isSubagent && ch.matrixEffect !== 'despawn') idle++;
    }
    return idle;
  }

  /**
   * With more than BUSY_LEISURE_MIN_IDLE agents idle, the free spot that keeps someone at the arcade
   * and two playing each other at pool, or null when they already are (or can't be). Arcade first,
   * then a pool table that already has a player, so the pair share a table.
   */
  private neededLeisureSpot(free: LeisureSpot[], poolPlayers: Map<string, number>): LeisureSpot | null {
    if (this.idleAgentCount() <= BUSY_LEISURE_MIN_IDLE) return null;
    let arcadePlayers = 0;
    for (const key of this.leisureClaims.keys()) {
      if (this.leisureSpots.get(key)?.kind === 'arcade') arcadePlayers++;
    }
    if (arcadePlayers < BUSY_LEISURE_ARCADE_PLAYERS) {
      const arcades = free.filter((spot) => spot.kind === 'arcade');
      if (arcades.length > 0) return arcades[Math.floor(Math.random() * arcades.length)];
    }
    if (Math.max(0, ...poolPlayers.values()) >= BUSY_LEISURE_POOL_PLAYERS) return null;
    const tables = free.filter((spot) => spot.kind === 'pool');
    if (tables.length === 0) return null;
    const busiest = Math.max(...tables.map((spot) => poolPlayers.get(spot.furnitureUid) ?? 0));
    const options = tables.filter((spot) => (poolPlayers.get(spot.furnitureUid) ?? 0) === busiest);
    return options[Math.floor(Math.random() * options.length)];
  }

  /** Send an idle agent who's just standing about to fill a gap at the pool table or arcade */
  private fillBusyLeisure(dt: number): void {
    this.busyLeisureTimer -= dt;
    if (this.busyLeisureTimer > 0) return;
    this.busyLeisureTimer = BUSY_LEISURE_CHECK_SEC;
    if (this.idleAgentCount() <= BUSY_LEISURE_MIN_IDLE) return;
    const standing = [...this.characters.values()].filter(
      (ch) =>
        ch.state === CharacterState.IDLE &&
        !ch.isActive &&
        !ch.isSick &&
        !ch.isSubagent &&
        !ch.matrixEffect &&
        !ch.leisureSpotKey,
    );
    const poolPlayers = this.poolPlayerCounts();
    const free = [...this.leisureSpots.values()].filter(
      (spot) =>
        spot.kind !== 'dj' &&
        spot.kind !== 'pingpong' &&
        !this.leisureClaims.has(spot.key) &&
        (spot.kind !== 'pool' || (poolPlayers.get(spot.furnitureUid) ?? 0) < MAX_POOL_PLAYERS),
    );
    const needed = this.neededLeisureSpot(free, poolPlayers);
    if (!needed) return;
    // Whoever's nearest, so the gap fills quickly; claiming then picks the needed spot (or its twin)
    const distance = (ch: Character) => Math.abs(ch.tileCol - needed.col) + Math.abs(ch.tileRow - needed.row);
    for (const ch of standing.sort((a, b) => distance(a) - distance(b))) {
      if (startLeisure(ch, this.leisure, this.tileMap, this.blockedTiles)) return;
    }
  }

  /**
   * The room a leisure spot belongs to: the largest room at or just around it. Spots on furniture
   * (sofas) and spots on a room's edging (e.g. the drinks by the lounge's chequered strip) count as
   * part of the main room beside them.
   */
  private leisureSpotRoom(spot: LeisureSpot): number | undefined {
    let best: number | undefined;
    for (const [dc, dr] of [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0], [0, -2], [0, -3]]) {
      const room = this.tileRooms.get(`${spot.col + dc},${spot.row + dr}`);
      if (room !== undefined && (best === undefined || this.roomSizes[room] > this.roomSizes[best])) best = room;
    }
    return best;
  }

  /** Walk a character already at leisure to another free spot (e.g. around the pool table) */
  moveToLeisureSpot(ch: Character, key: string): boolean {
    const spot = this.leisureSpots.get(key);
    const claimant = this.leisureClaims.get(key);
    if (!spot || (claimant !== undefined && claimant !== ch.id)) return false;
    const path = findPath(ch.tileCol, ch.tileRow, spot.col, spot.row, this.tileMap, this.blockedTiles);
    if (path.length === 0) return false;
    if (ch.leisureSpotKey && this.leisureClaims.get(ch.leisureSpotKey) === ch.id) {
      this.leisureClaims.delete(ch.leisureSpotKey);
    }
    this.leisureClaims.set(key, ch.id);
    ch.leisureSpotKey = key;
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  /** Spot keys currently claimed by other characters */
  isLeisureSpotFree(key: string, ch: Character): boolean {
    const claimant = this.leisureClaims.get(key);
    return claimant === undefined || claimant === ch.id;
  }

  private releaseLeisureSpot(ch: Character): void {
    if (ch.leisureSpotKey && this.leisureClaims.get(ch.leisureSpotKey) === ch.id) {
      this.leisureClaims.delete(ch.leisureSpotKey);
    }
    ch.leisureSpotKey = null;
    ch.leisureTimer = 0;
    ch.leisureStep = null;
  }

  /** Get the blocked-tile key for a character's own seat, or null */
  private ownSeatKey(ch: Character): string | null {
    if (!ch.seatId) return null;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return null;
    return `${seat.seatCol},${seat.seatRow}`;
  }

  /** Temporarily unblock a character's own seat, run fn, then re-block */
  /** The office as chair jousting sees it */
  private joustContext(): JoustContext {
    return {
      characters: this.characters,
      seats: this.seats,
      seatWorkplaces: this.seatWorkplaces,
      walkableTiles: this.walkableTiles,
      tileMap: this.tileMap,
      blockedTiles: this.blockedTiles,
      furniture: this.layout.furniture,
      pathToSeat: (ch) => {
        const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined;
        if (!seat) return [];
        return this.withOwnSeatUnblocked(ch, () =>
          findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
        );
      },
    };
  }

  private withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T {
    const key = this.ownSeatKey(ch);
    if (key) this.blockedTiles.delete(key);
    const result = fn();
    if (key) this.blockedTiles.add(key);
    return result;
  }

  /** Tiles covered by electronics; with `frontOnly`, just computers whose screens face the camera. */
  private getElectronicsTiles(frontOnly = false): Set<string> {
    const out = new Set<string>();
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry || entry.category !== 'electronics') continue;
      if (frontOnly && !item.type.startsWith('PC_FRONT')) continue;
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          out.add(`${item.col + dc},${item.row + dr}`);
        }
      }
    }
    return out;
  }

  /** Whether a seat faces electronics (same logic as auto-state detection) */
  private seatFacesPC(seat: Seat, electronicsTiles: Set<string>): boolean {
    const dCol = seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
    const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
    for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
      const tileCol = seat.seatCol + dCol * d;
      const tileRow = seat.seatRow + dRow * d;
      if (electronicsTiles.has(`${tileCol},${tileRow}`)) return true;
      const sideways =
        dCol !== 0
          ? [`${tileCol},${tileRow - 1}`, `${tileCol},${tileRow + 1}`]
          : [`${tileCol - 1},${tileRow}`, `${tileCol + 1},${tileRow}`];
      if (sideways.some((key) => electronicsTiles.has(key))) return true;
    }
    return false;
  }

  /**
   * Halls and doorways: floor tiles in a strip no more than PASSAGE_MAX_WIDTH tiles across (between
   * walls or the void) that carries on through them on both sides, like the corridors between the
   * buildings and the gaps in walls between rooms. A nook closed off at its ends isn't one.
   */
  private findPassageTiles(): Set<string> {
    const isFloor = (col: number, row: number) => {
      const type = this.tileMap[row]?.[col];
      return type !== undefined && type !== TileType.WALL && type !== TileType.VOID;
    };
    const spanAcross = (col: number, row: number, dc: number, dr: number) => {
      let span = 1;
      for (let c = col + dc, r = row + dr; isFloor(c, r); c += dc, r += dr) span++;
      for (let c = col - dc, r = row - dr; isFloor(c, r); c -= dc, r -= dr) span++;
      return span;
    };
    const passages = new Set<string>();
    for (let row = 0; row < this.tileMap.length; row++) {
      for (let col = 0; col < (this.tileMap[row]?.length ?? 0); col++) {
        if (!isFloor(col, row)) continue;
        // Narrow up-and-down with floor carrying on left and right, or the other way round
        const horizontal = spanAcross(col, row, 0, 1) <= PASSAGE_MAX_WIDTH && isFloor(col - 1, row) && isFloor(col + 1, row);
        const vertical = spanAcross(col, row, 1, 0) <= PASSAGE_MAX_WIDTH && isFloor(col, row - 1) && isFloor(col, row + 1);
        if (horizontal || vertical) passages.add(`${col},${row}`);
      }
    }
    return passages;
  }

  private groupIdleTilesByRoom(): Map<number, Array<{ col: number; row: number }>> {
    const byRoom = new Map<number, Array<{ col: number; row: number }>>();
    for (const tile of this.idleTiles) {
      const room = this.tileRooms.get(`${tile.col},${tile.row}`);
      if (room === undefined) continue;
      let tiles = byRoom.get(room);
      if (!tiles) byRoom.set(room, (tiles = []));
      tiles.push(tile);
    }
    return byRoom;
  }

  /** Where an idle character may wander next: anywhere in the breakout room they should be idling in. */
  private wanderTilesFor(ch: Character): Array<{ col: number; row: number }> {
    const room = this.idleRoomFor(ch);
    return (room === undefined ? undefined : this.idleTilesByRoom.get(room)) ?? this.idleTiles;
  }

  /** Rooms idle agents hang about in (lounges, kitchen...), not halls and doorways. */
  private breakoutRooms(): number[] {
    return [...this.idleTilesByRoom].filter(([, tiles]) => tiles.length >= MIN_ROOM_TILES_TO_STAY).map(([room]) => room);
  }

  /** The room an idle character is in or heading for: their leisure spot's, their walk's end, or where they stand. */
  private idleDestinationRoom(ch: Character): number | undefined {
    const spot = ch.leisureSpotKey ? this.leisureSpots.get(ch.leisureSpotKey) : undefined;
    if (spot) return this.leisureSpotRoom(spot);
    const end = ch.state === CharacterState.WALK && ch.path.length > 0 ? ch.path[ch.path.length - 1] : { col: ch.tileCol, row: ch.tileRow };
    return this.tileRooms.get(`${end.col},${end.row}`);
  }

  /**
   * The breakout room an idle character should idle in, keeping idle agents spread across the rooms:
   * they stay in their current room while it has no more than its fair share, and otherwise (or when
   * they're due a roam, or on first load) head for the room with the fewest idle agents.
   */
  private idleRoomFor(ch: Character): number | undefined {
    const rooms = this.breakoutRooms();
    if (rooms.length === 0) return undefined;
    const headcount = new Map<number, number>(rooms.map((room) => [room, 0]));
    let idle = 1;
    for (const other of this.characters.values()) {
      if (other.id === ch.id || other.isActive || other.isSick || other.matrixEffect === 'despawn') continue;
      idle++;
      const room = this.idleDestinationRoom(other);
      if (room !== undefined && headcount.has(room)) headcount.set(room, headcount.get(room)! + 1);
    }
    const current = this.tileRooms.get(`${ch.tileCol},${ch.tileRow}`);
    const fairShare = Math.ceil(idle / rooms.length);
    const roaming = this.settling || this.roamingNext.has(ch.id);
    if (!roaming && current !== undefined && headcount.has(current) && headcount.get(current)! < fairShare) return current;
    // Least crowded room, somewhere new when roaming (ties broken at random)
    const candidates = rooms.length > 1 && roaming && !this.settling ? rooms.filter((room) => room !== current) : rooms;
    const fewest = Math.min(...candidates.map((room) => headcount.get(room)!));
    const quietest = candidates.filter((room) => headcount.get(room) === fewest);
    return quietest[Math.floor(Math.random() * quietest.length)];
  }

  /** Re-roll whether a character's next idle move may change room (after each move they make). */
  private rollRoaming(ch: Character): void {
    if (Math.random() < ROOM_CHANGE_CHANCE) this.roamingNext.add(ch.id);
    else this.roamingNext.delete(ch.id);
  }

  /** The floor tile just right of the boardroom whiteboard (or under its right edge if that's taken) */
  private findPresenterSpot(): { col: number; row: number } | null {
    const walkable = new Set(this.walkableTiles.map((t) => `${t.col},${t.row}`));
    for (const item of this.layout.furniture) {
      if (item.type !== 'WHITEBOARD') continue;
      const entry = getCatalogEntry(item.type);
      const width = entry?.footprintW ?? 1;
      const row = item.row + (entry?.footprintH ?? 1);
      for (const col of [item.col + width, item.col + width - 1]) {
        const key = `${col},${row}`;
        if (this.boardroomTiles.has(key) && walkable.has(key)) return { col, row };
      }
    }
    return null;
  }

  /** The floor tile in front of the middle of each boardroom wall board, in board order */
  private findInspectStops(): Array<{ col: number; row: number }> {
    const walkable = new Set(this.walkableTiles.map((t) => `${t.col},${t.row}`));
    const stops: Array<{ col: number; row: number }> = [];
    const boards = this.layout.furniture
      .filter((item) => INSPECTED_BOARD_TYPES.includes(item.type))
      .sort((a, b) => a.col - b.col);
    for (const item of boards) {
      const entry = getCatalogEntry(item.type);
      const width = entry?.footprintW ?? 1;
      const row = item.row + (entry?.footprintH ?? 1);
      const middle = item.col + Math.floor((width - 1) / 2);
      const cols = [middle, middle + 1, middle - 1, ...Array.from({ length: width }, (_, i) => item.col + i)];
      const col = cols.find((c) => this.boardroomTiles.has(`${c},${row}`) && walkable.has(`${c},${row}`));
      if (col !== undefined) stops.push({ col, row });
    }
    return stops;
  }

  /**
   * One agent working in the boardroom walks between the wall boards studying them; with two or
   * more, one of them presents at the whiteboard. They keep their chair and just stand at the board.
   */
  private assignBoardroomRoles(): void {
    const working = [...this.characters.values()].filter(
      (ch) => ch.isActive && !ch.matrixEffect && !!ch.seatId && this.seatWorkplaces.get(ch.seatId) === 'boardroom',
    );
    const presenter = working.length >= 2 && this.presenterSpot
      ? working.find((ch) => ch.boardroomRole === 'presenter') ?? working.reduce((a, b) => (b.id < a.id ? b : a))
      : undefined;
    const inspector = working.length === 1 && this.inspectStops.length > 0 ? working[0] : undefined;
    for (const ch of this.characters.values()) {
      const role = ch === presenter ? 'presenter' : ch === inspector ? 'inspector' : null;
      if (role !== 'inspector') this.inspecting.delete(ch.id);
      if (ch.boardroomRole === role) continue;
      ch.boardroomRole = role;
      if (role === 'inspector') this.inspecting.set(ch.id, { stop: Math.floor(Math.random() * this.inspectStops.length), timer: this.inspectTime() });
      if (ch.state === CharacterState.TYPE) {
        // Stand up so the idle handler walks to the board (or back to the chair)
        ch.state = CharacterState.IDLE;
        ch.frame = 0;
        ch.frameTimer = 0;
      }
    }
  }

  private inspectTime(): number {
    return INSPECT_MIN_SEC + Math.random() * (INSPECT_MAX_SEC - INSPECT_MIN_SEC);
  }

  /** Once an inspector has studied a board long enough, send them on to the next one. */
  private moveInspectors(dt: number): void {
    for (const [id, visit] of this.inspecting) {
      const ch = this.characters.get(id);
      // The clock only runs once they've reached the board
      if (!ch || ch.state !== CharacterState.TYPE) continue;
      visit.timer -= dt;
      if (visit.timer > 0) continue;
      visit.stop = (visit.stop + 1) % this.inspectStops.length;
      visit.timer = this.inspectTime();
      // Stand up so the idle handler walks them over to it
      ch.state = CharacterState.IDLE;
      ch.frame = 0;
      ch.frameTimer = 0;
    }
  }

  /**
   * Seats as a character's FSM sees them: the presenter's seat is the spot at the whiteboard, and
   * an inspector's is in front of the board they're studying, facing it.
   */
  private seatsFor(ch: Character): Map<string, Seat> {
    const visit = this.inspecting.get(ch.id);
    const spot = ch.boardroomRole === 'presenter' ? this.presenterSpot : visit ? this.inspectStops[visit.stop] : null;
    if (!spot || !ch.seatId) return this.seats;
    const chair = this.seats.get(ch.seatId);
    if (!chair) return this.seats;
    return new Map(this.seats).set(ch.seatId, {
      ...chair,
      seatCol: spot.col,
      seatRow: spot.row,
      facingDir: ch.boardroomRole === 'presenter' ? Direction.DOWN : Direction.UP,
    });
  }

  /** Work seats per room: every boardroom chair, plus PC desks in the main and overflow offices */
  private buildFrontScreenSeats(): Set<string> {
    const frontScreens = this.getElectronicsTiles(true);
    const seats = new Set<string>();
    for (const [uid, workplace] of this.seatWorkplaces) {
      const seat = this.seats.get(uid);
      if (workplace !== 'boardroom' && seat && this.seatFacesPC(seat, frontScreens)) seats.add(uid);
    }
    return seats;
  }

  /**
   * Whenever an office has agents working, at least one sits at a computer whose screen faces the
   * camera, swapping seats with an idle agent if need be. Once someone is, nobody is shuffled.
   */
  private seatWorkersAtFrontScreens(): void {
    for (const workplace of ['main', 'overflow'] as const) {
      const working = [...this.characters.values()].filter(
        (ch) => ch.isActive && !ch.matrixEffect && !!ch.seatId && this.seatWorkplaces.get(ch.seatId) === workplace,
      );
      if (!working.length || working.some((ch) => this.frontScreenSeats.has(ch.seatId!))) continue;
      // Always the same agent, so seats don't flip between workers.
      const worker = working.reduce((a, b) => (b.id < a.id ? b : a));
      const target = [...this.frontScreenSeats].find((uid) => {
        if (this.seatWorkplaces.get(uid) !== workplace) return false;
        const holder = [...this.characters.values()].find((other) => other.seatId === uid);
        return !holder || !holder.isActive;
      });
      if (!target) continue;
      const holder = [...this.characters.values()].find((other) => other.seatId === target);
      const oldSeat = worker.seatId!;
      if (holder) {
        holder.seatId = oldSeat;
      } else {
        this.seats.get(oldSeat)!.assigned = false;
        this.seats.get(target)!.assigned = true;
      }
      worker.seatId = target;
      if (worker.state === CharacterState.TYPE) {
        // Stand up so the idle handler walks to the new desk
        worker.state = CharacterState.IDLE;
        worker.frame = 0;
        worker.frameTimer = 0;
      }
      this.rebuildFurnitureInstances();
    }
  }

  private buildSeatWorkplaces(): Map<string, Workplace> {
    const electronicsTiles = this.getElectronicsTiles();
    const workplaces = new Map<string, Workplace>();
    for (const [uid, seat] of this.seats) {
      if (this.boardroomTiles.has(`${seat.seatCol},${seat.seatRow}`)) {
        workplaces.set(uid, 'boardroom');
      } else if (this.officeTiles.has(`${seat.seatCol},${seat.seatRow}`) && this.seatFacesPC(seat, electronicsTiles)) {
        workplaces.set(uid, uid.startsWith(OVERFLOW_OFFICE_UID_PREFIX) ? 'overflow' : 'main');
      }
    }
    return workplaces;
  }

  /** Set the room an agent works from; they move seats next time they need one */
  setAgentWorkplace(id: number, workplace: Workplace): void {
    const ch = this.characters.get(id);
    if (!ch || ch.workplace === workplace) return;
    ch.workplace = workplace;
    ch.sickSettled = false;
    this.sickTargets.delete(ch.id);
  }

  /**
   * Give a working or sick agent a seat in their own room. When the room is full,
   * take the seat of an idle agent (or, for a working agent, a sick one).
   */
  private ensureWorkSeat(ch: Character): void {
    if (ch.seatId && this.seatWorkplaces.get(ch.seatId) === ch.workplace) return;
    const roomSeats = new Set(
      [...this.seatWorkplaces].filter(([, workplace]) => workplace === ch.workplace).map(([uid]) => uid),
    );
    // Front-facing screens first, so a lone worker is seen at their computer.
    const free = [...roomSeats].filter((uid) => !this.seats.get(uid)?.assigned);
    let seatId = free.find((uid) => this.frontScreenSeats.has(uid)) ?? free[0];
    if (seatId) {
      this.seats.get(seatId)!.assigned = true;
    } else {
      const holders = [...this.characters.values()].filter(
        (other) => other !== ch && !other.isActive && other.seatId !== null && roomSeats.has(other.seatId),
      );
      const victim = holders.find((other) => !other.isSick) ?? (ch.isActive ? holders.find((other) => other.isSick) : undefined);
      if (!victim?.seatId) return;
      // The seat stays assigned and passes straight to ch; the victim gets any spare non-work seat
      seatId = victim.seatId;
      victim.seatId = null;
      victim.sickSettled = false;
      this.sickTargets.delete(victim.id);
      const spare = [...this.seats].find(([uid, seat]) => !seat.assigned && !this.seatWorkplaces.has(uid));
      if (spare) {
        spare[1].assigned = true;
        victim.seatId = spare[0];
      }
    }

    if (ch.seatId) {
      const old = this.seats.get(ch.seatId);
      if (old) old.assigned = false;
    }
    ch.seatId = seatId;
    ch.sickSettled = false;
    this.sickTargets.delete(ch.id);
    if (ch.state === CharacterState.TYPE) {
      // Sitting at the wrong desk: stand up so the idle handler walks to the new one
      ch.state = CharacterState.IDLE;
      ch.frame = 0;
      ch.frameTimer = 0;
    }
    if (ch.isActive) this.rebuildFurnitureInstances();
  }

  /** Sick agents got ill at work: stand beside their seat in their own room */
  private sendSickToWorkplace(ch: Character): void {
    this.ensureWorkSeat(ch);
    // Stand by their own seat, or anywhere in their room if workers have taken every seat
    const anchorId =
      ch.seatId && this.seatWorkplaces.get(ch.seatId) === ch.workplace
        ? ch.seatId
        : [...this.seatWorkplaces].find(([, workplace]) => workplace === ch.workplace)?.[0];
    const seat = anchorId ? this.seats.get(anchorId) : undefined;
    if (!seat) return; // layout has no such room: wander instead

    const taken = new Set([...this.sickTargets].filter(([id]) => id !== ch.id).map(([, key]) => key));
    let target: { col: number; row: number } | null = null;
    let targetDist = Infinity;
    for (const tile of this.walkableTiles) {
      const key = `${tile.col},${tile.row}`;
      if (!this.officeTiles.has(key) || taken.has(key)) continue;
      const dist = Math.hypot(tile.col - seat.seatCol, tile.row - seat.seatRow);
      if (dist < targetDist) {
        target = tile;
        targetDist = dist;
      }
    }
    if (!target) return;

    this.sickTargets.set(ch.id, `${target.col},${target.row}`);
    if (ch.tileCol === target.col && ch.tileRow === target.row) {
      ch.sickSettled = true;
      return;
    }
    const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, this.tileMap, this.blockedTiles);
    if (path.length === 0) return;
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    ch.sickSettled = true;
  }

  /** Find the area label assigned to a seat's tile, or null. Public for e2e
   *  observability (getAgentSeats hook reads a seated agent's area). */
  seatZone(uid: string): string | null {
    const seat = this.seats.get(uid);
    if (!seat) return null;
    const tiles = this.layout.areaTiles;
    if (!tiles || tiles.length === 0) return null;
    const idx = seat.seatRow * this.layout.cols + seat.seatCol;
    if (idx < 0 || idx >= tiles.length) return null;
    return tiles[idx] ?? null;
  }

  /**
   * Random-pick a seat from a candidate list, biased toward seats that face an
   * electronics tile. Returns null when the candidate list is empty.
   */
  private pickFromSeats(seatUids: string[], electronicsTiles: Set<string>): string | null {
    if (seatUids.length === 0) return null;
    const pcSeats: string[] = [];
    const otherSeats: string[] = [];
    for (const uid of seatUids) {
      const seat = this.seats.get(uid);
      if (!seat) continue;
      if (this.seatFacesPC(seat, electronicsTiles)) {
        pcSeats.push(uid);
      } else {
        otherSeats.push(uid);
      }
    }
    if (pcSeats.length > 0) return pcSeats[Math.floor(Math.random() * pcSeats.length)];
    if (otherSeats.length > 0) return otherSeats[Math.floor(Math.random() * otherSeats.length)];
    return null;
  }

  /**
   * 3-stage seat picker for top-level agents.
   *
   *   Stage 1: If `folderName` is given and `areaMappings[folderName]` lists
   *            Area labels, prefer free seats whose tile is labeled with one
   *            of those areas.
   *   Stage 2: Prefer free seats whose tile has NO area label (unzoned).
   *   Stage 3: Any free seat.
   *
   * Each stage routes through `pickFromSeats` for the PC-bias rule. Returns
   * null only when every seat is already occupied. Passing `undefined`
   * preserves pre-Areas single-stage behavior (skips Stage 1; Stage 2 picks
   * unzoned seats from a layout without `areaTiles`, which is every seat).
   */
  private findFreeSeat(folderName?: string): string | null {
    const electronicsTiles = this.getElectronicsTiles();
    const freeSeats: string[] = [];
    for (const [uid, seat] of this.seats) {
      if (!seat.assigned) freeSeats.push(uid);
    }
    if (freeSeats.length === 0) return null;

    const areaLabels = folderName ? this.areaMappings[folderName] : undefined;

    // Stage 1 — in-area seats for the folder's mapped Area labels.
    if (areaLabels && areaLabels.length > 0) {
      const wanted = new Set(areaLabels);
      const inArea = freeSeats.filter((uid) => {
        const label = this.seatZone(uid);
        return label !== null && wanted.has(label);
      });
      const pick = this.pickFromSeats(inArea, electronicsTiles);
      if (pick) return pick;
    }

    // Stage 2 — unzoned seats (no area label, or layout has no areas at all).
    const unzoned = freeSeats.filter((uid) => this.seatZone(uid) === null);
    const pick2 = this.pickFromSeats(unzoned, electronicsTiles);
    if (pick2) return pick2;

    // Stage 3 — any free seat.
    return this.pickFromSeats(freeSeats, electronicsTiles);
  }

  /** Closest walkable tile to (col,row) not occupied by another character, or null. */
  private closestFreeWalkableTile(col: number, row: number): { col: number; row: number } | null {
    const occupied = new Set<string>();
    for (const ch of this.characters.values()) {
      occupied.add(`${ch.tileCol},${ch.tileRow}`);
    }
    let best: { col: number; row: number } | null = null;
    let bestDist = Infinity;
    for (const tile of this.walkableTiles) {
      if (occupied.has(`${tile.col},${tile.row}`)) continue;
      const d = Math.abs(tile.col - col) + Math.abs(tile.row - row);
      if (d < bestDist) {
        best = tile;
        bestDist = d;
      }
    }
    return best;
  }

  /**
   * Pick a diverse palette for a new agent based on currently active agents.
   * First 6 agents each get a unique skin (random order). Beyond 6, skins
   * repeat in balanced rounds with a random hue shift (≥45°).
   */
  private pickDiversePalette(): { palette: number; hueShift: number } {
    // Count how many non-sub-agents use each base palette (0-5)
    const paletteCount = getLoadedCharacterCount();
    const counts = new Array(paletteCount).fill(0) as number[];
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue;
      if (ch.palette < paletteCount) counts[ch.palette]++;
    }
    return pickDiversePalette(paletteCount, counts);
  }

  addAgent(
    id: number,
    preferredPalette?: number,
    preferredHueShift?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    folderName?: string,
    nearAgentId?: number,
  ): void {
    if (this.characters.has(id)) return;

    let palette: number;
    let hueShift: number;
    if (preferredPalette !== undefined) {
      palette = preferredPalette;
      hueShift = preferredHueShift ?? 0;
    } else {
      const pick = this.pickDiversePalette();
      palette = pick.palette;
      hueShift = pick.hueShift;
    }

    // Try preferred seat first, then (for teammates) the seat closest to the
    // anchor agent, then any free seat. anchorTile resolves to the anchor's SEAT
    // (stable from creation) rather than its live tile, so a teammate placed while
    // the lead is still walking to its seat still clusters around the final seat.
    const anchor = nearAgentId !== undefined ? this.characters.get(nearAgentId) : undefined;
    const anchorAt = anchorTile(anchor, this.seats);
    let seatId: string | null = null;
    if (preferredSeatId && this.seats.has(preferredSeatId)) {
      const seat = this.seats.get(preferredSeatId)!;
      if (!seat.assigned) {
        seatId = preferredSeatId;
      }
    }
    if (!seatId && anchorAt) {
      seatId = closestFreeSeat(this.seats, anchorAt.col, anchorAt.row);
    }
    if (!seatId) {
      seatId = this.findFreeSeat(folderName);
    }

    let ch: Character;
    if (seatId) {
      const seat = this.seats.get(seatId)!;
      seat.assigned = true;
      ch = createCharacter(id, palette, seatId, seat, hueShift);
      this.moveCharacterToSpawn(ch);
    } else {
      ch = createCharacter(id, palette, null, null, hueShift);
      this.moveCharacterToSpawn(ch);
    }

    if (folderName) {
      ch.folderName = folderName;
    }
    if (!skipSpawnEffect) {
      startMatrixEffect(ch, 'spawn');
    }
    this.characters.set(id, ch);
  }

  /**
   * Put characters straight where they would end up (desk, leisure spot, sick spot or a
   * wander tile) instead of walking there from the entrance. Used on first page load.
   */
  settleAgents(ids: Iterable<number>): void {
    const occupied = this.occupiedTiles();
    const tick = (ch: Character) => {
      const before = this.restingTileKey(ch);
      this.withOwnSeatUnblocked(ch, () =>
        updateCharacter(ch, 0, this.freeWanderTilesFor(ch, occupied), this.seatsFor(ch), this.tileMap, this.blockedTiles, this.leisure),
      );
      this.moveOccupant(occupied, before, this.restingTileKey(ch));
    };
    // Workers first so idle agents don't claim sofa seats that are someone's desk
    const rank = (ch: Character) => (ch.isActive ? 0 : ch.isSick ? 1 : 2);
    const chars = [...ids]
      .map((id) => this.characters.get(id))
      .filter((ch): ch is Character => !!ch)
      .sort((a, b) => rank(a) - rank(b));

    this.assignBoardroomRoles();
    this.settling = true;
    for (const ch of chars) {
      // Let the normal logic pick a destination and path...
      if (ch.isActive) {
        this.ensureWorkSeat(ch);
      } else if (ch.isSick) {
        this.sendSickToWorkplace(ch);
      } else {
        ch.wanderTimer = 0;
      }
      for (let attempt = 0; attempt < 5 && ch.state === CharacterState.IDLE; attempt++) {
        if (ch.isSick && ch.sickSettled) break;
        tick(ch);
        if (!ch.isActive) ch.wanderTimer = 0;
      }
      if (ch.state !== CharacterState.WALK || ch.path.length === 0) continue;

      // ...then jump to the end of it and run the usual arrival (sit, play, or stand)
      const end = ch.path[ch.path.length - 1];
      ch.tileCol = end.col;
      ch.tileRow = end.row;
      ch.x = end.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = end.row * TILE_SIZE + TILE_SIZE / 2;
      ch.path = [];
      ch.moveProgress = 0;
      tick(ch);
      // tick() changed the state; TypeScript still thinks it is WALK
      if ((ch.state as string) === CharacterState.IDLE && !ch.isSick) ch.dir = Direction.DOWN;
    }
    this.settling = false;
  }

  /** Where a character is and what they're doing, to put them back after a reload; null mid-spawn or leaving. */
  snapshotCharacter(id: number): CharacterSnapshot | null {
    const ch = this.characters.get(id);
    if (!ch || ch.matrixEffect) return null;
    const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined;
    const atDesk = ch.state === CharacterState.TYPE && !ch.joust && !!seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow;
    // Mid-walk (or rolling about on a chair) they're saved where they were heading
    const end = ch.joust ? (seat ? { col: seat.seatCol, row: seat.seatRow } : { col: ch.tileCol, row: ch.tileRow })
      : ch.state === CharacterState.WALK && ch.path.length > 0 ? ch.path[ch.path.length - 1]
      : { col: ch.tileCol, row: ch.tileRow };
    return {
      seatId: ch.seatId,
      col: end.col,
      row: end.row,
      dir: ch.dir,
      activity: atDesk || ch.joust ? 'desk' : ch.state === CharacterState.LEISURE ? 'leisure' : 'other',
      leisureSpotKey: ch.state === CharacterState.LEISURE ? ch.leisureSpotKey : null,
      leisureTimer: ch.leisureTimer,
    };
  }

  /**
   * Put a just-added character back where a snapshot says they were: working at their desk, at their
   * leisure spot, or standing where they were. False when that no longer fits (they've started or
   * stopped work, the spot's taken, the floor's gone), leaving them for settleAgents to place.
   */
  restoreCharacter(id: number, snapshot: CharacterSnapshot): boolean {
    const ch = this.characters.get(id);
    if (!ch || ch.isSick) return false;
    const place = (col: number, row: number, state: CharacterState, dir: Direction) => {
      ch.tileCol = col;
      ch.tileRow = row;
      ch.x = col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = row * TILE_SIZE + TILE_SIZE / 2;
      ch.path = [];
      ch.moveProgress = 0;
      ch.state = state;
      ch.dir = dir;
      ch.frame = 0;
      ch.frameTimer = 0;
    };
    const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined;
    if (ch.isActive) {
      // Back at the same desk, if they're still working and it's in the room they work from
      if (snapshot.activity !== 'desk' || !seat || ch.seatId !== snapshot.seatId || this.seatWorkplaces.get(ch.seatId!) !== ch.workplace) {
        return false;
      }
      place(seat.seatCol, seat.seatRow, CharacterState.TYPE, seat.facingDir);
      this.rebuildFurnitureInstances();
      return true;
    }
    if (snapshot.activity === 'leisure' && snapshot.leisureSpotKey) {
      const spot = this.leisureSpots.get(snapshot.leisureSpotKey);
      // The decks are only manned while music plays
      if (spot?.kind === 'dj' && !getMusicAudio().playing) return false;
      if (!spot || this.leisureClaims.has(spot.key) || spot.col !== snapshot.col || spot.row !== snapshot.row) return false;
      this.leisureClaims.set(spot.key, ch.id);
      ch.leisureSpotKey = spot.key;
      ch.leisureTimer = Math.max(snapshot.leisureTimer, 1);
      place(spot.col, spot.row, CharacterState.LEISURE, spot.facingDir);
      return true;
    }
    if (
      snapshot.activity === 'other' &&
      !this.backstageTiles.has(`${snapshot.col},${snapshot.row}`) &&
      !this.gameSpotTiles.has(`${snapshot.col},${snapshot.row}`) &&
      ![...this.characters.values()].some((other) => other !== ch && this.restingTileKey(other) === `${snapshot.col},${snapshot.row}`) &&
      isWalkable(snapshot.col, snapshot.row, this.tileMap, this.blockedTiles)
    ) {
      place(snapshot.col, snapshot.row, CharacterState.IDLE, snapshot.dir);
      ch.wanderTimer = 1 + Math.random() * 4;
      return true;
    }
    return false;
  }

  /** The tile a character is stopped on, or will stop on: the end of their walk while walking */
  private restingTileKey(ch: Character): string {
    const end = ch.state === CharacterState.WALK && ch.path.length > 0 ? ch.path[ch.path.length - 1] : { col: ch.tileCol, row: ch.tileRow };
    return `${end.col},${end.row}`;
  }

  /** How many characters are stopped on (or heading to stop on) each tile */
  private occupiedTiles(): Map<string, number> {
    const occupied = new Map<string, number>();
    for (const ch of this.characters.values()) {
      if (ch.matrixEffect === 'despawn') continue;
      const key = this.restingTileKey(ch);
      occupied.set(key, (occupied.get(key) ?? 0) + 1);
    }
    return occupied;
  }

  private moveOccupant(occupied: Map<string, number>, from: string, to: string): void {
    if (from === to) return;
    occupied.set(from, Math.max(0, (occupied.get(from) ?? 1) - 1));
    occupied.set(to, (occupied.get(to) ?? 0) + 1);
  }

  /**
   * Where an idle character may wander to: their room's wander tiles, less any where someone else is
   * standing or heading. Walkers can brush past each other; standers and dancers keep their own tile.
   */
  private freeWanderTilesFor(ch: Character, occupied: Map<string, number>): Array<{ col: number; row: number }> {
    const tiles = this.wanderTilesFor(ch);
    const own = this.restingTileKey(ch);
    const free = tiles.filter((tile) => {
      const key = `${tile.col},${tile.row}`;
      return (occupied.get(key) ?? 0) - (key === own ? 1 : 0) <= 0;
    });
    return free.length > 0 ? free : tiles;
  }

  // ── Greeter ───────────────────────────────────────────────────
  // The Intro is diegetic: a char_0 character stands near the office's
  // bottom-left corner and "speaks" the tour through a DOM bubble
  // (IntroBubble). It is not an agent — see the `greeter` field.

  /** Spawn the greeter near the office's bottom-left corner: target tile
   *  GREETER_TILE_MARGIN in from the left and bottom edges, falling
   *  back to the closest walkable tile when the target is a seat, furniture,
   *  a wall, or VOID (seat tiles are in blockedTiles, so closestFreeWalkableTile
   *  covers every one of those). Idempotent; a remount mid-despawn (StrictMode)
   *  revives it. */
  spawnGreeter(): void {
    this.greeterCameraCancelled = false;
    if (this.greeter) {
      if (this.greeter.matrixEffect === 'despawn') startMatrixEffect(this.greeter, 'spawn');
      return;
    }
    const spawn = this.closestFreeWalkableTile(
      GREETER_TILE_MARGIN,
      this.layout.rows - 1 - GREETER_TILE_MARGIN,
    );
    if (!spawn) return; // no walkable tile — IntroBubble falls back to a fixed panel
    const ch = createCharacter(GREETER_ID, 0, null, null, 0);
    ch.isGreeter = true;
    ch.state = CharacterState.IDLE;
    ch.isActive = false;
    ch.dir = Direction.DOWN;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    startMatrixEffect(ch, 'spawn');
    this.greeter = ch;
  }

  /** Start the greeter's despawn effect and release the greeter camera. The
   *  character is dropped once the effect finishes (see update()).
   *  Idempotent — every close path (answer, Escape, hooksStatus) funnels here. */
  despawnGreeter(): void {
    this.greeterCameraTarget = null;
    this.greeterCameraCancelled = false;
    if (!this.greeter || this.greeter.matrixEffect === 'despawn') return;
    startMatrixEffect(this.greeter, 'despawn');
  }

  /** Per-frame update from the bubble overlay; ignored once the user panned. */
  setGreeterCameraTarget(p: { x: number; y: number }): void {
    if (!this.greeterCameraCancelled) this.greeterCameraTarget = p;
  }

  /** Manual pan during the ask: stop re-centering until the next spawn. */
  cancelGreeterCamera(): void {
    this.greeterCameraTarget = null;
    this.greeterCameraCancelled = true;
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    if (ch.matrixEffect === 'despawn') return; // already despawning
    // Free seat and clear selection immediately
    this.releaseLeisureSpot(ch);
    this.sickTargets.delete(ch.id);
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId);
      if (seat) seat.assigned = false;
    }
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
    // Start despawn animation instead of immediate delete
    startMatrixEffect(ch, 'despawn');
    ch.bubbleType = null;
  }

  /** Find seat uid at a given tile position, or null */
  getSeatAtTile(col: number, row: number): string | null {
    for (const [uid, seat] of this.seats) {
      if (seat.seatCol === col && seat.seatRow === row) return uid;
    }
    return null;
  }

  /** Reassign an agent from their current seat to a new seat */
  reassignSeat(agentId: number, seatId: string): void {
    const ch = this.characters.get(agentId);
    if (!ch) return;
    // Unassign old seat
    if (ch.seatId) {
      const old = this.seats.get(ch.seatId);
      if (old) old.assigned = false;
    }
    // Assign new seat
    const seat = this.seats.get(seatId);
    if (!seat || seat.assigned) return;
    seat.assigned = true;
    ch.seatId = seatId;
    // Pathfind to new seat (unblock own seat tile for this query)
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
    );
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else {
      // Already at seat or no path — sit down
      ch.state = CharacterState.TYPE;
      ch.dir = seat.facingDir;
      ch.frame = 0;
      ch.frameTimer = 0;
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
      }
    }
  }

  /**
   * Move a just-linked teammate to the free seat closest to its lead, so teams
   * cluster. Only moves when that seat is strictly closer than the teammate's
   * current one — a teammate created as a plain external agent (seated by an
   * arbitrary findFreeSeat) and tagged as a teammate only after tag discovery
   * would otherwise keep its arbitrary seat, unlike an inline teammate seated
   * next to the lead at creation.
   */
  private reseatNextToLead(teammateId: number, leadId: number): void {
    const teammate = this.characters.get(teammateId);
    const lead = this.characters.get(leadId);
    if (!teammate || !lead) return;
    const anchorAt = anchorTile(lead, this.seats);
    if (!anchorAt) return;
    const target = closestFreeSeat(this.seats, anchorAt.col, anchorAt.row);
    if (!target || target === teammate.seatId) return;
    const targetSeat = this.seats.get(target)!;
    const targetDist =
      Math.abs(targetSeat.seatCol - anchorAt.col) + Math.abs(targetSeat.seatRow - anchorAt.row);
    const currentSeat = teammate.seatId ? this.seats.get(teammate.seatId) : undefined;
    const currentDist = currentSeat
      ? Math.abs(currentSeat.seatCol - anchorAt.col) + Math.abs(currentSeat.seatRow - anchorAt.row)
      : Infinity;
    if (targetDist < currentDist) {
      this.reassignSeat(teammateId, target);
    }
  }

  /** Send an agent back to their currently assigned seat */
  sendToSeat(agentId: number): void {
    const ch = this.characters.get(agentId);
    if (!ch || !ch.seatId) return;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return;
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
    );
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else {
      // Already at seat — sit down
      ch.state = CharacterState.TYPE;
      ch.dir = seat.facingDir;
      ch.frame = 0;
      ch.frameTimer = 0;
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
      }
    }
  }

  /** Walk an agent to an arbitrary walkable tile (right-click command) */
  walkToTile(agentId: number, col: number, row: number): boolean {
    const ch = this.characters.get(agentId);
    if (!ch || ch.isSubagent) return false;
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) {
      // Also allow walking to own seat tile (blocked for others but not self)
      const key = this.ownSeatKey(ch);
      if (!key || key !== `${col},${row}`) return false;
    }
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles),
    );
    if (path.length === 0) return false;
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  /** Create a sub-agent character with the parent's palette. Returns the sub-agent ID. */
  addSubagent(parentAgentId: number, parentToolId: string): number {
    const key = `${parentAgentId}:${parentToolId}`;
    if (this.subagentIdMap.has(key)) return this.subagentIdMap.get(key)!;

    const id = this.nextSubagentId--;
    const parentCh = this.characters.get(parentAgentId);
    const palette = parentCh ? parentCh.palette : 0;
    const hueShift = parentCh ? parentCh.hueShift : 0;

    // Find the closest walkable tile to the parent, avoiding tiles occupied by other characters
    const parentCol = parentCh ? parentCh.tileCol : 0;
    const parentRow = parentCh ? parentCh.tileRow : 0;
    let spawn = { col: parentCol, row: parentRow };
    if (this.walkableTiles.length > 0) {
      spawn = this.closestFreeWalkableTile(parentCol, parentRow) ?? this.walkableTiles[0];
    }

    const ch = createCharacter(id, palette, null, null, hueShift);
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    // Face the same direction as the parent agent
    if (parentCh) ch.dir = parentCh.dir;
    ch.isSubagent = true;
    ch.parentAgentId = parentAgentId;
    startMatrixEffect(ch, 'spawn');
    this.characters.set(id, ch);

    this.subagentIdMap.set(key, id);
    this.subagentMeta.set(id, { parentAgentId, parentToolId });
    return id;
  }

  /** Remove a specific sub-agent character and free its seat */
  removeSubagent(parentAgentId: number, parentToolId: string): void {
    const key = `${parentAgentId}:${parentToolId}`;
    const id = this.subagentIdMap.get(key);
    if (id === undefined) return;

    const ch = this.characters.get(id);
    if (ch) {
      if (ch.matrixEffect === 'despawn') {
        // Already despawning — just clean up maps
        this.subagentIdMap.delete(key);
        this.subagentMeta.delete(id);
        return;
      }
      if (ch.seatId) {
        const seat = this.seats.get(ch.seatId);
        if (seat) seat.assigned = false;
      }
      // Start despawn animation — keep character in map for rendering
      startMatrixEffect(ch, 'despawn');
      ch.bubbleType = null;
    }
    // Clean up tracking maps immediately so keys don't collide
    this.subagentIdMap.delete(key);
    this.subagentMeta.delete(id);
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
  }

  /** Remove all sub-agents belonging to a parent agent */
  removeAllSubagents(parentAgentId: number): void {
    const toRemove: string[] = [];
    for (const [key, id] of this.subagentIdMap) {
      const meta = this.subagentMeta.get(id);
      if (meta && meta.parentAgentId === parentAgentId) {
        const ch = this.characters.get(id);
        if (ch) {
          if (ch.matrixEffect === 'despawn') {
            // Already despawning — just clean up maps
            this.subagentMeta.delete(id);
            toRemove.push(key);
            continue;
          }
          if (ch.seatId) {
            const seat = this.seats.get(ch.seatId);
            if (seat) seat.assigned = false;
          }
          // Start despawn animation
          startMatrixEffect(ch, 'despawn');
          ch.bubbleType = null;
        }
        this.subagentMeta.delete(id);
        if (this.selectedAgentId === id) this.selectedAgentId = null;
        if (this.cameraFollowId === id) this.cameraFollowId = null;
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      this.subagentIdMap.delete(key);
    }
  }

  /** Look up the sub-agent character ID for a given parent+toolId, or null */
  getSubagentId(parentAgentId: number, parentToolId: string): number | null {
    return this.subagentIdMap.get(`${parentAgentId}:${parentToolId}`) ?? null;
  }

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.isActive = active;
      // A jouster rolls home along their own path when the joust ends
      if (!active && !ch.joust) {
        // Sentinel -1: signals turn just ended, skip next seat rest timer.
        // Prevents the WALK handler from setting a 2-4 min rest on arrival.
        ch.seatTimer = -1;
        ch.path = [];
        ch.moveProgress = 0;
      }
      this.rebuildFurnitureInstances();
    }
  }

  /** Rebuild furniture instances with auto-state applied (agents working at their desks turn electronics ON) */
  private rebuildFurnitureInstances(): void {
    // Collect tiles where working agents face desks. A computer only comes on once its agent has sat
    // down to it (not while they're still walking over); this runs every animation frame, so promptly.
    const autoOnTiles = new Set<string>();
    // The same, for agents waiting on a long tool call: their computers show an egg timer
    const waitingTiles = new Set<string>();
    const now = Date.now();
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.seatId || ch.state !== CharacterState.TYPE) continue;
      const seat = this.seats.get(ch.seatId);
      // Off jousting, their computer keeps its egg timer until they head home
      const jousting = !!ch.joust && ch.joust.phase !== 'roll-home';
      if (!seat || (!ch.joust && (ch.tileCol !== seat.seatCol || ch.tileRow !== seat.seatRow))) continue;
      const waiting = jousting || isWaiting(ch, now);
      const mark = (key: string) => {
        autoOnTiles.add(key);
        if (waiting) waitingTiles.add(key);
      };
      // Find the desk tile(s) the agent faces from their seat
      const dCol =
        seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
      // Check tiles in the facing direction (desk could be 1-3 tiles deep)
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
        const tileCol = seat.seatCol + dCol * d;
        const tileRow = seat.seatRow + dRow * d;
        mark(`${tileCol},${tileRow}`);
      }
      // Also check tiles to the sides of the facing direction (desks can be wide)
      for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
        const baseCol = seat.seatCol + dCol * d;
        const baseRow = seat.seatRow + dRow * d;
        if (dCol !== 0) {
          // Facing left/right: check tiles above and below
          mark(`${baseCol},${baseRow - 1}`);
          mark(`${baseCol},${baseRow + 1}`);
        } else {
          // Facing up/down: check tiles left and right
          mark(`${baseCol - 1},${baseRow}`);
          mark(`${baseCol + 1},${baseRow}`);
        }
      }
    }

    if (autoOnTiles.size === 0) {
      this.furniture = layoutToFurnitureInstances(this.layout.furniture);
      return;
    }

    // Build modified furniture list with auto-state and animation applied
    const animFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    const waitingUids = new Set<string>();
    const modifiedFurniture: PlacedFurniture[] = this.layout.furniture.map((item) => {
      const entry = getCatalogEntry(item.type);
      if (!entry) return item;
      // Check if any tile of this furniture overlaps an auto-on tile
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          if (autoOnTiles.has(`${item.col + dc},${item.row + dr}`)) {
            let onType = getOnStateType(item.type);
            if (onType !== item.type) {
              if (waitingTiles.size && overlaps(item, entry, waitingTiles)) waitingUids.add(item.uid);
              // Check if the on-state type has animation frames
              const frames = getAnimationFrames(onType);
              if (frames && frames.length > 1) {
                const frameIdx = animFrame % frames.length;
                onType = frames[frameIdx];
              }
              return { ...item, type: onType };
            }
            return item;
          }
        }
      }
      return item;
    });

    this.furniture = layoutToFurnitureInstances(modifiedFurniture);
    for (const instance of this.furniture) {
      if (instance.uid && waitingUids.has(instance.uid)) instance.waiting = true;
    }
  }

  setAgentTool(id: number, tool: string | null): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.currentTool = tool;
    }
  }

  showPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = 'permission';
      ch.bubbleTimer = 0;
    }
  }

  clearPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch && ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    }
  }

  showWaitingBubble(id: number, awaitingInput = false): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = 'waiting';
      ch.waitingAwaitingInput = awaitingInput;
      ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
    }
  }

  /** Dismiss bubble on click — permission: instant, waiting: quick fade */
  dismissBubble(id: number): void {
    const ch = this.characters.get(id);
    if (!ch || !ch.bubbleType) return;
    if (ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    } else if (ch.bubbleType === 'waiting') {
      // Trigger immediate fade (0.3s remaining)
      ch.bubbleTimer = Math.min(ch.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC);
    }
  }

  // ── Pets ──────────────────────────────────────────────────────

  /**
   * Add a pet to the live runtime. Spawns at a uniformly-random walkable tile.
   * Mirror in `this.layout.pets` so debounced saveLayout serialises the roster.
   * Bounds-checks petType against the loaded sprite count to defend against stale layouts.
   */
  addPet(placedPet: PlacedPet): void {
    // Defensive guards (upstream 5e6c0a0)
    if (
      typeof placedPet.id !== 'string' ||
      placedPet.id.length === 0 ||
      placedPet.id.length > MAX_PET_ID_LENGTH
    ) {
      return;
    }
    if (
      !Number.isInteger(placedPet.petType) ||
      placedPet.petType < 0 ||
      placedPet.petType >= getPetCount()
    ) {
      return;
    }
    if (this.pets.some((p) => p.id === placedPet.id)) return; // de-dupe
    if (this.walkableTiles.length === 0) return; // no spawn space — silently drop

    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
    const pet = createPet(placedPet.id, placedPet.petType, spawn.col, spawn.row);
    pet.name = getPetName(placedPet.petType);
    this.pets.push(pet);
    this.syncLayoutPets();
  }

  /** Remove a pet by id. Idempotent. */
  removePet(id: string): void {
    const before = this.pets.length;
    this.pets = this.pets.filter((p) => p.id !== id);
    if (this.pets.length !== before) {
      this.syncLayoutPets();
    }
  }

  /** Shallow snapshot for external consumers (renderer, hooks). */
  getPets(): Pet[] {
    return this.pets.slice();
  }

  /** Unique petType values currently placed. Used by the Pets toolbar to mark active rows. */
  getActivePetTypes(): number[] {
    const seen = new Set<number>();
    for (const p of this.pets) seen.add(p.petType);
    return Array.from(seen);
  }

  /**
   * Hit-test pets at a pixel world position. Sorts back-to-front (largest y wins on tie)
   * so the visually-frontmost pet receives the click.
   * Returns the pet id or null.
   */
  getPetAt(worldX: number, worldY: number): string | null {
    const ordered = this.pets.slice().sort((a, b) => b.y - a.y);
    for (const pet of ordered) {
      const left = pet.x - PET_HIT_HALF_WIDTH;
      const right = pet.x + PET_HIT_HALF_WIDTH;
      const top = pet.y - PET_HIT_HEIGHT;
      const bottom = pet.y;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return pet.id;
      }
    }
    return null;
  }

  /** Show the heart bubble on a pet for WAITING_BUBBLE_DURATION_SEC. */
  showPetBubble(petId: string): void {
    const pet = this.pets.find((p) => p.id === petId);
    if (!pet) return;
    pet.bubbleType = 'heart';
    pet.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
  }

  /** Dismiss the heart bubble on click; collapses timer to a fast fade. */
  dismissPetBubble(petId: string): void {
    const pet = this.pets.find((p) => p.id === petId);
    if (!pet || !pet.bubbleType) return;
    pet.bubbleTimer = Math.min(pet.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC);
  }

  /**
   * Reconcile `this.pets` to match the layout's placed-pet roster.
   * - Pets in layout but not in runtime → spawn via addPet().
   * - Pets in runtime but not in layout → remove.
   * - Pets in both → keep existing runtime state (position, FSM).
   *
   * Called from constructor and rebuildFromLayout. Always runs AFTER walkableTiles
   * is populated.
   */
  private rebuildPetsFromLayout(layout: OfficeLayout): void {
    const placed = layout.pets ?? [];
    const placedIds = new Set(placed.map((p) => p.id));

    // 1. Remove pets no longer in layout
    this.pets = this.pets.filter((p) => placedIds.has(p.id));

    // 2. Add pets that exist in layout but not in runtime
    const existingIds = new Set(this.pets.map((p) => p.id));
    for (const p of placed) {
      if (existingIds.has(p.id)) continue;
      this.addPet(p); // pushes onto this.pets, calls syncLayoutPets()
    }
    // syncLayoutPets() inside addPet keeps this.layout.pets coherent; one final
    // sync handles the removal-only branch where addPet was never called.
    this.syncLayoutPets();
  }

  /**
   * Re-export the current pet roster into `this.layout.pets`. Called only from
   * mutating methods (addPet / removePet / rebuildPetsFromLayout) — NEVER from
   * getLayout(), which runs on every render frame.
   */
  private syncLayoutPets(): void {
    this.layout.pets = this.pets.map((p) => ({ id: p.id, petType: p.petType }));
  }

  setTeamInfo(
    id: number,
    teamName?: string,
    agentName?: string,
    isTeamLead?: boolean,
    leadAgentId?: number,
    teamUsesTmux?: boolean,
  ): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    const wasUnlinked = ch.leadAgentId === undefined;
    ch.teamName = teamName;
    ch.agentName = agentName;
    ch.isTeamLead = isTeamLead;
    ch.leadAgentId = leadAgentId;
    if (teamUsesTmux !== undefined) {
      ch.teamUsesTmux = teamUsesTmux;
    }
    // A teammate is not a headless agent: clicking it focuses its lead's terminal.
    // Adopted sessions are marked headless at creation and only later discovered
    // to be teammates, so drop the mark once the link lands.
    if (leadAgentId !== undefined) {
      ch.isHeadless = false;
    }
    // A teammate discovered only after its plain external session was adopted is
    // linked here, not at creation, so it never went through the seat-next-to-lead
    // path addAgent runs for inline teammates. Cluster it now, once, on first link.
    if (wasUnlinked && leadAgentId !== undefined && !isTeamLead) {
      this.reseatNextToLead(id, leadAgentId);
    }
  }

  /** Mark an agent as headless (adopted, no terminal to focus). */
  setHeadless(id: number, headless: boolean): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.isHeadless = headless;
  }

  setAgentContext(id: number, contextTokens: number, maxContextTokens: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.contextTokens = contextTokens;
    ch.maxContextTokens = maxContextTokens;
  }

  update(dt: number): void {
    // Furniture animation cycling
    const prevFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    this.furnitureAnimTimer += dt;
    const newFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    if (newFrame !== prevFrame) {
      this.rebuildFurnitureInstances();
    }

    this.assignBoardroomRoles();
    this.moveInspectors(dt);
    this.seatWorkersAtFrontScreens();
    this.fillBusyLeisure(dt);
    this.fillDjBooth(dt);
    this.fillPingPong(dt);
    this.updateDancers();
    const joust = this.joustContext();
    this.joustTimer -= dt;
    if (this.joustTimer <= 0) {
      this.joustTimer = JOUST_CHECK_SEC;
      startJousts(joust);
    }
    updateJousts(joust, dt);

    // The greeter materializes and dematerializes like anyone else, but runs
    // no FSM — it stands where it spawned for as long as the ask is up.
    if (this.greeter && advanceMatrixEffect(this.greeter, dt) === 'despawned') {
      this.greeter = null;
    }

    const toDelete: number[] = [];
    // Where everyone's standing or about to, so idle agents don't stop on top of each other
    const occupied = this.occupiedTiles();
    for (const ch of this.characters.values()) {
      const effect = advanceMatrixEffect(ch, dt);
      if (effect !== 'none') {
        if (effect === 'despawned') toDelete.push(ch.id);
        continue; // skip normal FSM while the effect is (or just was) active
      }

      // Jousters are moved by the joust itself
      if (ch.joust) continue;

      if (ch.isActive) {
        this.ensureWorkSeat(ch);
      } else if (ch.isSick) {
        if (ch.state === CharacterState.IDLE && !ch.sickSettled) this.sendSickToWorkplace(ch);
      } else {
        this.sickTargets.delete(ch.id);
        // Idle agents don't hang about in the offices, halls, doorways, behind the DJ booth (a DJ whose
        // turn is over steps out for the next) or at a game they've stopped playing: move on promptly
        const here = `${ch.tileCol},${ch.tileRow}`;
        const inTheWay =
          this.officeTiles.has(here) || this.passageTiles.has(here) || this.backstageTiles.has(here) || this.gameSpotTiles.has(here);
        if (ch.state === CharacterState.IDLE && inTheWay) {
          ch.wanderTimer = Math.min(ch.wanderTimer, 0.5);
        }
      }

      // Temporarily unblock own seat so character can pathfind to it
      const movesBefore = ch.wanderCount;
      const leisureBefore = ch.leisureSpotKey;
      const restingBefore = this.restingTileKey(ch);
      this.withOwnSeatUnblocked(ch, () =>
        updateCharacter(ch, dt, this.freeWanderTilesFor(ch, occupied), this.seatsFor(ch), this.tileMap, this.blockedTiles, this.leisure),
      );
      this.moveOccupant(occupied, restingBefore, this.restingTileKey(ch));
      if (ch.wanderCount !== movesBefore || (ch.leisureSpotKey && ch.leisureSpotKey !== leisureBefore)) this.rollRoaming(ch);

      // Tick bubble timer for waiting bubbles
      if (ch.bubbleType === 'waiting') {
        ch.bubbleTimer -= dt;
        if (ch.bubbleTimer <= 0) {
          ch.bubbleType = null;
          ch.bubbleTimer = 0;
        }
      }
    }
    // Remove characters that finished despawn
    for (const id of toDelete) {
      this.characters.delete(id);
    }

    // ── Pet FSM ────────────────────────────────────────────────
    for (const pet of this.pets) {
      updatePet(pet, dt, this.walkableTiles, this.characters, this.tileMap, this.blockedTiles);

      // Tick heart bubble timer (mirrors character waiting-bubble pattern)
      if (pet.bubbleType) {
        pet.bubbleTimer -= dt;
        if (pet.bubbleTimer <= 0) {
          pet.bubbleType = null;
          pet.bubbleTimer = 0;
        }
      }
    }
  }

  /** The `saveAgentSeats` payload: palette, hue and seat for every agent worth
   *  restoring. Sub-agents are excluded because they are derived state the
   *  runtime re-materializes, and the greeter never reaches here at all —
   *  it is not in `characters`. */
  getPersistableSeats(): Record<
    number,
    { palette: number; hueShift: number; seatId: string | null }
  > {
    const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {};
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue;
      seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId };
    }
    return seats;
  }

  /** Everything the renderer draws: the agents plus, while the first-run ask
   *  is up, the consent greeter. This is the ONE place the greeter joins the
   *  agents — every other consumer reads `characters` and gets agents only. */
  getCharacters(): Character[] {
    const chars = Array.from(this.characters.values());
    if (this.greeter) chars.push(this.greeter);
    return chars;
  }

  /** Get character at pixel position (for hit testing). Returns id or null.
   *  Agents only: clicks pass straight through the consent greeter, which is
   *  a prop, not something to select or follow. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = Array.from(this.characters.values()).sort((a, b) => b.y - a.y);
    for (const ch of chars) {
      // Skip characters that are despawning
      if (ch.matrixEffect === 'despawn') continue;
      // Character sprite is 16x24, anchored bottom-center
      // Apply sitting offset to match visual position
      const sittingOffset = isSeated(ch) ? CHARACTER_SITTING_OFFSET_PX : 0;
      const anchorY = ch.y + sittingOffset;
      const left = ch.x - CHARACTER_HIT_HALF_WIDTH;
      const right = ch.x + CHARACTER_HIT_HALF_WIDTH;
      const top = anchorY - CHARACTER_HIT_HEIGHT;
      const bottom = anchorY;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id;
      }
    }
    return null;
  }
}

/** Whether any tile of a piece of furniture is in `tiles`. */
function overlaps(item: PlacedFurniture, entry: { footprintW: number; footprintH: number }, tiles: Set<string>): boolean {
  for (let dr = 0; dr < entry.footprintH; dr++) {
    for (let dc = 0; dc < entry.footprintW; dc++) {
      if (tiles.has(`${item.col + dc},${item.row + dr}`)) return true;
    }
  }
  return false;
}
