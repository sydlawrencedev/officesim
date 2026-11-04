//! GitHub issues, read with the `gh` CLI (installed and signed in on the Mac, so no tokens of
//! its own). Each git repo an agent works in has its open issues, which go on the boardroom
//! kanban.
//!
//! `gh` is asked for the repo's owner and name, then for its open issues with their labels and
//! assignees. Answers are cached for a little while, since the board asks often and GitHub is
//! slow.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a repo's issues are reused before asking GitHub again.
///
/// Two minutes: long enough that reading the board doesn't hammer GitHub, short enough that a
/// change someone made is noticed while they're looking at it.
pub const CACHE_FOR: Duration = Duration::from_secs(2 * 60);
/// Most issues read from one repo, so a busy board doesn't ask for hundreds.
const MAX_ISSUES: usize = 100;

/// One GitHub issue, as the board wants it.
#[derive(Clone, Debug)]
pub struct Issue {
    /// The issue's number in its repo.
    pub number: u64,
    /// "owner/repo", so the board can say where the issue is from.
    pub repo: String,
    pub title: String,
    /// The labels on the issue, lowercased.
    pub labels: Vec<String>,
    /// Who it's assigned to, by their GitHub login.
    pub assignee: Option<String>,
    /// How many comments it has.
    pub comments: u64,
    /// When it was opened, in milliseconds since the epoch.
    pub created_at: Option<i64>,
    /// When it was last touched, in milliseconds since the epoch.
    pub updated_at: Option<i64>,
    /// When it was closed, in milliseconds since the epoch.
    pub closed_at: Option<i64>,
}

/// The cached issues of a repo, and when they were read.
struct Cached {
    at: Instant,
    issues: Vec<Issue>,
}

static CACHE: Mutex<Option<HashMap<String, Cached>>> = Mutex::new(None);

/// The GitHub repos the agents in the office work in, each one once.
///
/// These are the repos the Issues and Activity tabs show.
pub fn tracked_repos() -> Vec<String> {
    let mut repos: Vec<String> = Vec::new();
    for folder in tracked_folders() {
        let Some(repo) = repo_slug(&folder) else { continue };
        if !repos.contains(&repo) {
            repos.push(repo);
        }
    }
    repos
}

