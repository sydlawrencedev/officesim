import type { SpriteData } from '../types.js';

/*
 * The games room's DJ booth: a pair of vinyl decks either side of a mixer, with a speaker on a
 * stand each side. The page can feed it the viewer's music (see ui/musicListener): while music plays
 * the records spin, the mixer's meters bounce, the speaker cones pump with the bass, and the room
 * lights up with a red and a green laser and a disco ball. Sprites and overlays share the geometry
 * below so they always line up.
 */

export const DJ_BOOTH_TYPE = 'DJ_BOOTH';
export const DJ_BOOTH_WIDTH = 48;
export const DJ_BOOTH_HEIGHT = 32;
export const DJ_SPEAKER_TYPE = 'DJ_SPEAKER';
export const DJ_SPEAKER_WIDTH = 16;
export const DJ_SPEAKER_HEIGHT = 32;

// ── The music it's playing along to ──────────────────────────────

export interface MusicAudio {
  /** Music is audible right now */
  playing: boolean;
  /** 1 on a beat, easing back to 0 */
  beat: number;
  /** Loudness per band, low to high, each 0..1 */
  bands: number[];
}

let audio: MusicAudio = { playing: false, beat: 0, bands: [] };
/** Beats heard so far, so dancers can change move on each one */
let beats = 0;

export function setMusicAudio(next: MusicAudio): void {
  if (next.beat >= 1 && audio.beat < 1) beats++;
  audio = next;
}

/** What the DJ booth is playing, for anything moving to it */
export function getMusicAudio(): MusicAudio & { beats: number } {
  return { ...audio, beats };
}

/** Bass level (0..1) below which the speakers sit still */
const BASS_FLOOR = 0.2;

/** How hard the bass is hitting, 0..1 */
function bassThump(): number {
  return Math.min(1, Math.max(0, ((audio.bands[0] ?? 0) - BASS_FLOOR) / (1 - BASS_FLOOR)));
}

// ── Painting ────────────────────────────────────────────────────

const OUTLINE = '#111317';
const TOP = '#2b2f37';
const TOP_EDGE = '#4a505c';
const FRONT = '#1c1f25';
const FRONT_LIGHT = '#2a2e36';
const PLINTH = '#3d424c';
const PLINTH_LIGHT = '#59606d';
const VINYL = '#0d0e10';
const GROOVE = '#24262b';
const LABELS = ['#e03131', '#f5d547'];
const TONEARM = '#b8bec8';
const MIXER = '#15171b';
const KNOB = '#8a919b';
const FADER = '#cfd4da';
const METER_OFF = '#20262a';
const METER_COLORS = ['#51cf66', '#51cf66', '#94d82d', '#ffd43b', '#ff922b', '#ff4d4d'];
const CABINET = '#22252b';
const CABINET_LIGHT = '#3a3f48';
const GRILLE = '#5c636e';
const CONE = '#15171b';
const CONE_CAP = '#6b7280';
const STAND = '#7d838d';

/** The decks: platter centres in booth-sprite pixels, and the record's radius across and down (seen from the front, so squashed) */
const DECKS = [
  { x: 9.5, y: 8 },
  { x: 38.5, y: 8 },
];
const RECORD_RX = 6;
const RECORD_RY = 3.6;
/** The mixer between the decks */
const MIXER_BOX = { x: 18, y: 3, w: 12, h: 10 };
/** The LED strip along the front of the booth, lit to the music */
export const DJ_BOOTH_STRIP = { x: 3, y: 21, w: 42 };

type Paint = (x: number, y: number, w: number, h: number, color: string) => void;

function canvas(width: number, height: number): { px: string[][]; rect: Paint } {
  const px: string[][] = Array.from({ length: height }, () => Array<string>(width).fill(''));
  const rect: Paint = (x, y, w, h, color) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (px[yy]?.[xx] !== undefined) px[yy][xx] = color;
  };
  return { px, rect };
}

function ellipse(px: string[][], cx: number, cy: number, rx: number, ry: number, color: string): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1 && px[y]?.[x] !== undefined) px[y][x] = color;
    }
  }
}

/**
 * A 48x32 DJ booth: the top (seen from the front, so squashed) carries a turntable each side of a
 * mixer; below, the front panel with an LED strip. Its back row is open floor for the DJ to stand on.
 */
