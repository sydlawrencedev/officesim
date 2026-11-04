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
