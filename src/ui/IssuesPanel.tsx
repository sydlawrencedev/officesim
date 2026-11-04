import { useEffect, useMemo, useRef, useState } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import {
  BOARD_STATUS_COLORS,
  BOARD_STATUS_LABELS,
  BOARD_STATUSES,
  priorityRank,
  repoColor,
  type BoardIssue,
  type IssuesBoard,
} from "../issuesBoard.js";
import { timeAgo } from "./PixelOfficeCanvas.js";

/*
 * The Issues tab: every open issue across the repos the office knows about, as a kanban board.
 *
 * The boardroom's own kanban (the one on the wall) shows a company's issues. This one is bigger:
 * every tracked repo's issues, in the same columns, with more about each of them.
 */

const BOARD_REFRESH_MS = 60_000;

const PRIORITY_COLORS: Record<string, string> = {
  critical: "#e5484d",
  high: "#f97316",
  medium: "#f5d547",
  low: "#4dabf7",
};

/** How the board is grouped: by column only, or by column and repo. */
type Grouping = "column" | "repo";

export function IssuesPanel({
  active = true,
  onIssueClick,
}: {
  active?: boolean;
  onIssueClick: (issue: string, newTab: boolean) => void;
}) {
  const { data, loading, error, refresh } = usePluginData<IssuesBoard>("issues-board");
  const [filter, setFilter] = useState("");
  const [grouping, setGrouping] = useState<Grouping>("column");
  const [repo, setRepo] = useState<string | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshRef.current();
    }, BOARD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = (data?.columns ?? []).flatMap((column) => column.issues);
    return all.filter((issue) => {
      if (repo && issue.repo !== repo) return false;
      if (!needle) return true;
      return [issue.identifier, issue.title, issue.repo, issue.assignee, ...issue.labels]
        .filter((text): text is string => typeof text === "string")
        .some((text) => text.toLowerCase().includes(needle));
    });
  }, [data, filter, repo]);

  const columns = useMemo(
    () =>
      BOARD_STATUSES.map((status) => ({
        status,
        issues: filtered
          .filter((issue) => issue.status === status)
          .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.title.localeCompare(b.title)),
      })),
    [filtered],
  );

  const total = filtered.length;
  const all = (data?.columns ?? []).flatMap((column) => column.issues).length;

  return (
    <div className="op-issues">
      <div className="op-log-toolbar">
        <input
          className="op-log-filter"
          type="search"
          placeholder="Filter by title, id, repo…"
          aria-label="Filter issues"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="op-segment" role="group" aria-label="Group by">
          <button
            type="button"
            className="op-button"
            aria-pressed={grouping === "column"}
            onClick={() => setGrouping("column")}
          >
            By column
          </button>
          <button
            type="button"
            className="op-button"
            aria-pressed={grouping === "repo"}
            onClick={() => setGrouping("repo")}
          >
            By repo
          </button>
        </div>
        <span className="op-log-count">
          {data ? `${total}${total !== all ? ` of ${all}` : ""} open` : ""}
        </span>
      </div>

      {data?.repos.length ? (
        <div className="op-issues-repos">
          <button
            type="button"
            className="op-issues-repo"
            aria-pressed={repo === null}
            onClick={() => setRepo(null)}
          >
            All repos
          </button>
          {data.repos.map((entry) => (
            <button
              key={entry.repo}
              type="button"
              className="op-issues-repo"
              aria-pressed={repo === entry.repo}
              onClick={() => setRepo(repo === entry.repo ? null : entry.repo)}
              title={`${entry.open} open issue${entry.open === 1 ? "" : "s"}`}
            >
              <span style={{ color: repoColor(entry.repo) }}>{entry.repo}</span>
              <span className="op-issues-repo-count">{entry.open}</span>
            </button>
          ))}
        </div>
      ) : null}

      {data?.problems.length ? (
        <div className="op-issues-problems">
          {data.problems.map((problem) => (
            <div key={problem.repo} className="op-issues-problem">
              {problem.repo}: {problem.problem}
            </div>
          ))}
        </div>
      ) : null}

      {error && !data ? (
        <div className="op-list-empty">Couldn’t load the issues.</div>
      ) : !data && loading ? (
        <div className="op-list-empty">Loading…</div>
      ) : total === 0 ? (
        <div className="op-list-empty">
          {filter || repo ? "No issues match." : "No open issues in the tracked repos."}
        </div>
      ) : grouping === "repo" ? (
        <div className="op-issues-body">
          {data?.repos
            .map((entry) => ({
              ...entry,
              issues: filtered.filter((issue) => issue.repo === entry.repo),
            }))
            .filter((entry) => entry.issues.length > 0)
            .map((entry) => (
              <section key={entry.repo} className="op-issues-group">
                <h3 className="op-issues-group-title" style={{ color: repoColor(entry.repo) }}>
                  {entry.repo}
                  <span className="op-log-count">{entry.issues.length} open</span>
                </h3>
                <div className="op-issues-cards">
                  {entry.issues
                    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.title.localeCompare(b.title))
                    .map((issue) => (
                      <IssueCard key={issue.id} issue={issue} onOpen={onIssueClick} />
                    ))}
                </div>
              </section>
            ))}
        </div>
      ) : (
        <div className="op-issues-body op-issues-columns">
          {columns.map((column) => {
            const color = BOARD_STATUS_COLORS[column.status] ?? "#9aa0a6";
            return (
              <section
                key={column.status}
                className="op-issues-column"
                data-empty={column.issues.length === 0 ? "true" : undefined}
                // The column is tinted with its stage's colour, so the board reads at a glance.
                // A column with nothing in it is only as wide as its header, so the ones with
                // work in them get the room.
                style={{
                  background: `${color}14`,
                  borderTopColor: color,
                }}
              >
                <h3 className="op-issues-column-title" style={{ borderTopColor: color }}>
                  {BOARD_STATUS_LABELS[column.status] ?? column.status}
                  <span className="op-log-count">{column.issues.length}</span>
                </h3>
                <div className="op-issues-cards">
                  {column.issues.map((issue) => (
                    <IssueCard key={issue.id} issue={issue} onOpen={onIssueClick} />
                  ))}
                  {column.issues.length === 0 ? <div className="op-issues-empty">—</div> : null}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One issue on the board. */
function IssueCard({ issue, onOpen }: { issue: BoardIssue; onOpen: (issue: string, newTab: boolean) => void }) {
  // The identifier names the repo and the number; the card shows the number and the repo's name
  const number = issue.identifier?.includes("#") ? issue.identifier.split("#").pop() : issue.identifier;
  const open = (newTab: boolean) => onOpen(issue.identifier ?? issue.id, newTab);
  return (
    <article className="op-issues-card">
      <div className="op-issues-card-top">
        <span
          className="op-log-dot"
          style={{ background: PRIORITY_COLORS[issue.priority] ?? PRIORITY_COLORS.medium }}
          title={`${issue.priority} priority`}
        />
        {number ? <span className="op-log-id">#{number}</span> : null}
        <span className="op-issues-repo-name" style={{ color: repoColor(issue.repo) }} title={issue.repo}>
          {issue.repo.split("/").pop()}
        </span>
      </div>
      <button
        type="button"
        className="op-issues-card-open"
        title="Open issue"
        onClick={(event) => open(event.metaKey || event.ctrlKey)}
        onAuxClick={(event) => {
          if (event.button === 1) open(true);
        }}
      >
        <span className="op-issues-card-title">{issue.title}</span>
      </button>
      <div className="op-issues-card-meta">
        {issue.workingAgent ? (
          <span className="op-issues-working" title="Being worked on now">
            ● {issue.workingAgent}
          </span>
        ) : null}
        {issue.assignee ? <span title="Assigned to">{issue.assignee}</span> : <span className="op-log-dim">Unassigned</span>}
        {issue.comments ? <span>{issue.comments} comment{issue.comments === 1 ? "" : "s"}</span> : null}
        {issue.updatedAt ? <span title={new Date(issue.updatedAt).toLocaleString()}>updated {timeAgo(issue.updatedAt)}</span> : null}
      </div>
      {issue.labels.length ? (
        <div className="op-issues-labels">
          {issue.labels.slice(0, 3).map((label) => (
            <span key={label} className="op-issues-label">
              {label}
            </span>
          ))}
          {issue.labels.length > 3 ? <span className="op-log-dim">+{issue.labels.length - 3}</span> : null}
        </div>
      ) : null}
    </article>
  );
}
