import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { HarnessIcon, HostFullscreen, HostMusic } from "../../../src/ui/hostExtensions";
import { iconFor } from "./harnessIcons";
import { musicPermission, nativeMusicStatus, startNativeMusic, stopNativeMusic, type NativeMusicStatus } from "./nativeMusic";
import { usePluginAction, usePluginData } from "./sdkShim";

/*
 * The Mac app's version of src/ui/hostExtensions.ts (swapped in by mac/vite.config.ts): an "Agent
 * sources" section at the top of the Settings tab, listing the agent harnesses and task sources
 * OfficeSim can read and turning each on or off. Changes apply straight away; a source that's off
 * isn't read at all. And each agent's harness icon, shown before its name.
 */

type Harness = {
  id: string;
  label: string;
  location: string;
  detected: boolean;
  enabled: boolean;
  /** Its agents now, when it's detected and on. */
  agents: number | null;
  problem: string | null;
};

/** Where the office's work items (kanban, done timeline, done tasks) come from. */
type TaskSource = Omit<Harness, "agents"> & {
  /** Its open issues now, when it's detected and on. */
  open: number | null;
};

type Sources = { harnesses: Harness[]; taskSources: TaskSource[] };

/** A source's row: its toggle, icon, name, what it has now, and where it reads from. */
type SourceRow = Omit<Harness, "agents"> & { icon: string; count: string };

// Matching the other Settings sections (src/ui/SettingsPanel.tsx)
const styles = {
  section: {
    display: "grid",
    gap: 12,
    padding: 14,
    border: "2px solid",
    borderColor: "var(--op-lo, #3a4a5b) var(--op-hi, #a9bacb) var(--op-hi, #a9bacb) var(--op-lo, #3a4a5b)",
    background: "var(--op-field, #1b2530)",
    color: "var(--op-field-ink, #e8f0d8)",
  },
  heading: { margin: 0, fontSize: 14, fontWeight: 700, color: "#f5d547" },
  hint: { margin: 0, fontSize: 12, opacity: 0.7, lineHeight: 1.5 },
  list: { display: "grid", gap: 8, margin: 0, padding: 0, listStyle: "none" },
  row: { display: "flex", gap: 10, alignItems: "flex-start" },
  name: { fontSize: 13, fontWeight: 700 },
  location: { fontSize: 11, opacity: 0.6, fontFamily: "ui-monospace, monospace", wordBreak: "break-all" },
  error: { color: "#ff8a80", fontSize: 12 },
} satisfies Record<string, CSSProperties>;

function Pill({ tone, children }: { tone: "on" | "off" | "warn"; children: ReactNode }) {
  const colors = { on: ["rgba(34,197,94,0.15)", "#4ade80"], off: ["rgba(148,163,184,0.15)", "inherit"], warn: ["rgba(248,113,113,0.15)", "#ff8a80"] }[tone];
  return (
    <span style={{ padding: "2px 8px", borderRadius: 999, fontSize: 11, whiteSpace: "nowrap", background: colors[0], color: colors[1] }}>{children}</span>
  );
}

function status(source: SourceRow): ReactNode {
  if (!source.detected) return <Pill tone="off">Not found</Pill>;
  if (!source.enabled) return <Pill tone="off">Off</Pill>;
  if (source.problem) return <Pill tone="warn">Can't read</Pill>;
  return <Pill tone="on">{source.count}</Pill>;
}

const plural = (count: number | null, one: string, many: string) => `${count ?? 0} ${count === 1 ? one : many}`;

