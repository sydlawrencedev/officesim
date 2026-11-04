//! The office's view of an agent, whatever harness it runs in. Serialized in the shapes the office
//! UI already reads from the Paperclip plugin worker (camelCase, see src/worker.ts).

use serde::Serialize;

/// What an agent is doing, which decides where in the office it goes.
// Research, writing and meeting come from the adapters still to be written
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityKind {
    Coding,
    Research,
    Writing,
    Meeting,
    #[default]
    Idle,
}

/// One agent's latest run: its live session if it has one, else its last finished one.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub run_id: String,
    pub status: String,
    pub active: bool,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub last_output_at: Option<String>,
    pub last_output_bytes: Option<u64>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub issue_identifier: Option<String>,
    pub issue_title: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    /// Stable across sessions (source plus project, or the harness's own agent id), so an agent
    /// keeps its desk and character.
    pub id: String,
    pub name: String,
    /// "running" while it works, else "idle"; the office UI reads Paperclip's statuses.
    pub status: String,
    pub url_key: Option<String>,
    pub activity_kind: ActivityKind,
    pub last_run: Option<LastRun>,
    /// Which harness it runs in, e.g. "claude", "codex", "hermes".
    pub source: &'static str,
    /// The model it runs on, as its harness names it (e.g. "claude-opus-5-5"), when known.
    pub model: Option<String>,
    /// What it's waiting on the person for (a permission prompt, a question), if anything. The
    /// office shows a decision bubble over it.
    #[serde(skip)]
    pub waiting_on: Option<String>,
    /// The harness's own session id, so an orchestrator that launched the session can claim it
    /// (see `Claims`) and the office doesn't show the same work twice.
    #[serde(skip)]
    pub session_ref: Option<String>,
    /// When the session was created, in milliseconds since the epoch.
    #[serde(skip)]
    pub created_ms: Option<i64>,
    /// The folder it works in, for finding its process when it's clicked.
    #[serde(skip)]
    pub cwd: Option<String>,
    /// Its process, when the harness says.
    #[serde(skip)]
    pub pid: Option<u32>,
    /// Where clicking it goes, when that's a web page (a Paperclip agent's page).
    #[serde(skip)]
    pub open_url: Option<String>,
}

/// What an agent did in a time frame, for the Agents tab (AgentStats in src/worker.ts, less what
/// the office knows already: name, status, last run).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub issues_done: u64,
    /// Time spent working.
    pub active_seconds: u64,
    pub runs: u64,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
}

/// Sessions an orchestrator launched in other harnesses: those harnesses leave them out, since the
/// orchestrator shows the same work as its own agent.
#[derive(Clone, Debug, Default)]
pub struct Claims {
    /// Harness session ids its runs used.
    pub session_ids: std::collections::HashSet<String>,
    /// Runs still starting up, which haven't reported a session id yet: (harness source id, when the
    /// run started). A session that harness created just after is the run's.
    pub starting_runs: Vec<(&'static str, i64)>,
}

impl Claims {
    /// How long after a run starts its harness may take to create the session.
    const STARTUP_MILLIS: i64 = 2 * 60 * 1000;

    pub fn claims(&self, agent: &Agent) -> bool {
        if agent.session_ref.as_ref().is_some_and(|id| self.session_ids.contains(id)) {
            return true;
        }
        let Some(created) = agent.created_ms else { return false };
        self.starting_runs
            .iter()
            .any(|&(source, started)| source == agent.source && (started - 5_000..=started + Self::STARTUP_MILLIS).contains(&created))
    }
}
