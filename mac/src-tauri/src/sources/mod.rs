//! Agent sources: one per harness or orchestrator whose local files OfficeSim reads.
//!
//! Each source is read-only and must never fail the others: a source that can't read its files
//! returns no agents (and says why in `problem`, shown in the Settings tab). Sources the person
//! turned off in Settings aren't read at all.

mod aider;
mod claude;
mod claude_usage;
mod codex;
mod cursor;
mod demo;
mod gemini;
mod goose;
mod hermes;
pub mod naming;
mod opencode;
mod orchestrator;
pub mod paperclip;

use crate::model::{Agent, Claims, Usage};
use crate::settings;
use serde::Serialize;
use std::path::PathBuf;

pub trait Source: Send + Sync {
    /// Short id, also `Agent::source` and the key its on/off setting is saved under.
    fn id(&self) -> &'static str;
    /// Its name in the Settings tab.
    fn label(&self) -> &'static str;
    /// Where it reads from, shown in the Settings tab.
    fn location(&self) -> String;
    /// Whether this harness looks installed on this Mac.
    fn detect(&self) -> bool;
    /// The agents it has now.
    fn agents(&self) -> Vec<Agent>;
    /// Why it can't read its agents right now, if it can't.
    fn problem(&self) -> Option<String> {
        None
    }
    /// Files and folders whose changes mean its agents may have changed.
    fn watch_paths(&self) -> Vec<PathBuf> {
        Vec::new()
    }
    /// Part of one of its runs' logs, in Paperclip's run log format (NDJSON lines of
    /// `{"stream":"stdout","chunk":<adapter event JSON>}`, what the UI's summarizeRunLog reads):
    /// `limit` bytes from byte `offset`. None if the run isn't this source's.
    fn read_log(&self, _run_id: &str, _offset: u64, _limit: u64) -> Option<String> {
        None
    }
    /// What one of its agents did since `since` (milliseconds since the epoch).
    fn usage(&self, _agent: &Agent, _since: i64) -> Usage {
        Usage::default()
    }
    /// Sessions it launched in other harnesses (an orchestrator's runs).
    fn claims(&self) -> Claims {
        Claims::default()
    }
    /// A `pgrep -f` pattern for its processes, so a click on one of its agents can find the one
    /// working in that agent's folder and bring its window forward.
    fn process_pattern(&self) -> Option<&'static str> {
        None
    }
}

/// Every source OfficeSim knows, in the order the Settings tab lists them.
pub fn all() -> Vec<Box<dyn Source>> {
    vec![
        Box::new(claude::ClaudeCode::new()),
        Box::new(codex::Codex::new()),
        Box::new(opencode::OpenCode::new()),
        Box::new(gemini::GeminiCli::new()),
        Box::new(cursor::Cursor::new()),
        Box::new(goose::Goose::new()),
        Box::new(aider::Aider),
        Box::new(hermes::Hermes::new()),
        Box::new(orchestrator::Orchestrator::new()),
        Box::new(paperclip::Paperclip::new()),
        Box::new(demo::Demo),
    ]
}

/// The sources that look installed.
pub fn detected() -> Vec<Box<dyn Source>> {
    all().into_iter().filter(|source| source.detect()).collect()
}

/// The sources that look installed and are turned on.
pub fn active() -> Vec<Box<dyn Source>> {
    detected().into_iter().filter(|source| settings::source_enabled(source.id())).collect()
}

/// The last look at the agents, and when. The office, the menu bar and the Agents tab all ask
/// within moments of each other, so a look is reused briefly.
static LAST_LOOK: std::sync::Mutex<Option<(std::time::Instant, Vec<Agent>)>> = std::sync::Mutex::new(None);
const LOOK_FRESH_FOR: std::time::Duration = std::time::Duration::from_millis(1500);

/// Every active source's agents.
pub fn agents() -> Vec<Agent> {
    if let Ok(last) = LAST_LOOK.lock() {
        if let Some((_, agents)) = last.as_ref().filter(|(at, _)| at.elapsed() < LOOK_FRESH_FOR) {
            return agents.clone();
        }
    }
    let agents: Vec<Agent> = agents_from(&active()).into_iter().map(|(_, agent)| agent).collect();
    if let Ok(mut last) = LAST_LOOK.lock() {
        *last = Some((std::time::Instant::now(), agents.clone()));
    }
    agents
}

