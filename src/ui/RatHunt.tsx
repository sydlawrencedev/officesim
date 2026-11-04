import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { boltRats, RAT_HUNT_MS, shootRatAt, startRats, stopRats } from "../office/engine/rats.js";

/*
 * Rat hunt: a 20-second mini game in the office, when the company's done tasks reach a multiple of
 * 20. Rats scurry about the rooms on the camera, under the
 * furniture too (they live in the office: src/office/engine/rats.ts); this is the hunt over the
 * camera: the crosshair cursor, the shots, kills in the bottom left, and a stopwatch in the bottom
 * right filling up in red over the 20 seconds.
 */

export const RAT_HUNT_EVERY_DONE = 20;
const GAME_MS = RAT_HUNT_MS;
/** The end banner shows this long before the hunt clears away. */
const END_BANNER_MS = 5_000;
/** The start banner shows this long. */
const START_BANNER_MS = 2_500;
/** How long a shot's flash lasts. */
const FLASH_MS = 180;

type Shot = { x: number; y: number; at: number; hit: boolean };

/** A red pixel crosshair for the cursor, hot spot in the middle. */
const CROSSHAIR = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" shape-rendering="crispEdges">
    <circle cx="16" cy="16" r="10" fill="none" stroke="#000" stroke-width="4"/>
    <circle cx="16" cy="16" r="10" fill="none" stroke="#ef4444" stroke-width="2"/>
    <path d="M16 1v10M16 21v10M1 16h10M21 16h10" stroke="#000" stroke-width="4"/>
    <path d="M16 2v8M16 22v8M2 16h8M22 16h8" stroke="#ef4444" stroke-width="2"/>
    <rect x="15" y="15" width="2" height="2" fill="#ef4444"/>
  </svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, crosshair`;
})();

/** A short squelch when a rat is hit, made on the fly (no sound files). */
function useSplat() {
  const audio = useRef<AudioContext | null>(null);
  return () => {
    try {
      audio.current ??= new AudioContext();
      const ctx = audio.current;
      const now = ctx.currentTime;
      const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.18), ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
      const source = ctx.createBufferSource();
      source.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(1800, now);
      filter.frequency.exponentialRampToValueAtTime(220, now + 0.18);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.5, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      source.connect(filter).connect(gain).connect(ctx.destination);
      source.start(now);
      // A squeak on top
      const squeak = ctx.createOscillator();
      const squeakGain = ctx.createGain();
      squeak.type = "square";
      squeak.frequency.setValueAtTime(2400, now);
      squeak.frequency.exponentialRampToValueAtTime(1200, now + 0.08);
      squeakGain.gain.setValueAtTime(0.06, now);
      squeakGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      squeak.connect(squeakGain).connect(ctx.destination);
      squeak.start(now);
      squeak.stop(now + 0.1);
    } catch {
      // No audio: the hunt goes on silently
    }
  };
}

export function RatHunt({ reason, onEnd }: { reason: string | null; onEnd: (kills: number) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shots = useRef<Shot[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [kills, setKills] = useState(0);
  const killsRef = useRef(0);
  const over = elapsed >= GAME_MS;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const splat = useSplat();

  // The rats come out with the hunt, and go (dead ones too) when it's over
  useEffect(() => {
    startRats();
    return stopRats;
  }, []);

  // The clock, and the shots' flashes
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const startedAt = performance.now();
    let frame = 0;
    let lastTick = 0;
    const size = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(wrap.clientWidth * ratio);
      canvas.height = Math.round(wrap.clientHeight * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    size();
    const observer = new ResizeObserver(size);
    observer.observe(wrap);
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
      shots.current = shots.current.filter((shot) => now - shot.at < FLASH_MS);
      for (const shot of shots.current) {
        const age = (now - shot.at) / FLASH_MS;
        ctx.strokeStyle = shot.hit ? `rgba(239,68,68,${1 - age})` : `rgba(255,255,255,${0.8 * (1 - age)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(shot.x, shot.y, 4 + age * 12, 0, Math.PI * 2);
        ctx.stroke();
      }
      const gameTime = now - startedAt;
      if (now - lastTick > 100 || gameTime >= GAME_MS) {
        lastTick = now;
        setElapsed(Math.min(GAME_MS, gameTime));
      }
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // Time's up: the rest of the rats run for it, the score shows a moment, then the hunt clears away
  useEffect(() => {
    if (!over) return;
    boltRats();
    const timer = window.setTimeout(() => onEndRef.current(killsRef.current), END_BANNER_MS);
    return () => window.clearTimeout(timer);
  }, [over]);

  // Escape ends it early
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEndRef.current(killsRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function shoot(event: ReactPointerEvent<HTMLDivElement>) {
    if (over) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const hit = shootRatAt(event.clientX, event.clientY);
    shots.current.push({ x: event.clientX - bounds.left, y: event.clientY - bounds.top, at: performance.now(), hit });
    if (!hit) return;
    killsRef.current += 1;
    setKills(killsRef.current);
    splat();
  }

  const left = Math.max(0, Math.ceil((GAME_MS - elapsed) / 1000));
  const fraction = elapsed / GAME_MS;
  const showStart = elapsed < START_BANNER_MS;

  return (
    <div
      ref={wrapRef}
      role="application"
      aria-label="Rat hunt: click the rats"
      onPointerDown={shoot}
      style={{ ...styles.overlay, cursor: over ? "default" : CROSSHAIR }}
    >
      <canvas ref={canvasRef} style={styles.canvas} />
      {showStart ? (
        <div style={styles.banner}>
          <div style={styles.bannerTitle}>🐀 RAT HUNT! 🐀</div>
          <div>{reason ?? "Squash as many as you can in 20 seconds"}</div>
        </div>
      ) : null}
      {over ? (
        <div style={styles.banner}>
          <div style={styles.bannerTitle}>TIME!</div>
          <div>
            {kills === 0 ? "Not a single rat. They'll be back." : kills === 1 ? "You got 1 rat." : `You got ${kills} rats.`}
          </div>
        </div>
      ) : null}
      <div style={{ ...styles.hud, left: 12 }} aria-live="polite">
        <span style={{ fontSize: 22 }} aria-hidden="true">
          🐀
        </span>
        <span>
          <span style={styles.hudLabel}>KILLS</span>
          <span style={styles.hudNumber}>{kills}</span>
        </span>
      </div>
      <div style={{ ...styles.hud, right: 12, padding: 6 }} title={`${left} seconds left`}>
        <Stopwatch fraction={fraction} secondsLeft={left} />
      </div>
      <button
        type="button"
        aria-label="Stop the rat hunt"
        title="Stop (Esc)"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onEnd(killsRef.current)}
        style={styles.close}
      >
        ✕
      </button>
    </div>
  );
}