function SourceList({ sources, pending, onToggle }: { sources: SourceRow[]; pending: Record<string, boolean>; onToggle: (source: SourceRow, enabled: boolean) => void }) {
  return (
    <ul style={styles.list}>
      {sources.map((source) => {
        const enabled = pending[source.id] ?? source.enabled;
        const icon = iconFor(source.icon);
        return (
          <li key={source.id} style={styles.row}>
            <input
              id={`source-${source.id}`}
              type="checkbox"
              // A source that isn't installed reads as off, whatever its saved setting
              checked={source.detected && enabled}
              disabled={!source.detected || source.id in pending}
              onChange={(event) => onToggle(source, event.target.checked)}
              style={{ marginTop: 3 }}
            />
            <label htmlFor={`source-${source.id}`} style={{ display: "grid", gap: 2, flex: 1, minWidth: 0, cursor: source.detected ? "pointer" : "default" }}>
              <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {icon ? <img src={icon.src} alt="" width={14} height={14} style={{ padding: 1, borderRadius: 3, background: "#f4f4f5" }} /> : null}
                <span style={styles.name}>{source.label}</span>
                {status(source)}
              </span>
              <span style={styles.location}>{source.location}</span>
              {source.problem && enabled ? <span style={styles.error}>{source.problem}</span> : null}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function Sources() {
  const { data, error, refresh } = usePluginData<Sources>("harnesses");
  const setEnabled = usePluginAction("set-harness-enabled");
  // Toggled but not yet saved, so the checkbox follows the click straight away
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  async function toggle(source: SourceRow, enabled: boolean) {
    setPending((current) => ({ ...current, [source.id]: enabled }));
    setSaveError(null);
    try {
      await setEnabled({ id: source.id, enabled });
    } catch (failure) {
      setSaveError(`Couldn't turn ${source.label} ${enabled ? "on" : "off"}: ${String(failure)}`);
    }
    refresh();
    setPending((current) => {
      const { [source.id]: _, ...rest } = current;
      return rest;
    });
  }

  const harnesses: SourceRow[] = (data?.harnesses ?? []).map((harness) => ({ ...harness, icon: harness.id, count: plural(harness.agents, "agent", "agents") }));
  // A task source shows its harness's icon (paperclip-tasks: Paperclip's)
  const taskSources: SourceRow[] = (data?.taskSources ?? []).map((source) => ({ ...source, icon: source.id.replace(/-tasks$/, ""), count: plural(source.open, "open issue", "open issues") }));

  return (
    <section style={styles.section}>
      <h3 style={styles.heading}>Agent sources</h3>
      <p style={styles.hint}>
        The harnesses OfficeSim reads agents from on this Mac. Sessions an orchestrator like Paperclip started show once, as its agent.
        Changes apply straight away.
      </p>
      {error ? <span style={styles.error}>{error.message}</span> : null}
      {saveError ? <span style={styles.error}>{saveError}</span> : null}
      <SourceList sources={harnesses} pending={pending} onToggle={(source, enabled) => void toggle(source, enabled)} />
      <h3 style={styles.heading}>Task sources</h3>
      <p style={styles.hint}>Where the boardroom kanban, the done timeline and the Activity tab's done tasks come from.</p>
      <SourceList sources={taskSources} pending={pending} onToggle={(source, enabled) => void toggle(source, enabled)} />
    </section>
  );
}

type AppSettings = { launchAtLogin: boolean; notifyWaiting: boolean };

/** The app's own settings: launch at login, notifications, and the mini camera window. */
function ThisMac() {
  const { data, refresh } = usePluginData<AppSettings>("app-settings");
  const setLaunchAtLogin = usePluginAction("set-launch-at-login");
  const setNotifyWaiting = usePluginAction("set-notify-waiting");
  const toggleMini = usePluginAction("toggle-mini-camera");
  const [error, setError] = useState<string | null>(null);

  async function change(action: (params: Record<string, unknown>) => Promise<unknown>, enabled: boolean) {
    setError(null);
    try {
      await action({ enabled });
    } catch (failure) {
      setError(String(failure));
    }
    refresh();
  }

  const check = (id: string, label: string, checked: boolean, onChange: (checked: boolean) => void) => (
    <li style={styles.row}>
      <input id={id} type="checkbox" checked={checked} disabled={!data} onChange={(event) => onChange(event.target.checked)} style={{ marginTop: 3 }} />
      <label htmlFor={id} style={{ ...styles.name, fontWeight: 400, cursor: "pointer" }}>{label}</label>
    </li>
  );

  return (
    <section style={styles.section}>
      <h3 style={styles.heading}>This Mac</h3>
      <p style={styles.hint}>Closing the office keeps OfficeSim in the menu bar, with who's working and who needs you.</p>
      {error ? <span style={styles.error}>{error}</span> : null}
      <ul style={styles.list}>
        {check("app-notify", "Notify me when an agent needs me", data?.notifyWaiting ?? true, (enabled) => void change(setNotifyWaiting, enabled))}
        {check("app-login", "Launch at login (into the menu bar)", data?.launchAtLogin ?? false, (enabled) => void change(setLaunchAtLogin, enabled))}
      </ul>
      <div>
        <button
          type="button"
          onClick={() => void toggleMini().catch((failure: unknown) => setError(String(failure)))}
          style={{ padding: "5px 10px", border: "2px solid", borderColor: "var(--op-hi, #a9bacb) var(--op-lo, #3a4a5b) var(--op-lo, #3a4a5b) var(--op-hi, #a9bacb)", background: "var(--op-face, #6f8295)", color: "var(--op-ink, #101820)", fontFamily: "inherit", fontSize: 13, cursor: "pointer" }}
        >
          Open mini camera
        </button>
      </div>
    </section>
  );
}

export function HostSettingsSections(): ReactNode {
  return (
    <>
      <Sources />
      <ThisMac />
    </>
  );
}

export function harnessIcon(source: string | null | undefined): HarnessIcon | null {
  return iconFor(source);
}

/**
 * The app hears what the Mac is playing, so the games room's DJ booth reacts to it without the
 * viewer having to share a tab.
 */
export function useHostMusic(): HostMusic {
  const [status, setStatus] = useState<NativeMusicStatus>({ state: "off" });

  useEffect(() => {
    // Whether macOS has allowed the capture. It's only asked while the capture isn't running:
    // the check and the capture both want the tap, and they'd fight over it.
    let cancelled = false;
    const poll = window.setInterval(() => {
      if (status.state === "on" || status.state === "connecting") return;
      void musicPermission().then((permission) => {
        if (cancelled) return;
        if (permission === "denied") setStatus({ state: "error", message: PERMISSION_MESSAGE });
      });
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [status.state]);

  return {
    status: status.state === "error" ? { state: "error", message: status.message } : status,
    toggle: () => {
      if (status.state === "on" || status.state === "connecting") {
        void stopNativeMusic().then(() => setStatus({ state: "off" }));
        return;
      }
      setStatus({ state: "connecting" });
      void startNativeMusic().then(() => {
        setStatus(nativeMusicStatus());
      });
    },
  };
}

/** What to tell the viewer when macOS won't let the app hear the system. */
const PERMISSION_MESSAGE =
  "macOS hasn't let OfficeSim hear your music yet. Turn on OfficeSim in System Settings → Privacy & Security → Screen & System Audio Recording, then click the DJ booth again.";

/** The app window is the OfficeSim window, so it fills it. */
export const FILLS_HOST_WINDOW = true;

/** Full screen is the app window's own (macOS full screen), kept in step when it's changed from the menu or green button. */
export function useHostFullscreen(): HostFullscreen {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    let appWindow: ReturnType<typeof getCurrentWindow>;
    try {
      appWindow = getCurrentWindow();
    } catch {
      return; // Not in the app (the browser dev preview): no window to follow
    }
    let disposed = false;
    const sync = () => void appWindow.isFullscreen().then((value) => !disposed && setFullscreen(value)).catch(() => {});
    sync();
    const unlisten = appWindow.onResized(sync);
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);
  return {
    fullscreen,
    toggle: () => {
      const next = !fullscreen;
      setFullscreen(next);
      try {
        void getCurrentWindow().setFullscreen(next).catch(() => setFullscreen(!next));
      } catch {
        setFullscreen(!next);
      }
    },
  };
}
