//! The Issues tab: every open issue across the repos the office knows about, as a kanban board.
//!
//! The Mac app reads them from GitHub (with the `gh` CLI) and from Paperclip (its own database).
//! The board is grouped by repo, with a column for each stage, and each issue carries what else
//! is known about it: its labels, who it's assigned to, how many comments it has and when it was
//! last touched.

use crate::github;
use crate::sources;
use crate::tasks;
use serde_json::{json, Value};
use std::path::PathBuf;

/// The board's columns, in board order.
pub const BOARD_STATUSES: [&str; 5] = ["backlog", "todo", "in_progress", "in_review", "blocked"];

/// The board, as the UI reads it.
pub fn issues_board() -> Value {
    let mut issues: Vec<Value> = Vec::new();
    let mut problems: Vec<Value> = Vec::new();
    // What the office knows about the work in progress, so an issue an agent is on is in progress
    let work = crate::work::look();

    // GitHub: the issues of every repo an agent works in, each repo asked for side by side.
    for (repo, answer) in github::issues_for_repos(&repos(), "open") {
        match answer {
            Ok(repo_issues) => {
                for issue in repo_issues {
                    issues.push(github_issue(&issue, &work));
                }
            }
            Err(error) => {
                // A repo that isn't on GitHub (a worktree, or one that was never pushed) can't be
                // read. That's worth saying plainly rather than passing GitHub's wording on.
                let problem = if error.contains("Could not resolve to a Repository") {
                    "not on GitHub, or not readable with your sign-in".to_owned()
                } else {
                    error
                };
                problems.push(json!({ "repo": repo, "problem": problem }));
            }
        }
    }
    // Paperclip: the issues of every active company.
    for (status, issue) in paperclip_issues() {
        issues.push(issue);
        let _ = status;
    }

    let mut repos: Vec<(String, usize)> = Vec::new();
    for issue in &issues {
        let repo = issue.get("repo").and_then(Value::as_str).unwrap_or_default().to_owned();
        match repos.iter_mut().find(|(name, _)| *name == repo) {
            Some((_, count)) => *count += 1,
            None => repos.push((repo, 1)),
        }
    }
    // The repos with no open issues are still repos you can add an issue to, so they're here
    // too, with nothing open in them.
    for repo in github::tracked_repos() {
        if !repos.iter().any(|(name, _)| *name == repo) {
            repos.push((repo, 0));
        }
    }
    repos.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let columns: Vec<Value> = BOARD_STATUSES
        .iter()
        .map(|status| {
            let column: Vec<&Value> = issues
                .iter()
                .filter(|issue| issue.get("status").and_then(Value::as_str) == Some(*status))
                .collect();
            json!({ "status": status, "issues": column })
        })
        .collect();

    json!({
        "columns": columns,
        "repos": repos.iter().map(|(repo, open)| json!({ "repo": repo, "open": open })).collect::<Vec<_>>(),
        "problems": problems,
    })
}

/// One GitHub issue, as the board shows it.
fn github_issue(issue: &github::Issue, work: &crate::work::Work) -> Value {
    let mut entry = github::to_board_entry(issue);
    if let Some(object) = entry.as_object_mut() {
        // The stage comes from what the office knows of the work, not the labels alone
        let stage = work.stage_of(&issue.repo, issue.number, &issue.title, &issue.labels);
        object.insert("status".to_owned(), json!(stage));
        object.insert(
            "workingAgent".to_owned(),
            json!(work.working_agent(&issue.repo, issue.number, &issue.title)),
        );
    }
    entry
}

/// Paperclip's issues, across every active company.
fn paperclip_issues() -> Vec<(String, Value)> {
    let mut issues = Vec::new();
    for source in tasks::active() {
        if source.id() != "paperclip-tasks" {
            continue;
        }
        // The Paperclip source's own board, as the office's kanban shows it
        if let Ok(paperclip) = source.kanban() {
            for (status, issue) in paperclip {
                let mut issue = issue;
                if let Some(object) = issue.as_object_mut() {
                    let repo = object.get("identifier").and_then(Value::as_str).and_then(|id| id.split_once('-')).map(|(prefix, _)| prefix.to_owned());
                    object.insert("repo".to_owned(), json!(repo.unwrap_or_else(|| "Paperclip".to_owned())));
                    object.insert("status".to_owned(), json!(status));
                    object.insert("labels".to_owned(), json!([]));
                    object.insert("comments".to_owned(), json!(0));
                    object.insert("updatedAt".to_owned(), Value::Null);
                    if !object.contains_key("createdAt") {
                        object.insert("createdAt".to_owned(), Value::Null);
                    }
                }
                issues.push((status, issue));
            }
        }
    }
    issues
}

/// The GitHub repos the agents' folders are, each one once.
fn repos() -> Vec<String> {
    let mut repos: Vec<String> = Vec::new();
    for folder in folders() {
        let Some(repo) = github::repo_slug(&folder) else { continue };
        if !repos.contains(&repo) {
            repos.push(repo);
        }
    }
    repos
}

/// The folders the agents in the office work in, each one once.
fn folders() -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = Vec::new();
    for agent in sources::agents() {
        let Some(cwd) = agent.cwd.as_deref() else { continue };
        let folder = PathBuf::from(cwd);
        if !folder.is_dir() || folders.contains(&folder) {
            continue;
        }
        folders.push(folder);
    }
    folders.sort();
    folders
}
