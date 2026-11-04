import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "officesim.camera";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "officesim";

export const SLOT_IDS = {
  sidebar: "officesim-sidebar",
  page: "officesim-camera-page",
} as const;

export const EXPORT_NAMES = {
  sidebar: "OfficeSimSidebarLink",
  page: "OfficeSimCameraPage",
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "OfficeSim",
  description: "Security camera style pixel office view for Paperclip companies.",
  author: "Garratt Campton",
  categories: ["ui"],
  capabilities: [
    "companies.read",
    "agents.read",
    "agents.invoke",
    "database.namespace.read",
    "database.namespace.migrate",
    "database.namespace.write",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "instance.settings.register",
    "ui.sidebar.register",
    "ui.page.register",
  ],
  // Only the secrets live in plugin config; everything else about the office (wall charts, wall
  // art, scorecard, seating) is set per company in the OfficeSim window's Settings tab and kept in plugin
  // state. The other fields are from older versions and are only read until a company saves settings.
  instanceConfigSchema: {
    type: "object",
    properties: {
      posthogApiKey: {
        type: "object",
        format: "secret-ref",
        title: "PostHog personal API key",
        description: "Needs read access to insights and queries. Pick which insights each wall board shows in the Settings tab in OfficeSim.",
      },
      stripeAccessToken: {
        type: "object",
        format: "secret-ref",
        title: "Stripe MCP access token",
        description: "Used to read subscriptions and customers through Stripe's MCP server (e.g. the Stripe connector's OAuth access token), for boards set to show MRR or new customers.",
      },
      posthogHost: { type: "string", title: "PostHog host (deprecated: use the Settings tab in OfficeSim)" },
      posthogProjectId: { type: "string", title: "PostHog project ID (deprecated: use the Settings tab in OfficeSim)" },
      posthogInsightId: { type: "string", title: "Office 2 left board insight ID (deprecated: use the Settings tab in OfficeSim)" },
      mausInsightId: { type: "string", title: "Office right board insight ID (deprecated: use the Settings tab in OfficeSim)" },
      posthogLoginPath: { type: "string", title: "Login page path (deprecated: use the Settings tab in OfficeSim)" },
      posthogDashboardPath: { type: "string", title: "Dashboard page path (deprecated: use the Settings tab in OfficeSim)" },
      stripeMcpUrl: { type: "string", title: "Stripe MCP URL (deprecated: use the Settings tab in OfficeSim)" },
      gitRepoPath: { type: "string", title: "Git repository path (deprecated: use the Settings tab in OfficeSim)" },
    },
  },
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  // Our own table holds arcade and pool scores (src/migrations). Core read access: runs and issues
  // for hover cards, the kanban and stats, comments for the scorecard, cost events for token
  // counts in stats, agents for names.
  database: {
    migrationsDir: "./dist/migrations",
    coreReadTables: ["agents", "heartbeat_runs", "issues", "issue_comments", "cost_events"],
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "OfficeSim",
        exportName: EXPORT_NAMES.sidebar,
      },
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "OfficeSim",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
    ],
  },
};

export default manifest;
