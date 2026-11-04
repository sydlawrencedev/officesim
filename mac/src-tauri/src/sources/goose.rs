//! Goose sessions, from its SQLite database (`~/.local/share/goose/sessions/sessions.db`, opened
//! read only): `sessions` (folder, name, token totals, times) and `messages` (role, and
//! `content_json`: a list of typed blocks, `text`, `toolRequest`, `toolResponse`,
//! `toolConfirmationRequest`, `actionRequired`...). Shapes from Goose's own code
//! (crates/goose/src/session/session_manager.rs, crates/goose-provider-types/src/conversation/message.rs).
//!
//! The person's sessions updated within the last hour are agents. One is working while a reply is
//! due (the latest message is the person's, or a tool call is unanswered) and Goose is running, and
//! waiting on the person when its latest message asks to confirm a tool call or for an action.

use super::naming::{number_namesakes, project_name, tidy};
use super::Source;
use crate::model::{ActivityKind, Agent, LastRun, Usage};
use crate::time::{iso_from_millis, millis_from_sql_time, now_millis};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;

pub const ID: &str = "goose";
const RUN_PREFIX: &str = "goose:";
const HARNESS_NAME: &str = "Goose";
/// Sessions stay in the office this long after they were last updated.
const RECENT_MILLIS: i64 = 60 * 60 * 1000;
/// A reply due for this long was abandoned.
const STALE_MILLIS: i64 = 10 * 60 * 1000;
const SUMMARY_MAX_CHARS: usize = 320;
/// Messages sent for the live speech bubble.
const LOG_MESSAGES: i64 = 30;

pub struct Goose {
    db: PathBuf,
}

impl Goose {
    pub fn new() -> Self {
        let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| super::home().join(".local/share"));
        Self { db: data.join("goose/sessions/sessions.db") }
    }

    #[cfg(test)]
    fn at(db: PathBuf) -> Self {
        Self { db }
    }

    fn read_agents(&self) -> rusqlite::Result<Vec<Agent>> {
        let conn = super::open_sqlite(&self.db)?;
        let now = now_millis();
        let running = super::process_running(&["-x", "goose|goosed"]);
        let mut statement = conn.prepare(
            "SELECT id, name, working_dir, created_at, updated_at FROM sessions WHERE session_type = 'user' ORDER BY created_at",
        )?;
        let rows: Vec<(String, String, String, String, String)> =
            statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?.flatten().collect();
        let mut agents = Vec::new();
        for (id, name, working_dir, created, updated) in rows {
            let created = millis_from_sql_time(&created);
            let messages = latest_messages(&conn, &id, 2)?;
            let last_at = messages.last().map(|message| message.at).or_else(|| millis_from_sql_time(&updated)).unwrap_or(0);
            if now - last_at > RECENT_MILLIS {
                continue;
            }
            let last = messages.last();
            let waiting_on = if running { last.and_then(Message::confirmation) } else { None };
            let reply_due = last.is_some_and(|message| message.role == "user" || message.unanswered_tool_call(messages.iter()));
            let working = running && waiting_on.is_none() && reply_due && now - last_at <= STALE_MILLIS;
            agents.push(Agent {
                id: format!("goose:{id}"),
                name: project_name(HARNESS_NAME, Some(&working_dir)),
                status: if working { "running" } else { "idle" }.into(),
                activity_kind: if working { ActivityKind::Coding } else { ActivityKind::Idle },
                last_run: Some(LastRun {
                    run_id: format!("{RUN_PREFIX}{id}"),
                    status: if working { "running" } else { "succeeded" }.into(),
                    active: working,
                    started_at: created.map(iso_from_millis),
                    finished_at: (!working).then(|| iso_from_millis(last_at)),
                    last_output_at: Some(iso_from_millis(last_at)),
                    summary: if working { None } else { last_reply(&conn, &id)? },
                    issue_title: Some(name).filter(|name| !name.trim().is_empty()),
                    ..LastRun::default()
                }),
                source: ID,
                waiting_on,
                session_ref: Some(id),
                created_ms: created,
                cwd: Some(working_dir.clone()),
                ..Agent::default()
            });
        }
        number_namesakes(&mut agents);
        Ok(agents)
    }

    fn read_usage(&self, session_id: &str, since: i64) -> rusqlite::Result<Usage> {
        let conn = super::open_sqlite(&self.db)?;
        let mut usage = Usage::default();
        let messages = latest_messages(&conn, session_id, i64::MAX)?;
        let mut previous: Option<i64> = None;
        for message in &messages {
            if message.at >= since {
                match message.role.as_str() {
                    "user" if message.has_text() => usage.runs += 1,
                    "assistant" => {
                        if let Some(previous) = previous {
                            usage.active_seconds += ((message.at - previous).clamp(0, STALE_MILLIS) / 1000) as u64;
                        }
                    }
                    _ => {}
                }
            }
            previous = Some(message.at);
        }
        // Token totals are per session: counted when the session was active in the time frame
        if usage.runs > 0 || messages.first().is_some_and(|message| message.at >= since) {
            let (input, output, cache_read): (Option<i64>, Option<i64>, Option<i64>) = conn.query_row(
                "SELECT accumulated_input_tokens, accumulated_output_tokens, accumulated_cache_read_tokens FROM sessions WHERE id = ?1",
                params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let count = |value: Option<i64>| value.unwrap_or(0).max(0) as u64;
            usage.cached_input_tokens = count(cache_read);
            usage.input_tokens = count(input).saturating_sub(usage.cached_input_tokens);
            usage.output_tokens = count(output);
        }
        Ok(usage)
    }
}

