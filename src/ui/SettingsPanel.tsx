import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  CHART_SOURCE_LABELS,
  isHttpUrl,
  isValidPattern,
  normalizeSettings,
  WALL_CHART_SLOT_LABELS,
  WALL_CHART_SLOTS,
  type ChartSource,
  type ChartSourceKind,
  type OfficeSettings,
  type WallChartKey,
} from "../officeSettings.js";
import type { SpriteData } from "../office/types.js";
import { loadPixelAssets } from "./pixelAssets.js";
import { loadWallArtSprite, wallArtSlots, type WallArtSlot } from "./wallArt.js";
import { useAgentNames, useOfficeSettings, useOfficeSettingsActions, type FetchWallImage } from "./officeSettingsData.js";
import { HostSettingsSections } from "./hostExtensions.js";

const border = "1px solid rgba(232,240,216,0.14)";

// Sunken panels in the OfficeSim window's own palette (see gameUi.tsx), with plain fallbacks
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
  row: { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" },
  field: { display: "grid", gap: 4, fontSize: 12, minWidth: 180, flex: "1 1 180px" },
  label: { opacity: 0.75 },
  input: {
    padding: "6px 8px",
    border: "1px solid",
    borderColor: "var(--op-lo, #3a4a5b) var(--op-hi, #a9bacb) var(--op-hi, #a9bacb) var(--op-lo, #3a4a5b)",
    background: "var(--op-deep, #243140)",
    color: "var(--op-field-ink, #e8f0d8)",
    fontFamily: "inherit",
    fontSize: 13,
    minWidth: 0,
  },
  button: {
    padding: "5px 10px",
    border: "2px solid",
    borderColor: "var(--op-hi, #a9bacb) var(--op-lo, #3a4a5b) var(--op-lo, #3a4a5b) var(--op-hi, #a9bacb)",
    background: "var(--op-face, #6f8295)",
    color: "var(--op-ink, #101820)",
    fontFamily: "inherit",
    fontSize: 13,
    cursor: "pointer",
  },
  primary: { background: "#f5d547", fontWeight: 700 },
  disabled: { opacity: 0.5, cursor: "default" },
  check: { display: "flex", gap: 8, alignItems: "center", fontSize: 13 },
  error: { color: "#ff8a80", fontSize: 12 },
  ok: { color: "#7ee787", fontSize: 12 },
} satisfies Record<string, CSSProperties>;

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label style={{ ...styles.field, ...(wide ? { flexBasis: 360 } : {}) }}>
      <span style={styles.label}>{label}</span>
      {children}
    </label>
  );
}

function TextInput({ value, onChange, placeholder, invalid }: { value: string; onChange: (value: string) => void; placeholder?: string; invalid?: boolean }) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      style={{ ...styles.input, ...(invalid ? { borderColor: "#f87171" } : {}) }}
    />
  );
}

function Status({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: 6,
        alignItems: "center",
        padding: "3px 9px",
        borderRadius: 999,
        fontSize: 12,
        background: on ? "rgba(34,197,94,0.15)" : "rgba(148,163,184,0.15)",
        color: on ? "#4ade80" : "inherit",
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: on ? "#22c55e" : "#94a3b8" }} />
      {on ? onLabel : offLabel}
    </span>
  );
}