export function paintDjBooth(): SpriteData {
  const { px, rect } = canvas(DJ_BOOTH_WIDTH, DJ_BOOTH_HEIGHT);
  // Top
  rect(0, 1, 48, 14, OUTLINE);
  rect(1, 2, 46, 12, TOP);
  rect(1, 2, 46, 1, TOP_EDGE);
  // Front panel down to the floor
  rect(0, 15, 48, 16, OUTLINE);
  rect(1, 15, 46, 15, FRONT);
  rect(1, 15, 46, 1, FRONT_LIGHT);
  rect(DJ_BOOTH_STRIP.x, DJ_BOOTH_STRIP.y, DJ_BOOTH_STRIP.w, 1, METER_OFF);
  // Turntables: plinth, record with grooves, label, tonearm
  DECKS.forEach((deck, i) => {
    rect(Math.round(deck.x - 8), 3, 16, 10, OUTLINE);
    rect(Math.round(deck.x - 7), 4, 14, 8, PLINTH);
    rect(Math.round(deck.x - 7), 4, 14, 1, PLINTH_LIGHT);
    ellipse(px, deck.x - 0.5, deck.y, RECORD_RX, RECORD_RY, VINYL);
    ellipse(px, deck.x - 0.5, deck.y, RECORD_RX - 2, RECORD_RY - 1.3, GROOVE);
    ellipse(px, deck.x - 0.5, deck.y, RECORD_RX - 3, RECORD_RY - 2, VINYL);
    rect(Math.round(deck.x - 1), deck.y - 1, 2, 2, LABELS[i]);
    // Tonearm from the back corner, resting on the record
    const armX = Math.round(deck.x + (i === 0 ? 5 : 5));
    rect(armX, 4, 1, 3, TONEARM);
    rect(armX - 1, 7, 1, 2, TONEARM);
  });
  // Mixer: panel, a row of knobs, two channel faders, the crossfader, and two level meters
  const m = MIXER_BOX;
  rect(m.x, m.y, m.w, m.h, OUTLINE);
  rect(m.x + 1, m.y + 1, m.w - 2, m.h - 2, MIXER);
  for (const kx of [m.x + 2, m.x + 4, m.x + 7, m.x + 9]) rect(kx, m.y + 2, 1, 1, KNOB);
  for (const fx of [m.x + 3, m.x + 8]) {
    rect(fx, m.y + 4, 1, 4, '#000000');
    rect(fx, m.y + 6, 1, 1, FADER);
  }
  rect(m.x + 4, m.y + 8, 4, 1, '#000000');
  rect(m.x + 5, m.y + 8, 2, 1, FADER);
  rect(m.x + 5, m.y + 4, 1, 3, METER_OFF);
  rect(m.x + 6, m.y + 4, 1, 3, METER_OFF);
  return px;
}

/** Speaker cones in speaker-sprite pixels */
const WOOFER = { x: 8, y: 11.5, r: 3.4 };
const TWEETER = { x: 8, y: 5, r: 1.6 };

/** A 16x32 PA speaker on a tripod stand: the cabinet high up, woofer below the tweeter. */
export function paintDjSpeaker(): SpriteData {
  const { px, rect } = canvas(DJ_SPEAKER_WIDTH, DJ_SPEAKER_HEIGHT);
  // Cabinet
  rect(2, 0, 12, 17, OUTLINE);
  rect(3, 1, 10, 15, CABINET);
  rect(3, 1, 10, 1, CABINET_LIGHT);
  for (const cone of [WOOFER, TWEETER]) {
    for (let y = 0; y < 17; y++) {
      for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x + 0.5 - cone.x, y + 0.5 - cone.y);
        if (d < cone.r * 0.35) px[y][x] = CONE_CAP;
        else if (d < cone.r * 0.8) px[y][x] = CONE;
        else if (d < cone.r + 0.2) px[y][x] = GRILLE;
      }
    }
  }
  // Pole and tripod legs
  rect(7, 17, 2, 10, STAND);
  rect(6, 26, 4, 1, STAND);
  rect(5, 27, 1, 2, STAND);
  rect(10, 27, 1, 2, STAND);
  rect(4, 29, 1, 2, STAND);
  rect(11, 29, 1, 2, STAND);
  rect(7, 27, 2, 4, STAND);
  return px;
}

// ── Drawing to the music ────────────────────────────────────────

function pixel(c: CanvasRenderingContext2D, ox: number, oy: number, zoom: number, x: number, y: number, w: number, h: number, color: string): void {
  c.fillStyle = color;
  c.fillRect(Math.round(ox + x * zoom), Math.round(oy + y * zoom), Math.ceil(w * zoom), Math.ceil(h * zoom));
}

/**
 * The booth: with music on, the records spin (a highlight going round each one), the mixer's meters
 * bounce with the levels and the front strip pulses through colours on the beat. Off, a standby
 * light blinks.
 */
