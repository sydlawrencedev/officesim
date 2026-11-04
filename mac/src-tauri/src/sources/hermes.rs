//! Hermes agent sessions, from its SQLite state (`~/.hermes/state.db`, opened read only):
//! `sessions` (where it came from, e.g. "cli" or "whatsapp", title, token totals, started and
//! ended times in seconds) and `messages` (role, content, OpenAI-style tool calls).
//!
//! Sessions that haven't ended and were active within the last hour are agents. One is working
//! while its latest message is the person's or a tool's (a reply is due) and Hermes is running.
//! Hermes keeps no record of waiting on the person, so no decision bubbles.

use super::naming::{number_namesakes, tidy, title_case};
use super::Source;
use crate::model::{ActivityKind, Agent, LastRun, Usage};
use crate::time::{iso_from_millis, now_millis};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::PathBuf;

pub const ID: &str = "hermes";
const RUN_PREFIX: &str = "hermes:";
/// Sessions stay in the office this long after their last message.
const RECENT_MILLIS: i64 = 60 * 60 * 1000;
/// A reply due for this long was abandoned.
const STALE_MILLIS: i64 = 10 * 60 * 1000;
const SUMMARY_MAX_CHARS: usize = 320;
/// Messages sent for the live speech bubble.
const LOG_MESSAGES: i64 = 30;

pub struct Hermes {
    root: PathBuf,
}

impl Hermes {
    pub fn new() -> Self {
        let root = std::env::var_os("HERMES_HOME").map(PathBuf::from).unwrap_or_else(|| super::home().join(".hermes"));
        Self { root }
    }

    #[cfg(test)]
    fn at(root: PathBuf) -> Self {
        Self { root }
    }

    fn db(&self) -> PathBuf {
        self.root.join("state.db")
    }

    fn open(&self) -> rusqlite::Result<Connection> {
        super::open_sqlite(&self.db())
    }

