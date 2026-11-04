//! Which issues are being worked on, and how far along each one is.
//!
//! An issue's stage doesn't come from its labels alone. The office knows which agents are
//! running and what each is working on, so an issue an agent is on is in progress. A branch that
//! names an issue, or an open pull request, says the same thing.

use crate::model::Agent;
use crate::sources;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

/// A branch counts as work in progress only if it was committed to recently.
const BRANCH_IS_RECENT_SECONDS: i64 = 14 * 24 * 60 * 60;

/// What the office knows about the work in progress.
pub struct Work {
    /// The titles of the issues the agents are working on, lowercased, and who they're working on.
    pub titles: Vec<(String, String)>,
    /// The issue numbers the agents' branches name, by repo, and the branches themselves.
    pub branches: Vec<(String, Vec<(u64, String)>)>,
    /// The issues whose work is on a pull request, by repo, and whether it's been merged.
    pub merged: HashMap<(String, u64), bool>,
}

impl Work {
    /// The agent working on an issue, if one is.
    pub fn working_agent(&self, repo: &str, number: u64, title: &str) -> Option<String> {
        // An agent whose session is on this issue
        let wanted = title.trim().to_lowercase();
        for (agent_title, agent) in &self.titles {
            if *agent_title == wanted {
                return Some(agent.clone());
            }
        }
        // A branch that names it, like "fix/520-bank-connection-claims"
        for (branch_repo, branches) in &self.branches {
            if branch_repo != repo {
                continue;
            }
            for (branch_number, branch) in branches {
                if *branch_number == number {
                    return Some(format!("on {branch}"));
                }
            }
        }
        None
    }
    /// The stage an issue is in, given what the office knows.
    pub fn stage_of(&self, repo: &str, number: u64, title: &str, labels: &[String]) -> &'static str {
        // Being worked on wins: an agent on it, or a branch naming it
        if self.is_being_worked_on(repo, number, title) {
            return "in_progress";
        }
        // A pull request for it means the work is done or being looked at, but the issue is open
        if self.merged.contains_key(&(repo.to_owned(), number)) {
            return "in_review";
        }
        // Otherwise, its labels
        crate::tasks::status_for_labels(labels)
    }

    /// Whether an issue is being worked on right now.
    pub fn is_being_worked_on(&self, repo: &str, number: u64, title: &str) -> bool {
        self.working_agent(repo, number, title).is_some()
    }
}

/// What the office can see of the work in progress.
pub fn look() -> Work {
    let agents: Vec<Agent> = sources::agents();
    let titles: Vec<(String, String)> = agents
        .iter()
        .filter(|agent| agent.status == "running")
        .filter_map(|agent| {
            let title = agent.last_run.as_ref()?.issue_title.clone()?;
            let title = title.trim().to_lowercase();
            (!title.is_empty()).then(|| (title, agent.name.clone()))
        })
        .collect();
    let branches = branches(&agents);
    let merged = pull_requests(&agents);
    Work { titles, branches, merged }
}

/// The issue numbers the branches in each repo name, like "fix/del-552-something".
fn branches(agents: &[Agent]) -> Vec<(String, Vec<(u64, String)>)> {
    let mut found: Vec<(String, Vec<(u64, String)>)> = Vec::new();
    for folder in folders(agents) {
        let Some(repo) = crate::github::repo_slug(&folder) else { continue };
        let branches = branch_numbers(&folder);
        if branches.is_empty() {
            continue;
        }
        match found.iter_mut().find(|(name, _)| *name == repo) {
            Some((_, set)) => set.extend(branches),
            None => found.push((repo, branches)),
        }
    }
    found
}