impl Source for Goose {
    fn process_pattern(&self) -> Option<&'static str> {
        Some("(^|/)goose( |$)")
    }

    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Goose"
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
        self.read_agents().err().map(|error| format!("Can't read Goose's database: {error}"))
    }

    fn watch_paths(&self) -> Vec<PathBuf> {
        vec![self.db.with_extension("db-wal"), self.db.clone()]
    }

    fn read_log(&self, run_id: &str, offset: u64, _limit: u64) -> Option<String> {
        let session_id = run_id.strip_prefix(RUN_PREFIX)?;
        if offset > 0 {
            return Some(String::new());
        }
        let conn = super::open_sqlite(&self.db).ok()?;
        let events: Vec<String> = latest_messages(&conn, session_id, LOG_MESSAGES)
            .ok()?
            .iter()
            .filter(|message| message.role == "assistant")
            .map(|message| super::claude_event(Some(&message.text()), &message.tool_calls()).to_string())
            .collect();
        Some(super::as_run_log(events.iter().map(String::as_str)))
    }

    fn usage(&self, agent: &Agent, since: i64) -> Usage {
        agent.session_ref.as_deref().and_then(|session| self.read_usage(session, since).ok()).unwrap_or_default()
    }
}

struct Message {
    role: String,
    /// Milliseconds since the epoch.
    at: i64,
    blocks: Vec<Value>,
}

impl Message {
    fn of_type<'a>(&'a self, kind: &'a str) -> impl Iterator<Item = &'a Value> + 'a {
        self.blocks.iter().filter(move |block| block.get("type").and_then(Value::as_str) == Some(kind))
    }

    fn text(&self) -> String {
        self.of_type("text").filter_map(|block| block.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")
    }

    fn has_text(&self) -> bool {
        !self.text().trim().is_empty()
    }

    /// Its tool calls as (name, arguments): `toolRequest` blocks' `toolCall.value`.
    fn tool_calls(&self) -> Vec<(String, Value)> {
        self.of_type("toolRequest")
            .filter_map(|block| {
                let call = block.pointer("/toolCall/value")?;
                Some((call.get("name")?.as_str()?.to_owned(), call.get("arguments").cloned().unwrap_or(Value::Null)))
            })
            .collect()
    }

    /// Whether it calls a tool no later message answers.
    fn unanswered_tool_call<'a>(&self, messages: impl Iterator<Item = &'a Message>) -> bool {
        let answered: HashSet<String> = messages
            .flat_map(|message| message.of_type("toolResponse").filter_map(|block| block.get("id").and_then(Value::as_str).map(str::to_owned)).collect::<Vec<_>>())
            .collect();
        self.of_type("toolRequest").any(|block| block.get("id").and_then(Value::as_str).is_some_and(|id| !answered.contains(id)))
    }

    /// What it asks the person to confirm or do, if it does.
    fn confirmation(&self) -> Option<String> {
        if let Some(block) = self.of_type("toolConfirmationRequest").next() {
            let prompt = block.get("prompt").and_then(Value::as_str).map(str::to_owned);
            let tool = block.get("toolName").and_then(Value::as_str).unwrap_or("a tool");
            return Some(prompt.unwrap_or_else(|| format!("Allow {tool}?")));
        }
        self.of_type("actionRequired").next().map(|block| {
            block.pointer("/data/message").or_else(|| block.get("message")).and_then(Value::as_str).unwrap_or("Needs your input").to_owned()
        })
    }
}

