//! The git activity of every repo the agents work in, for the Activity tab.
//!
//! The office used to show one repo (the company's own). It now shows all of them, so the work
//! across the agents' repos is visible in one place.
//!
//! Each repo is read with `git` directly: its branch, its uncommitted changes and its latest
//! commits.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Most commits shown for one repo.
const COMMITS: usize = 40;

/// The git activity of every repo the agents work in.
pub fn git_activity() -> Value {
    let mut repos: Vec<Value> = Vec::new();
    for folder in folders() {
        let name = folder
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| folder.to_string_lossy().into_owned());
        repos.push(repo_activity(&folder, &name));
    }
    json!({ "state": if repos.is_empty() { "unconfigured" } else { "ok" }, "repos": repos })
}

/// Every repo's commits in one list, newest first.
///
/// The commits of all the repos the agents work in, together rather than split by repo.
pub fn git_commits() -> Value {
    let mut commits: Vec<Value> = Vec::new();
    let mut problems: Vec<Value> = Vec::new();
    for folder in folders() {
        let name = folder
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| folder.to_string_lossy().into_owned());
        let repo = crate::github::repo_slug(&folder).unwrap_or_else(|| name.clone());
        let activity = repo_activity(&folder, &name);
        if let Some(problem) = activity.get("problem").and_then(Value::as_str) {
            problems.push(json!({ "repo": repo, "problem": problem }));
            continue;
        }
        let branch = activity.get("branch").and_then(Value::as_str).map(str::to_owned);
        for commit in activity.get("commits").and_then(Value::as_array).into_iter().flatten() {
            let mut commit = commit.clone();
            if let Some(object) = commit.as_object_mut() {
                object.insert("repo".to_owned(), json!(repo));
                object.insert("repoName".to_owned(), json!(name));
                object.insert("branch".to_owned(), json!(branch));
            }
            commits.push(commit);
        }
    }
    // Newest first
    commits.sort_by_key(|commit| {
        -commit
            .get("date")
            .and_then(Value::as_str)
            .and_then(crate::time::millis_from_iso)
            .unwrap_or(0)
    });
    json!({
        "state": if commits.is_empty() && problems.is_empty() { "unconfigured" } else { "ok" },
        "commits": commits,
        "problems": problems,
    })
}

/// One repo's activity: its branch, its uncommitted changes and its latest commits.
fn repo_activity(folder: &Path, name: &str) -> Value {
    let branch = git(folder, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|out| out.trim().to_owned())
        .filter(|out| !out.is_empty());
    let changes = match git(folder, &["status", "--porcelain=v1"]) {
        Ok(status) => changes_of(folder, &status),
        Err(error) => {
            return json!({
                "repoPath": folder.to_string_lossy(),
                "name": name,
                "branch": Value::Null,
                "changes": empty_changes(),
                "commits": [],
                "problem": error,
            })
        }
    };
    let commits = match git(folder, &["log", &format!("-n{COMMITS}"), "--format=\u{1e}%H\u{1f}%h\u{1f}%an\u{1f}%aI\u{1f}%s", "--shortstat"]) {
        Ok(log) => commits_of(&log),
        Err(error) => {
            return json!({
                "repoPath": folder.to_string_lossy(),
                "name": name,
                "branch": branch,
                "changes": changes,
                "commits": [],
                "problem": error,
            })
        }
    };
    json!({
        "repoPath": folder.to_string_lossy(),
        "name": name,
        "branch": branch,
        "changes": changes,
        "commits": commits,
        "problem": Value::Null,
    })
}

/// The folders the agents in the office work in, each one once.
fn folders() -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = Vec::new();
    for agent in crate::sources::agents() {
        let Some(cwd) = agent.cwd.as_deref() else { continue };
        let folder = PathBuf::from(cwd);
        if !folder.is_dir() || !folder.join(".git").exists() || folders.contains(&folder) {
            continue;
        }
        folders.push(folder);
    }
    folders.sort();
    folders
}

