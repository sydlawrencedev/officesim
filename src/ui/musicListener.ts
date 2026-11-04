import { useSyncExternalStore } from "react";
import { setMusicAudio } from "../office/engine/djBooth.js";
import { useHostMusic } from "./hostExtensions.js";

/*
 * Lets the games room's DJ booth play along to the viewer's music. A page can't hear what else the
 * computer is playing unless the viewer shares it, so this asks through the browser's screen-share
 * picker: a tab playing music (Spotify, YouTube…) with "Share audio" ticked, or the whole screen's
 * audio where the browser offers it. The sound is only analysed here, for the beat and the levels;
 * it's never played back, recorded or sent anywhere.
 *
 * A host that can hear the system itself (the Mac app) says so through useHostMusic, and the booth
 * uses that instead of asking the viewer to share anything.
 */

export type MusicStatus =
  | { state: "off" }
  | { state: "connecting" }
  /** `hearing`: sound is actually coming through the shared audio right now */
  | { state: "on"; hearing: boolean }
  | { state: "error"; message: string };

let status: MusicStatus = { state: "off" };
const listeners = new Set<() => void>();

function setStatus(next: MusicStatus): void {
  status = next;
  for (const listener of listeners) listener();
}

export function useMusicStatus(): MusicStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
  );
}

let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let frame = 0;

/** Bass bins (about 40–170Hz at 44.1kHz with a 1024-point FFT) carry the beat */
const FFT_SIZE = 1024;
const BASS_BINS = [1, 5] as const;
/** A beat is bass this much louder than its recent average, at least this far apart */
const BEAT_RATIO = 1.3;
const MIN_BEAT_GAP_MS = 240;
/** Average level (0–255) below which it's treated as silence */
const SILENCE_LEVEL = 6;
/** Keep playing through a quiet bar this long before the DJ booth stops */
const SILENCE_HOLD_MS = 1500;
const METER_BANDS = 6;

export function toggleMusic(): void {
  // A host that can hear the system itself (the Mac app) does it its own way
  if (hostMusic) {
    hostMusic.toggle();
    setStatus(hostMusic.status);
    return;
  }
  if (status.state === "on" || status.state === "connecting") stopMusic();
  else void startMusic();
}

/** The host's own listening, when it has one (the Mac app). */
let hostMusic: { status: MusicStatus; toggle: () => void } | null = null;

/**
 * Uses the host's way of hearing the computer, when it has one.
 *
 * The Mac app can hear the system itself, so the booth doesn't ask the viewer to share a tab.
 *
 * This is called wherever the office is shown, so the host's way is known even when the camera
 * isn't on screen (the Agents tab, for instance).
 */
export function useHostMusicListening(): void {
  const host = useHostMusic();
  hostMusic = host
    ? {
        status:
          host.status.state === "error"
            ? { state: "error", message: host.status.message ?? "" }
            : host.status.state === "on"
              ? { state: "on", hearing: host.status.hearing ?? false }
              : { state: host.status.state },
        toggle: host.toggle,
      }
    : null;
}

export function stopMusic(): void {
  // A host that hears the system itself stops its own way of listening
  if (hostMusic) return;
  cancelAnimationFrame(frame);
  stream?.getTracks().forEach((track) => track.stop());
  void context?.close();
  stream = null;
  context = null;
  setMusicAudio({ playing: false, beat: 0, bands: [] });
  setStatus({ state: "off" });
}

async function startMusic(): Promise<void> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus({ state: "error", message: "This browser can't share audio with the page." });
    return;
  }
  setStatus({ state: "connecting" });
  let shared: MediaStream;
  try {
    shared = await navigator.mediaDevices.getDisplayMedia({
      // Browsers only offer audio alongside a picture; the picture is dropped straight away
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      // Chrome: offer the whole system's audio where it can, and don't mute the tab being shared
      systemAudio: "include",
      suppressLocalAudioPlayback: false,
      selfBrowserSurface: "exclude",
    } as DisplayMediaStreamOptions);
  } catch {
    // Cancelled in the picker
    setStatus({ state: "off" });
    return;
  }
  const audioTracks = shared.getAudioTracks();
  shared.getVideoTracks().forEach((track) => track.stop());
  if (audioTracks.length === 0) {
    shared.getTracks().forEach((track) => track.stop());
    setStatus({ state: "error", message: "No audio was shared. Choose Entire screen with “Also share system audio” on, or a tab with “Share audio” ticked." });
    return;
  }

  stream = new MediaStream(audioTracks);
  console.info("[OfficeSim] Listening to shared audio:", audioTracks[0].label, audioTracks[0].getSettings());
  context = new AudioContext();
  // Picking what to share uses up the click, so the browser can start the analyser paused
  if (context.state === "suspended") await context.resume().catch(() => {});
  const analyser = context.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.5;
  // Analysed only: not connected to the speakers, so nothing plays twice
  context.createMediaStreamSource(stream).connect(analyser);
  audioTracks[0].addEventListener("ended", stopMusic);
  setStatus({ state: "on", hearing: false });

  const bins = new Uint8Array(analyser.frequencyBinCount);
  let bassAverage = 0;
  let lastBeat = 0;
  let beat = 0;
  let lastSound = 0;
  const tick = (now: number) => {
    analyser.getByteFrequencyData(bins);
    let bass = 0;
    for (let i = BASS_BINS[0]; i <= BASS_BINS[1]; i++) bass += bins[i];
    bass /= BASS_BINS[1] - BASS_BINS[0] + 1;
    let total = 0;
    for (const value of bins) total += value;
    const level = total / bins.length;
    if (level > SILENCE_LEVEL) lastSound = now;

    beat *= 0.88;
    if (bass > bassAverage * BEAT_RATIO && bass > 60 && now - lastBeat > MIN_BEAT_GAP_MS) {
      beat = 1;
      lastBeat = now;
    }
    bassAverage = bassAverage * 0.94 + bass * 0.06;

    // Log-spaced bands from the bass up, for the level meter
    const bands: number[] = [];
    for (let band = 0; band < METER_BANDS; band++) {
      const from = Math.max(1, Math.floor(2 ** (band * 1.3)));
      const to = Math.min(bins.length, Math.floor(2 ** ((band + 1) * 1.3)) + 1);
      let sum = 0;
      for (let i = from; i < to; i++) sum += bins[i];
      bands.push(sum / Math.max(1, to - from) / 255);
    }
    const playing = now - lastSound < SILENCE_HOLD_MS;
    setMusicAudio({ playing, beat, bands });
    if (status.state === "on" && status.hearing !== playing) setStatus({ state: "on", hearing: playing });
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}
