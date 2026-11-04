/** The Issues tab: every open issue across the repos the office knows about, as a kanban board. Shared by the worker and the UI. */

/** One issue, however it was found (a GitHub issue, a Paperclip issue). */
export type BoardIssue = {
  /** Stable across the office's refreshes, so the board doesn't jump about. */
  id: string;
  /** How it's written: "owner/repo#12" for a GitHub issue, "DEL-12" for a Paperclip one. */
  identifier: string | null;
  title: string;
  /** The stage it's in: backlog, todo, in_progress, in_review or blocked. */
  status: string;
  priority: string;
  /** The repo it belongs to, so the board can group by it. */
  repo: string;
  /** Labels on it, GitHub ones or Paperclip's. */
  labels: string[];
  /** Who it's assigned to, by name. */
  assignee: string | null;
  /** Who's working on it now, if anyone (an agent, or a branch naming it). */
  workingAgent: string | null;
  /** How many comments it has. */
  comments: number;
  /** When it was opened. */
  createdAt: string | null;
  /** When it was last touched. */
  updatedAt: string | null;
  /** Where it is, for a click to open it. */
  url: string | null;
};

/** The board: its columns, and the repos it came from. */
export type IssuesBoard = {
  /** One entry per column: its issues, most urgent first. */
  columns: Array<{ status: string; issues: BoardIssue[] }>;
  /** The repos the issues came from, and how many each has. */
  repos: Array<{ repo: string; open: number }>;
  /** Why a repo's issues couldn't be read, if they couldn't. */
  problems: Array<{ repo: string; problem: string }>;
};

/** The board's columns, in board order. */
export const BOARD_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

/** The name of each column, as the board's header shows it. */
export const BOARD_STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
};

/** Each column's colour, as the board's header strip is drawn. */
export const BOARD_STATUS_COLORS: Record<string, string> = {
  backlog: "#9aa0a6",
  todo: "#4dabf7",
  in_progress: "#fab005",
  in_review: "#9775fa",
  blocked: "#fa5252",
};

/** How a GitHub label maps onto a column. */
export function statusForLabels(labels: string[]): string {
  for (const label of labels) {
    switch (label.trim().toLowerCase()) {
      case "backlog":
      case "icebox":
      case "later":
      case "someday":
        return "backlog";
      case "in progress":
      case "in-progress":
      case "in_progress":
      case "doing":
      case "wip":
      case "started":
        return "in_progress";
      case "in review":
      case "in-review":
      case "in_review":
      case "review":
      case "needs review":
      case "needs-review":
        return "in_review";
      case "blocked":
      case "blocker":
      case "waiting":
      case "on hold":
      case "on-hold":
        return "blocked";
      case "todo":
      case "to do":
      case "to-do":
      case "ready":
      case "open":
      case "next":
        return "todo";
      default:
        break;
    }
  }
  return "todo";
}

/** How a GitHub label maps onto a priority. */
export function priorityForLabels(labels: string[]): string {
  for (const label of labels) {
    switch (label.trim().toLowerCase()) {
      case "critical":
      case "p0":
      case "urgent":
      case "sev1":
      case "severity: critical":
        return "critical";
      case "high":
      case "p1":
      case "important":
      case "sev2":
        return "high";
      case "medium":
      case "p2":
      case "normal":
        return "medium";
      default:
        break;
    }
  }
  return "low";
}

/** How urgent a priority is, so the board can put the worst first. */
export function priorityRank(priority: string): number {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

/**
 * A colour for a repo, so each one keeps the same colour wherever it appears.
 *
 * The hue comes from the repo's name, so it's the same every time and doesn't need storing.
 */
export function repoColor(repo: string): string {
  let hash = 0;
  for (let i = 0; i < repo.length; i += 1) {
    hash = (hash * 31 + repo.charCodeAt(i)) | 0;
  }
  // A spread of hues that all read well on the dark background
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 62% 62%)`;
}