    /// Whether Hermes is running: its gateway's process, or a Hermes CLI.
    fn running(&self) -> bool {
        let gateway = std::fs::read(self.root.join("gateway.pid"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|pid| pid.get("pid").and_then(Value::as_u64));
        gateway.is_some_and(pid_alive) || super::process_running(&["-f", "hermes_cli|bin/hermes"])
    }

    fn read_agents(&self) -> rusqlite::Result<Vec<Agent>> {
        let conn = self.open()?;
        let now = now_millis();
        let running = self.running();
        let mut statement = conn.prepare(
            "SELECT s.id, s.source, s.title, s.model, s.started_at,
                    (SELECT max(m.timestamp) FROM messages m WHERE m.session_id = s.id),
                    (SELECT m.role FROM messages m WHERE m.session_id = s.id ORDER BY m.timestamp DESC, m.id DESC LIMIT 1)
             FROM sessions s
             WHERE s.ended_at IS NULL AND s.parent_session_id IS NULL
             ORDER BY s.started_at",
        )?;
        let rows: Vec<(String, String, Option<String>, f64, Option<f64>, Option<String>)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(4)?, row.get(5)?, row.get(6)?)))?
            .flatten()
            .collect();
        let mut agents = Vec::new();
        for (id, source, title, started, last_message, last_role) in rows {
            let started = (started * 1000.0) as i64;
            let last = last_message.map_or(started, |at| (at * 1000.0) as i64);
            if now - last > RECENT_MILLIS {
                continue;
            }
            let reply_due = matches!(last_role.as_deref(), Some("user" | "tool"));
            let working = running && reply_due && now - last <= STALE_MILLIS;
            agents.push(Agent {
                id: format!("hermes:{id}"),
                name: format!("Hermes {}", title_case(&source)).trim().to_owned(),
                status: if working { "running" } else { "idle" }.into(),
                activity_kind: if working { ActivityKind::Research } else { ActivityKind::Idle },
                last_run: Some(LastRun {
                    run_id: format!("{RUN_PREFIX}{id}"),
                    status: if working { "running" } else { "succeeded" }.into(),
                    active: working,
                    started_at: Some(iso_from_millis(started)),
                    finished_at: (!working).then(|| iso_from_millis(last)),
                    last_output_at: Some(iso_from_millis(last)),
                    summary: if working { None } else { last_reply(&conn, &id) },
                    issue_title: title.filter(|title| !title.trim().is_empty()),
                    ..LastRun::default()
                }),
                source: ID,
                session_ref: Some(id),
                created_ms: Some(started),
                ..Agent::default()
            });
        }
        number_namesakes(&mut agents);
        Ok(agents)
    }

    fn read_usage(&self, session_id: &str, since: i64) -> rusqlite::Result<Usage> {
        let conn = self.open()?;
        let mut usage = Usage::default();
        // Token totals are per session: counted when the session was active in the time frame
        let (started, input, output, cache_read): (f64, i64, i64, i64) = conn.query_row(
            "SELECT started_at, coalesce(input_tokens, 0), coalesce(output_tokens, 0), coalesce(cache_read_tokens, 0) FROM sessions WHERE id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let mut statement = conn.prepare("SELECT role, timestamp FROM messages WHERE session_id = ?1 ORDER BY timestamp, id")?;
        let messages: Vec<(String, f64)> = statement.query_map(params![session_id], |row| Ok((row.get(0)?, row.get(1)?)))?.flatten().collect();
        let mut previous: Option<i64> = None;
        for (role, at) in &messages {
            let at = (*at * 1000.0) as i64;
            if at >= since {
                match role.as_str() {
                    "user" => usage.runs += 1,
                    "assistant" => {
                        if let Some(previous) = previous {
                            usage.active_seconds += ((at - previous).clamp(0, STALE_MILLIS) / 1000) as u64;
                        }
                    }
                    _ => {}
                }
            }
            previous = Some(at);
        }
        let active_in_frame = (started * 1000.0) as i64 >= since || usage.runs > 0;
        if active_in_frame {
            usage.input_tokens = input.max(0) as u64;
            usage.cached_input_tokens = cache_read.max(0) as u64;
            usage.output_tokens = output.max(0) as u64;
        }
        Ok(usage)
    }

    /// The latest messages as Claude-shaped events: replies' text and tool calls.
    fn read_events(&self, session_id: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.open()?;
        let mut statement = conn.prepare(
            "SELECT content, tool_calls FROM messages WHERE session_id = ?1 AND role = 'assistant' ORDER BY timestamp DESC, id DESC LIMIT ?2",
        )?;
        let rows: Vec<(Option<String>, Option<String>)> = statement.query_map(params![session_id, LOG_MESSAGES], |row| Ok((row.get(0)?, row.get(1)?)))?.flatten().collect();
        Ok(rows
            .into_iter()
            .rev()
            .map(|(content, tool_calls)| super::claude_event(content.as_deref(), &openai_tool_calls(tool_calls.as_deref())).to_string())
            .collect())
    }
}

impl Source for Hermes {
    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Hermes"
    }

    fn location(&self) -> String {
        self.db().display().to_string()
    }

    fn detect(&self) -> bool {
        self.db().is_file()
    }

    fn agents(&self) -> Vec<Agent> {
        self.read_agents().unwrap_or_default()
    }

    fn problem(&self) -> Option<String> {
        self.read_agents().err().map(|error| format!("Can't read Hermes's database: {error}"))
    }

    fn watch_paths(&self) -> Vec<PathBuf> {
        vec![self.db().with_extension("db-wal"), self.db()]
    }

    fn read_log(&self, run_id: &str, offset: u64, _limit: u64) -> Option<String> {
        let session_id = run_id.strip_prefix(RUN_PREFIX)?;
        if offset > 0 {
            return Some(String::new());
        }
        let events = self.read_events(session_id).ok()?;
        Some(super::as_run_log(events.iter().map(String::as_str)))
    }

    fn usage(&self, agent: &Agent, since: i64) -> Usage {
        agent.session_ref.as_deref().and_then(|session| self.read_usage(session, since).ok()).unwrap_or_default()
    }
}

