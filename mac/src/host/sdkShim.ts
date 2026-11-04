import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { getData, onAgentsChanged, runAction } from "./bridge";
import { showToast } from "./toasts";

/*
 * Stands in for "@paperclipai/plugin-sdk/ui" in the Mac app (aliased in vite.config.ts), with the
 * same names and shapes as the hooks the office UI uses, so ../src/ui runs unchanged outside
 * Paperclip. Data comes from bridge.ts instead of a plugin worker.
 */

/** The office shows every agent on this Mac as one "company". */
export const LOCAL_WORKSPACE_ID = "local";

export type PluginBridgeError = { code: string; message: string; details?: unknown };

export interface PluginHostContext {
  companyId: string | null;
  companyPrefix: string | null;
  projectId: string | null;
  entityId: string | null;
  entityType: string | null;
  parentEntityId?: string | null;
  userId: string | null;
}

export interface PluginDataResult<T = unknown> {
  data: T | null;
  loading: boolean;
  error: PluginBridgeError | null;
  refresh(): void;
}

export type PluginActionFn = (params?: Record<string, unknown>) => Promise<unknown>;
export type PluginSidebarProps = { context: PluginHostContext };
export type PluginSettingsPageProps = { context: PluginHostContext };
export type PluginPageProps = { context: PluginHostContext };

export type PluginToastTone = "info" | "success" | "warn" | "error";
export type PluginToastInput = {
  id?: string;
  dedupeKey?: string;
  title: string;
  body?: string;
  tone?: PluginToastTone;
  ttlMs?: number;
  action?: { label: string; href: string };
};
export type PluginToastFn = (input: PluginToastInput) => string | null;

export type HostNavigationOptions = { replace?: boolean; state?: unknown };
export interface HostNavigation {
  resolveHref(to: string): string;
  navigate(to: string, options?: HostNavigationOptions): void;
  linkProps(to: string, options?: HostNavigationOptions & { target?: string; rel?: string }): {
    href: string;
    target?: string;
    rel?: string;
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  };
}

function toBridgeError(error: unknown): PluginBridgeError {
  if (error && typeof error === "object" && "message" in error) return { code: "WORKER_ERROR", message: String(error.message) };
  return { code: "WORKER_ERROR", message: String(error) };
}

/** Data that follows agent activity, re-read as soon as the backend sees an agent's files change. */
const LIVE_KEYS = new Set(["camera-room", "agent-stats", "kanban-board", "issues-done", "done-tasks", "character-settings", "harnesses"]);

export function usePluginData<T = unknown>(key: string, params: Record<string, unknown> = {}): PluginDataResult<T> {
  const paramsKey = JSON.stringify(params);
  const [state, setState] = useState<{ data: T | null; error: PluginBridgeError | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  // Bumped to re-fetch; responses to older requests are dropped
  const [version, setVersion] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    setState((prev) => ({ ...prev, loading: true }));
    getData(key, JSON.parse(paramsKey) as Record<string, unknown>).then(
      (data) => {
        if (request === latest.current) setState({ data: data as T, error: null, loading: false });
      },
      (error: unknown) => {
        if (request === latest.current) setState({ data: null, error: toBridgeError(error), loading: false });
      },
    );
  }, [key, paramsKey, version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const live = LIVE_KEYS.has(key);
  useEffect(() => (live ? onAgentsChanged(refresh) : undefined), [live, refresh]);

  return { ...state, refresh };
}

export function usePluginAction(key: string): PluginActionFn {
  return useCallback((params?: Record<string, unknown>) => runAction(key, params ?? {}), [key]);
}

const HOST_CONTEXT: PluginHostContext = {
  companyId: LOCAL_WORKSPACE_ID,
  companyPrefix: null,
  projectId: null,
  entityId: null,
  entityType: null,
  userId: null,
};

export function useHostContext(): PluginHostContext {
  return HOST_CONTEXT;
}

/** Paperclip routes (/agents/:id, /issues...) are handed to the backend, which opens what fits. */
export function navigate(to: string): void {
  runAction("navigate", { to }).catch((error: unknown) => {
    showToast({ title: "Couldn't open that", body: error instanceof Error ? error.message : String(error), tone: "warn" });
  });
}

export function useHostNavigation(): HostNavigation {
  return useMemo(
    () => ({
      resolveHref: (to: string) => `#${to}`,
      navigate: (to: string) => navigate(to),
      linkProps: (to: string, options?: { target?: string; rel?: string }) => ({
        href: `#${to}`,
        target: options?.target,
        rel: options?.rel,
        onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          navigate(to);
        },
      }),
    }),
    [],
  );
}

export function useHostLocation(): { pathname: string; search: string; hash: string } {
  return { pathname: "/", search: "", hash: "" };
}

export function usePluginStream<T = unknown>(_channel: string): { events: T[]; lastEvent: T | null; connected: boolean; connecting: boolean; error: Error | null; close(): void } {
  return { events: [], lastEvent: null, connected: false, connecting: false, error: null, close() {} };
}

export function usePluginToast(): PluginToastFn {
  return showToast;
}
