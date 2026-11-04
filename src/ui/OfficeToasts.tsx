/** Something that just happened in the office, shown as a toast */
export type OfficeToast = {
  /** Unique per toast */
  key: string;
  /** An issue moved to done, an agent now waiting on a decision, or someone logging in to the product */
  kind: "done" | "decision" | "login";
  /** Shown beside the heading, e.g. the issue's identifier */
  tag: string | null;
  title: string;
  /** e.g. "by Tech Team" */
  detail: string | null;
};

/** At most this many toasts show at once; older ones go first */
export const MAX_TOASTS = 4;

const HEADINGS: Record<OfficeToast["kind"], { heading: string; badge: string; open: string }> = {
  done: { heading: "Done", badge: "✓", open: "Open issue" },
  decision: { heading: "Decision needed", badge: "?", open: "Open decisions" },
  login: { heading: "Hello", badge: "👋", open: "Dismiss" },
};

/**
 * Toasts stacked in the top corner of the window. Each slides in, stays a few seconds (held while
 * hovered) and fades away; clicking one opens what it's about.
 */
export function OfficeToasts({
  toasts,
  onExpire,
  onOpen,
}: {
  toasts: OfficeToast[];
  onExpire: (key: string) => void;
  onOpen: (toast: OfficeToast, newTab: boolean) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="op-toasts" aria-live="polite">
      {toasts.map((toast) => {
        const look = HEADINGS[toast.kind];
        return (
          <button
            key={toast.key}
            type="button"
            className="op-toast"
            data-kind={toast.kind}
            onAnimationEnd={(event) => {
              if (event.animationName === "op-toast-life") onExpire(toast.key);
            }}
            onClick={(event) => onOpen(toast, event.metaKey || event.ctrlKey)}
            title={look.open}
          >
            <span className="op-toast-badge" aria-hidden="true">{look.badge}</span>
            <span className="op-toast-body">
              <span className="op-toast-head">
                <strong>{look.heading}</strong>
                {toast.tag ? <span className="op-toast-id">{toast.tag}</span> : null}
              </span>
              <span className="op-toast-title">{toast.title}</span>
              {toast.detail ? <span className="op-toast-by">{toast.detail}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
