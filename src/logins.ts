import { createHash } from "node:crypto";

/**
 * Logins to the product, seen in PostHog: someone viewed the login page and then landed on the
 * dashboard. Only an opaque id and a time leave the worker, never who it was.
 */
export type Logins = {
  /** False until a PostHog key is set, so the office doesn't wait on logins that can't be seen */
  live: boolean;
  /** Most recent first */
  recent: Array<{ id: string; at: string }>;
};

/** Pageviews from this far back are read on each check */
export const LOGINS_LOOKBACK_MINUTES = 60;
/** A dashboard visit counts as a login only this soon after the login page */
export const LOGIN_TO_DASHBOARD_MINUTES = 30;

/** The page itself or anything under it, e.g. "/dashboard" matches "/dashboard/settings" */
function onPage(pathname: string, page: string): boolean {
  const base = page.replace(/\/+$/, "") || "/";
  return pathname === base || pathname.startsWith(`${base}/`) || pathname.startsWith(`${base}?`);
}

/** Your app's own page view event as well as PostHog's, since not every page sends both */
const PAGEVIEW_EVENTS = ["$pageview", "page_view"];

function hogqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function loginPageviewsQuery(loginPath: string, dashboardPath: string): { kind: "HogQLQuery"; query: string } {
  const login = hogqlString(loginPath.replace(/\/+$/, ""));
  const dashboard = hogqlString(dashboardPath.replace(/\/+$/, ""));
  return {
    kind: "HogQLQuery",
    query: `
      SELECT toString(person_id), toUnixTimestamp(timestamp), properties.$pathname
      FROM events
      WHERE event IN (${PAGEVIEW_EVENTS.map(hogqlString).join(", ")})
        AND timestamp > now() - INTERVAL ${LOGINS_LOOKBACK_MINUTES} MINUTE
        AND (startsWith(properties.$pathname, ${login}) OR startsWith(properties.$pathname, ${dashboard}))
      ORDER BY timestamp
      LIMIT 5000
    `,
  };
}

/**
 * Walk each person's pageviews in time order: a login page view starts a login, and the first
 * dashboard view within the window after it completes one. Rows are [person, unix seconds, pathname].
 */
export function findLogins(rows: unknown[][], loginPath: string, dashboardPath: string): Logins["recent"] {
  const pendingSince = new Map<string, number>();
  const logins: Logins["recent"] = [];
  for (const [person, timestamp, pathname] of rows) {
    if (typeof person !== "string" || typeof pathname !== "string") continue;
    const at = Number(timestamp) * 1000;
    if (!Number.isFinite(at)) continue;
    if (onPage(pathname, loginPath)) {
      pendingSince.set(person, at);
    } else if (onPage(pathname, dashboardPath)) {
      const since = pendingSince.get(person);
      if (since === undefined || at - since > LOGIN_TO_DASHBOARD_MINUTES * 60_000) continue;
      pendingSince.delete(person);
      // Hashed with the login's time, so the id is stable across checks but says nothing about the person
      const id = createHash("sha256").update(`${person}|${since}`).digest("hex").slice(0, 16);
      logins.push({ id, at: new Date(at).toISOString() });
    }
  }
  return logins.reverse();
}
