//! The Activity tab's Tasks: the issues that were recently closed, across the tracked repos.
//!
//! The boardroom's own done tasks come from Paperclip. On the Mac the work happens in GitHub, so
//! the closed issues of the repos the agents work in are what the tab shows.

use crate::github;
use crate::sources;
use crate::time::iso_from_millis;
use serde_json::{json, Value};
use std::path::PathBuf;

/// How many closed issues each repo contributes.
const PER_REPO: usize = 30;

/// The closed issues of every repo the agents work in, newest first.
pub fn closed_issues() -> Value {
    let mut issues: Vec<Value> = Vec::new();
    let mut problems: Vec<Value> = Vec::new();
    for repo in repos() {
        match github::closed_issues(&repo) {
            Ok(repo_issues) => {
                for issue in repo_issues.into_iter().take(PER_REPO) {
                    issues.push(closed_issue(&issue));
                }
            }
            Err(error) => problems.push(json!({ "repo": repo, "problem": error })),
        }
    }
    // Newest closed first
    issues.sort_by_key(|issue| {
        -issue
            .get("completedAt")
            .and_then(Value::as_str)
            .and_then(crate::time::millis_from_iso)
            .unwrap_or(0)
    });
    json!({ "issues": issues, "problems": problems })
}

/// One closed issue, as the Activity tab shows it.
fn closed_issue(issue: &github::Issue) -> Value {
    let closed_at = issue.closed_at.or(issue.updated_at);
    json!({
        "id": format!("github:{}#{}", issue.repo, issue.number),
        "identifier": format!("{}#{}", issue.repo, issue.number),
        "title": issue.title,
        "priority": github::priority_for(&issue.labels),
        "repo": issue.repo,
        "labels": issue.labels,
        "assignee": issue.assignee,
        "createdAt": issue.created_at.map(iso_from_millis),
        "completedAt": closed_at.map(iso_from_millis),
        "comments": issue.comments,
        "url": github::issue_url(issue),
    })
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
