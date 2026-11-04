//! The Activity tab's Tasks: the issues that were recently closed, across the tracked repos.
//!
//! The boardroom's own done tasks come from Paperclip. On the Mac the work happens in GitHub, so
//! the closed issues of the repos the agents work in are what the tab shows.

use crate::github;
use crate::time::iso_from_millis;
use serde_json::{json, Value};

/// How many closed issues each repo contributes.
const PER_REPO: usize = 30;

/// The closed issues of every repo the agents work in, newest first.
pub fn closed_issues() -> Value {
    let mut issues: Vec<Value> = Vec::new();
    let mut problems: Vec<Value> = Vec::new();
    // Each repo is asked for side by side, so the wait is one answer rather than one per repo
    for (repo, answer) in github::issues_for_repos(&repos(), "closed") {
        match answer {
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
    github::tracked_repos()
}
