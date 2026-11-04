//! Agent Orchestrator (ao, formerly ComposioHQ/agent-orchestrator) sessions, from its SQLite store
//! (`~/.ao/data/ao.db`, or under `$AO_DATA_DIR`, opened read only): `sessions` (project, harness,
//! `activity_state` of active / idle / waiting_input / exited, the harness's own session id, branch,
//! prompt) and `projects` (folder, display name). Schema from its migrations
//! (backend/internal/storage/sqlite/migrations).
//!
//! Its live and recently active sessions are agents, working while `active` and waiting on the
//! person while `waiting_input`. Each runs in another harness (Claude Code, Codex...): it claims
//! that harness's session, and borrows its run log and usage, so the work shows once, as its agent.

use super::naming::{number_namesakes, project_name, tidy, title_case};
use super::Source;
use crate::model::{ActivityKind, Agent, Claims, LastRun, Usage};
use crate::time::{iso_from_millis, millis_from_sql_time, now_millis};
use rusqlite::Connection;
use std::path::PathBuf;

pub const ID: &str = "orchestrator";
const HARNESS_NAME: &str = "Orchestrator";
/// Ended sessions stay in the office this long after their last activity.
const RECENT_MILLIS: i64 = 60 * 60 * 1000;
const TITLE_MAX_CHARS: usize = 80;

const SESSIONS_SQL: &str = "
  SELECT s.id, s.num, s.kind, s.harness, s.activity_state, s.activity_last_at, s.is_terminated, s.branch,
         s.workspace_path, s.agent_session_id, s.prompt, s.issue_id, s.display_name, s.created_at,
         p.path, p.display_name
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  WHERE p.archived_at IS NULL
  ORDER BY s.created_at
";

pub struct Orchestrator {
    db: PathBuf,
}

impl Orchestrator {
    pub fn new() -> Self {
        let data = std::env::var_os("AO_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| super::home().join(".ao/data"));
        Self { db: data.join("ao.db") }
    }

    #[cfg(test)]
    fn at(db: PathBuf) -> Self {
        Self { db }
    }

    fn read_sessions(&self) -> rusqlite::Result<Vec<SessionRow>> {
        let conn: Connection = super::open_sqlite(&self.db)?;
        let mut statement = conn.prepare(SESSIONS_SQL)?;
        let rows = statement
            .query_map([], |row| {
                Ok(SessionRow {
                    id: row.get(0)?,
                    num: row.get(1)?,
                    kind: row.get(2)?,
                    harness: row.get(3)?,
                    activity: row.get(4)?,
                    activity_at: row.get::<_, Option<String>>(5)?.as_deref().and_then(millis_from_sql_time),
                    terminated: row.get(6)?,
                    branch: row.get(7)?,
                    workspace: row.get(8)?,
                    harness_session: row.get(9)?,
                    prompt: row.get(10)?,
                    issue: row.get(11)?,
                    title: row.get(12)?,
                    created: row.get::<_, Option<String>>(13)?.as_deref().and_then(millis_from_sql_time),
                    project_path: row.get(14)?,
                    project_name: row.get(15)?,
                })
            })?
            .flatten()
            .collect();
        Ok(rows)
    }

    fn read_agents(&self) -> rusqlite::Result<Vec<Agent>> {
        let now = now_millis();
        let mut agents: Vec<Agent> = self
            .read_sessions()?
            .into_iter()
            .filter(|session| !session.terminated || session.activity_at.is_some_and(|at| now - at <= RECENT_MILLIS))
            .filter(|session| session.activity != "exited" || session.activity_at.is_some_and(|at| now - at <= RECENT_MILLIS))
            .map(|session| session.agent())
            .collect();
        number_namesakes(&mut agents);
        Ok(agents)
    }
}

impl Source for Orchestrator {
    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Agent Orchestrator"
    }

    fn location(&self) -> String {
        self.db.display().to_string()
    }

    fn detect(&self) -> bool {
        self.db.is_file()
    }

    fn agents(&self) -> Vec<Agent> {
        self.read_agents().unwrap_or_default()
    }

    fn problem(&self) -> Option<String> {
        self.read_agents().err().map(|error| format!("Can't read Agent Orchestrator's database: {error}"))
    }

    fn watch_paths(&self) -> Vec<PathBuf> {
        vec![self.db.with_extension("db-wal"), self.db.clone()]
    }

    // Run logs are the harness's: a worker's run id is its harness session's (e.g. "claude:<id>"),
    // read by that harness's source.

    fn usage(&self, agent: &Agent, since: i64) -> Usage {
        // Its harness session's usage, read by that harness's source
        let Some(run) = &agent.last_run else { return Usage::default() };
        let Some((source, _)) = run.run_id.split_once(':') else { return Usage::default() };
        super::all()
            .into_iter()
            .find(|candidate| candidate.id() == source && candidate.detect())
            .map(|harness| harness.usage(&Agent { source: harness.id(), ..agent.clone() }, since))
            .unwrap_or_default()
    }

    fn claims(&self) -> Claims {
        let mut claims = Claims::default();
        let Ok(sessions) = self.read_sessions() else { return claims };
        for session in sessions {
            if !session.harness_session.is_empty() {
                claims.session_ids.insert(session.harness_session.clone());
            } else if session.activity != "exited" && !session.terminated {
                if let (Some(source), Some(created)) = (harness_source(&session.harness), session.created) {
                    claims.starting_runs.push((source, created));
                }
            }
        }
        claims
    }
}

