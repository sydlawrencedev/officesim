import { invoke } from "@tauri-apps/api/core";
import { getData, inTauri } from "./bridge";
import { navigate } from "./sdkShim";

/*
 * The office UI calls a few Paperclip REST routes directly. There's no Paperclip server behind the
 * Mac app, so those calls are answered here instead:
 * - /api/heartbeat-runs/:runId/log, a run's live log behind the speech bubbles, is read from the
 *   agent's own transcript by the backend.
 * - /api/companies/:id/attention, the agents waiting on a decision, comes from the backend too.
 * Any other /api/ route gets a 404 straight away rather than the webview's index.html.
 */

const nativeFetch = window.fetch.bind(window);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function answer(url: URL): Promise<Response> {
  const log = url.pathname.match(/^\/api\/heartbeat-runs\/([^/]+)\/log$/);
  if (log && inTauri) {
    try {
      return json(await invoke("read_run_log", {
        runId: decodeURIComponent(log[1]),
        offset: Number(url.searchParams.get("offset") ?? 0),
        limitBytes: Number(url.searchParams.get("limitBytes") ?? 0),
      }));
    } catch (error) {
      return json({ error: String(error) }, 404);
    }
  }
  if (/^\/api\/companies\/[^/]+\/attention$/.test(url.pathname)) {
    return json(inTauri ? await getData("attention", {}) : { items: [] });
  }
  return json({ error: "Not available in OfficeSim for Mac" }, 404);
}

/** "Open in a new tab" links are host routes (#/agents/...): followed like a click instead. */
function installOpenBridge(): void {
  const nativeOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    const href = typeof url === "string" ? url : url?.href ?? "";
    if (href.startsWith("#/")) {
      navigate(href.slice(1));
      return null;
    }
    return nativeOpen(url, target, features);
  };
}

export function installFetchBridge(): void {
  installOpenBridge();
  window.fetch = (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, window.location.href);
    if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) return answer(url);
    return nativeFetch(input, init);
  };
}