/// The folders the agents in the office work in, each one once.
pub fn tracked_folders() -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = Vec::new();
    for agent in crate::sources::agents() {
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

/// The repo's owner and name, from its git remotes (the folder's own remote, no network).
///
/// The remote that points at github.com, of the folder's `origin` remote when it has one.
pub fn repo_slug(folder: &Path) -> Option<String> {
    let remote = git_remote(folder)?;
    // git@github.com:owner/repo.git or https://github.com/owner/repo.git
    let without_suffix = remote.strip_suffix(".git").unwrap_or(&remote);
    let path = if let Some((_, path)) = without_suffix.split_once('@') {
        // An scp-like remote: "git@github.com:owner/repo"
        path.strip_prefix("github.com:").unwrap_or(path)
    } else {
        without_suffix
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_start_matches("www.")
            .trim_start_matches("github.com/")
    };
    let (owner, name) = path.split_once('/')?;
    (!owner.is_empty() && !name.is_empty()).then(|| format!("{owner}/{name}"))
}

/// The folder's `origin` remote, or its first GitHub remote.
fn git_remote(folder: &Path) -> Option<String> {
    if !folder.join(".git").exists() {
        return None;
    }
    let output = Command::new("/usr/bin/git")
        .args(["-C", folder.to_str()?, "remote", "-v"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let remotes = String::from_utf8_lossy(&output.stdout);
    let mut first_github = None;
    for line in remotes.lines() {
        // "origin\thttps://github.com/owner/repo.git (fetch)"
        let Some((name, url)) = line.split_once('\t') else { continue };
        let url = url.split_whitespace().next().unwrap_or(url);
        if !url.contains("github.com") {
            continue;
        }
        if name == "origin" {
            return Some(url.to_owned());
        }
        first_github.get_or_insert_with(|| url.to_owned());
    }
    first_github
}

/// The issues of a repo in a given state, from `gh`.
///
/// Both states are cached: the closed ones are asked for by two different panels (the Activity
/// list and the toolbar's Done count), and asking GitHub twice costs a second each time.
fn issues_in(repo: &str, state: &str) -> Result<Vec<Issue>, String> {
    if let Some(cached) = cached(repo, state) {
        return Ok(cached);
    }
    let output = gh(&[
        "issue",
        "list",
        "--repo",
        repo,
        "--limit",
        &MAX_ISSUES.to_string(),
        "--state",
        state,
        "--json",
        "number,title,labels,assignees,comments,createdAt,updatedAt,closedAt",
    ])?;
    let parsed: Vec<Value> = serde_json::from_str(&output).map_err(|error| format!("Can't read GitHub's answer: {error}"))?;
    let issues: Vec<Issue> = parsed
        .iter()
        .filter_map(|issue| {
            let number = issue.get("number").and_then(Value::as_u64)?;
            let title = issue.get("title").and_then(Value::as_str)?.to_owned();
            let labels = issue
                .get("labels")
                .and_then(Value::as_array)
                .map(|labels| {
                    labels
                        .iter()
                        .filter_map(|label| label.get("name").and_then(Value::as_str))
                        .map(|name| name.to_lowercase())
                        .collect()
                })
                .unwrap_or_default();
            let assignee = issue
                .get("assignees")
                .and_then(Value::as_array)
                .and_then(|assignees| assignees.first())
                .and_then(|assignee| assignee.get("login").and_then(Value::as_str))
                .map(str::to_owned);
            // The comments come as a list, so the count is how many there are
            let comments = issue
                .get("comments")
                .and_then(Value::as_array)
                .map(|comments| comments.len() as u64)
                .unwrap_or(0);
            let created_at = issue.get("createdAt").and_then(Value::as_str).and_then(crate::time::millis_from_iso);
            let updated_at = issue.get("updatedAt").and_then(Value::as_str).and_then(crate::time::millis_from_iso);
            let closed_at = issue.get("closedAt").and_then(Value::as_str).and_then(crate::time::millis_from_iso);
            Some(Issue { number, repo: repo.to_owned(), title, labels, assignee, comments, created_at, updated_at, closed_at })
        })
        .collect();
    remember(repo, state, issues.clone());
    Ok(issues)
}

/// Why GitHub can't be read, if it can't (shown in the Settings tab).
pub fn problem() -> Option<String> {
    let output = Command::new("/usr/bin/env").args(["gh", "--version"]).output().ok()?;
    if !output.status.success() {
        return Some("gh isn't installed, so GitHub issues can't be read".to_owned());
    }
    let output = Command::new("/usr/bin/env").args(["gh", "auth", "status"]).output().ok()?;
    if !output.status.success() {
        return Some("gh isn't signed in to GitHub".to_owned());
    }
    None
}

/// The web page of an issue.
pub fn issue_url(issue: &Issue) -> String {
    format!("https://github.com/{}/issues/{}", issue.repo, issue.number)
}

/// The board's priority for an issue, from its labels.
pub fn priority_for(labels: &[String]) -> &'static str {
    for label in labels {
        match label.as_str() {
            "critical" | "p0" | "urgent" | "sev1" | "severity: critical" => return "critical",
            "high" | "p1" | "important" | "sev2" => return "high",
            "medium" | "p2" | "normal" => return "medium",
            _ => {}
        }
    }
    "low"
}

/// The board's issue for a GitHub issue.
pub fn to_board_issue(issue: &Issue) -> Value {
    json!({
        "id": format!("github:{}#{}", issue.repo, issue.number),
        // The board's identifier is what a click opens, so it names the repo and the number.
        "identifier": format!("{}#{}", issue.repo, issue.number),
        "title": issue.title,
        "priority": priority_for(&issue.labels),
        // Nobody's run is in progress on a GitHub issue, and its assignee is a person, not an agent.
        "workingAgent": Value::Null,
        "assigneeAgent": Value::Null,
        "assignedToUser": issue.assignee.is_some(),
        // Where the issue is, for a click to open it on GitHub.
        "url": issue_url(issue),
    })
}

/// The issue as the Issues tab shows it: everything known about it.
pub fn to_board_entry(issue: &Issue) -> Value {
    json!({
        "id": format!("github:{}#{}", issue.repo, issue.number),
        "identifier": format!("{}#{}", issue.repo, issue.number),
        "title": issue.title,
        "status": status_for(&issue.labels),
        "priority": priority_for(&issue.labels),
        "repo": issue.repo,
        "labels": issue.labels,
        "assignee": issue.assignee,
        "workingAgent": Value::Null,
        "comments": issue.comments,
        "createdAt": issue.created_at.map(crate::time::iso_from_millis),
        "updatedAt": issue.updated_at.map(crate::time::iso_from_millis),
        "url": issue_url(issue),
    })
}

/// The column an issue belongs to, from its labels.
fn status_for(labels: &[String]) -> &'static str {
    crate::tasks::status_for_labels(labels)
}

/// Opens a new issue on a repo.
///
/// Returns the number of the new issue, so the board can show it.
pub fn create_issue(repo: &str, title: &str, body: Option<&str>, labels: &[String]) -> Result<u64, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("The issue needs a title.".to_owned());
    }
    let mut args = vec!["issue", "create", "--repo", repo, "--title", title];
    if let Some(body) = body.map(str::trim).filter(|body| !body.is_empty()) {
        args.push("--body");
        args.push(body);
    }
    for label in labels {
        let label = label.trim();
        if !label.is_empty() {
            args.push("--label");
            args.push(label);
        }
    }
    let output = gh(&args)?;
    // gh answers with the issue's URL: "https://github.com/owner/repo/issues/12"
    let number = output
        .split('/')
        .last()
        .and_then(|number| number.trim().parse::<u64>().ok())
        .ok_or_else(|| format!("GitHub didn't say which issue it made: {output}"))?;
    // The board shows the new issue straight away
    forget(repo);
    Ok(number)
}