/// Runs git in a folder and returns its output.
fn git(folder: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("/usr/bin/git");
    command.arg("-C").arg(folder);
    command.args(args);
    let output = command
        .output()
        .map_err(|error| format!("Can't run git: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let error = String::from_utf8_lossy(&output.stderr);
        let error = error.lines().next().unwrap_or("git failed").trim().to_owned();
        Err(if error.is_empty() { "git failed".to_owned() } else { error })
    }
}

/// No changes at all.
fn empty_changes() -> Value {
    json!({ "files": 0, "added": 0, "removed": 0, "byKind": {}, "byFolder": [] })
}

/// The uncommitted changes, summed up: files and lines, by kind and by top-level folder.
fn changes_of(folder: &Path, status: &str) -> Value {
    let numstat = git(folder, &["diff", "--numstat", "HEAD"]).unwrap_or_default();
    let mut lines: Vec<(String, u64, u64)> = Vec::new();
    for line in numstat.lines() {
        let mut parts = line.split('\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        lines.push((path.to_owned(), added.parse().unwrap_or(0), removed.parse().unwrap_or(0)));
    }

    let mut files = 0usize;
    let mut added = 0u64;
    let mut removed = 0u64;
    let mut by_kind: Vec<(String, usize)> = Vec::new();
    let mut by_folder: Vec<(String, usize, u64, u64)> = Vec::new();
    for line in status.lines() {
        if line.len() <= 3 {
            continue;
        }
        let code = &line[..2];
        // Renames read "old -> new"; the new path is the one that matters
        let path = match line[3..].split_once(" -> ") {
            Some((_, new)) => new,
            None => &line[3..],
        }
        .replace('"', "");
        let counts = lines.iter().find(|(name, _, _)| *name == path);
        let (added_here, removed_here) = match counts {
            Some((_, added, removed)) => (*added, *removed),
            None => (0, 0),
        };
        let kind = kind_of(code);
        files += 1;
        added += added_here;
        removed += removed_here;
        match by_kind.iter_mut().find(|(name, _)| *name == kind) {
            Some((_, count)) => *count += 1,
            None => by_kind.push((kind, 1)),
        }
        let folder_name = if path.contains('/') { path.split('/').next().unwrap_or("(root)").to_owned() } else { "(root)".to_owned() };
        match by_folder.iter_mut().find(|(name, _, _, _)| *name == folder_name) {
            Some((_, count, a, r)) => {
                *count += 1;
                *a += added_here;
                *r += removed_here;
            }
            None => by_folder.push((folder_name, 1, added_here, removed_here)),
        }
    }
    by_folder.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let kinds: serde_json::Map<String, Value> = by_kind
        .iter()
        .map(|(kind, count)| (kind.clone(), json!(count)))
        .collect();
    json!({
        "files": files,
        "added": added,
        "removed": removed,
        "byKind": kinds,
        "byFolder": by_folder.iter().map(|(folder, files, added, removed)| json!({
            "folder": folder, "files": files, "added": added, "removed": removed
        })).collect::<Vec<_>>(),
    })
}

/// Git's two-letter status: the staged side when there is one, else the working tree.
///
/// The status is two characters: the staged side and the working tree side. The staged side wins
/// when there's something in it.
fn kind_of(code: &str) -> String {
    let staged = &code[..1.min(code.len())];
    let working = &code[1.min(code.len())..2.min(code.len())];
    let side = if staged != " " { staged } else { working };
    match side {
        "?" => "untracked",
        "A" => "added",
        "D" => "deleted",
        "R" => "renamed",
        _ => "modified",
    }
    .to_owned()
}

/// The commits in git's log output.
fn commits_of(log: &str) -> Vec<Value> {
    let mut commits = Vec::new();
    for record in log.split('\u{1e}') {
        if record.trim().is_empty() {
            continue;
        }
        let mut lines = record.lines();
        let Some(header) = lines.next() else { continue };
        let stat = lines.collect::<Vec<_>>().join(" ");
        let mut fields = header.split('\u{1f}');
        let (Some(hash), Some(short), Some(author), Some(date), Some(subject)) = (
            fields.next(), fields.next(), fields.next(), fields.next(), fields.next(),
        ) else { continue };
        // Git's shortstat: "3 files changed, 12 insertions(+), 4 deletions(-)"
        let count = |singular: &str| -> u64 {
            let parts: Vec<&str> = stat.split_whitespace().collect();
            let mut total = 0;
            for pair in parts.windows(2) {
                // The word may be plural, and may carry a comma or a "(+)"
                let name = pair[1]
                    .trim_end_matches("(+)")
                    .trim_end_matches("(-)")
                    .trim_end_matches(',');
                if name == singular || name == format!("{singular}s") {
                    if let Ok(number) = pair[0].parse::<u64>() {
                        total += number;
                    }
                }
            }
            total
        };
        commits.push(json!({
            "hash": hash,
            "shortHash": short,
            "author": author,
            "date": date,
            "subject": subject,
            "filesChanged": count("file"),
            "insertions": count("insertion"),
            "deletions": count("deletion"),
        }));
    }
    commits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_kinds_of_change() {
        assert_eq!(kind_of(" M"), "modified");
        assert_eq!(kind_of("A "), "added");
        assert_eq!(kind_of(" D"), "deleted");
        assert_eq!(kind_of("R "), "renamed");
        assert_eq!(kind_of("??"), "untracked");
    }

    #[test]
    fn reads_the_commits_out_of_gits_log() {
        let log = "\u{1e}abc123\u{1f}abc\u{1f}Sam\u{1f}2026-11-04T10:00:00Z\u{1f}Fix it\n 1 file changed, 3 insertions(+)\n";
        let commits = commits_of(log);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0]["shortHash"], "abc");
        assert_eq!(commits[0]["subject"], "Fix it");
        assert_eq!(commits[0]["insertions"], 3);
        assert_eq!(commits[0]["filesChanged"], 1);
    }

    #[test]
    fn no_changes_is_an_empty_summary() {
        let changes = changes_of(Path::new("/nowhere"), "");
        assert_eq!(changes["files"], 0);
        assert_eq!(changes["added"], 0);
        assert_eq!(changes["byFolder"].as_array().unwrap().len(), 0);
    }
}