struct SessionRow {
    id: String,
    num: i64,
    kind: String,
    harness: String,
    activity: String,
    activity_at: Option<i64>,
    terminated: bool,
    branch: String,
    workspace: String,
    harness_session: String,
    prompt: String,
    issue: String,
    title: String,
    created: Option<i64>,
    project_path: String,
    project_name: String,
}

impl SessionRow {
    fn agent(self) -> Agent {
        let working = self.activity == "active";
        let waiting = matches!(self.activity.as_str(), "waiting_input" | "blocked");
        let name = if self.project_name.trim().is_empty() {
            project_name(HARNESS_NAME, Some(if self.project_path.is_empty() { &self.workspace } else { &self.project_path }))
        } else {
            title_case(&self.project_name)
        };
        let name = if self.kind == "orchestrator" { format!("{name} Lead") } else { name };
        let title = [&self.title, &self.prompt].into_iter().map(|text| text.trim()).find(|text| !text.is_empty()).map(|text| tidy(text.lines().next().unwrap_or(text), TITLE_MAX_CHARS));
        // The harness session's run id, so its source serves the live log
        let run_id = match (harness_source(&self.harness), self.harness_session.is_empty()) {
            (Some(source), false) => format!("{source}:{}", self.harness_session),
            _ => format!("{ID}:{}", self.id),
        };
        Agent {
            id: format!("orchestrator:{}", self.id),
            name,
            status: if working { "running" } else { "idle" }.into(),
            activity_kind: if working { ActivityKind::Coding } else { ActivityKind::Idle },
            last_run: Some(LastRun {
                run_id,
                status: if working { "running" } else { "succeeded" }.into(),
                active: working,
                started_at: self.created.map(iso_from_millis),
                finished_at: if working { None } else { self.activity_at.map(iso_from_millis) },
                last_output_at: self.activity_at.map(iso_from_millis),
                issue_identifier: Some(self.issue.clone()).filter(|issue| !issue.is_empty()).or_else(|| Some(format!("#{}", self.num))),
                issue_title: title.or_else(|| Some(self.branch.clone()).filter(|branch| !branch.is_empty())),
                ..LastRun::default()
            }),
            source: ID,
            waiting_on: waiting.then(|| "Waiting for your input".to_owned()),
            session_ref: Some(self.id),
            created_ms: self.created,
            cwd: Some(self.workspace.clone()).filter(|workspace| !workspace.is_empty()),
            ..Agent::default()
        }
    }
}

/// The OfficeSim source of an orchestrator harness name.
fn harness_source(harness: &str) -> Option<&'static str> {
    match harness {
        "claude-code" => Some(super::claude::ID),
        "codex" => Some(super::codex::ID),
        "opencode" => Some(super::opencode::ID),
        "goose" => Some(super::goose::ID),
        "cursor" => Some(super::cursor::ID),
        "aider" => Some(super::aider::ID),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    #[test]
    fn reads_sessions_and_claims_their_harness_sessions() {
        let path = std::env::temp_dir().join(format!("officesim-ao-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', archived_at TIMESTAMP);
             CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, num INTEGER NOT NULL, issue_id TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL DEFAULT 'worker', harness TEXT NOT NULL DEFAULT '', activity_state TEXT NOT NULL DEFAULT 'idle',
                activity_last_at TIMESTAMP NOT NULL, is_terminated BOOLEAN NOT NULL DEFAULT FALSE, branch TEXT NOT NULL DEFAULT '',
                workspace_path TEXT NOT NULL DEFAULT '', agent_session_id TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '',
                display_name TEXT NOT NULL DEFAULT '', created_at TIMESTAMP NOT NULL);",
        )
        .unwrap();
        let now = iso_from_millis(now_millis()).replace('T', " ").replace('Z', "+00:00");
        conn.execute("INSERT INTO projects VALUES ('mer', '/Users/me/code/my-app', '', NULL)", []).unwrap();
        let session = |id: &str, num: i64, harness: &str, state: &str, harness_session: &str, terminated: bool| {
            conn.execute(
                "INSERT INTO sessions VALUES (?1, 'mer', ?2, 'GH-12', 'worker', ?3, ?4, ?5, ?6, 'fix-login', '', ?7, 'Fix the login\nthen tests', '', ?5)",
                params![id, num, harness, state, now, terminated, harness_session],
            )
            .unwrap();
        };
        session("mer-1", 1, "claude-code", "active", "aaaa-1111", false);
        session("mer-2", 2, "codex", "waiting_input", "", false);
        session("mer-3", 3, "codex", "exited", "", true);
        drop(conn);

        let source = Orchestrator::at(path.clone());
        let agents = source.agents();
        let names: Vec<&str> = agents.iter().map(|agent| agent.name.as_str()).collect();
        assert_eq!(names, ["My App 1", "My App 2", "My App 3"]);
        let working = &agents[0];
        assert_eq!(working.status, "running");
        let run = working.last_run.as_ref().unwrap();
        assert_eq!(run.run_id, "claude:aaaa-1111");
        assert_eq!(run.issue_identifier.as_deref(), Some("GH-12"));
        assert_eq!(run.issue_title.as_deref(), Some("Fix the login"));
        assert_eq!(agents[1].waiting_on.as_deref(), Some("Waiting for your input"));

        let claims = source.claims();
        assert!(claims.session_ids.contains("aaaa-1111"));
        assert_eq!(claims.starting_runs.len(), 1);
        assert_eq!(claims.starting_runs[0].0, "codex");
        std::fs::remove_file(path).unwrap();
    }
}
