/**
 * The office's chiptune sounds, synthesised so there's no audio file to ship:
 * - a victory fanfare for an issue done: a quick rising arpeggio on a square-wave lead, landing on a
 *   held top note with a little vibrato, over a triangle-wave bass;
 * - a "your call?" chime when an agent needs a decision: two rising notes, asked twice;
 * - a cheery "hel-lo!" when someone logs in: a short note then a higher one that bends up into it;
 * - a llama squealing on the About tab: a nasal "eee-EEE-eee" that climbs, wobbles hard, and warbles
 *   at the top before dropping away.
 */

const VOLUME = 0.12;
/** [frequency Hz, start s, length s] */
const LEAD: Array<[number, number, number]> = [
  [523.25, 0, 0.09], // C5
  [659.25, 0.09, 0.09], // E5
  [783.99, 0.18, 0.09], // G5
  [1046.5, 0.27, 0.55], // C6, held
];
const BASS: Array<[number, number, number]> = [
  [130.81, 0, 0.27], // C3
  [196.0, 0.27, 0.55], // G3
];

/** A rising fourth, asked twice with the second a touch quieter: [frequency Hz, start s, length s, level] */
const DECISION_CHIME: Array<[number, number, number, number]> = [
  [659.25, 0, 0.1, 0.8], // E5
  [880.0, 0.11, 0.22, 0.8], // A5
  [659.25, 0.42, 0.1, 0.5], // E5
  [880.0, 0.53, 0.3, 0.5], // A5
];

/** "Hel-lo!": [frequency Hz, start s, length s, bend from Hz] */
const HELLO: Array<[number, number, number, number]> = [
  [587.33, 0, 0.12, 587.33], // D5, "hel"
  [880.0, 0.15, 0.4, 698.46], // A5, "lo", sliding up from F5 like a voice
];

/**
 * A llama squealing: "eee-EEE-eee-EEE", climbing and wobbling, then a warble at the top and a
 * drop away. It sits an octave lower than a real bleat, which is what makes it sound like a big
 * animal rather than a squeaky toy: [frequency Hz, start s, length s, bend from Hz]
 */
const LLAMA_SQUEEAL: Array<[number, number, number, number]> = [
  [164.81, 0, 0.13, 146.83], // E3
  [220.0, 0.12, 0.13, 164.81], // A3
  [293.66, 0.24, 0.15, 220.0], // D4
  [349.23, 0.38, 0.17, 293.66], // F4
  [311.13, 0.54, 0.11, 349.23], // D#4, the warble at the top
  [261.63, 0.65, 0.16, 311.13], // C4, falling away
  [329.63, 0.81, 0.34, 261.63], // E4, held and wobbling
];

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  try {
    context ??= new AudioContext();
  } catch {
    return null;
  }
  // Suspended before any click, or "interrupted" in WebKit after sleep or another app taking audio
  if (context.state !== "running") void context.resume().catch(() => {});
  return context;
}

/*
 * Sounds are set off by polls (an issue done, a decision, a login), never by a click. Browsers only
 * start audio from a click or key press, and WebKit (the Mac app) only during one, so wake the
 * shared context on every interaction; it's then running when a poll wants to play.
 */
if (typeof window !== "undefined") {
  const unlock = () => {
    if (context?.state !== "running") audioContext();
  };
  for (const event of ["pointerdown", "keydown", "touchend"]) {
    window.addEventListener(event, unlock, { capture: true, passive: true });
  }
}

/**
 * A fresh output to play into, or null when audio isn't available. Until the viewer has clicked or
 * pressed a key in the page, sounds are silent.
 */
function output(): { ctx: AudioContext; out: AudioNode; start: number } | null {
  const ctx = audioContext();
  if (!ctx) return null;
  const out = ctx.createGain();
  out.gain.value = VOLUME;
  out.connect(ctx.destination);
  return { ctx, out, start: ctx.currentTime + 0.05 };
}

