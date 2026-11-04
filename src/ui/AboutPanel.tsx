import { useCallback, useEffect, useRef, useState } from "react";
import { PLUGIN_VERSION } from "../manifest.js";
import { PixelSprite } from "./gameUi.js";
import {
  LLAMA_IDLE_FRAME_MS,
  LLAMA_IDLE_FRAMES,
  LLAMA_SQUEAL_FRAME_MS,
  llamaFrame,
} from "./llama.js";
import { playLlamaSqueel } from "./sounds.js";

/** Where the office is built */
const LABS_URL = "https://minithlabs.com";

/** The other projects the office is built on top of, or owes its look to */
const INSPIRATIONS: Array<{ name: string; href?: string }> = [
  { name: "Pixel Agents", href: "https://github.com/pixel-agents-hq/pixel-agents" },
  { name: "JIK-A-4 Metro City (CC0)", href: "https://jik-a-4.itch.io/metrocity" },
  { name: "Theme Hospital" },
  { name: "Theme Park" },
];

/**
 * OfficeSim's GitHub repo. Left empty until the source is actually public, so the panel tells the
 * truth about where the code lives instead of linking somewhere that 404s.
 */
const REPO_URL = "";

/** How long the llama keeps up the squeal for before settling back to its shuffle */
const SQUEAL_MS = 900;

/**
 * Whether the reader would rather the llama stood still. Handled here rather than in CSS because
 * the animation is React swapping sprite frames, not a keyframe.
 */
function usePreferStill(): boolean {
  const [still, setStill] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStill(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return still;
}

export function AboutPanel() {
  const [frame, setFrame] = useState(0);
  const [squealing, setSquealing] = useState(false);
  const still = usePreferStill();
  const settle = useRef(0);

  // The idle shuffle and the squeal share one clock, so the llama can't desync when it squawks
  useEffect(() => {
    if (still) return;
    const timer = window.setInterval(
      () => setFrame((current) => current + 1),
      squealing ? LLAMA_SQUEAL_FRAME_MS : LLAMA_IDLE_FRAME_MS,
    );
    return () => window.clearInterval(timer);
  }, [squealing, still]);

  useEffect(() => () => window.clearTimeout(settle.current), []);

  const squeal = useCallback(() => {
    playLlamaSqueel();
    setFrame(0);
    setSquealing(true);
    // Re-clicking mid-squeal restarts it rather than being swallowed by the one already playing
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => setSquealing(false), SQUEAL_MS);
  }, []);

  const sprite = llamaFrame(squealing ? LLAMA_IDLE_FRAMES + (frame % 2) : frame % LLAMA_IDLE_FRAMES);

  return (
    <div className="op-about">
      <div className="op-about-stage" data-squealing={squealing || undefined}>
        <button
          type="button"
          className="op-about-llama"
          onClick={squeal}
          data-squealing={squealing || undefined}
          aria-label="Give the llama a pat"
        >
          <PixelSprite sprite={sprite} scale={2} />
        </button>
      </div>
      <div className="op-about-copy">
        <h3>
          OfficeSim <span className="op-about-version">v{PLUGIN_VERSION}</span>
        </h3>
        <p className="op-about-tagline">Proudly shareware.</p>
        <p>
          Built by{" "}
          <a className="op-about-link" href={LABS_URL} target="_blank" rel="noreferrer">
            Minith Labs
          </a>
          .
        </p>
        <p>
          Open source —{" "}
          {REPO_URL ? (
            <a className="op-about-link" href={REPO_URL} target="_blank" rel="noreferrer">
              please do submit a pull request on GitHub
            </a>
          ) : (
            <span className="op-about-link" data-coming="true">
              please do submit a pull request on GitHub (link coming)
            </span>
          )}
          .
        </p>
        <div className="op-about-credits">
          <h4>Built on the shoulders of giants</h4>
          <ul>
            {INSPIRATIONS.map((credit) => (
              <li key={credit.name}>
                {credit.href ? (
                  <a className="op-about-link" href={credit.href} target="_blank" rel="noreferrer">
                    {credit.name}
                  </a>
                ) : (
                  credit.name
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}