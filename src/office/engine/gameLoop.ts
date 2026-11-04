import { MAX_DELTA_TIME_SEC } from '../../constants.js';

/** @internal */
export interface GameLoopCallbacks {
  update: (dt: number) => void;
  render: (ctx: CanvasRenderingContext2D) => void;
}

/** Stops the loop; `redraw()` renders immediately (e.g. after a resize cleared the canvas). */
export type GameLoopHandle = (() => void) & { redraw: () => void };

export function startGameLoop(canvas: HTMLCanvasElement, callbacks: GameLoopCallbacks): GameLoopHandle {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  let lastTime = 0;
  let rafId = 0;
  let stopped = false;

  const frame = (time: number) => {
    if (stopped) return;
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC);
    lastTime = time;

    callbacks.update(dt);

    ctx.imageSmoothingEnabled = false;
    callbacks.render(ctx);

    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);

  const stop = () => {
    stopped = true;
    cancelAnimationFrame(rafId);
  };
  return Object.assign(stop, {
    redraw: () => {
      if (stopped) return;
      ctx.imageSmoothingEnabled = false;
      callbacks.render(ctx);
    },
  });
}
