import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { localData, localAction } from "./localHandlers";
import { devMockData, devMockAction } from "./devMock";

/*
 * Where the office's data keys are answered. A few are app configuration kept in the webview
 * (localHandlers); the rest go to the Rust backend, which reads the agents' local files. Opened in
 * a plain browser (vite dev without Tauri), a mock backend stands in so the UI can be worked on.
 */

/** Emitted by the backend when an agent source's files change. */
export const AGENTS_CHANGED_EVENT = "agents-changed";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function getData(key: string, params: Record<string, unknown>): Promise<unknown> {
  const local = await localData(key, params);
  if (local !== undefined) return local;
  if (!inTauri) return devMockData(key, params);
  return invoke("get_data", { key, params });
}

export async function runAction(key: string, params: Record<string, unknown>): Promise<unknown> {
  const local = await localAction(key, params);
  if (local !== undefined) return local;
  if (!inTauri) return devMockAction(key, params);
  return invoke("run_action", { key, params });
}

/** Calls back whenever the backend sees agent activity; returns an unsubscribe function. */
export function onAgentsChanged(callback: () => void): () => void {
  if (!inTauri) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void listen(AGENTS_CHANGED_EVENT, callback).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