/** A sprite drawn at a whole-number scale, pixels kept crisp. */
function SpriteDataPreview({ sprite, scale = 2 }: { sprite: SpriteData | null; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = sprite?.[0]?.length ?? 16;
  const height = sprite?.length ?? 16;
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    sprite?.forEach((row, y) =>
      row.forEach((color, x) => {
        if (!color) return;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
      }),
    );
  }, [sprite, width, height]);
  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      aria-hidden="true"
      style={{ width: width * scale, height: height * scale, imageRendering: "pixelated", background: "rgba(148,163,184,0.12)", borderRadius: 4 }}
    />
  );
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  const w = 120;
  const h = 28;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values.map((value, i) => `${(i * step).toFixed(1)},${(h - (value / max) * (h - 2) - 1).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={points} fill="none" stroke="#60a5fa" strokeWidth={1.5} />
    </svg>
  );
}

type ChartTest = { state: "idle" } | { state: "testing" } | { state: "ok"; title: string | null; values: number[] } | { state: "error"; message: string };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : String(error));

function ChartSlotEditor({
  slot,
  source,
  onChange,
  onTest,
  posthogReady,
}: {
  slot: WallChartKey;
  source: ChartSource;
  onChange: (source: ChartSource) => void;
  onTest: (insightId: string) => Promise<{ title: string | null; values: number[] }>;
  posthogReady: boolean;
}) {
  const [test, setTest] = useState<ChartTest>({ state: "idle" });
  const title = source.kind === "none" ? "" : source.title ?? "";
  const setKind = (kind: ChartSourceKind) => {
    setTest({ state: "idle" });
    if (kind === "none") onChange({ kind });
    else if (kind === "posthogInsight") onChange({ kind, insightId: source.kind === "posthogInsight" ? source.insightId : "", ...(title ? { title } : {}) });
    else onChange({ kind, ...(title ? { title } : {}) });
  };
  const setTitle = (next: string) => {
    if (source.kind === "none") return;
    const { title: _old, ...rest } = source;
    onChange(next ? { ...rest, title: next } : rest as ChartSource);
  };

  return (
    <div style={{ display: "grid", gap: 8, paddingBottom: 12, borderBottom: border }}>
      <strong style={{ fontSize: 13 }}>{WALL_CHART_SLOT_LABELS[slot]}</strong>
      <div style={styles.row}>
        <Field label="Shows">
          <select value={source.kind} onChange={(event) => setKind(event.target.value as ChartSourceKind)} style={styles.input}>
            {(Object.keys(CHART_SOURCE_LABELS) as ChartSourceKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {CHART_SOURCE_LABELS[kind]}
              </option>
            ))}
          </select>
        </Field>
        {source.kind === "posthogInsight" ? (
          <Field label="Insight ID">
            <TextInput
              value={source.insightId}
              placeholder="e.g. 1234567"
              onChange={(insightId) => {
                setTest({ state: "idle" });
                onChange({ ...source, insightId: insightId.trim() });
              }}
            />
          </Field>
        ) : null}
        {source.kind !== "none" ? (
          <Field label="Title (optional)">
            <TextInput value={title} placeholder="Uses the source's own name" onChange={setTitle} />
          </Field>
        ) : null}
        {source.kind === "posthogInsight" ? (
          <button
            type="button"
            style={styles.button}
            disabled={!source.insightId || !posthogReady || test.state === "testing"}
            title={posthogReady ? undefined : "Set the PostHog key and project ID first"}
            onClick={() => {
              setTest({ state: "testing" });
              onTest(source.insightId).then(
                (result) => setTest({ state: "ok", ...result }),
                (error: unknown) => setTest({ state: "error", message: errorMessage(error) }),
              );
            }}
          >
            {test.state === "testing" ? "Testing…" : "Test"}
          </button>
        ) : null}
      </div>
      {test.state === "ok" ? (
        <div style={{ ...styles.row, alignItems: "center", gap: 8 }}>
          <Sparkline values={test.values} />
          <span style={styles.ok}>
            {test.title ?? "Insight"}: {test.values.length} points
          </span>
        </div>
      ) : null}
      {test.state === "error" ? <span style={styles.error}>{test.message}</span> : null}
    </div>
  );
}

type ArtPreview = { state: "idle" } | { state: "loading" } | { state: "ok"; sprite: SpriteData } | { state: "error"; message: string };

function WallArtEditor({
  slot,
  url,
  onChange,
  fetchImage,
}: {
  slot: WallArtSlot;
  url: string;
  onChange: (url: string) => void;
  fetchImage: FetchWallImage;
}) {
  const [preview, setPreview] = useState<ArtPreview>({ state: "idle" });
  const fetchImageRef = useRef(fetchImage);
  fetchImageRef.current = fetchImage;
  const trimmed = url.trim();
  const valid = !trimmed || isHttpUrl(trimmed);
  useEffect(() => {
    if (!trimmed || !isHttpUrl(trimmed)) {
      setPreview({ state: "idle" });
      return;
    }
    let cancelled = false;
    setPreview({ state: "loading" });
    // Wait for typing to settle before fetching
    const timer = window.setTimeout(() => {
      loadWallArtSprite(fetchImageRef.current, trimmed, slot).then(
        (sprite) => !cancelled && setPreview({ state: "ok", sprite }),
        (error: unknown) => !cancelled && setPreview({ state: "error", message: errorMessage(error) }),
      );
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmed, slot]);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", paddingBottom: 12, borderBottom: border }}>
      <SpriteDataPreview sprite={preview.state === "ok" ? preview.sprite : slot.sprite} />
      <div style={{ display: "grid", gap: 6, flex: "1 1 280px", minWidth: 0 }}>
        <strong style={{ fontSize: 13 }}>
          {slot.label} <span style={{ fontWeight: 400, opacity: 0.6 }}>({slot.bounds.width}×{slot.bounds.height}px)</span>
        </strong>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="url"
            value={url}
            placeholder="https://… (PNG, JPG, SVG or GIF)"
            onChange={(event) => onChange(event.target.value)}
            style={{ ...styles.input, flex: 1, ...(valid ? {} : { borderColor: "#f87171" }) }}
          />
          {url ? (
            <button type="button" style={styles.button} onClick={() => onChange("")}>
              Reset
            </button>
          ) : null}
        </div>
        {!valid ? <span style={styles.error}>Use an http(s) image URL</span> : null}
        {preview.state === "loading" ? <span style={styles.hint}>Loading…</span> : null}
        {preview.state === "error" ? <span style={styles.error}>{preview.message}</span> : null}
      </div>
    </div>
  );
}

/**
 * Everything about a company's office that isn't built in: what the wall boards chart, the pictures
 * on the walls, where the scorecard comes from, who sits where. Saved for everyone in the company.
 */
export function OfficeSettingsPanel({ companyId, children }: { companyId: string | null; children?: ReactNode }) {
  const { data, loading, error, refresh } = useOfficeSettings(companyId);
  const agentNames = useAgentNames(companyId);
  const { saveSettings, testInsight, fetchWallImage } = useOfficeSettingsActions(companyId);

  const [draft, setDraft] = useState<OfficeSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [slots, setSlots] = useState<WallArtSlot[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);

  const savedJson = data ? JSON.stringify(data.settings) : null;
  // Start from the saved settings, and again whenever they're saved (here or elsewhere)
  useEffect(() => {
    if (data) setDraft(data.settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on contents
  }, [savedJson]);

  useEffect(() => {
    let cancelled = false;
    loadPixelAssets().then(
      ({ layouts }) => !cancelled && setSlots(wallArtSlots(layouts.combined)),
      (failure: unknown) => !cancelled && setSlotsError(errorMessage(failure)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!companyId) return <p style={styles.hint}>Open a company to set up its office.</p>;
  if (loading && !draft) return <p style={styles.hint}>Loading office settings…</p>;
  if (error && !draft) return <p style={styles.error}>Could not load office settings: {error.message}</p>;
  if (!draft || !data) return null;

  const dirty = JSON.stringify(normalizeSettings(draft)) !== savedJson;
  const update = (change: (current: OfficeSettings) => OfficeSettings) => {
    setSaveResult(null);
    setDraft((current) => (current ? change(current) : current));
  };
  const posthogReady = data.posthogConnected && !!draft.posthog.projectId.trim();
  const patternValid = isValidPattern(draft.workplaces.overflowAgentNamePattern);
  const artValid = Object.values(draft.wallArt).every((art) => !art.imageUrl.trim() || isHttpUrl(art.imageUrl.trim()));

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setSaveResult(null);
    try {
      await saveSettings(draft);
      refresh();
      setSaveResult({ ok: true, message: "Saved. Open offices update within a few seconds." });
    } catch (failure) {
      setSaveResult({ ok: false, message: `Could not save: ${errorMessage(failure)}` });
    } finally {
      setSaving(false);
    }
  }

  const setPosthog = (patch: Partial<OfficeSettings["posthog"]>) => update((s) => ({ ...s, posthog: { ...s.posthog, ...patch } }));
  const setScorecard = (patch: Partial<OfficeSettings["scorecard"]>) => update((s) => ({ ...s, scorecard: { ...s.scorecard, ...patch } }));
  const setWorkplaces = (patch: Partial<OfficeSettings["workplaces"]>) => update((s) => ({ ...s, workplaces: { ...s.workplaces, ...patch } }));

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 1,
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 0 8px",
          background: "var(--op-face, #6f8295)",
          color: "var(--op-ink, #101820)",
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>Office setup</h2>
          <p style={styles.hint}>
            {data.saved ? "Shared by everyone in this company." : "Not saved yet: showing defaults (and any values from older plugin config)."}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {saveResult ? (
            <span style={{ ...(saveResult.ok ? styles.ok : styles.error), background: "var(--op-field, #1b2530)", padding: "2px 6px" }}>{saveResult.message}</span>
          ) : null}
          <button type="button" style={{ ...styles.button, ...(!dirty || saving ? styles.disabled : {}) }} disabled={!dirty || saving} onClick={() => setDraft(data.settings)}>
            Discard
          </button>
          <button
            type="button"
            style={{ ...styles.button, ...styles.primary, ...((!dirty && data.saved) || saving || !patternValid || !artValid ? styles.disabled : {}) }}
            disabled={(!dirty && data.saved) || saving || !patternValid || !artValid}
            onClick={handleSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <HostSettingsSections />

      <section style={styles.section}>
        <h3 style={styles.heading}>Connections</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Status on={data.posthogConnected} onLabel="PostHog key set" offLabel="No PostHog key" />
          <Status on={data.stripeConnected} onLabel="Stripe token set" offLabel="No Stripe token" />
        </div>
        <p style={styles.hint}>
          API keys are stored as Paperclip secrets: set them in the OfficeSim plugin's configuration (Instance settings → Plugins → OfficeSim).
          Everything else is set here.
        </p>
        <div style={styles.row}>
          <Field label="PostHog host">
            <TextInput value={draft.posthog.host} placeholder="https://us.posthog.com" onChange={(host) => setPosthog({ host })} />
          </Field>
          <Field label="PostHog project ID">
            <TextInput value={draft.posthog.projectId} placeholder="e.g. 12345" onChange={(projectId) => setPosthog({ projectId })} />
          </Field>
          <Field label="Stripe MCP URL" wide>
            <TextInput value={draft.stripe.mcpUrl} placeholder="https://mcp.stripe.com/" onChange={(mcpUrl) => update((s) => ({ ...s, stripe: { mcpUrl } }))} />
          </Field>
        </div>
      </section>

      <section style={styles.section}>
        <h3 style={styles.heading}>Wall charts</h3>
        <p style={styles.hint}>
          Each board can chart a saved PostHog insight (trends insights are drawn without their breakdown; SQL insights have their rows summed per x-axis
          value) or a Stripe metric. Boards set to None show a placeholder.
        </p>
        {WALL_CHART_SLOTS.map((slot) => (
          <ChartSlotEditor
            key={slot}
            slot={slot}
            source={draft.wallCharts[slot]}
            posthogReady={posthogReady}
            onChange={(source) => update((s) => ({ ...s, wallCharts: { ...s.wallCharts, [slot]: source } }))}
            onTest={async (insightId) => {
              const chart = await testInsight(insightId, draft.posthog);
              return { title: chart.title, values: chart.points.map((point) => point.value) };
            }}
          />
        ))}
      </section>

      <section style={styles.section}>
        <h3 style={styles.heading}>Scorecard</h3>
        <p style={styles.hint}>
          The boardroom's traffic-light board shows the latest issue comment containing a markdown table of <code>| Section | 🟢/🟡/🔴 | metric |</code>{" "}
          rows. It can also include an <code>Overall Status: 🟡</code> line (otherwise the worst section is used) and a numbered list after{" "}
          <code>Top priority issues:</code>.
        </p>
        <label style={styles.check}>
          <input type="checkbox" checked={draft.scorecard.enabled} onChange={(event) => setScorecard({ enabled: event.target.checked })} />
          Show the scorecard
        </label>
        {draft.scorecard.enabled ? (
          <div style={styles.row}>
            <Field label="Comments containing">
              <TextInput value={draft.scorecard.keyword} placeholder="Any comment" onChange={(keyword) => setScorecard({ keyword })} />
            </Field>
            <Field label="Posted by">
              <select value={draft.scorecard.authorAgentName} onChange={(event) => setScorecard({ authorAgentName: event.target.value })} style={styles.input}>
                <option value="">Anyone</option>
                {draft.scorecard.authorAgentName && !agentNames.includes(draft.scorecard.authorAgentName) ? (
                  <option value={draft.scorecard.authorAgentName}>{draft.scorecard.authorAgentName}</option>
                ) : null}
                {agentNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Title when the comment has none">
              <TextInput value={draft.scorecard.defaultTitle} onChange={(defaultTitle) => setScorecard({ defaultTitle })} />
            </Field>
            <Field label="Rows needed">
              <input
                type="number"
                min={1}
                max={12}
                value={draft.scorecard.minSections}
                onChange={(event) => setScorecard({ minSections: Number(event.target.value) })}
                style={styles.input}
              />
            </Field>
          </div>
        ) : null}
      </section>

      <section style={styles.section}>
        <h3 style={styles.heading}>Wall art</h3>
        <p style={styles.hint}>
          Swap any painting, portrait or the logo for your own picture. It's cropped to fill the frame and scaled down to pixel art. The image is
          fetched by the plugin, so any public image URL works.
        </p>
        {slotsError ? <span style={styles.error}>Could not load the office: {slotsError}</span> : null}
        {slots === null && !slotsError ? <span style={styles.hint}>Loading the office…</span> : null}
        {slots?.map((slot) => (
          <WallArtEditor
            key={slot.uid}
            slot={slot}
            url={draft.wallArt[slot.uid]?.imageUrl ?? ""}
            fetchImage={fetchWallImage}
            onChange={(imageUrl) =>
              update((s) => {
                const wallArt = { ...s.wallArt };
                if (imageUrl) wallArt[slot.uid] = { imageUrl };
                else delete wallArt[slot.uid];
                return { ...s, wallArt };
              })
            }
          />
        ))}
      </section>

      <section style={styles.section}>
        <h3 style={styles.heading}>Product logins</h3>
        <p style={styles.hint}>
          When someone views the login page and then the dashboard within 30 minutes (PostHog pageviews), the office waves and says hello.
        </p>
        <label style={styles.check}>
          <input type="checkbox" checked={draft.posthog.loginsEnabled} onChange={(event) => setPosthog({ loginsEnabled: event.target.checked })} />
          Wave at logins
        </label>
        {draft.posthog.loginsEnabled ? (
          <div style={styles.row}>
            <Field label="Login page path">
              <TextInput value={draft.posthog.loginPath} placeholder="/login" onChange={(loginPath) => setPosthog({ loginPath })} />
            </Field>
            <Field label="Dashboard page path">
              <TextInput value={draft.posthog.dashboardPath} placeholder="/dashboard" onChange={(dashboardPath) => setPosthog({ dashboardPath })} />
            </Field>
          </div>
        ) : null}
      </section>

      <section style={styles.section}>
        <h3 style={styles.heading}>Seating</h3>
        <p style={styles.hint}>
          Where agents work unless someone picks a room for them below. Everyone else is spread at random across the three rooms.
        </p>
        <div style={{ display: "grid", gap: 6 }}>
          <span style={{ ...styles.label, fontSize: 12 }}>Boardroom</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
            {agentNames.length === 0 ? <span style={styles.hint}>No agents yet</span> : null}
            {agentNames.map((name) => {
              const checked = draft.workplaces.boardroomAgentNames.some((n) => n.toLowerCase() === name.toLowerCase());
              return (
                <label key={name} style={styles.check}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) =>
                      setWorkplaces({
                        boardroomAgentNames: event.target.checked
                          ? [...draft.workplaces.boardroomAgentNames, name]
                          : draft.workplaces.boardroomAgentNames.filter((n) => n.toLowerCase() !== name.toLowerCase()),
                      })
                    }
                  />
                  {name}
                </label>
              );
            })}
          </div>
        </div>
        <div style={styles.row}>
          <Field label="Office 2: names matching (regular expression)" wide>
            <TextInput
              value={draft.workplaces.overflowAgentNamePattern}
              placeholder="e.g. ^engineer"
              invalid={!patternValid}
              onChange={(overflowAgentNamePattern) => setWorkplaces({ overflowAgentNamePattern })}
            />
          </Field>
        </div>
        {!patternValid ? <span style={styles.error}>That isn't a valid regular expression</span> : null}
      </section>

      <section style={styles.section}>
        <h3 style={styles.heading}>Activity</h3>
        <div style={styles.row}>
          <Field label="Git repository path, for the Activity tab's Git view" wide>
            <TextInput value={draft.gitRepoPath} placeholder="/Users/you/code/app" onChange={(gitRepoPath) => update((s) => ({ ...s, gitRepoPath }))} />
          </Field>
        </div>
      </section>

      {children}
    </div>
  );
}
