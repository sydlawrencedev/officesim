import { execFile } from "node:child_process";
import type { GitChangeKind, GitChanges, GitCommit, GitLog } from "./logs.js";

const GIT_TIMEOUT_MS = 10_000;
const COMMITS = 40;
const FIELD = "\x1f";
const RECORD = "\x1e";

function git(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoPath, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

/** Uncommitted changes, summed up, and the latest commits of a repo. */
export async function readGitLog(repoPath: string): Promise<GitLog> {
  try {
    const [branch, status, numstat, log] = await Promise.all([
      git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).then((out) => out.trim() || null).catch(() => null),
      git(repoPath, ["status", "--porcelain=v1"]),
      // Staged and unstaged changes to tracked files against the last commit
      git(repoPath, ["diff", "--numstat", "HEAD"]).catch(() => ""),
      git(repoPath, ["log", `-n${COMMITS}`, `--format=${RECORD}%H${FIELD}%h${FIELD}%an${FIELD}%aI${FIELD}%s`, "--shortstat"]),
    ]);

    const changes = summariseChanges(status, numstat);

    const commits: GitCommit[] = log
      .split(RECORD)
      .filter((record) => record.trim())
      .map((record) => {
        const [header, ...rest] = record.split("\n");
        const [hash, shortHash, author, date, subject] = header.split(FIELD);
        const stat = rest.join(" ");
        const count = (pattern: RegExp) => Number(stat.match(pattern)?.[1] ?? 0);
        return {
          hash,
          shortHash,
          author,
          date,
          subject,
          filesChanged: count(/(\d+) files? changed/),
          insertions: count(/(\d+) insertions?/),
          deletions: count(/(\d+) deletions?/),
        };
      });

    return { state: "ok", repoPath, branch, changes, commits };
  } catch (error) {
    return { state: "error", repoPath, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Git's two-letter status: the staged side when there is one, else the working tree */
function kindOf(status: string): GitChangeKind {
  if (status === "??") return "untracked";
  const code = status[0] !== " " ? status[0] : status[1];
  return code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : "modified";
}

/** Sum up `git status --porcelain` and `git diff --numstat HEAD` output by kind and top-level folder. */
function summariseChanges(status: string, numstat: string): GitChanges {
  const lines = new Map<string, { added: number; removed: number }>();
  for (const line of numstat.split("\n")) {
    const [added, removed, path] = line.split("\t");
    // Binary files show "-" for their counts
    if (path) lines.set(path, { added: Number(added) || 0, removed: Number(removed) || 0 });
  }
  const summary: GitChanges = { files: 0, added: 0, removed: 0, byKind: {}, byFolder: [] };
  const folders = new Map<string, { folder: string; files: number; added: number; removed: number }>();
  for (const line of status.split("\n")) {
    if (line.length <= 3) continue;
    // Renames read "old -> new"; count the new path
    const path = line.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, "");
    const kind = kindOf(line.slice(0, 2));
    const counts = lines.get(path) ?? { added: 0, removed: 0 };
    const folderName = path.includes("/") ? path.split("/")[0] : "(root)";
    const folder = folders.get(folderName) ?? { folder: folderName, files: 0, added: 0, removed: 0 };
    folders.set(folderName, folder);
    summary.files++;
    summary.added += counts.added;
    summary.removed += counts.removed;
    summary.byKind[kind] = (summary.byKind[kind] ?? 0) + 1;
    folder.files++;
    folder.added += counts.added;
    folder.removed += counts.removed;
  }
  summary.byFolder = [...folders.values()].sort((a, b) => b.files - a.files || a.folder.localeCompare(b.folder));
  return summary;
}