export function renderDjBooth(c: CanvasRenderingContext2D, sprite: CanvasImageSource, fx: number, fy: number, zoom: number, now: number): void {
  c.drawImage(sprite, fx, fy);
  if (!audio.playing) {
    if (Math.floor(now / 1200) % 2 === 0) pixel(c, fx, fy, zoom, MIXER_BOX.x + 10, MIXER_BOX.y + 8, 1, 1, '#e03131');
    return;
  }
  // Records spinning at 33⅓: a glint going round each, the decks a little out of step
  DECKS.forEach((deck, i) => {
    const angle = now / 1800 * Math.PI * 2 * (1 + i * 0.02) + i * 1.7;
    const gx = deck.x - 0.5 + Math.cos(angle) * (RECORD_RX - 1.5);
    const gy = deck.y + Math.sin(angle) * (RECORD_RY - 1);
    pixel(c, fx, fy, zoom, Math.floor(gx), Math.floor(gy), 1, 1, '#5c6370');
  });
  // Mixer meters: left and right, three lights each
  const m = MIXER_BOX;
  [audio.bands[0] ?? 0, audio.bands[2] ?? 0].forEach((level, i) => {
    const lit = Math.min(3, Math.round(level * 3.4));
    for (let k = 0; k < lit; k++) pixel(c, fx, fy, zoom, m.x + 5 + i, m.y + 6 - k, 1, 1, METER_COLORS[Math.min(5, k * 2 + (lit === 3 ? 1 : 0))]);
  });
  // Front strip: a run of colour sweeping along, brightest on the beat
  for (let x = 0; x < DJ_BOOTH_STRIP.w; x++) {
    const hue = (now / 8 + x * 9) % 360;
    c.globalAlpha = 0.45 + audio.beat * 0.55;
    pixel(c, fx, fy, zoom, DJ_BOOTH_STRIP.x + x, DJ_BOOTH_STRIP.y, 1, 1, `hsl(${hue}, 95%, 60%)`);
  }
  c.globalAlpha = 1;
}

/** How much bigger (in pixels of radius) a cone gets at full bass, and the extra kick on a beat */
const CONE_SWELL = 0.9;
const CONE_BEAT_KICK = 0.4;

/** A speaker: its cones pump with the bass and kick on the beat, and the cabinet shudders on big hits. */
export function renderDjSpeaker(c: CanvasRenderingContext2D, sprite: CanvasImageSource, fx: number, fy: number, zoom: number): void {
  if (!audio.playing) {
    c.drawImage(sprite, fx, fy);
    return;
  }
  const thump = bassThump();
  const shake = audio.beat > 0.8 ? Math.round((Math.random() - 0.5) * 2) * 0.5 : 0;
  const ox = fx + shake * zoom;
  c.drawImage(sprite, ox, fy);
  for (const [cone, weight] of [[WOOFER, 1], [TWEETER, 0.4]] as const) {
    const swell = (thump * CONE_SWELL + audio.beat * CONE_BEAT_KICK) * weight;
    const outer = cone.r * 0.8 + swell;
    const cap = cone.r * 0.35 + swell * 0.6;
    for (let y = Math.floor(cone.y - outer - 1); y <= Math.ceil(cone.y + outer); y++) {
      for (let x = Math.floor(cone.x - outer - 1); x <= Math.ceil(cone.x + outer); x++) {
        const d = Math.hypot(x + 0.5 - cone.x, y + 0.5 - cone.y);
        if (d >= outer) continue;
        pixel(c, ox, fy, zoom, x, y, 1, 1, d < cap ? (thump > 0.6 ? '#8d949e' : CONE_CAP) : CONE);
      }
    }
  }
}

// ── Lights: lasers and the disco ball ───────────────────────────

