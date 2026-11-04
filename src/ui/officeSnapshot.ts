import type { OfficeState } from "../office/engine/officeState.js";
import type { CharacterSnapshot } from "../office/types.js";
import { readSetting, writeSetting } from "./storage.js";

/** Where everyone is, saved in the browser so a reload puts them back */
const SNAPSHOT_SETTING = "office-snapshot";
/** How often the office is saved */
export const SNAPSHOT_SAVE_MS = 2000;
/** Saved seats always come back; saved positions only if the save is this recent */
export const SNAPSHOT_POSITIONS_FRESH_MS = 10 * 60_000;

export type OfficeSnapshot = {
  savedAt: number;
  /** By agent id */
  agents: Record<string, CharacterSnapshot>;
};

export function readOfficeSnapshot(): OfficeSnapshot | null {
  try {
    const stored = readSetting(SNAPSHOT_SETTING);
    if (!stored) return null;
    const snapshot = JSON.parse(stored) as OfficeSnapshot;
    return typeof snapshot?.savedAt === "number" && snapshot.agents && typeof snapshot.agents === "object" ? snapshot : null;
  } catch {
    return null;
  }
}

/** Save each agent's seat and whereabouts; `agentIds` maps the office's character ids to agent ids. */
export function writeOfficeSnapshot(office: OfficeState, agentIds: Map<number, string>): void {
  const agents: Record<string, CharacterSnapshot> = {};
  for (const [characterId, agentId] of agentIds) {
    const snapshot = office.snapshotCharacter(characterId);
    if (snapshot) agents[agentId] = snapshot;
  }
  try {
    writeSetting(SNAPSHOT_SETTING, JSON.stringify({ savedAt: Date.now(), agents } satisfies OfficeSnapshot));
  } catch {
    // Storage unavailable or full: a reload just seats everyone afresh
  }
}
