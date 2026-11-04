/** The Activity tab: closed issues, and the git log of every repo the agents work in. Shared by the worker and the UI. */

/** One issue, as the Activity tab shows it. */
export type DoneIssue = {
  id: string;
  identifier: string | null;
  title: string;
  priority: string;
  /** The repo it came from, so the list says where each one is from. */
  repo: string;
  assignee: string | null;
  createdAt: string | null;
  completedAt: string | null;
  comments: number;
  labels: string[];
  url: string | null;
};

export type DoneIssues = {
  issues: DoneIssue[];
  /** Why a repo's issues couldn't be read, if they couldn't. */
  problems: Array<{ repo: string; problem: string }>;
};

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
 * The git activity of every repo the agents work in.
 *
 * The office used to show one repo (the company's own, from the plugin settings). It now shows
 * all of them, so the work across the agents' repos is visible in one place.
 */
export type GitActivity = {
  state: "unconfigured" | "ok";
  repos: RepoActivity[];
};

/** One commit, with the repo it was made in, so the list says where each one is from. */
export type RepoCommit = GitCommit & {
  /** The repo it was made in, as "owner/repo". */
  repo: string;
  /** The repo's name, as the list shows it. */
  repoName: string;
  /** The branch it was made on. */
  branch: string | null;
};

/**
 * Every repo's commits in one list, newest first.
 *
 * The commits of all the repos the agents work in, together rather than split by repo.
 */
export type GitCommits = {
  state: "unconfigured" | "ok";
  commits: RepoCommit[];
  /** Why a repo couldn't be read, if it couldn't. */
  problems: Array<{ repo: string; problem: string }>;
};