/** The room the party lights fill, in world pixels: its floor, plus the wall above it */
export interface PartyRoom {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where the lasers fire from (the top of the back wall, above the booth's ends) */
  emitters: Array<{ x: number; y: number }>;
  /** Where the disco ball hangs */
  ball: { x: number; y: number };
}

let partyRoom: PartyRoom | null = null;

/** Set by the office once it knows where the booth is; null when there isn't one */
export function setPartyRoom(room: PartyRoom | null): void {
  partyRoom = room;
}

const LASERS = [
  { color: [255, 50, 50], speed: 0.9, phase: 0 },
  { color: [60, 255, 90], speed: -1.15, phase: 2.1 },
] as const;
/** Beams per laser, fanned out */
const LASER_BEAMS = 4;
const BALL_RADIUS = 4;
/** How much of the ball's string shows below the (unseen) ceiling */
const BALL_STRING = 7;
/** Light spots thrown by the disco ball, each at its own distance and speed */
const SPOTS = Array.from({ length: 34 }, (_, i) => ({
  angle: (i * 2.39996) % (Math.PI * 2),
  reach: 0.25 + ((i * 0.6180339) % 1) * 0.75,
  hue: [0, 55, 190, 290, 120][i % 5],
}));

/**
 * With music on, the disco ball comes out and turns, throwing spots of light that wheel round the
 * room, and the two lasers sweep fans of beams across the floor, flaring on the beat.
 */
export function renderPartyLights(c: CanvasRenderingContext2D, offsetX: number, offsetY: number, zoom: number, now: number): void {
  const room = partyRoom;
  if (!room) return;
  const X = (x: number) => offsetX + x * zoom;
  const Y = (y: number) => offsetY + y * zoom;
  const playing = audio.playing;
  const t = now / 1000;


  if (playing) {
    c.save();
    c.beginPath();
    c.rect(X(room.x), Y(room.y), room.w * zoom, room.h * zoom);
    c.clip();
    c.globalCompositeOperation = 'lighter';

    // Disco spots wheeling round the room
    const cx = room.ball.x;
    const cy = room.ball.y + room.h * 0.35;
    const maxX = room.w * 0.55;
    const maxY = room.h * 0.55;
    for (const spot of SPOTS) {
      const a = spot.angle + t * 0.6;
      const x = cx + Math.cos(a) * spot.reach * maxX;
      const y = cy + Math.sin(a) * spot.reach * maxY;
      const size = Math.max(1, Math.round(zoom * 1.5));
      c.globalAlpha = 0.35 + 0.25 * Math.sin(t * 6 + spot.angle * 3);
      c.fillStyle = `hsl(${spot.hue}, 90%, 75%)`;
      c.fillRect(Math.round(X(x)), Math.round(Y(y)), size, size);
    }

    // Lasers: each a fan of beams from its emitter to the floor, sweeping side to side
    const floorY = room.y + room.h;
    LASERS.forEach((laser, i) => {
      const from = room.emitters[i % room.emitters.length];
      const sweep = Math.sin(t * laser.speed + laser.phase);
      const spread = 0.22 + audio.beat * 0.12;
      const [r, g, b] = laser.color;
      for (let k = 0; k < LASER_BEAMS; k++) {
        const angle = sweep * 0.9 + (k - (LASER_BEAMS - 1) / 2) * spread;
        const length = (floorY - from.y) / Math.max(0.2, Math.cos(angle));
        const toX = from.x + Math.sin(angle) * length;
        const toY = from.y + Math.cos(angle) * length;
        c.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.5 + audio.beat * 0.35})`;
        c.lineWidth = Math.max(1, zoom * 0.75);
        c.beginPath();
        c.moveTo(X(from.x), Y(from.y));
        c.lineTo(X(toX), Y(toY));
        c.stroke();
        // A bright dot where the beam lands
        c.fillStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
        const dot = Math.max(1, Math.round(zoom * 1.2));
        c.fillRect(Math.round(X(toX) - dot / 2), Math.round(Y(toY) - dot / 2), dot, dot);
      }
      // The emitter's glow
      c.fillStyle = `rgba(${r}, ${g}, ${b}, 0.9)`;
      c.fillRect(Math.round(X(from.x) - zoom), Math.round(Y(from.y) - zoom), Math.ceil(zoom * 2), Math.ceil(zoom * 2));
    });
    c.restore();
  }

  // The disco ball on a short string from the ceiling, only out while music plays: mirror tiles that
  // glint as it turns
  if (!playing) return;
  const ball = room.ball;
  c.save();
  c.fillStyle = '#9aa3ad';
  c.fillRect(Math.round(X(ball.x) - zoom / 2), Math.round(Y(ball.y - BALL_RADIUS - BALL_STRING)), Math.ceil(zoom), Math.round(BALL_STRING * zoom));
  const turn = Math.floor(t * 8);
  for (let y = -BALL_RADIUS; y < BALL_RADIUS; y++) {
    for (let x = -BALL_RADIUS; x < BALL_RADIUS; x++) {
      if (Math.hypot(x + 0.5, y + 0.5) > BALL_RADIUS) continue;
      const tile = (x + y + turn) & 3;
      const lit = (x * 7 + y * 13 + turn) % 9 === 0;
      c.fillStyle = lit ? '#ffffff' : ['#c9d1da', '#8f99a5', '#e3e8ee', '#6f7884'][tile];
      c.fillRect(Math.round(X(ball.x + x)), Math.round(Y(ball.y + y)), Math.ceil(zoom), Math.ceil(zoom));
    }
  }
  c.restore();
}
