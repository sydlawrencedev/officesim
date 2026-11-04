import type { ColorValue } from "../components/ui/types.js";
import { readSetting, writeSetting } from "./storage.js";

/** Rooms a theme can restyle, as recorded per tile by combineLayouts. */
export type RoomKey =
  | "wall"
  | "office"
  | "lounge"
  | "boardroom"
  | "kitchen"
  | "hall"
  | "overflowWall"
  | "overflowOffice"
  | "overflowLounge";

export type ThemeId = "classic" | "solarTemple" | "neonNile" | "oasis";

/** A room's floor: colourised like the layout's own tile colours, optionally with another floor pattern. */
export type RoomStyle = { color: ColorValue; pattern?: number };

export type Theme = {
  id: ThemeId;
  label: string;
  /** Floor or wall styling per room; rooms left out keep the layout's own look. */
  rooms: Partial<Record<RoomKey, RoomStyle>>;
  /** A wash over the whole scene to set the light, e.g. warm sun or a dark night. */
  ambient?: { color: string; alpha: number; mode: GlobalCompositeOperation };
  /** Glowing light strips where floors meet the back walls. */
  trim?: { color: string; glow: number };
};

/*
 * Floor patterns (tile types): 1 plain/carpet, 2 large tiles light grout, 3 large tiles dark grout,
 * 4 small tiles dark grout, 5 small tiles light grout, 6 light bricks/planks, 7 dark planks,
 * 8 small chequers, 9 large chequers.
 */
const color = (h: number, s: number, b: number, c: number): ColorValue => ({ h, s, b, c });

export const THEMES: Record<ThemeId, Theme> = {
  classic: { id: "classic", label: "Classic", rooms: {} },

  // A sun temple rebuilt in 2150: sandstone, gold and warm white light.
  solarTemple: {
    id: "solarTemple",
    label: "Solar Temple",
    rooms: {
      wall: { color: color(36, 45, 14, -30) },
      overflowWall: { color: color(30, 42, 8, -30) },
      office: { pattern: 2, color: color(36, 40, 36, -45) },
      lounge: { pattern: 1, color: color(174, 45, 2, -30) },
      boardroom: { pattern: 3, color: color(40, 22, 44, -50) },
      kitchen: { pattern: 5, color: color(34, 34, 42, -45) },
      hall: { pattern: 9, color: color(45, 55, 20, -40) },
      overflowOffice: { pattern: 2, color: color(28, 42, 30, -45) },
      overflowLounge: { pattern: 1, color: color(174, 40, -4, -30) },
    },
    ambient: { color: "#ffcf7a", alpha: 0.18, mode: "soft-light" },
    trim: { color: "#ffd66b", glow: 6 },
  },

  // Anubis in neon: dark indigo rooms, glowing teal and magenta edges.
  neonNile: {
    id: "neonNile",
    label: "Neon Nile",
    rooms: {
      wall: { color: color(252, 45, -78, -30) },
      overflowWall: { color: color(282, 45, -78, -30) },
      office: { pattern: 4, color: color(246, 40, -62, 20) },
      lounge: { pattern: 3, color: color(286, 45, -60, 10) },
      boardroom: { pattern: 3, color: color(206, 50, -64, 10) },
      kitchen: { pattern: 4, color: color(318, 40, -60, 10) },
      hall: { pattern: 8, color: color(262, 30, -70, -10) },
      overflowOffice: { pattern: 4, color: color(222, 40, -62, 20) },
      overflowLounge: { pattern: 3, color: color(176, 45, -62, 10) },
    },
    ambient: { color: "#2b1d5c", alpha: 0.22, mode: "multiply" },
    trim: { color: "#2ef2e0", glow: 10 },
  },

  // The future as green and hopeful: pale stone, oak, grass and water.
  oasis: {
    id: "oasis",
    label: "Oasis Solarpunk",
    rooms: {
      wall: { color: color(95, 18, 22, -30) },
      overflowWall: { color: color(70, 20, 18, -30) },
      office: { pattern: 6, color: color(38, 28, 38, -50) },
      lounge: { pattern: 1, color: color(102, 38, 6, -30) },
      boardroom: { pattern: 2, color: color(60, 12, 46, -50) },
      kitchen: { pattern: 5, color: color(18, 48, 18, -40) },
      hall: { pattern: 2, color: color(188, 45, 16, -30) },
      overflowOffice: { pattern: 6, color: color(30, 30, 34, -50) },
      overflowLounge: { pattern: 1, color: color(130, 34, 4, -30) },
    },
    ambient: { color: "#fff1c9", alpha: 0.2, mode: "soft-light" },
    trim: { color: "#a6f28c", glow: 5 },
  },
};

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

const THEME_STORAGE_KEY = "theme";

export function readStoredTheme(): ThemeId {
  try {
    const stored = readSetting(THEME_STORAGE_KEY);
    return stored && stored in THEMES ? (stored as ThemeId) : "classic";
  } catch {
    return "classic";
  }
}

export function writeStoredTheme(theme: ThemeId): void {
  try {
    writeSetting(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable: the choice applies for this visit only
  }
}