/// The issue numbers a folder's branches name.
///
/// A branch names its issue in one of two ways: with a prefix ("fix/del-552-something"), or
/// bare after a slash ("fix/520-bank-connection-claims"). Only the branches that are recent count:
/// an old branch left over from finished work says nothing about what's being worked on now.
fn branch_numbers(folder: &PathBuf) -> Vec<(u64, String)> {
    let Ok(output) = std::process::Command::new("/usr/bin/git")
        .args(["-C", folder.to_str().unwrap_or(""), "branch", "--format=%(refname:short) %(committerdate:unix)"])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let branches = String::from_utf8_lossy(&output.stdout);
    let now = crate::time::now_millis() / 1000;
    let mut numbers = Vec::new();
    for line in branches.lines() {
        let mut parts = line.split_whitespace();
        let Some(branch) = parts.next() else { continue };
        // A branch with no commits (or an old one) isn't work in progress
        let committed = parts.next().and_then(|when| when.parse::<i64>().ok());
        let recent = committed.is_none_or(|when| now - when < BRANCH_IS_RECENT_SECONDS);
        if !recent {
            continue;
        }
        let mut references = issue_references(branch);
        if let Some(number) = branch_issue_number(branch) {
            references.push(number);
        }
        for number in references {
            numbers.push((number, branch.to_owned()));
        }
    }
    numbers
}