/** A pixel stopwatch whose face fills up in red as the hunt goes on. */
function Stopwatch({ fraction, secondsLeft }: { fraction: number; secondsLeft: number }) {
  const size = 64;
  const r = 24;
  const cx = size / 2;
  const cy = size / 2 + 4;
  const angle = Math.min(1, fraction) * Math.PI * 2;
  const end = { x: cx + r * Math.sin(angle), y: cy - r * Math.cos(angle) };
  const filled =
    fraction >= 1
      ? <circle cx={cx} cy={cy} r={r} fill="#dc2626" />
      : fraction > 0
        ? <path d={`M${cx} ${cy} L${cx} ${cy - r} A${r} ${r} 0 ${angle > Math.PI ? 1 : 0} 1 ${end.x} ${end.y} Z`} fill="#dc2626" />
        : null;
  return (
    <svg width={size} height={size + 4} viewBox={`0 0 ${size} ${size + 4}`} aria-hidden="true">
      {/* Crown and buttons */}
      <rect x={cx - 5} y={0} width={10} height={5} fill="#cbd5e1" stroke="#0f172a" strokeWidth={1.5} />
      <rect x={cx - 2} y={5} width={4} height={4} fill="#94a3b8" />
      <rect x={cx + 17} y={8} width={6} height={4} fill="#94a3b8" transform={`rotate(40 ${cx + 20} 10)`} />
      <circle cx={cx} cy={cy} r={r + 4} fill="#e2e8f0" stroke="#0f172a" strokeWidth={2} />
      <circle cx={cx} cy={cy} r={r} fill="#f8fafc" />
      {filled}
      {Array.from({ length: 12 }, (_, tick) => {
        const a = (tick / 12) * Math.PI * 2;
        return <line key={tick} x1={cx + (r - 4) * Math.sin(a)} y1={cy - (r - 4) * Math.cos(a)} x2={cx + r * Math.sin(a)} y2={cy - r * Math.cos(a)} stroke="#0f172a" strokeWidth={1.5} />;
      })}
      <line x1={cx} y1={cy} x2={end.x} y2={end.y} stroke="#0f172a" strokeWidth={2} strokeLinecap="round" />
      <text x={cx} y={cy + 4} textAnchor="middle" fontSize={13} fontWeight={700} fill={fraction > 0.5 ? "#fff" : "#0f172a"} stroke={fraction > 0.5 ? "#7f1d1d" : "none"} strokeWidth={0.6} style={{ fontFamily: "ui-monospace, monospace" }}>
        {secondsLeft}
      </text>
    </svg>
  );
}

const styles = {
  overlay: { position: "absolute", inset: 0, zIndex: 20, userSelect: "none", touchAction: "none" },
  canvas: { position: "absolute", inset: 0, width: "100%", height: "100%", imageRendering: "pixelated" },
  banner: {
    position: "absolute",
    left: "50%",
    top: "38%",
    transform: "translate(-50%, -50%)",
    padding: "14px 22px",
    background: "rgba(15, 23, 42, 0.88)",
    border: "3px solid #dc2626",
    color: "#f8fafc",
    textAlign: "center",
    fontFamily: "ui-monospace, monospace",
    fontSize: 14,
    pointerEvents: "none",
    boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
  },
  bannerTitle: { fontSize: 26, fontWeight: 800, color: "#fca5a5", letterSpacing: 2, marginBottom: 6 },
  hud: {
    position: "absolute",
    bottom: 12,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 12px",
    background: "rgba(15, 23, 42, 0.85)",
    border: "2px solid #475569",
    color: "#f8fafc",
    fontFamily: "ui-monospace, monospace",
    pointerEvents: "none",
  },
  hudLabel: { display: "block", fontSize: 10, letterSpacing: 2, color: "#94a3b8" },
  hudNumber: { display: "block", fontSize: 24, fontWeight: 800, lineHeight: 1, color: "#fca5a5" },
  close: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 28,
    height: 28,
    border: "2px solid #475569",
    background: "rgba(15, 23, 42, 0.85)",
    color: "#f8fafc",
    fontSize: 14,
    cursor: "pointer",
  },
} satisfies Record<string, CSSProperties>;
