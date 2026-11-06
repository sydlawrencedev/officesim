//! The Issues tab: every open issue across the repos the office knows about, as a kanban board.
//!
//! The Mac app reads them from GitHub (with the `gh` CLI) and from Paperclip (its own database).
//! The board is grouped by repo, with a column for each stage, and each issue carries what else
//! is known about it: its labels, who it's assigned to, how many comments it has and when it was
//! last touched.

use crate::github;
use crate::tasks;
use serde_json::{json, Value};

/// The board's columns, in board order.
pub const BOARD_STATUSES: [&str; 5] = ["backlog", "todo", "in_progress", "in_review", "blocked"];

/// The board, as the UI reads it.
pub fn issues_board() -> Value {
    let mut issues: Vec<Value> = Vec::new();
    let mut problems: Vec<Value> = Vec::new();
    // What the office knows about the work in progress, so an issue an agent is on is in progress
    let work = crate::work::look();

    // The GitHub repos the office knows about: the ones the agents work in now, the ones they
    // worked in before, and the ones remembered from earlier.
    //
    // This is the same list the boardroom's own kanban reads, so the Issues tab and the wall
    // board show the same issues. It used to be a smaller list — only the repos an agent was in
    // that minute — which is why this tab could show four issues while the wall board showed
    // many more.
    let tracked = github::tracked_repos();

    // GitHub: the issues of every one of those repos, each asked for side by side.
    for (repo, answer) in github::issues_for_repos(&tracked, "open") {
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
    for repo in &tracked {
        if !repos.iter().any(|(name, _)| name == repo) {
            repos.push((repo.clone(), 0));
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
                    // The company it belongs to names it, the way a repo names a GitHub issue.
                    let repo = object
                        .get("company")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| "Paperclip".to_owned());
                    object.insert("repo".to_owned(), json!(repo));
                    object.insert("status".to_owned(), json!(status));
                    object.insert("labels".to_owned(), json!([]));
                    if !object.contains_key("comments") {
                        object.insert("comments".to_owned(), json!(0));
                    }
                    if !object.contains_key("updatedAt") {
                        object.insert("updatedAt".to_owned(), Value::Null);
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The Issues tab and the boardroom's wall board must show the same issues.
    ///
    /// They used to read different repo lists: the wall board asked for every repo the office
    /// knew about, and this tab asked only for the ones an agent was in that minute. A repo
    /// nobody was in still had open issues, so the wall board showed many more than this tab.
    ///
    /// Both now read the office's list of known repos, and this is what stops them drifting
    /// apart again: every repo the wall board would ask about is on this tab's list too.
    #[test]
    fn this_tab_reads_the_same_repos_as_the_wall_board() {
        // The wall board asks GitHub for every repo the office knows about.
        let wall_board_repos = crate::tasks::active_repos();
        // This tab reads the same list.
        assert_eq!(issues_repos(), wall_board_repos);
    }

    /// The repos the Issues tab reads its issues from.
    ///
    /// Kept as its own function so the test above can compare it with the wall board's list
    /// without waiting for GitHub to answer.
    fn issues_repos() -> Vec<String> {
        github::tracked_repos()
    }
}