/// Forgets the last look, so the next one sees a source just turned on or off.
pub fn forget_agents() {
    if let Ok(mut last) = LAST_LOOK.lock() {
        *last = None;
    }
}

/// Every active source's agents, with what each did since `since`.
pub fn agents_with_usage(since: i64) -> Vec<(Agent, Usage)> {
    let sources = active();
    agents_from(&sources)
        .into_iter()
        .map(|(source, agent)| {
            let usage = sources[source].usage(&agent, since);
            (agent, usage)
        })
        .collect()
}

/// A chunk of a run's log, from whichever source it belongs to.
pub fn read_log(run_id: &str, offset: u64, limit: u64) -> Option<String> {
    active().iter().find_map(|source| source.read_log(run_id, offset, limit))
}

/// A source as the Settings tab shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Harness {
    id: &'static str,
    label: &'static str,
    location: String,
    detected: bool,
    enabled: bool,
    /// Its agents now, when it's detected and on.
    agents: Option<usize>,
    problem: Option<String>,
}

/// Every source, for the Settings tab (the demo source only when it's turned on).
pub fn harnesses() -> Vec<Harness> {
    // Counted as the office shows them: less sessions another source launched
    let claims: Vec<(&'static str, Claims)> = detected().iter().map(|source| (source.id(), source.claims())).collect();
    all()
        .into_iter()
        .filter(|source| source.id() != demo::ID || source.detect())
        .map(|source| {
            let detected = source.detect();
            let enabled = settings::source_enabled(source.id());
            let agents = (detected && enabled).then(|| agents_claimed_by(std::slice::from_ref(&source), &claims).len());
            Harness {
                id: source.id(),
                label: source.label(),
                location: source.location(),
                detected,
                enabled,
                agents,
                problem: if detected && enabled { source.problem() } else { None },
            }
        })
        .collect()
}

/// The sources' agents, each with its source's index, less sessions another installed source
/// launched. That's whether or not the launcher is turned on: turning Paperclip off hides its work,
/// rather than showing its runs' sessions as OpenCode agents.
fn agents_from(sources: &[Box<dyn Source>]) -> Vec<(usize, Agent)> {
    let claims: Vec<(&'static str, Claims)> = detected().iter().map(|source| (source.id(), source.claims())).collect();
    agents_claimed_by(sources, &claims)
}

fn agents_claimed_by(sources: &[Box<dyn Source>], claims: &[(&'static str, Claims)]) -> Vec<(usize, Agent)> {
    sources
        .iter()
        .enumerate()
        .flat_map(|(index, source)| source.agents().into_iter().map(move |agent| (index, agent)))
        .filter(|(_, agent)| !claims.iter().any(|(claimer, claims)| *claimer != agent.source && claims.claims(agent)))
        .collect()
}

/// The user's home folder.
pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Whether a process matching `pgrep` arguments (e.g. `["-x", "codex"]`) is running.
pub fn process_running(args: &[&str]) -> bool {
    std::process::Command::new("/usr/bin/pgrep").args(args).output().is_ok_and(|output| output.status.success())
}

/// The working folders of running processes whose command line matches a `pgrep -f` pattern.
pub fn process_cwds(pattern: &str) -> Vec<PathBuf> {
    processes_in(pattern).into_iter().map(|(_, cwd)| cwd).collect()
}

/// Running processes whose command line matches a `pgrep -f` pattern, with their working folders.
pub fn processes_in(pattern: &str) -> Vec<(u32, PathBuf)> {
    let Ok(pgrep) = std::process::Command::new("/usr/bin/pgrep").args(["-f", pattern]).output() else { return Vec::new() };
    let pids: Vec<String> = String::from_utf8_lossy(&pgrep.stdout).split_whitespace().map(str::to_owned).collect();
    if pids.is_empty() {
        return Vec::new();
    }
    let Ok(lsof) = std::process::Command::new("/usr/sbin/lsof").args(["-a", "-d", "cwd", "-Fpn", "-p", &pids.join(",")]).output() else {
        return Vec::new();
    };
    // Lines come as "p<pid>" then "n<folder>"
    let mut found = Vec::new();
    let mut pid = None;
    for line in String::from_utf8_lossy(&lsof.stdout).lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse().ok();
        } else if let (Some(folder), Some(pid)) = (line.strip_prefix('n'), pid) {
            found.push((pid, PathBuf::from(folder)));
        }
    }
    found
}

/// A harness's SQLite database, opened read only, waiting briefly if the harness is mid-write.
pub fn open_sqlite(path: &std::path::Path) -> rusqlite::Result<rusqlite::Connection> {
    use rusqlite::{Connection, OpenFlags};
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(std::time::Duration::from_millis(500))?;
    Ok(conn)
}

/// A Claude-shaped assistant event (text and tool_use blocks), which the UI's runOutput.ts reads,
/// for harnesses whose own events it doesn't know.
pub fn claude_event(text: Option<&str>, tools: &[(String, serde_json::Value)]) -> serde_json::Value {
    let mut content = Vec::new();
    if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
        content.push(serde_json::json!({ "type": "text", "text": text }));
    }
    for (name, input) in tools {
        content.push(serde_json::json!({ "type": "tool_use", "name": name, "input": input }));
    }
    serde_json::json!({ "type": "assistant", "message": { "content": content } })
}

/// Wraps adapter event JSON lines as Paperclip run log lines.
pub fn as_run_log<'a>(events: impl IntoIterator<Item = &'a str>) -> String {
    let mut log = String::new();
    for event in events.into_iter().filter(|line| !line.trim().is_empty()) {
        log.push_str(&serde_json::json!({ "stream": "stdout", "chunk": event }).to_string());
        log.push('\n');
    }
    log
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake(&'static str, &'static [&'static str]);

    impl Source for Fake {
        fn id(&self) -> &'static str {
            self.0
        }
        fn label(&self) -> &'static str {
            self.0
        }
        fn location(&self) -> String {
            String::new()
        }
        fn detect(&self) -> bool {
            true
        }
        fn agents(&self) -> Vec<Agent> {
            self.1
                .iter()
                .map(|name| Agent { id: (*name).into(), name: (*name).into(), source: self.0, session_ref: Some(format!("ses-{name}")), ..Agent::default() })
                .collect()
        }
        fn claims(&self) -> Claims {
            let mut claims = Claims::default();
            if self.0 == "paperclip" {
                claims.session_ids.insert("ses-Heartbeat".into());
            }
            claims
        }
    }

    fn names(sources: Vec<Box<dyn Source>>) -> Vec<String> {
        let claims: Vec<(&'static str, Claims)> = sources.iter().map(|source| (source.id(), source.claims())).collect();
        agents_claimed_by(&sources, &claims).into_iter().map(|(_, agent)| agent.name).collect()
    }

    #[test]
    fn leaves_out_sessions_an_orchestrator_launched() {
        let sources: Vec<Box<dyn Source>> = vec![
            Box::new(Fake("opencode", &["Heartbeat", "Mine"])),
            Box::new(Fake("paperclip", &["CEO"])),
        ];
        assert_eq!(names(sources), ["Mine", "CEO"]);
        // Paperclip turned off: its runs' sessions still aren't shown as OpenCode's
        let opencode_only: Vec<Box<dyn Source>> = vec![Box::new(Fake("opencode", &["Heartbeat", "Mine"]))];
        let paperclip_claims = vec![("paperclip", Fake("paperclip", &[]).claims())];
        let names: Vec<String> = agents_claimed_by(&opencode_only, &paperclip_claims).into_iter().map(|(_, agent)| agent.name).collect();
        assert_eq!(names, ["Mine"]);
    }

    #[test]
    fn claims_sessions_started_just_after_a_run() {
        let claims = Claims { starting_runs: vec![("opencode", 1_000_000)], ..Claims::default() };
        let session = |source, created| Agent { source, created_ms: Some(created), ..Agent::default() };
        assert!(claims.claims(&session("opencode", 1_030_000)));
        assert!(!claims.claims(&session("opencode", 1_000_000 + 10 * 60 * 1000)));
        assert!(!claims.claims(&session("claude", 1_030_000)));
    }

    #[test]
    fn wraps_events_as_run_log_lines() {
        assert_eq!(as_run_log(["{}", ""]), "{\"chunk\":\"{}\",\"stream\":\"stdout\"}\n");
    }
}
