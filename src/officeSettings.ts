/**
 * Per-company office setup, edited in the Settings tab of the OfficeSim window and kept in plugin state so
 * everyone viewing a company's office sees the same walls, charts and seating. Secrets (the
 * PostHog key, the Stripe token) are not here: they stay in Paperclip's plugin config.
 */

/** The wall boards that can show a chart, named by where they hang. */
export const WALL_CHART_SLOTS = ["officeRight", "boardroom", "office2Left", "office2Right"] as const;
export type WallChartKey = (typeof WALL_CHART_SLOTS)[number];

export const WALL_CHART_SLOT_LABELS: Record<WallChartKey, string> = {
  officeRight: "Main office, right board",
  boardroom: "Boardroom whiteboard",
  office2Left: "Office 2, left board",
  office2Right: "Office 2, right board",
};

export type ChartSource =
  | { kind: "none" }
  | { kind: "posthogInsight"; insightId: string; title?: string }
  | { kind: "stripeMrr"; title?: string }
  | { kind: "stripeNewCustomers"; title?: string };
export type ChartSourceKind = ChartSource["kind"];

export const CHART_SOURCE_LABELS: Record<ChartSourceKind, string> = {
  none: "None (placeholder)",
  posthogInsight: "PostHog insight",
  stripeMrr: "Stripe: active MRR",
  stripeNewCustomers: "Stripe: new customers",
};

/** A replacement picture for one piece of wall art, by its combined-layout furniture uid. */
export type WallArt = { imageUrl: string };

export type OfficeSettings = {
  version: 1;
  posthog: {
    host: string;
    projectId: string;
    /** Wave hello when someone logs in to the product (a login page view, then the dashboard). */
    loginsEnabled: boolean;
    loginPath: string;
    dashboardPath: string;
  };
  stripe: { mcpUrl: string };
  wallCharts: Record<WallChartKey, ChartSource>;
  scorecard: {
    enabled: boolean;
    /** Only comments containing this (case-insensitive) are read for a scorecard table. */
    keyword: string;
    /** Only comments by this agent, when set. */
    authorAgentName: string;
    /** Board title when the comment has no bold heading. */
    defaultTitle: string;
    /** Rows a table needs before it counts as a scorecard, so passing mentions are skipped. */
    minSections: number;
  };
  wallArt: Record<string, WallArt>;
  workplaces: {
    /** Agents (by name, case-insensitive) who sit in the boardroom unless picked otherwise. */
    boardroomAgentNames: string[];
    /** Agents whose names match this regular expression sit in Office 2. */
    overflowAgentNamePattern: string;
  };
  /** Git repo the agents commit to, for the Activity tab's Git view. */
  gitRepoPath: string;
};

export const DEFAULT_POSTHOG_HOST = "https://us.posthog.com";
export const DEFAULT_STRIPE_MCP_URL = "https://mcp.stripe.com/";

export const DEFAULT_SETTINGS: OfficeSettings = {
  version: 1,
  posthog: { host: DEFAULT_POSTHOG_HOST, projectId: "", loginsEnabled: true, loginPath: "/login", dashboardPath: "/dashboard" },
  stripe: { mcpUrl: DEFAULT_STRIPE_MCP_URL },
  wallCharts: { officeRight: { kind: "none" }, boardroom: { kind: "none" }, office2Left: { kind: "none" }, office2Right: { kind: "none" } },
  scorecard: { enabled: true, keyword: "scorecard", authorAgentName: "", defaultTitle: "Business scorecard", minSections: 3 },
  wallArt: {},
  workplaces: { boardroomAgentNames: [], overflowAgentNamePattern: "" },
  gitRepoPath: "",
};

/** Plugin state key the settings are saved under, per company. */
export const SETTINGS_STATE_KEY = "office-settings";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown, fallback: string, max = 500) =>
  typeof value === "string" ? value.trim().slice(0, max) : fallback;

const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

const optionalTitle = (value: unknown) => {
  const title = text(value, "", 80);
  return title ? { title } : {};
};

