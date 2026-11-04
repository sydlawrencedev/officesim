import { normalizeSettings, type OfficeSettingsData } from "../../../src/officeSettings";

/*
 * Data keys answered in the webview rather than by the backend: the office settings, which the
 * Mac app keeps in its own storage (the plugin keeps them in Paperclip's plugin state). Each
 * handler returns undefined for keys it doesn't own.
 */

const SETTINGS_STORAGE_KEY = "officesim.mac.office-settings";

function readStoredSettings(): unknown {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function localData(key: string, _params: Record<string, unknown>): Promise<unknown> {
  if (key === "office-settings") {
    const stored = readStoredSettings();
    // Wall chart secrets (PostHog, Stripe) aren't wired up in the Mac app yet
    const data: OfficeSettingsData = { settings: normalizeSettings(stored), saved: stored !== null, posthogConnected: false, stripeConnected: false };
    return data;
  }
  return undefined;
}

export async function localAction(key: string, params: Record<string, unknown>): Promise<unknown> {
  if (key === "save-office-settings") {
    const settings = normalizeSettings(params.settings);
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return { settings };
  }
  return undefined;
}
