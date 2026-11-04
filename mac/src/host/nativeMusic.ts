import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setMusicAudio } from "../../../src/office/engine/djBooth.js";

/*
 * The Mac app's music listener: it hears what the Mac is playing, so the games room's DJ booth can
 * react to it.
 *
 * A web page can't hear the system, so the app does it natively: the backend starts a Core Audio
 * tap (a small Swift helper) and sends the levels it works out over the `music-levels` event. The
 * sound is analysed for the beat and the levels only, and never recorded, saved or sent anywhere.
 *
 * The tap needs the "System Audio Recording" permission, which macOS asks for the first time.
 */

export type NativeMusicStatus =
  | { state: "off" }
  | { state: "connecting" }
  /** `hearing`: sound is actually coming through right now */
  | { state: "on"; hearing: boolean }
  | { state: "error"; message: string };

const MUSIC_EVENT = "music-levels";

let status: NativeMusicStatus = { state: "off" };
let unlisten: (() => void) | null = null;

/** Sets the status and tells whoever is watching. */
export function setNativeMusicStatus(next: NativeMusicStatus): void {
  status = next;
}

/** The status now, for the UI to read. */
export function nativeMusicStatus(): NativeMusicStatus {
  return status;
}

/**
 * Starts listening to what the Mac is playing.
 *
 * macOS asks for permission the first time, so this may take a moment and may open System
 * Settings if the request is declined.
 */
export async function startNativeMusic(): Promise<void> {
  if (status.state === "on" || status.state === "connecting") return;
  setNativeMusicStatus({ state: "connecting" });
  try {
    // The levels arrive as the backend works them out
    unlisten = await listen<{ playing: boolean; beat: number; bands: number[] }>(MUSIC_EVENT, (event) => {
      const levels = event.payload;
      setMusicAudio({ playing: !!levels.playing, beat: levels.beat ?? 0, bands: levels.bands ?? [] });
      const hearing = !!levels.playing;
      if (status.state === "on" && status.hearing !== hearing) setNativeMusicStatus({ state: "on", hearing });
    });
    await invoke("start_music");
    setNativeMusicStatus({ state: "on", hearing: false });
  } catch (error) {
    unlisten?.();
    unlisten = null;
    const message = error instanceof Error ? error.message : String(error);
    setNativeMusicStatus({
      state: "error",
      message: message.includes("hasn't allowed")
        ? "macOS hasn't let OfficeSim hear your music yet. Turn on OfficeSim in System Settings → Privacy & Security → Screen & System Audio Recording, then try again."
        : message,
    });
  }
}

/** Stops listening. */
export async function stopNativeMusic(): Promise<void> {
  unlisten?.();
  unlisten = null;
  try {
    await invoke("stop_music");
  } catch {
    // The backend may already have stopped it.
  }
  setMusicAudio({ playing: false, beat: 0, bands: [] });
  setNativeMusicStatus({ state: "off" });
}

/** Whether macOS has allowed the capture: "allowed", "denied" or "unknown". */
export async function musicPermission(): Promise<"allowed" | "denied" | "unknown"> {
  try {
    const answer = await invoke<string>("music_permission");
    return answer === "allowed" || answer === "denied" ? answer : "unknown";
  } catch {
    return "unknown";
  }
}
