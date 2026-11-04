import type { Workplace } from "../office/types.js";
import { readSetting, writeSetting } from "./storage.js";
import { isValidPattern, type OfficeSettings } from "../officeSettings.js";

export const WORKPLACE_OPTIONS: Array<{ value: Workplace; label: string }> = [
  { value: "main", label: "Main office" },
  { value: "boardroom", label: "Boardroom" },
  { value: "overflow", label: "Office 2" },
];

const WORKPLACE_CHANGED_EVENT = "officesim:workplaces-changed";

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A room picked at random for the name, the same one every time so the agent doesn't move between visits. */
function randomWorkplace(name: string): Workplace {
  let hash = 2166136261;
  for (const char of normalizeName(name)) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return WORKPLACE_OPTIONS[(hash >>> 0) % WORKPLACE_OPTIONS.length].value;
}

/**
 * Room an agent uses when none has been picked for them: the boardroom for the agents named in the
 * office settings, Office 2 for names matching its pattern, otherwise one of the three at random.
 */
export function defaultWorkplace(name: string, rules?: OfficeSettings["workplaces"] | null): Workplace {
  const normalized = normalizeName(name);
  if (rules?.boardroomAgentNames.some((boardroomName) => normalizeName(boardroomName) === normalized)) return "boardroom";
  if (rules?.overflowAgentNamePattern && isValidPattern(rules.overflowAgentNamePattern) && new RegExp(rules.overflowAgentNamePattern, "i").test(name.trim())) {
    return "overflow";
  }
  return randomWorkplace(name);
}

function storageKey(companyId: string | null): string {
  return `workplaces.${companyId ?? "instance"}`;
}

function isWorkplace(value: unknown): value is Workplace {
  return value === "main" || value === "boardroom" || value === "overflow";
}

export function readStoredWorkplaces(companyId: string | null): Record<string, Workplace> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(readSetting(storageKey(companyId)) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, Workplace] => isWorkplace(entry[1])),
    );
  } catch {
    return {};
  }
}

export function writeStoredWorkplaces(companyId: string | null, workplaces: Record<string, Workplace>): void {
  try {
    writeSetting(storageKey(companyId), JSON.stringify(workplaces));
  } catch {
    // Storage unavailable: the choice applies for this session only
  }
  window.dispatchEvent(new CustomEvent(WORKPLACE_CHANGED_EVENT, { detail: { companyId } }));
}

/** Re-read stored workplaces when they change elsewhere on the page (e.g. the Characters tab) */
export function onWorkplacesChanged(listener: () => void): () => void {
  window.addEventListener(WORKPLACE_CHANGED_EVENT, listener);
  return () => window.removeEventListener(WORKPLACE_CHANGED_EVENT, listener);
}
