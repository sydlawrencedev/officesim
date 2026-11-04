import type { FurnitureInstance } from '../types.js';
import { DJ_BOOTH_STRIP, DJ_BOOTH_TYPE, DJ_BOOTH_WIDTH, getMusicAudio } from './djBooth.js';

/*
 * Night time across the whole office, from 6pm to 6am: a dark blue wash over every room and corridor, with whatever's
 * switched on glowing through it: computer screens in use, the arcade, and the DJ booth's light
 * strip (coloured to the music). The games room's lasers and disco ball are drawn after, on top.
 */

const NIGHT_WASH = 'rgba(8, 12, 40, 0.58)';
/** Night is from 6pm until 6am, by the viewer's own clock */
const NIGHT_FROM_HOUR = 18;
const NIGHT_UNTIL_HOUR = 6;

export function isNightTime(now: Date = new Date()): boolean {
  const hour = now.getHours();
  return hour >= NIGHT_FROM_HOUR || hour < NIGHT_UNTIL_HOUR;
}

type Glow = { x: number; y: number; radius: number; color: string };

/** Glows given off by a piece of furniture, in world pixels; none for most things */
function glowsOf(f: FurnitureInstance, now: number): Glow[] {
  const type = f.type ?? '';
  // A computer in use: its screen (the terminal area of the monitor)
  if (type.startsWith('PC_FRONT_ON')) return [{ x: f.x + 8, y: f.y + 8, radius: 16, color: 'rgba(120, 220, 170, 0.32)' }];
  if (type.startsWith('ARCADE_MACHINE')) return [{ x: f.x + 16, y: f.y + 14, radius: 24, color: 'rgba(110, 170, 255, 0.38)' }];
  if (type === DJ_BOOTH_TYPE) {
    const music = getMusicAudio();
    const color = music.playing ? `hsla(${(now / 8) % 360}, 95%, 60%, ${0.3 + music.beat * 0.25})` : 'rgba(120, 140, 200, 0.08)';
    return [{ x: f.x + DJ_BOOTH_WIDTH / 2, y: f.y + DJ_BOOTH_STRIP.y, radius: 32, color }];
  }
  return [];
}

export function renderNight(c: CanvasRenderingContext2D, furniture: FurnitureInstance[], offsetX: number, offsetY: number, zoom: number, now: number): void {
  c.save();
  // The whole view, so nothing at the map's edges is left in daylight
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = NIGHT_WASH;
  c.fillRect(0, 0, c.canvas.width, c.canvas.height);
  c.restore();

  c.save();
  c.globalCompositeOperation = 'lighter';
  for (const f of furniture) {
    for (const glow of glowsOf(f, now)) {
      const x = offsetX + glow.x * zoom;
      const y = offsetY + glow.y * zoom;
      const r = glow.radius * zoom;
      const gradient = c.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(0, glow.color);
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      c.fillStyle = gradient;
      c.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
  c.restore();
}
