import { useState } from "react";
import { DONE_TIMELINE_WINDOW_MINUTES, type IssuesDone } from "../issuesDone.js";

const BAR_W = 5;
const BAR_GAP = 2;
const CHART_H = 18;

const clock = (date: Date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Issues done over the last two hours, one bar per 10-minute window (oldest on the left), with the
 * number of issues ever done beside it. Hovering shows a tooltip; hovering a bar picks out its window.
 */
export function DoneTimeline({ data }: { data: IssuesDone | null }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const windows = data?.windows ?? [];
  const recentTotal = windows.reduce((sum, count) => sum + count, 0);
  const peak = Math.max(1, ...windows);
  const endsAt = data ? new Date(data.endsAt).getTime() : Date.now();
  const hours = (windows.length * DONE_TIMELINE_WINDOW_MINUTES) / 60;
  const width = Math.max(0, windows.length * (BAR_W + BAR_GAP) - BAR_GAP);
  const windowOf = (i: number) => {
    const end = new Date(endsAt - (windows.length - 1 - i) * DONE_TIMELINE_WINDOW_MINUTES * 60_000);
    return `${clock(new Date(end.getTime() - DONE_TIMELINE_WINDOW_MINUTES * 60_000))}–${clock(end)}`;
  };
  const busiest = recentTotal ? windows.indexOf(Math.max(...windows)) : -1;

  return (
    <div
      className="op-status op-timeline"
      aria-label={`${data?.total ?? 0} issues done`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        setOpen(false);
        setHovered(null);
      }}
    >
      <span>Done</span>
      <svg width={width} height={CHART_H} viewBox={`0 0 ${width} ${CHART_H}`} aria-hidden="true">
        {windows.map((count, i) => {
          // Whole pixels, so the bars stay crisp; an empty window keeps a 1px stub on the baseline
          const height = count ? Math.max(2, Math.round((count / peak) * CHART_H)) : 1;
          const x = i * (BAR_W + BAR_GAP);
          return (
            <g key={i} onMouseEnter={() => setHovered(i)}>
              {/* The whole column is the hover target, not just the bar */}
              <rect x={x - BAR_GAP / 2} y={0} width={BAR_W + BAR_GAP} height={CHART_H} fill="transparent" />
              <rect
                x={x}
                y={CHART_H - height}
                width={BAR_W}
                height={height}
                className={count ? "op-timeline-bar" : "op-timeline-empty"}
                data-hovered={hovered === i || undefined}
              />
            </g>
          );
        })}
      </svg>
      <span className="op-timeline-total">{data?.total ?? 0}</span>

      {open && data ? (
        <div role="tooltip" className="op-timeline-tip">
          <div className="op-timeline-tip-head">
            <strong>Issues done</strong>
            <span className="op-timeline-tip-big">{data.total}</span>
          </div>
          {hovered !== null ? (
            <div className="op-timeline-tip-row">
              <span>{windowOf(hovered)}</span>
              <span className="op-timeline-tip-count" data-zero={!windows[hovered] || undefined}>
                {windows[hovered]} done
              </span>
            </div>
          ) : (
            <>
              <div className="op-timeline-tip-row">
                <span>Last {hours} hours</span>
                <span className="op-timeline-tip-count" data-zero={!recentTotal || undefined}>
                  {recentTotal} done
                </span>
              </div>
              {busiest >= 0 ? (
                <div className="op-timeline-tip-row op-timeline-tip-dim">
                  <span>Busiest</span>
                  <span>
                    {windowOf(busiest)} · {windows[busiest]}
                  </span>
                </div>
              ) : null}
            </>
          )}
          <div className="op-timeline-tip-foot">Each bar is {DONE_TIMELINE_WINDOW_MINUTES} minutes · hover one for its count</div>
        </div>
      ) : null}
    </div>
  );
}
