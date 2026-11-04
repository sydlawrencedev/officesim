import { useEffect, useMemo, useRef, useState } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { DoneIssue, DoneIssues, GitChangeKind, GitChanges, GitCommits, GitCommit } from "../logs.js";
import { repoColor } from "../issuesBoard.js";
import { timeAgo } from "./PixelOfficeCanvas.js";
import { readSetting, writeSetting } from "./storage.js";

/*
 * The Activity tab: the issues that were closed recently, and the git activity of every repo the
 * agents work in.
 *
 * Both are in one list each, newest first, and each entry says which repo it came from.
 */

type Mode = "issues" | "git";
const MODES: Array<{ id: Mode; label: string; icon: string; color: string }> = [
  { id: "issues", label: "Issues", icon: "✓", color: "#6ee36e" },
  { id: "git", label: "Git", icon: "⎇", color: "#4dabf7" },
];
const MODE_SETTING = "logs-mode";
/** Both views refresh this often while the tab is open */
const LOGS_REFRESH_MS = 30_000;

const PRIORITY_COLORS: Record<string, string> = {
  critical: "#e5484d",
  high: "#f97316",
  medium: "#f5d547",
  low: "#4dabf7",
};

/** Each kind of uncommitted change, in the order the overview lists them */
const CHANGE_KINDS: Array<{ kind: GitChangeKind; label: string; color: string }> = [
  { kind: "modified", label: "modified", color: "#f5d547" },
  { kind: "added", label: "added", color: "#6ee36e" },
  { kind: "deleted", label: "deleted", color: "#e5484d" },
  { kind: "renamed", label: "renamed", color: "#4dabf7" },
  { kind: "untracked", label: "untracked", color: "#94a3b8" },
];
/** Folders listed in the overview; the rest are summed into one line */
const OVERVIEW_FOLDERS = 6;

function readStoredMode(): Mode {
  try {
    const stored = readSetting(MODE_SETTING);
    if (stored === "issues" || stored === "git") return stored;
  } catch {
    // Storage unavailable: use the default
  }
  return "issues";
}

/**
 * Poll a plugin data hook's refresh while the panel is showing and the page is visible, and refresh
 * straight away when a hidden panel is shown again (it keeps showing its last data meanwhile).
 */
function usePolling(refresh: () => void, active: boolean) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const shownRef = useRef(active);
  useEffect(() => {
    if (!active) return;
    if (!shownRef.current) refreshRef.current();
    shownRef.current = true;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshRef.current();
    }, LOGS_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      shownRef.current = false;
    };
  }, [active]);
}

/** The Activity tab: the closed issues (newest first) or the git activity of every repo. */
export function LogsPanel({
  companyId,
  onIssueClick,
  active = true,
}: {
  companyId: string | null;
  onIssueClick: (issue: string, newTab: boolean) => void;
  /** Whether the panel is showing; see StatsPanel's `active` */
  active?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(readStoredMode);
  const current = MODES.find((option) => option.id === mode) ?? MODES[0];
  return (
    <div className="op-stats">
      <div className="op-stats-top">
        {/* The buttons and the rule that says which list is showing: green for issues, blue for git */}
        <div className="op-activity-head">
          <div className="op-segment" role="group" aria-label="Activity">
            {MODES.map((option) => (
              <button
                key={option.id}
                type="button"
                className="op-button"
                aria-pressed={mode === option.id}
                onClick={() => {
                  setMode(option.id);
                  try {
                    writeSetting(MODE_SETTING, option.id);
                  } catch {
                    // Storage unavailable: the choice just lasts until reload
                  }
                }}
              >
                <span aria-hidden="true">{option.icon}</span> {option.label}
              </button>
            ))}
          </div>
          <div className="op-log-rule" style={{ background: current.color }} />
        </div>
      </div>
      {/* Both views stay mounted once opened, so switching between them shows their last data at once */}
      <IssuesLog companyId={companyId} onIssueClick={onIssueClick} active={active && mode === "issues"} />
      <GitLogView companyId={companyId} active={active && mode === "git"} />
    </div>
  );
}

function IssuesLog({
  companyId,
  onIssueClick,
  active,
}: {
  companyId: string | null;
  onIssueClick: (issue: string, newTab: boolean) => void;
  active: boolean;
}) {
  const { data, loading, error, refresh } = usePluginData<DoneIssues>("closed-issues", { companyId });
  usePolling(refresh, active);
  const [filter, setFilter] = useState("");
  const issues = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = data?.issues ?? [];
    if (!needle) return all;
    return all.filter((issue) =>
      [issue.identifier, issue.title, issue.repo, issue.assignee, ...issue.labels].some((text) =>
        text?.toLowerCase().includes(needle),
      ),
    );
  }, [data, filter]);
  if (!active) return null;

  return (
    <div className="op-list op-log">
      <div className="op-log-toolbar">
        <input
          className="op-log-filter"
          type="search"
          placeholder="Filter by title, id, repo…"
          aria-label="Filter closed issues"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <span className="op-log-count">
          {data ? `${issues.length}${filter ? ` of ${data.issues.length}` : ""} closed` : ""}
        </span>
      </div>
      <div className="op-log-body">
        {error && !data ? (
          <div className="op-list-empty">Couldn’t load the closed issues.</div>
        ) : !data && loading ? (
          <div className="op-list-empty">Loading…</div>
        ) : issues.length === 0 ? (
          <div className="op-list-empty">{filter ? "No closed issues match." : "No issues closed yet."}</div>
        ) : (
          issues.map((issue) => <IssueRow key={issue.id} issue={issue} onOpen={onIssueClick} />)
        )}
      </div>
    </div>
  );
}

