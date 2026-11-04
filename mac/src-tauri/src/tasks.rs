//! Task sources: where the office's work items come from (the boardroom kanban, the done timeline
//! and its cheers, the Activity tab's done tasks). A separate kind of source from the agent
//! harnesses: Paperclip is the first, from the same database as its agents.
//!
//! Answers are in the shapes the plugin worker returns (src/worker.ts, src/issuesDone.ts,
//! src/logs.ts). With no task source on, each is empty, as the plugin's are without data.

use crate::settings;
use crate::sources::paperclip::Paperclip;
use crate::time::{iso_from_millis, now_iso};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;

/// Open-work columns on the boardroom kanban, in board order (src/worker.ts KANBAN_STATUSES).
pub const KANBAN_STATUSES: [&str; 5] = ["backlog", "todo", "in_progress", "in_review", "blocked"];
/// The done timeline: this many windows of this many minutes (src/issuesDone.ts).
pub const DONE_TIMELINE_WINDOWS: usize = 12;
const DONE_TIMELINE_WINDOW_MINUTES: i32 = 10;
/// Issues done this recently are sent along so the office can cheer each one.
const RECENTLY_DONE_MINUTES: i32 = 15;
/// Done tasks in the Activity tab, newest first.
const DONE_TASKS_LIMIT: i64 = 100;
const LAST_COMMENT_MAX_CHARS: usize = 280;

pub trait TaskSource: Send + Sync {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    fn location(&self) -> String;
    fn detect(&self) -> bool;
    /// Open issues by KANBAN_STATUSES column, most urgent first.
    fn kanban(&self) -> Result<Vec<(String, Value)>, String>;
    /// Issues done per timeline window (oldest first), the total, and the recently done.
    fn issues_done(&self) -> Result<(Vec<i64>, i64, Vec<Value>), String>;
    fn done_tasks(&self) -> Result<Vec<Value>, String>;
}

pub fn all() -> Vec<Box<dyn TaskSource>> {
    vec![Box::new(PaperclipTasks(Paperclip::new())), Box::new(GitHubTasks)]
}

/// Detected and turned on.
pub fn active() -> Vec<Box<dyn TaskSource>> {
    all().into_iter().filter(|source| source.detect() && settings::source_enabled(source.id())).collect()
}

/// A task source as the Settings tab shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSourceInfo {
    id: &'static str,
    label: &'static str,
    location: String,
    detected: bool,
    enabled: bool,
    /// Its open issues now, when it's detected and on.
    open: Option<usize>,
    problem: Option<String>,
}

pub fn infos() -> Vec<TaskSourceInfo> {
    all()
        .into_iter()
        .map(|source| {
            let detected = source.detect();
            let enabled = settings::source_enabled(source.id());
            let kanban = (detected && enabled).then(|| source.kanban());
            TaskSourceInfo {
                id: source.id(),
                label: source.label(),
                location: source.location(),
                detected,
                enabled,
                open: kanban.as_ref().and_then(|result| result.as_ref().ok()).map(Vec::len),
                problem: kanban.and_then(Result::err),
            }
        })
        .collect()
}

pub fn kanban_board() -> Value {
    let issues: Vec<(String, Value)> = active().iter().flat_map(|source| source.kanban().unwrap_or_default()).collect();
    let columns: Vec<Value> = KANBAN_STATUSES
        .iter()
        .map(|status| {
            let column: Vec<&Value> = issues.iter().filter(|(issue_status, _)| issue_status == status).map(|(_, issue)| issue).collect();
            json!({ "status": status, "issues": column })
        })
        .collect();
    json!({ "columns": columns })
}

pub fn issues_done() -> Value {
    let mut windows = vec![0i64; DONE_TIMELINE_WINDOWS];
    let mut total = 0;
    let mut recent = Vec::new();
    for source in active() {
        if let Ok((source_windows, source_total, source_recent)) = source.issues_done() {
            for (window, done) in windows.iter_mut().zip(source_windows) {
                *window += done;
            }
            total += source_total;
            recent.extend(source_recent);
        }
    }
    json!({ "windows": windows, "endsAt": now_iso(), "total": total, "recent": recent })
}

