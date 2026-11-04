/** The Activity tab: done tasks, and the git log of the company's repo. Shared by the worker and the UI. */

export type DoneTask = {
  id: string;
  identifier: string | null;
  title: string;
  priority: string;
  assignee: string | null;
  /** The agent that created it, or "Board" for a person */
  createdBy: string | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  comments: number;
  /** The last comment, usually the agent's wrap-up, trimmed */
  lastComment: string | null;
};

export type DoneTasksLog = { tasks: DoneTask[] };

export type GitChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked";

/** Uncommitted changes summed up: files and lines, by kind and by top-level folder */
export type GitChanges = {
  files: number;
  added: number;
  removed: number;
  byKind: Partial<Record<GitChangeKind, number>>;
  /** Biggest first by files changed; "(root)" for files at the top of the repo */
  byFolder: Array<{ folder: string; files: number; added: number; removed: number }>;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type GitLog =
  | { state: "unconfigured" }
  | { state: "error"; repoPath: string; message: string }
  | { state: "ok"; repoPath: string; branch: string | null; changes: GitChanges; commits: GitCommit[] };

/** One repo the office knows about, and what it has been doing. */
export type RepoActivity = {
  /** The folder it lives in. */
  repoPath: string;
  /** Its name, as the Activity tab shows it. */
  name: string;
  branch: string | null;
  changes: GitChanges;
  /** Its latest commits, newest first. */
  commits: GitCommit[];
  /** Why it couldn't be read, if it couldn't. */
  problem: string | null;
};

/**
 * The git activity of every repo the agents work in, newest commit first.
 *
 * The office used to show one repo (the company's own, from the plugin settings). It now shows
 * all of them, so the work across the agents' repos is visible in one place.
 */
export type GitActivity = {
  state: "unconfigured" | "ok";
  repos: RepoActivity[];
};
