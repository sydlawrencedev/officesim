import { useEffect, useMemo, useRef, useState } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { DoneTask, DoneTasksLog, GitActivity, GitChangeKind, GitChanges, GitCommit } from "../logs.js";
import { duration, timeAgo } from "./PixelOfficeCanvas.js";
import { readSetting, writeSetting } from "./storage.js";

type Mode = "tasks" | "git";
const MODES: Array<{ id: Mode; label: string; icon: string }> = [
  { id: "tasks", label: "Tasks", icon: "✓" },
  { id: "git", label: "Git", icon: "⎇" },
];
const MODE_SETTING = "logs-mode";
/** Both logs refresh this often while the tab is open */
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
    if (stored === "tasks" || stored === "git") return stored;
  } catch {
    // Storage unavailable: use the default
  }
  return "tasks";
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

/** The Activity tab: done tasks (newest first, each opening its issue) or the repo's git log. */
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
  return (
    <div className="op-stats">
      <div className="op-stats-top">
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
      </div>
      {/* Both views stay mounted once opened, so switching between them shows their last data at once */}
      <TasksLog companyId={companyId} onIssueClick={onIssueClick} active={active && mode === "tasks"} />
      <GitLogView companyId={companyId} active={active && mode === "git"} />
    </div>
  );
}

function TasksLog({
  companyId,
  onIssueClick,
  active,
}: {
  companyId: string | null;
  onIssueClick: (issue: string, newTab: boolean) => void;
  active: boolean;
}) {
  const { data, loading, error, refresh } = usePluginData<DoneTasksLog>("done-tasks", { companyId });
  usePolling(refresh, active);
  const [filter, setFilter] = useState("");
  const tasks = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = data?.tasks ?? [];
    if (!needle) return all;
    return all.filter((task) =>
      [task.identifier, task.title, task.assignee, task.lastComment].some((text) => text?.toLowerCase().includes(needle)),
    );
  }, [data, filter]);
  if (!active) return null;

  return (
    <div className="op-list op-log">
      <div className="op-log-toolbar">
        <input
          className="op-log-filter"
          type="search"
          placeholder="Filter by title, id, agent…"
          aria-label="Filter done tasks"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <span className="op-log-count">
          {data ? `${tasks.length}${filter ? ` of ${data.tasks.length}` : ""} done` : ""}
        </span>
      </div>
      <div className="op-log-body">
        {error && !data ? (
          <div className="op-list-empty">Couldn’t load done tasks.</div>
        ) : !data && loading ? (
          <div className="op-list-empty">Loading…</div>
        ) : tasks.length === 0 ? (
          <div className="op-list-empty">{filter ? "No done tasks match." : "No tasks done yet."}</div>
        ) : (
          tasks.map((task) => <TaskRow key={task.id} task={task} onOpen={onIssueClick} />)
        )}
      </div>
    </div>
  );
}

function TaskRow({ task, onOpen }: { task: DoneTask; onOpen: (issue: string, newTab: boolean) => void }) {
  const took = duration(task.startedAt ?? task.createdAt, task.completedAt);
  return (
    <button
      type="button"
      className="op-log-row op-log-task"
      title="Open issue"
      onClick={(event) => onOpen(task.identifier ?? task.id, event.metaKey || event.ctrlKey)}
      onAuxClick={(event) => {
        if (event.button === 1) onOpen(task.identifier ?? task.id, true);
      }}
    >
      <span className="op-log-main">
        <span className="op-log-line">
          <span className="op-log-dot" style={{ background: PRIORITY_COLORS[task.priority] ?? PRIORITY_COLORS.medium }} title={`${task.priority} priority`} />
          {task.identifier ? <span className="op-log-id">{task.identifier}</span> : null}
          <span className="op-log-title">{task.title}</span>
        </span>
        {task.lastComment ? <span className="op-log-note">{task.lastComment}</span> : null}
      </span>
      <span className="op-log-meta">
        <span className="op-log-who">{task.assignee ?? "Unassigned"}</span>
        <span title={task.completedAt ? new Date(task.completedAt).toLocaleString() : undefined}>done {timeAgo(task.completedAt) ?? "—"}</span>
        <span className="op-log-dim">
          {took ? `took ${took}` : null}
          {took && task.comments ? " · " : null}
          {task.comments ? `${task.comments} comment${task.comments === 1 ? "" : "s"}` : null}
        </span>
        {task.createdBy ? <span className="op-log-dim">opened by {task.createdBy}</span> : null}
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
  const { data, loading, error, refresh } = usePluginData<GitActivity>("git-activity", { companyId });
  usePolling(refresh, active);
  if (!active) return null;

  if (error && !data) return <div className="op-list op-log"><div className="op-list-empty">Couldn’t read the git log.</div></div>;
  if (!data) return <div className="op-list op-log"><div className="op-list-empty">{loading ? "Loading…" : ""}</div></div>;
  if (data.state === "unconfigured" || data.repos.length === 0) {
    return (
      <div className="op-list op-log">
        <div className="op-list-empty">
          No git repos yet. The office reads the repos the agents work in, so it fills up as they start.
        </div>
      </div>
    );
  }

  return (
    <div className="op-list op-log">
      <div className="op-log-toolbar">
        <span className="op-log-repo">
          {data.repos.length} repo{data.repos.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="op-log-body">
        {data.repos.map((repo) => (
          <section key={repo.repoPath} className="op-log-repo-section">
            <div className="op-log-section">
              {repo.name}
              {repo.branch ? <span className="op-log-branch">⎇ {repo.branch}</span> : null}
            </div>
            {repo.problem ? (
              <div className="op-log-row op-log-clean" style={{ color: "#ff8a80" }}>
                Couldn’t read it: {repo.problem}
              </div>
            ) : (
              <>
                <ChangesOverview changes={repo.changes} />
                {repo.commits.map((commit) => (
                  <div key={commit.hash} className="op-log-row op-log-commit">
                    <span className="op-log-hash" title={commit.hash}>{commit.shortHash}</span>
                    <span className="op-log-main">
                      <span className="op-log-title">{commit.subject}</span>
                      <span className="op-log-dim">
                        {commit.author} · <span title={new Date(commit.date).toLocaleString()}>{timeAgo(commit.date)}</span>
                        {commit.filesChanged ? ` · ${commit.filesChanged} file${commit.filesChanged === 1 ? "" : "s"}` : null}
                      </span>
                    </span>
                    <LineCounts added={commit.insertions} removed={commit.deletions} />
                  </div>
                ))}
              </>
            )}
          </section>
        ))}
      </div>
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