pub fn done_tasks() -> Value {
    let tasks: Vec<Value> = active().iter().flat_map(|source| source.done_tasks().unwrap_or_default()).collect();
    json!({ "tasks": tasks })
}

/// Paperclip's issues, across every active company.
struct PaperclipTasks(Paperclip);

const KANBAN_SQL: &str = "
  SELECT i.id::text, i.identifier, i.title, i.status, i.priority, w.name, assignee.name, (i.assignee_user_id IS NOT NULL)
  FROM public.issues i
  JOIN public.companies c ON c.id = i.company_id AND c.status = 'active'
  LEFT JOIN public.agents assignee ON assignee.id = i.assignee_agent_id
  -- A run in progress on the issue: it holds the checkout, or was woken for this issue.
  LEFT JOIN LATERAL (
    SELECT a.name
    FROM public.heartbeat_runs hr
    JOIN public.agents a ON a.id = hr.agent_id
    WHERE hr.company_id = i.company_id AND hr.status = 'running'
      AND (hr.id = i.checkout_run_id OR hr.id = i.execution_run_id OR hr.context_snapshot ->> 'issueId' = i.id::text)
    ORDER BY hr.started_at DESC
    LIMIT 1
  ) w ON true
  WHERE i.hidden_at IS NULL AND i.status IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
  ORDER BY CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.created_at
";

// Issues completed in each $1-minute window back from now, over $2 windows: 0 is the latest.
const DONE_WINDOWS_SQL: &str = "
  SELECT floor(extract(epoch FROM now() - i.completed_at) / ($1::int * 60))::int4, count(*)::int8
  FROM public.issues i
  JOIN public.companies c ON c.id = i.company_id AND c.status = 'active'
  WHERE i.status = 'done' AND i.hidden_at IS NULL
    AND i.completed_at > now() - make_interval(mins => $1::int * $2::int) AND i.completed_at <= now()
  GROUP BY 1
";

const TOTAL_DONE_SQL: &str = "
  SELECT count(*)::int8 FROM public.issues i
  JOIN public.companies c ON c.id = i.company_id AND c.status = 'active'
  WHERE i.status = 'done' AND i.hidden_at IS NULL
";

// With the name of each one's assigned agent, credited in the office's toast.
const RECENTLY_DONE_SQL: &str = "
  SELECT i.id::text, i.identifier, i.title, (extract(epoch FROM i.completed_at) * 1000)::int8, assignee.name
  FROM public.issues i
  JOIN public.companies c ON c.id = i.company_id AND c.status = 'active'
  LEFT JOIN public.agents assignee ON assignee.id = i.assignee_agent_id
  WHERE i.status = 'done' AND i.hidden_at IS NULL AND i.completed_at > now() - make_interval(mins => $1::int)
  ORDER BY i.completed_at DESC
  LIMIT 50
";

const DONE_TASKS_SQL: &str = "
  SELECT i.id::text, i.identifier, i.title, i.priority,
         (extract(epoch FROM i.created_at) * 1000)::int8, (extract(epoch FROM i.started_at) * 1000)::int8,
         (extract(epoch FROM i.completed_at) * 1000)::int8,
         assignee.name,
         coalesce(creator.name, CASE WHEN i.created_by_user_id IS NOT NULL THEN 'Board' END),
         (SELECT count(*) FROM public.issue_comments c WHERE c.issue_id = i.id AND c.deleted_at IS NULL)::int8,
         (SELECT c.body FROM public.issue_comments c WHERE c.issue_id = i.id AND c.deleted_at IS NULL
           ORDER BY c.created_at DESC LIMIT 1)
  FROM public.issues i
  JOIN public.companies co ON co.id = i.company_id AND co.status = 'active'
  LEFT JOIN public.agents assignee ON assignee.id = i.assignee_agent_id
  LEFT JOIN public.agents creator ON creator.id = i.created_by_agent_id
  WHERE i.status = 'done' AND i.hidden_at IS NULL
  ORDER BY i.completed_at DESC NULLS LAST
  LIMIT $1
