/** How long the whole office cheers when an issue is done */
export const CHEER_MS = 3500;

let cheerUntil = 0;

/** Everyone in the office throws their arms up and hops, for a few seconds from now. */
export function startCheer(): void {
  cheerUntil = performance.now() + CHEER_MS;
}

export function isCheering(now = performance.now()): boolean {
  return now < cheerUntil;
}

/** How long everyone waves when someone logs in */
export const WAVE_MS = 3500;

let waveUntil = 0;

/** Everyone in the office turns to the camera and waves, for a few seconds from now. */
export function startWave(): void {
  waveUntil = performance.now() + WAVE_MS;
}

export function isWaving(now = performance.now()): boolean {
  return now < waveUntil;
}