/// The issue number a branch names after a slash, like "fix/520-bank-connection-claims".
fn branch_issue_number(branch: &str) -> Option<u64> {
    let after_slash = branch.rsplit('/').next()?;
    let digits: String = after_slash.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// The issues whose work is on a pull request, by repo, and whether it's been merged.
///
/// An open pull request means the work is in review; a merged one means it's done, but the issue
/// is still open. The pull request's branch says which issue it is: "fix/520-bank-connection-claims".
fn pull_requests(agents: &[Agent]) -> HashMap<(String, u64), bool> {
    let mut found: HashMap<(String, u64), bool> = HashMap::new();
    for repo in repos(agents) {
        let Ok(output) = std::process::Command::new("/usr/bin/env")
            .args([
                "gh",
                "pr",
                "list",
                "--repo",
                &repo,
                "--state",
                "all",
                "--limit",
                "50",
                "--json",
                "number,title,body,headRefName,state,mergedAt",
            ])
            .output()
        else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let Ok(prs) = serde_json::from_str::<Vec<Value>>(&String::from_utf8_lossy(&output.stdout)) else { continue };
        for pr in prs {
            let merged = pr.get("mergedAt").and_then(Value::as_str).is_some();
            let branch = pr.get("headRefName").and_then(Value::as_str).unwrap_or_default();
            // The branch names the issue it works on
            let mut numbers = issue_references(branch);
            if let Some(number) = branch_issue_number(branch) {
                numbers.push(number);
            }
            // A pull request that says it fixes an issue counts too ("Fixes #123")
            let text = format!(
                "{} {}",
                pr.get("title").and_then(Value::as_str).unwrap_or_default(),
                pr.get("body").and_then(Value::as_str).unwrap_or_default(),
            );
            numbers.extend(fixed_issues(&text));
            for number in numbers {
                found.insert((repo.clone(), number), merged);
            }
        }
    }
    found
}

/// The issue numbers a pull request says it fixes, like "Fixes #123" or "Closes del-45".
///
/// The keyword has to be there: a bare number in the text is a mention, not a fix.
fn fixed_issues(text: &str) -> Vec<u64> {
    let mut numbers = Vec::new();
    let lowered = text.to_lowercase();
    for line in lowered.lines() {
        let line = line.trim();
        let says_it_fixes = ["fixes", "fix", "closes", "close", "resolves", "resolve"]
            .iter()
            .any(|keyword| line.starts_with(keyword) || line.contains(&format!("{keyword} #")));
        if !says_it_fixes {
            continue;
        }
        numbers.extend(issue_references(line));
    }
    numbers
}

/// The issue numbers a piece of text refers to, like "fixes #123" or "del-552".
fn issue_references(text: &str) -> Vec<u64> {
    let mut numbers = Vec::new();
    let lowered = text.to_lowercase();
    // "#123"
    for part in lowered.split('#').skip(1) {
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(number) = digits.parse::<u64>() {
            numbers.push(number);
        }
    }
    // "del-552", "issue-405", "gh-12"
    for part in lowered.split(|c: char| !c.is_ascii_alphanumeric() && c != '-') {
        for prefix in ["del-", "issue-", "gh-"] {
            if let Some(digits) = part.strip_prefix(prefix) {
                let digits: String = digits.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(number) = digits.parse::<u64>() {
                    numbers.push(number);
                }
            }
        }
    }
    numbers
}

/// The folders the agents work in, each one once.
fn folders(agents: &[Agent]) -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = Vec::new();
    for agent in agents {
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

/// The GitHub repos the agents' folders are, each one once.
fn repos(agents: &[Agent]) -> Vec<String> {
    let mut repos: Vec<String> = Vec::new();
    for folder in folders(agents) {
        let Some(repo) = crate::github::repo_slug(&folder) else { continue };
        if !repos.contains(&repo) {
            repos.push(repo);
        }
    }
    repos
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work(titles: &[&str], branches: &[(&str, &[u64])]) -> Work {
        Work {
            titles: titles.iter().map(|title| (title.to_lowercase(), "An agent".to_owned())).collect(),
            branches: branches
                .iter()
                .map(|(repo, numbers)| {
                    (
                        repo.to_string(),
                        numbers.iter().map(|number| (*number, format!("fix/{number}-something"))).collect(),
                    )
                })
                .collect(),
            merged: HashMap::new(),
        }
    }

    #[test]
    fn an_agent_on_an_issue_puts_it_in_progress() {
        let work = work(&["Fix the tests"], &[]);
        assert_eq!(work.stage_of("owner/repo", 1, "Fix the tests", &[]), "in_progress");
        // A different issue isn't
        assert_eq!(work.stage_of("owner/repo", 2, "Something else", &[]), "todo");
    }

    #[test]
    fn a_branch_naming_an_issue_puts_it_in_progress() {
        let work = work(&[], &[("owner/repo", &[552])]);
        assert_eq!(work.stage_of("owner/repo", 552, "Anything", &[]), "in_progress");
        // But only in its own repo
        assert_eq!(work.stage_of("other/repo", 552, "Anything", &[]), "todo");
    }

    #[test]
    fn labels_say_the_stage_when_nothing_else_does() {
        let work = work(&[], &[]);
        assert_eq!(work.stage_of("owner/repo", 1, "It", &["blocked".to_owned()]), "blocked");
        assert_eq!(work.stage_of("owner/repo", 1, "It", &[]), "todo");
    }

    /// An issue whose work is on a pull request, but which is still open.
    #[test]
    fn an_issue_with_a_pull_request_is_in_review() {
        let mut with_pr = work(&[], &[]);
        with_pr.merged.insert(("owner/repo".to_owned(), 7), true);
        assert_eq!(with_pr.stage_of("owner/repo", 7, "It", &[]), "in_review");
        // Another issue in the same repo isn't
        assert_eq!(with_pr.stage_of("owner/repo", 8, "It", &[]), "todo");
        // Being worked on beats being in review
        let working = work(&["It"], &[]);
        assert_eq!(working.stage_of("owner/repo", 1, "It", &[]), "in_progress");
    }

    #[test]
    fn finds_the_issue_numbers_in_a_piece_of_text() {
        assert_eq!(issue_references("fixes #123 and del-45"), vec![123, 45]);
        assert_eq!(issue_references("nothing here"), Vec::<u64>::new());
    }

    #[test]
    fn reads_the_numbers_out_of_a_branch_name() {
        let folder = std::env::temp_dir().join(format!("officesim-branch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        let git = |args: &[&str]| {
            let mut command = std::process::Command::new("/usr/bin/git");
            command.arg("-C").arg(folder.to_str().unwrap());
            command.args(args);
            command.output().expect("git runs")
        };
        git(&["init", "-q"]);
        // A branch needs a commit to point at, so there's one first
        std::fs::write(folder.join("README.md"), "hello").unwrap();
        git(&["add", "README.md"]);
        git(&["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "first"]);
        git(&["branch", "fix/del-552-sourcemap-upload"]);
        git(&["branch", "fix/issue-405-stale-fees"]);
        git(&["branch", "main"]);
        let numbers = branch_numbers(&folder);
        assert!(numbers.contains(&(552, "fix/del-552-sourcemap-upload".to_owned())), "{numbers:?}");
        assert!(numbers.contains(&(405, "fix/issue-405-stale-fees".to_owned())), "{numbers:?}");
        assert!(!numbers.iter().any(|(number, _)| *number == 1), "{numbers:?}");
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