";

impl TaskSource for PaperclipTasks {
    fn id(&self) -> &'static str {
        "paperclip-tasks"
    }

    fn label(&self) -> &'static str {
        "Paperclip issues"
    }

    fn location(&self) -> String {
        crate::sources::Source::location(&self.0)
    }

    fn detect(&self) -> bool {
        crate::sources::Source::detect(&self.0)
    }

    fn kanban(&self) -> Result<Vec<(String, Value)>, String> {
        let rows = self.0.with_client(|client| client.query(KANBAN_SQL, &[]))?;
        Ok(rows
            .iter()
            .map(|row| {
                let issue = json!({
                    "id": row.get::<_, String>(0),
                    "identifier": row.get::<_, Option<String>>(1),
                    "title": row.get::<_, String>(2),
                    "priority": row.get::<_, String>(4),
                    "workingAgent": row.get::<_, Option<String>>(5),
                    "assigneeAgent": row.get::<_, Option<String>>(6),
                    "assignedToUser": row.get::<_, bool>(7),
                });
                (row.get(3), issue)
            })
            .collect())
    }

    fn issues_done(&self) -> Result<(Vec<i64>, i64, Vec<Value>), String> {
        let windows_count = DONE_TIMELINE_WINDOWS as i32;
        let counts = self.0.with_client(|client| client.query(DONE_WINDOWS_SQL, &[&DONE_TIMELINE_WINDOW_MINUTES, &windows_count]))?;
        let mut windows = vec![0i64; DONE_TIMELINE_WINDOWS];
        for row in counts {
            let windows_ago: i32 = row.get(0);
            let index = DONE_TIMELINE_WINDOWS as i64 - 1 - i64::from(windows_ago);
            if let Some(window) = usize::try_from(index).ok().and_then(|index| windows.get_mut(index)) {
                *window = row.get(1);
            }
        }
        let total: i64 = self.0.with_client(|client| client.query_one(TOTAL_DONE_SQL, &[]))?.get(0);
        let recent = self
            .0
            .with_client(|client| client.query(RECENTLY_DONE_SQL, &[&RECENTLY_DONE_MINUTES]))?
            .iter()
            .map(|row| {
                json!({
                    "id": row.get::<_, String>(0),
                    "identifier": row.get::<_, Option<String>>(1),
                    "title": row.get::<_, String>(2),
                    "completedAt": row.get::<_, Option<i64>>(3).map(iso_from_millis),
                    "doneBy": row.get::<_, Option<String>>(4),
                })
            })
            .collect();
        Ok((windows, total, recent))
    }

    fn done_tasks(&self) -> Result<Vec<Value>, String> {
        let rows = self.0.with_client(|client| client.query(DONE_TASKS_SQL, &[&DONE_TASKS_LIMIT]))?;
        Ok(rows
            .iter()
            .map(|row| {
                json!({
                    "id": row.get::<_, String>(0),
                    "identifier": row.get::<_, Option<String>>(1),
                    "title": row.get::<_, String>(2),
                    "priority": row.get::<_, String>(3),
                    "createdAt": row.get::<_, Option<i64>>(4).map(iso_from_millis),
                    "startedAt": row.get::<_, Option<i64>>(5).map(iso_from_millis),
                    "completedAt": row.get::<_, Option<i64>>(6).map(iso_from_millis),
                    "assignee": row.get::<_, Option<String>>(7),
                    "createdBy": row.get::<_, Option<String>>(8),
                    "comments": row.get::<_, i64>(9),
                    "lastComment": row.get::<_, Option<String>>(10).map(|comment| tidy_comment(&comment)),
                })
            })
            .collect())
    }
}