/** An issue done: the victory fanfare. */
export function playCheer(): void {
  const audio = output();
  if (!audio) return;
  const { ctx, out, start } = audio;
  LEAD.forEach(([freq, at, length], i) => note(ctx, out, "square", freq, start + at, length, 1, i === LEAD.length - 1));
  for (const [freq, at, length] of BASS) note(ctx, out, "triangle", freq, start + at, length, 1.6, false);
}

/** An agent needs a decision: the two-note chime, on a softer triangle lead with a square an octave up. */
export function playDecisionAlert(): void {
  const audio = output();
  if (!audio) return;
  const { ctx, out, start } = audio;
  for (const [freq, at, length, level] of DECISION_CHIME) {
    note(ctx, out, "triangle", freq, start + at, length, level * 1.4, false);
    note(ctx, out, "square", freq * 2, start + at, length, level * 0.25, false);
  }
}

/** Someone logged in: "hel-lo!" on a square lead, the second note bending up and held with vibrato. */
export function playHello(): void {
  const audio = output();
  if (!audio) return;
  const { ctx, out, start } = audio;
  HELLO.forEach(([freq, at, length, from], i) => {
    const last = i === HELLO.length - 1;
    note(ctx, out, "square", freq, start + at, length, 1, last, from);
    note(ctx, out, "triangle", freq / 2, start + at, length, 1.2, false, from / 2);
  });
}

/**
 * The About tab's llama: the squeal on a square lead, wobbling far harder and faster than a
 * chiptune note because a bleat does. The weight comes from the stack underneath it — a triangle
 * an octave down for the chest, and a pure sine two octaves down that barely moves, so the bottom
 * of the sound holds still while the lead wobbles over the top of it.
 */
export function playLlamaSqueel(): void {
  const audio = output();
  if (!audio) return;
  const { ctx, out, start } = audio;
  LLAMA_SQUEEAL.forEach(([freq, at, length, from], i) => {
    const held = i === LLAMA_SQUEEAL.length - 1;
    note(ctx, out, "square", freq, start + at, length, 0.8, true, from, 17, 0.035);
    // The nasal edge, kept quiet so it colours the lead without making it shrill again
    note(ctx, out, "sawtooth", freq * 2, start + at, length, 0.14, held, from * 2, 17, 0.035);
    note(ctx, out, "triangle", freq / 2, start + at, length, 0.7, false, from / 2);
    // The floor: a sine so far down it reads as weight rather than pitch
    note(ctx, out, "sine", freq / 4, start + at, length, 0.55, false, from / 4);
  });
}

function note(
  ctx: AudioContext,
  out: AudioNode,
  type: OscillatorType,
  freq: number,
  start: number,
  length: number,
  level: number,
  vibrato: boolean,
  /** Slide up (or down) to the note from this frequency over its first stretch */
  bendFrom = freq,
  /** Vibrato speed in Hz, for the wobbly ones like the llama */
  vibratoHz = 7,
  /** Vibrato depth as a fraction of the note's frequency */
  vibratoDepth = 0.012,
): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(bendFrom, start);
  if (bendFrom !== freq) osc.frequency.exponentialRampToValueAtTime(freq, start + Math.min(0.08, length * 0.3));
  if (vibrato) {
    // Vibrato eases in on the held note, like a chiptune lead
    const lfo = ctx.createOscillator();
    lfo.frequency.value = vibratoHz;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, start);
    depth.gain.linearRampToValueAtTime(freq * vibratoDepth, start + length * 0.6);
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(start);
    lfo.stop(start + length);
  }
  const gain = ctx.createGain();
  // Crisp attack, a short plateau, then a release so notes don't click
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(level, start + 0.005);
  gain.gain.setValueAtTime(level, start + length * 0.7);
  gain.gain.linearRampToValueAtTime(0, start + length);
  osc.connect(gain).connect(out);
  osc.start(start);
  osc.stop(start + length + 0.01);
}