/** One closed issue: which repo it was in, what it was, and when it was closed. */
function IssueRow({ issue, onOpen }: { issue: DoneIssue; onOpen: (issue: string, newTab: boolean) => void }) {
  const number = issue.identifier?.includes("#") ? issue.identifier.split("#").pop() : issue.identifier;
  return (
    <button
      type="button"
      className="op-log-row op-log-task"
      title="Open issue"
      onClick={(event) => onOpen(issue.identifier ?? issue.id, event.metaKey || event.ctrlKey)}
      onAuxClick={(event) => {
        if (event.button === 1) onOpen(issue.identifier ?? issue.id, true);
      }}
    >
      <span className="op-log-main">
        <span className="op-log-line">
          <span
            className="op-log-dot"
            style={{ background: PRIORITY_COLORS[issue.priority] ?? PRIORITY_COLORS.medium }}
            title={`${issue.priority} priority`}
          />
          {number ? <span className="op-log-id">#{number}</span> : null}
          <span className="op-log-title">{issue.title}</span>
        </span>
        {issue.labels.length ? (
          <span className="op-log-note">
            {issue.labels.slice(0, 4).join(", ")}
            {issue.labels.length > 4 ? ` +${issue.labels.length - 4}` : ""}
          </span>
        ) : null}
        {/* How it went, under the labels: how many comments it got, and when it closed */}
        <span className="op-log-note op-log-note-dim">
          {issue.comments ? `${issue.comments} comment${issue.comments === 1 ? "" : "s"}` : null}
          {issue.comments ? " · " : null}
          <span title={issue.completedAt ? new Date(issue.completedAt).toLocaleString() : undefined}>
            closed {timeAgo(issue.completedAt) ?? "—"}
          </span>
        </span>
      </span>
      <span className="op-log-meta">
        <span className="op-log-who" style={{ color: repoColor(issue.repo) }} title={issue.repo}>
          {issue.repo.split("/").pop()}
        </span>
        {/* An issue with nobody on it says nothing, rather than saying "Unassigned" */}
        <span title={issue.assignee ? `Assigned to ${issue.assignee}` : "Nobody's on it"}>
          {issue.assignee ?? ""}
        </span>
      </span>
    </button>
  );
}

function GitLogView({ companyId, active }: { companyId: string | null; active: boolean }) {
  const [opened, setOpened] = useState(active);
  useEffect(() => {
    if (active) setOpened(true);
  }, [active]);
  // Git isn't read until the view is first opened
  return opened ? <GitLogBody companyId={companyId} active={active} /> : null;
}

function GitLogBody({ companyId, active }: { companyId: string | null; active: boolean }) {
  const { data, loading, error, refresh } = usePluginData<GitCommits>("git-commits", { companyId });
  usePolling(refresh, active);
  if (!active) return null;

  if (error && !data) return <div className="op-list op-log"><div className="op-list-empty">Couldn’t read the git log.</div></div>;
  if (!data) return <div className="op-list op-log"><div className="op-list-empty">{loading ? "Loading…" : ""}</div></div>;
  if (data.state === "unconfigured" || data.commits.length === 0) {
    return (
      <div className="op-list op-log">
        <div className="op-list-empty">
          No git activity yet. The office reads the repos the agents work in, so it fills up as they commit.
        </div>
      </div>
    );
  }

  return (
    <div className="op-list op-log">
      <div className="op-log-toolbar">
        <span className="op-log-repo">
          {data.commits.length} commit{data.commits.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="op-log-body">
        {data.commits.map((commit) => (
          <CommitRow key={`${commit.repo}-${commit.hash}`} commit={commit} />
        ))}
      </div>
    </div>
  );
}

/** One commit: which repo it was made in, and what it changed. */
function CommitRow({ commit }: { commit: GitCommit & { repo: string; repoName: string; branch: string | null } }) {
  return (
    <div className="op-log-row op-log-commit">
      <span className="op-log-hash" title={commit.hash}>{commit.shortHash}</span>
      <span className="op-log-main">
        <span className="op-log-line">
          <span className="op-log-title">{commit.subject}</span>
        </span>
        <span className="op-log-dim">
          {commit.author} · <span title={new Date(commit.date).toLocaleString()}>{timeAgo(commit.date)}</span>
          {commit.filesChanged ? ` · ${commit.filesChanged} file${commit.filesChanged === 1 ? "" : "s"}` : null}
        </span>
      </span>
      <span className="op-log-meta">
        <span className="op-log-who" style={{ color: repoColor(commit.repo) }} title={commit.repo}>
          {commit.repoName}
        </span>
        {commit.branch ? <span className="op-log-dim">⎇ {commit.branch}</span> : null}
        <LineCounts added={commit.insertions} removed={commit.deletions} />
      </span>
    </div>
  );
}

/** Uncommitted changes at a glance: totals, how many of each kind, and where in the repo they are. */
function ChangesOverview({ changes }: { changes: GitChanges }) {
  if (changes.files === 0) return <div className="op-log-row op-log-clean">Working tree clean</div>;
  const shown = changes.byFolder.slice(0, OVERVIEW_FOLDERS);
  const rest = changes.byFolder.slice(OVERVIEW_FOLDERS);
  const others = rest.reduce(
    (sum, folder) => ({ files: sum.files + folder.files, added: sum.added + folder.added, removed: sum.removed + folder.removed }),
    { files: 0, added: 0, removed: 0 },
  );
  const files = (count: number) => `${count} file${count === 1 ? "" : "s"}`;
  return (
    <div className="op-log-overview">
      <div className="op-log-totals">
        <span className="op-log-total">{files(changes.files)} changed</span>
        <LineCounts added={changes.added} removed={changes.removed} />
      </div>
      <div className="op-log-kinds">
        {CHANGE_KINDS.filter(({ kind }) => changes.byKind[kind]).map(({ kind, label, color }) => (
          <span key={kind} className="op-log-kind">
            <span className="op-log-kind-dot" style={{ background: color }} />
            {changes.byKind[kind]} {label}
          </span>
        ))}
      </div>
      <div className="op-log-folders">
        {shown.map((folder) => (
          <div key={folder.folder} className="op-log-folder">
            <span className="op-log-path">{folder.folder === "(root)" ? "(top level)" : `${folder.folder}/`}</span>
            <span className="op-log-dim">{files(folder.files)}</span>
            <LineCounts added={folder.added} removed={folder.removed} />
          </div>
        ))}
        {others.files ? (
          <div className="op-log-folder op-log-dim">
            <span className="op-log-path">{rest.length} more folder{rest.length === 1 ? "" : "s"}</span>
            <span>{files(others.files)}</span>
            <LineCounts added={others.added} removed={others.removed} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LineCounts({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null && removed === null) return <span className="op-log-lines" />;
  return (
    <span className="op-log-lines">
      <span className="op-log-add">+{added ?? 0}</span> <span className="op-log-del">−{removed ?? 0}</span>
    </span>
  );
}
