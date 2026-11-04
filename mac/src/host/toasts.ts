import type { PluginToastInput } from "./sdkShim";

/*
 * Paperclip draws plugin toasts in its own UI; the Mac app draws them itself, stacked in the
 * bottom right corner of the window.
 */

const DEFAULT_TTL_MS = 5000;
const TONE_COLORS: Record<string, string> = { info: "#3b82f6", success: "#22c55e", warn: "#f59e0b", error: "#ef4444" };

let stack: HTMLDivElement | null = null;
let nextId = 0;
const shown = new Map<string, HTMLDivElement>();

function container(): HTMLDivElement {
  if (stack) return stack;
  stack = document.createElement("div");
  Object.assign(stack.style, {
    position: "fixed", right: "16px", bottom: "16px", zIndex: "10000",
    display: "flex", flexDirection: "column", gap: "8px", maxWidth: "320px",
  });
  document.body.appendChild(stack);
  return stack;
}

export function showToast(input: PluginToastInput): string | null {
  const id = input.dedupeKey ?? input.id ?? `toast-${nextId++}`;
  shown.get(id)?.remove();
  const toast = document.createElement("div");
  Object.assign(toast.style, {
    background: "#111827", color: "#f9fafb", borderLeft: `4px solid ${TONE_COLORS[input.tone ?? "info"]}`,
    padding: "10px 12px", borderRadius: "6px", font: "13px/1.4 -apple-system, system-ui, sans-serif",
    boxShadow: "0 4px 16px rgba(0,0,0,.35)",
  });
  const title = document.createElement("div");
  title.style.fontWeight = "600";
  title.textContent = input.title;
  toast.appendChild(title);
  if (input.body) {
    const body = document.createElement("div");
    body.style.opacity = "0.8";
    body.textContent = input.body;
    toast.appendChild(body);
  }
  container().appendChild(toast);
  shown.set(id, toast);
  window.setTimeout(() => {
    toast.remove();
    if (shown.get(id) === toast) shown.delete(id);
  }, input.ttlMs ?? DEFAULT_TTL_MS);
  return id;
}
