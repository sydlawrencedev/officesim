/** Prefix for this plugin's browser storage keys */
const PREFIX = "officesim.";
/** The plugin was called Agent Pixels; settings saved under that name are still read. */
const LEGACY_PREFIX = "agent-pixels.";

/** A saved setting by its key without the prefix, or null. May throw if storage is unavailable. */
export function readSetting(key: string): string | null {
  return window.localStorage.getItem(PREFIX + key) ?? window.localStorage.getItem(LEGACY_PREFIX + key);
}

/** Save a setting by its key without the prefix. May throw if storage is unavailable. */
export function writeSetting(key: string, value: string): void {
  window.localStorage.setItem(PREFIX + key, value);
}