/// The latest reply's text, tidied.
fn last_reply(conn: &Connection, session_id: &str) -> Option<String> {
    let text: String = conn
        .query_row(
            "SELECT content FROM messages WHERE session_id = ?1 AND role = 'assistant' AND trim(coalesce(content, '')) <> ''
             ORDER BY timestamp DESC, id DESC LIMIT 1",
            params![session_id],
            |row| row.get(0),
        )
        .ok()?;
    Some(tidy(&text, SUMMARY_MAX_CHARS))
}

/// OpenAI-style tool calls (`[{function: {name, arguments}}]`) as (name, input) pairs.
pub fn openai_tool_calls(json: Option<&str>) -> Vec<(String, Value)> {
    let Some(calls) = json.and_then(|json| serde_json::from_str::<Value>(json).ok()) else { return Vec::new() };
    calls
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|call| {
            let function = call.get("function").unwrap_or(call);
            let name = function.get("name")?.as_str()?.to_owned();
            let input = match function.get("arguments") {
                Some(Value::String(raw)) => serde_json::from_str(raw).unwrap_or(Value::String(raw.clone())),
                Some(other) => other.clone(),
                None => Value::Null,
            };
            Some((name, input))
        })
        .collect()
}

fn pid_alive(pid: u64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    // Signal 0 only checks the process exists (EPERM: it does, but isn't ours)
    unsafe { libc::kill(pid, 0) == 0 || *libc::__error() == libc::EPERM }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sessions_usage_and_log() {
        let root = std::env::temp_dir().join(format!("officesim-hermes-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let conn = Connection::open(root.join("state.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, parent_session_id TEXT, started_at REAL NOT NULL,
                                    ended_at REAL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, title TEXT);
             CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
                                    tool_calls TEXT, timestamp REAL NOT NULL);",
        )
        .unwrap();
        let now = now_millis() as f64 / 1000.0;
        conn.execute("INSERT INTO sessions VALUES ('s1', 'whatsapp', 'm', NULL, ?1, NULL, 100, 20, 50, 'Book a table')", params![now - 120.0]).unwrap();
        conn.execute("INSERT INTO sessions VALUES ('s2', 'cli', 'm', NULL, ?1, ?1, 1, 1, 1, 'Ended')", params![now - 60.0]).unwrap();
        conn.execute("INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES ('s1', 'user', 'Book it', NULL, ?1)", params![now - 100.0]).unwrap();
        conn.execute(
            "INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES ('s1', 'assistant', 'Booked for **8pm**.', ?2, ?1)",
            params![now - 90.0, r#"[{"id":"c1","type":"function","function":{"name":"web_search","arguments":"{\"query\":\"tables\"}"}}]"#],
        )
        .unwrap();
        drop(conn);

        let source = Hermes::at(root.clone());
        let agents = source.agents();
        assert_eq!(agents.len(), 1, "{agents:?}");
        let agent = &agents[0];
        assert_eq!(agent.name, "Hermes Whatsapp");
        assert_eq!(agent.status, "idle");
        let run = agent.last_run.as_ref().unwrap();
        assert_eq!(run.summary.as_deref(), Some("Booked for 8pm."));
        assert_eq!(run.issue_title.as_deref(), Some("Book a table"));
        assert_eq!(source.usage(agent, 0), Usage { runs: 1, active_seconds: 10, input_tokens: 100, cached_input_tokens: 50, output_tokens: 20, ..Usage::default() });
        let log = source.read_log(&run.run_id, 0, 1000).unwrap();
        assert!(log.contains(r#"\"name\":\"web_search\""#), "{log}");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
