import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";

/*
 * Extra pieces of the office UI that depend on the host running it. The Paperclip plugin has none:
 * these render nothing. OfficeSim for Mac swaps this module for its own (see mac/vite.config.ts),
 * e.g. to let the Settings tab turn agent sources on and off.
 */

/** A small square picture of the harness an agent runs in, shown before its name. */
export type HarnessIcon = { src: string; label: string };

/** Settings sections shown at the top of the Settings tab. */
export function HostSettingsSections(): ReactNode {
  return null;
}

/** The icon for an agent's harness (its `source`, e.g. "claude"), if the host has one. */
export function harnessIcon(_source: string | null | undefined): HarnessIcon | null {
  return null;
}

/** Full screen as the host does it: the state and a toggle. null when the page's own element full screen is used. */
export type HostFullscreen = { fullscreen: boolean; toggle: () => void };

/** The host's own full screen (e.g. the Mac app's window), if it has one. */
export function useHostFullscreen(): HostFullscreen | null {
  return null;
}

/** Whether the OfficeSim window always fills the host's page (e.g. the Mac app, where it's the whole app). */
export const FILLS_HOST_WINDOW = false;

/**
 * The host's own way of hearing what the computer is playing, for the games room's DJ booth.
 *
 * A page can't hear the system, so in a browser the office asks the viewer to share a tab's audio
 * (see ui/musicListener.ts). The Mac app can hear the system itself, so it swaps this module for
 * its own and the booth reacts to whatever the Mac is playing.
 *
 * Null when the host has no way of hearing: the office then falls back to sharing audio.
 */
export type HostMusic = {
  /** The state of the listening, and whether sound is coming through. */
  status: { state: "off" | "connecting" | "on" | "error"; hearing?: boolean; message?: string };
  /** Starts or stops listening. */
  toggle: () => void;
};

export function useHostMusic(): HostMusic | null {
  return null;
}

/**
 * The repos the host can make an issue in.
 *
 * The Mac app knows the GitHub repos the agents work in, and can open an issue on any of them.
 * The plugin uses Paperclip's own dialog instead, so it has none.
 */
export type HostIssueRepos = {
  /** The repos, with how many issues each has open. */
  repos: Array<{ repo: string; name: string; open: number }>;
  /** Whether the host can make an issue at all. */
  canCreate: boolean;
};

export function useHostIssueRepos(): HostIssueRepos {
  return { repos: [], canCreate: false };
}

/**
 * The host's own way of reading its data again now.
 *
 * The Mac app keeps what it reads for a couple of minutes, so a refresh button has to ask the
 * host to throw that away first — otherwise it would just show the same answer again.
 *
 * Null when the host has nothing to refresh.
 */
export type HostRefresh = {
  /** Whether the host can be asked to read its data again. */
  canRefresh: boolean;
  /** Reads the data again; resolves when it's done. */
  refresh: () => Promise<void>;
};

export function useHostRefresh(): HostRefresh | null {
  return null;
}