function normalizeChartSource(raw: unknown): ChartSource {
  if (!isRecord(raw)) return { kind: "none" };
  switch (raw.kind) {
    case "posthogInsight": {
      const insightId = text(raw.insightId, "", 40);
      return insightId ? { kind: "posthogInsight", insightId, ...optionalTitle(raw.title) } : { kind: "none" };
    }
    case "stripeMrr":
    case "stripeNewCustomers":
      return { kind: raw.kind, ...optionalTitle(raw.title) };
    default:
      return { kind: "none" };
  }
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** True when the pattern compiles, so a typo in settings can't break seating. */
export function isValidPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

/** Settings from storage or the settings form, merged onto the defaults with anything malformed dropped. */
export function normalizeSettings(raw: unknown): OfficeSettings {
  const d = DEFAULT_SETTINGS;
  const r = isRecord(raw) ? raw : {};
  const posthog = isRecord(r.posthog) ? r.posthog : {};
  const stripe = isRecord(r.stripe) ? r.stripe : {};
  const charts = isRecord(r.wallCharts) ? r.wallCharts : {};
  const scorecard = isRecord(r.scorecard) ? r.scorecard : {};
  const art = isRecord(r.wallArt) ? r.wallArt : {};
  const workplaces = isRecord(r.workplaces) ? r.workplaces : {};
  const minSections = Number(scorecard.minSections);
  const pattern = text(workplaces.overflowAgentNamePattern, "", 200);

  return {
    version: 1,
    posthog: {
      host: text(posthog.host, d.posthog.host).replace(/\/+$/, "") || d.posthog.host,
      projectId: text(posthog.projectId, "", 40),
      loginsEnabled: bool(posthog.loginsEnabled, d.posthog.loginsEnabled),
      loginPath: text(posthog.loginPath, d.posthog.loginPath, 200) || d.posthog.loginPath,
      dashboardPath: text(posthog.dashboardPath, d.posthog.dashboardPath, 200) || d.posthog.dashboardPath,
    },
    stripe: { mcpUrl: text(stripe.mcpUrl, d.stripe.mcpUrl) || d.stripe.mcpUrl },
    wallCharts: Object.fromEntries(WALL_CHART_SLOTS.map((slot) => [slot, normalizeChartSource(charts[slot])])) as OfficeSettings["wallCharts"],
    scorecard: {
      enabled: bool(scorecard.enabled, d.scorecard.enabled),
      keyword: text(scorecard.keyword, d.scorecard.keyword, 80),
      authorAgentName: text(scorecard.authorAgentName, "", 120),
      defaultTitle: text(scorecard.defaultTitle, d.scorecard.defaultTitle, 80) || d.scorecard.defaultTitle,
      minSections: Number.isInteger(minSections) && minSections >= 1 && minSections <= 12 ? minSections : d.scorecard.minSections,
    },
    wallArt: Object.fromEntries(
      Object.entries(art)
        .slice(0, 64)
        .map(([uid, value]) => [uid.slice(0, 120), isRecord(value) ? text(value.imageUrl, "", 2000) : ""] as const)
        .filter(([, imageUrl]) => isHttpUrl(imageUrl))
        .map(([uid, imageUrl]) => [uid, { imageUrl }]),
    ),
    workplaces: {
      boardroomAgentNames: Array.isArray(workplaces.boardroomAgentNames)
        ? [...new Set(workplaces.boardroomAgentNames.map((name) => text(name, "", 120)).filter(Boolean))].slice(0, 100)
        : [],
      overflowAgentNamePattern: isValidPattern(pattern) ? pattern : "",
    },
    gitRepoPath: text(r.gitRepoPath, "", 1000),
  };
}

/**
 * Settings for a company that hasn't saved any yet, carried over from the plugin config fields
 * older versions used, so an upgrade keeps its boards until its settings are saved.
 */
export function settingsFromLegacyConfig(config: Record<string, unknown>): OfficeSettings {
  const value = (key: string) => (typeof config[key] === "string" ? (config[key] as string).trim() : "");
  const insight = (key: string): ChartSource => (value(key) ? { kind: "posthogInsight", insightId: value(key) } : { kind: "none" });
  const hasStripe = !!config.stripeAccessToken;
  return normalizeSettings({
    posthog: {
      host: value("posthogHost") || undefined,
      projectId: value("posthogProjectId"),
      loginPath: value("posthogLoginPath") || undefined,
      dashboardPath: value("posthogDashboardPath") || undefined,
    },
    stripe: { mcpUrl: value("stripeMcpUrl") || undefined },
    wallCharts: {
      officeRight: insight("mausInsightId"),
      boardroom: hasStripe ? { kind: "stripeMrr" } : { kind: "none" },
      office2Left: insight("posthogInsightId"),
      office2Right: hasStripe ? { kind: "stripeNewCustomers" } : { kind: "none" },
    },
    gitRepoPath: value("gitRepoPath"),
  });
}

/** What the settings data endpoint returns: the settings plus which secrets are configured. */
export type OfficeSettingsData = {
  settings: OfficeSettings;
  /** False when the company hasn't saved settings yet (they come from defaults or older config). */
  saved: boolean;
  posthogConnected: boolean;
  stripeConnected: boolean;
};