/// Runs `gh` with these arguments and returns its output.
fn gh(args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("/usr/bin/env");
    command.arg("gh");
    for arg in args {
        command.arg(arg);
    }
    let output = command.output().map_err(|error| format!("Can't run gh: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let error = String::from_utf8_lossy(&output.stderr);
        let error = error.lines().next().unwrap_or("gh failed").trim().to_owned();
        Err(if error.is_empty() { "gh failed".to_owned() } else { error })
    }
}

/// The cached issues of a repo, when they're fresh enough.
fn cached(repo: &str, state: &str) -> Option<Vec<Issue>> {
    let cache = CACHE.lock().ok()?;
    let entries = cache.as_ref()?;
    let entry = entries.get(&cache_key(repo, state))?;
    (entry.at.elapsed() < CACHE_FOR).then(|| entry.issues.clone())
}

/// The issues of several repos at once, in the order the repos were given.
///
/// Each repo's answer takes a second or so, and they're asked for side by side, so the wait is
/// one answer rather than one per repo. A repo that can't be read doesn't stop the others: its
/// problem is the error in its place.
pub fn issues_for_repos(repos: &[String], state: &str) -> Vec<(String, Result<Vec<Issue>, String>)> {
    let state = state.to_owned();
    let mut handles = Vec::with_capacity(repos.len());
    for repo in repos {
        let repo = repo.clone();
        let state = state.clone();
        handles.push(std::thread::spawn(move || {
            let answer = issues_in(&repo, &state);
            (repo, answer)
        }));
    }
    handles
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .collect()
}

/// Remembers a repo's issues for a while.
fn remember(repo: &str, state: &str, issues: Vec<Issue>) {
    if let Ok(mut cache) = CACHE.lock() {
        cache.get_or_insert_with(HashMap::new).insert(cache_key(repo, state), Cached { at: Instant::now(), issues });
    }
}

/// Where a repo's issues are kept in the cache: one per state.
fn cache_key(repo: &str, state: &str) -> String {
    format!("{state}:{repo}")
}

/// Forgets a repo's cached issues, so the next read asks GitHub again.
pub fn forget(repo: &str) {
    if let Ok(mut cache) = CACHE.lock() {
        if let Some(entries) = cache.as_mut() {
            entries.remove(&cache_key(repo, "open"));
            entries.remove(&cache_key(repo, "closed"));
        }
    }
}

/// Forgets every repo's cached issues, so the next read asks GitHub again.
///
/// This is what the Issues tab's refresh button does: it wants the answer now, not the one
/// from a minute ago.
pub fn forget_all() {
    if let Ok(mut cache) = CACHE.lock() {
        *cache = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_owner_and_name_from_a_remote() {
        assert_eq!(repo_slug(Path::new("/nope")), None);
    }

    /// A folder with a git remote pointing at GitHub names the repo.
    #[test]
    fn names_a_repo_from_its_remote() {
        let folder = std::env::temp_dir().join(format!("officesim-gh-repo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        let git = |args: &[&str]| {
            let mut command = Command::new("/usr/bin/git");
            command.arg("-C").arg(folder.to_str().unwrap());
            command.args(args);
            command.output().expect("git runs")
        };
        git(&["init", "-q"]);
        git(&["remote", "add", "origin", "git@github.com:owner/repo.git"]);
        assert_eq!(repo_slug(&folder).as_deref(), Some("owner/repo"));
        // An https remote works the same way
        git(&["remote", "set-url", "origin", "https://github.com/owner/other-repo.git"]);
        assert_eq!(repo_slug(&folder).as_deref(), Some("owner/other-repo"));
        // A remote that isn't GitHub's isn't a GitHub repo
        git(&["remote", "set-url", "origin", "git@gitlab.com:owner/repo.git"]);
        assert_eq!(repo_slug(&folder), None);
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn maps_labels_onto_priorities() {
        let labels = |names: &[&str]| names.iter().map(|name| name.to_lowercase()).collect::<Vec<_>>();
        assert_eq!(priority_for(&labels(&["critical"])), "critical");
        assert_eq!(priority_for(&labels(&["P1"])), "high");
        assert_eq!(priority_for(&labels(&["medium"])), "medium");
        assert_eq!(priority_for(&labels(&["bug"])), "low");
        assert_eq!(priority_for(&[]), "low");
    }

    #[test]
    fn names_an_issue_by_its_repo_and_number() {
        let issue = Issue {
            number: 42,
            repo: "owner/repo".to_owned(),
            title: "Fix it".to_owned(),
            labels: vec!["in progress".to_owned()],
            assignee: Some("someone".to_owned()),
            comments: 3,
            created_at: Some(1_790_848_844_503),
            updated_at: Some(1_790_848_844_503),
            closed_at: None,
        };
        let board = to_board_issue(&issue);
        assert_eq!(board["identifier"], "owner/repo#42");
        assert_eq!(board["priority"], "low");
        assert_eq!(board["assignedToUser"], true);
        assert_eq!(board["url"], "https://github.com/owner/repo/issues/42");

        // The Issues tab's own shape: everything known about it
        let entry = to_board_entry(&issue);
        assert_eq!(entry["repo"], "owner/repo");
        assert_eq!(entry["comments"], 3);
        assert_eq!(entry["status"], "in_progress");
        assert_eq!(entry["labels"][0], "in progress");
    }
}