/// GitHub issues, from the git repos the agents in the office work in. Read with the `gh` CLI,
/// which needs no tokens of its own.
struct GitHubTasks;

impl TaskSource for GitHubTasks {
    fn id(&self) -> &'static str {
        "github-issues"
    }

    fn label(&self) -> &'static str {
        "GitHub issues"
    }

    fn location(&self) -> String {
        "the git repos the agents work in".to_owned()
    }

    fn detect(&self) -> bool {
        // Only when there's something to read: an agent in a repo with a GitHub remote
        !active_folders().is_empty()
    }

    /// The `TaskSource` trait has no problem of its own, so this source's trouble (gh missing or
    /// signed out) shows through the board's own answer.
    fn kanban(&self) -> Result<Vec<(String, Value)>, String> {
        if let Some(problem) = crate::github::problem() {
            return Err(problem);
        }
        let mut issues = Vec::new();
        let mut problems = Vec::new();
        for repo in active_repos() {
            match crate::github::issues(&repo) {
                Ok(repo_issues) => {
                    for issue in repo_issues {
                        let column = crate::github::column_for(&issue.labels);
                        issues.push((column.to_owned(), crate::github::to_board_issue(&issue)));
                    }
                }
                Err(error) => problems.push(format!("{repo}: {error}")),
            }
        }
        if issues.is_empty() && !problems.is_empty() {
            return Err(problems.join("; "));
        }
        Ok(issues)
    }

    /// GitHub issues don't say when they were done in a way the timeline can use, so this source
    /// only fills the board.
    fn issues_done(&self) -> Result<(Vec<i64>, i64, Vec<Value>), String> {
        Ok((vec![0i64; DONE_TIMELINE_WINDOWS], 0, Vec::new()))
    }

    fn done_tasks(&self) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }
}

/// The folders the agents in the office work in, each one once.
fn active_folders() -> Vec<PathBuf> {
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

/// The GitHub repos the agents' folders are, each one once.
fn active_repos() -> Vec<String> {
    let mut repos: Vec<String> = Vec::new();
    for folder in active_folders() {
        let Some(repo) = crate::github::repo_slug(&folder) else { continue };
        if !repos.contains(&repo) {
            repos.push(repo);
        }
    }
    repos
}

/// A comment as one plain line for the Activity tab: markdown, code blocks and link targets
/// dropped, trimmed to length. The plugin worker's tidyComment.
fn tidy_comment(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut rest = text;
    // Markdown links [label](url) keep just their label
    while let Some(open) = rest.find('[') {
        let Some(close) = rest[open..].find("](").map(|at| open + at) else { break };
        let Some(end) = rest[close..].find(')').map(|at| close + at) else { break };
        plain.push_str(&rest[..open]);
        plain.push_str(&rest[open + 1..close]);
        rest = &rest[end + 1..];
    }
    plain.push_str(rest);
    crate::sources::naming::tidy(&plain.replace('_', ""), LAST_COMMENT_MAX_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tidies_comments() {
        assert_eq!(tidy_comment("**Done** — see [the PR](https://x/1) and `__init__`"), "Done — see the PR and init");
    }

    #[test]
    fn empty_without_sources() {
        let board = kanban_board();
        assert_eq!(board["columns"].as_array().unwrap().len(), KANBAN_STATUSES.len());
    }

    /// `cargo test -- --ignored --nocapture` prints this Mac's task sources and open issues.
    #[test]
    #[ignore]
    fn prints_this_macs_tasks() {
        println!("{}", serde_json::to_string(&infos()).unwrap());
        println!("{}", kanban_board());
        println!("{}", issues_done());
        println!("{} done tasks", done_tasks()["tasks"].as_array().unwrap().len());
    }
}