/// A session's latest `limit` messages, oldest first.
fn latest_messages(conn: &Connection, session_id: &str, limit: i64) -> rusqlite::Result<Vec<Message>> {
    let mut statement =
        conn.prepare("SELECT role, created_timestamp, content_json FROM messages WHERE session_id = ?1 ORDER BY created_timestamp DESC, id DESC LIMIT ?2")?;
    let mut messages: Vec<Message> = statement
        .query_map(params![session_id, limit], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)))?
        .flatten()
        .map(|(role, created, content)| Message {
            role,
            // Goose writes seconds; anything this big is already milliseconds
            at: if created > 100_000_000_000 { created } else { created * 1000 },
            blocks: serde_json::from_str::<Value>(&content).ok().and_then(|blocks| blocks.as_array().cloned()).unwrap_or_default(),
        })
        .collect();
    messages.reverse();
    Ok(messages)
}

fn last_reply(conn: &Connection, session_id: &str) -> rusqlite::Result<Option<String>> {
    let messages = latest_messages(conn, session_id, 20)?;
    Ok(messages.iter().rev().filter(|message| message.role == "assistant").map(Message::text).find(|text| !text.trim().is_empty()).map(|text| tidy(&text, SUMMARY_MAX_CHARS)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_sessions_confirmations_usage_and_log() {
        let path = std::env::temp_dir().join(format!("officesim-goose-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', session_type TEXT NOT NULL DEFAULT 'user',
                                    working_dir TEXT NOT NULL, created_at TIMESTAMP, updated_at TIMESTAMP,
                                    accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER, accumulated_cache_read_tokens INTEGER);
             CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
                                    content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL);",
        )
        .unwrap();
        let now = now_millis() / 1000;
        conn.execute("INSERT INTO sessions VALUES ('g1', 'Tidy the docs', 'user', '/Users/me/code/my-app', '2026-10-01 10:00:00', '2026-10-01 10:01:00', 500, 60, 300)", []).unwrap();
        conn.execute("INSERT INTO sessions VALUES ('g2', 'Sub', 'sub_agent', '/x', '2026-10-01 10:00:00', '2026-10-01 10:01:00', 0, 0, 0)", []).unwrap();
        let insert = |role: &str, content: Value, at: i64| {
            conn.execute("INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES ('g1', ?1, ?2, ?3)", params![role, content.to_string(), at]).unwrap();
        };
        insert("user", json!([{ "type": "text", "text": "Tidy the docs" }]), now - 60);
        insert("assistant", json!([{ "type": "text", "text": "Reading **them**." }, { "type": "toolRequest", "id": "t1", "toolCall": { "status": "success", "value": { "name": "developer__shell", "arguments": { "command": "ls docs" } } } }]), now - 50);
        insert("user", json!([{ "type": "toolResponse", "id": "t1", "toolResult": { "status": "success", "value": [] } }]), now - 45);
        insert("assistant", json!([{ "type": "toolConfirmationRequest", "id": "t2", "toolName": "developer__text_editor", "arguments": {}, "prompt": "Edit README.md?" }]), now - 40);
        drop(conn);

        let source = Goose::at(path.clone());
        let agents = source.agents();
        assert_eq!(agents.len(), 1, "{agents:?}");
        let agent = &agents[0];
        assert_eq!(agent.name, "My App");
        assert_eq!(agent.last_run.as_ref().unwrap().issue_title.as_deref(), Some("Tidy the docs"));
        assert_eq!(agent.last_run.as_ref().unwrap().summary.as_deref(), Some("Reading them."));

        let conn = super::super::open_sqlite(&path).unwrap();
        let messages = latest_messages(&conn, "g1", 10).unwrap();
        assert_eq!(messages.last().unwrap().confirmation().as_deref(), Some("Edit README.md?"));
        assert!(!messages[1].unanswered_tool_call(messages.iter()));

        let usage = source.usage(agent, 0);
        assert_eq!(usage, Usage { runs: 1, active_seconds: 15, input_tokens: 200, cached_input_tokens: 300, output_tokens: 60, ..Usage::default() });
        let log = source.read_log("goose:g1", 0, 1000).unwrap();
        assert!(log.contains(r#"\"command\":\"ls docs\""#), "{log}");
        std::fs::remove_file(path).unwrap();
    }
}
