import { useEffect } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { OfficeSettings, OfficeSettingsData } from "../officeSettings.js";
import type { WhiteboardChart } from "./PixelOfficeCanvas.js";

/*
 * Everything the office settings need from the host, in one place: reading and saving the
 * settings, testing an insight, fetching wall art and listing agents. Running OfficeSim outside
 * Paperclip means swapping these for another backend; the settings panel itself doesn't change.
 */

const SETTINGS_SAVED_EVENT = "officesim:settings-saved";

/** Tell open offices on this page that the settings were saved, so they re-read them. */
export function announceSettingsSaved(): void {
  window.dispatchEvent(new CustomEvent(SETTINGS_SAVED_EVENT));
}

/** The company's office settings from the worker, re-read when saved elsewhere on the page. */
export function useOfficeSettings(companyId: string | null | undefined) {
  const result = usePluginData<OfficeSettingsData>("office-settings", companyId ? { companyId } : {});
  const { refresh } = result;
  useEffect(() => {
    window.addEventListener(SETTINGS_SAVED_EVENT, refresh);
    return () => window.removeEventListener(SETTINGS_SAVED_EVENT, refresh);
  }, [refresh]);
  return result;
}

export type WallImage = { contentType: string; base64: string };
export type FetchWallImage = (params: { url: string }) => Promise<WallImage>;

/** The host calls the settings panel and the office make. */
export function useOfficeSettingsActions(companyId: string | null | undefined) {
  const save = usePluginAction("save-office-settings");
  const testInsight = usePluginAction("test-posthog-insight");
  const fetchImage = usePluginAction("fetch-wall-image");
  return {
    saveSettings: async (settings: OfficeSettings) => {
      await save({ companyId, settings });
      announceSettingsSaved();
    },
    /** One PostHog insight, read with the given (possibly unsaved) host and project. */
    testInsight: async (insightId: string, posthog: OfficeSettings["posthog"]) =>
      ((await testInsight({ companyId, insightId, posthog })) as { chart: WhiteboardChart }).chart,
    fetchWallImage: ((params) => fetchImage(params) as Promise<WallImage>) as FetchWallImage,
  };
}

/** The company's agents, for picking the scorecard author and boardroom seats. */
export function useAgentNames(companyId: string | null | undefined): string[] {
  const { data } = usePluginData<{ agents: Array<{ name: string }> }>("character-settings", companyId ? { companyId } : {});
  return (data?.agents ?? []).map((agent) => agent.name).sort((a, b) => a.localeCompare(b));
}
