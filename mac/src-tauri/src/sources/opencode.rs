//! OpenCode sessions, from its SQLite database (`~/.local/share/opencode/opencode.db`, opened read
//! only).
//!
//! OpenCode has two schemas. The current one keeps sessions in `session_v2` and their messages in
//! `session_message` (the message's role is a column, its text and tool calls are an array in the
//! message's JSON, and its token counts are in the same JSON). The older one keeps them in
//! `session`, `message` and `part` (the role is in the message's JSON). This adapter reads the
//! current one when the database has it, and the older one otherwise.
//!
//! Top-level sessions updated within the last hour are agents (subagent sessions are part of their
//! parent's work). A session is working while its latest reply hasn't completed, as long as an
//! OpenCode process is running and the session was written to recently.

use super::naming::{number_namesakes, project_name, question_text, tidy};
use super::Source;
use crate::model::{ActivityKind, Agent, LastRun, Usage};
use crate::time::{iso_from_millis, now_millis};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;

pub const ID: &str = "opencode";
const RUN_PREFIX: &str = "opencode:";
/// An agent's name when its project isn't known.
const HARNESS_NAME: &str = "OpenCode";
/// Sessions stay in the office this long after they were last updated.
const RECENT_MILLIS: i64 = 60 * 60 * 1000;
/// A reply that hasn't completed but hasn't been written to for this long was abandoned.
const STALE_MILLIS: i64 = 10 * 60 * 1000;
const SUMMARY_MAX_CHARS: usize = 320;
/// Parts of the latest replies sent for the live speech bubble.
const LOG_PARTS: usize = 40;

pub struct OpenCode {
    db: PathBuf,
}

impl OpenCode {
    pub fn new() -> Self {
        let data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| super::home().join(".local/share"));
        Self { db: data.join("opencode/opencode.db") }
    }

    #[cfg(test)]
    fn at(db: PathBuf) -> Self {
        Self { db }
    }

    fn open(&self) -> rusqlite::Result<Connection> {
        let conn = Connection::open_with_flags(&self.db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        // OpenCode may be writing; wait a moment for its lock rather than failing
        conn.busy_timeout(std::time::Duration::from_millis(500))?;
        Ok(conn)
    }

    fn read_agents(&self) -> rusqlite::Result<Vec<Agent>> {
        let conn = self.open()?;
        if has_table(&conn, "session_v2") {
            self.read_agents_v2(&conn)
        } else {
            self.read_agents_legacy(&conn)
        }
    }

    /// The current schema: sessions in `session_v2`, their messages in `session_message`.
    ///
    /// Whether the session is working comes from the session's own `time_busy` and `time_idle`,
    /// which OpenCode keeps up to date. Guessing from the latest message doesn't work here:
    /// OpenCode writes one message per tool call, so "the newest reply hasn't finished" is true
    /// and false several times a minute while the agent is working steadily.
    fn read_agents_v2(&self, conn: &Connection) -> rusqlite::Result<Vec<Agent>> {
        let now = now_millis();
        let running = opencode_running();
        let mut statement = conn.prepare(
            "SELECT s.id, s.directory, s.title, s.time_created, s.time_updated,
                    (SELECT m.data FROM session_message m WHERE m.session_id = s.id ORDER BY m.time_created DESC, m.id DESC LIMIT 1),
                    (SELECT m.type FROM session_message m WHERE m.session_id = s.id ORDER BY m.time_created DESC, m.id DESC LIMIT 1),
                    s.model, s.time_busy, s.time_idle
             FROM session_v2 s
             WHERE s.parent_id IS NULL AND s.time_archived IS NULL AND s.time_updated >= ?1
             ORDER BY s.time_created",
        )?;
        let rows = statement.query_map(params![now - RECENT_MILLIS], |row| {
            Ok(SessionRow {
                id: row.get(0)?,
                directory: row.get(1)?,
                title: row.get(2)?,
                created: row.get(3)?,
                updated: row.get(4)?,
                last_message: row.get::<_, Option<String>>(5)?.and_then(|data| serde_json::from_str(&data).ok()),
                last_role: row.get(6)?,
                model: row.get::<_, Option<String>>(7)?.and_then(|model| session_model(&model)),
                // OpenCode's own answer to "is this session working right now?"
                busy_at: row.get(8)?,
                idle_at: row.get(9)?,
                v2: true,
            })
        })?;
        let mut agents = Vec::new();
        for session in rows.flatten() {
            agents.push(self.agent_from(&conn, &session, running, now));
        }
        number_namesakes(&mut agents);
        Ok(agents)
    }

    /// The older schema: sessions in `session`, their messages in `message`.
    fn read_agents_legacy(&self, conn: &Connection) -> rusqlite::Result<Vec<Agent>> {
        let now = now_millis();
        let running = opencode_running();
        let mut statement = conn.prepare(
            "SELECT s.id, s.directory, s.title, s.time_created, s.time_updated,
                    (SELECT m.data FROM message m WHERE m.session_id = s.id ORDER BY m.time_created DESC, m.id DESC LIMIT 1),
                    (SELECT json_extract(m.data, '$.role') FROM message m WHERE m.session_id = s.id ORDER BY m.time_created DESC, m.id DESC LIMIT 1),
                    (SELECT json_extract(m.data, '$.modelID') FROM message m
                     WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'assistant'
                     ORDER BY m.time_created DESC, m.id DESC LIMIT 1)
             FROM session s
             WHERE s.parent_id IS NULL AND s.time_archived IS NULL AND s.time_updated >= ?1
             ORDER BY s.time_created",
        )?;
        let rows = statement.query_map(params![now - RECENT_MILLIS], |row| {
            Ok(SessionRow {
                id: row.get(0)?,
                directory: row.get(1)?,
                title: row.get(2)?,
                created: row.get(3)?,
                updated: row.get(4)?,
                last_message: row.get::<_, Option<String>>(5)?.and_then(|data| serde_json::from_str(&data).ok()),
                last_role: row.get(6)?,
                model: row.get(7)?,
                busy_at: None,
                idle_at: None,
                v2: false,
            })
        })?;
        let mut agents = Vec::new();
        for session in rows.flatten() {
            agents.push(self.agent_from(conn, &session, running, now));
        }
        number_namesakes(&mut agents);
        Ok(agents)
    }

    /// One session as an agent, whichever schema it came from.
    fn agent_from(&self, conn: &Connection, session: &SessionRow, running: bool, now: i64) -> Agent {
        let working = running && session.updated >= now - STALE_MILLIS && session.replying();
        // The error is on the last reply, which isn't the newest message in the current schema
        // (that one is an "idle" marker when the turn is over).
        let error = if working { None } else { self.last_error(conn, session) };
        let summary = if working { None } else { error.clone().or_else(|| last_reply_text(conn, &session.id, session.v2)) };
        let status = if working { "running" } else if error.is_some() { "error" } else { "idle" };
        // A question it's waiting on the person to answer, while its reply is open
        let waiting_on = (running && session.replying()).then(|| open_question(conn, &session.id, session.v2)).flatten();
        Agent {
            id: format!("opencode:{}", session.id),
            name: project_name(HARNESS_NAME, Some(&session.directory)),
            status: status.into(),
            activity_kind: if working { ActivityKind::Coding } else { ActivityKind::Idle },
            last_run: Some(LastRun {
                run_id: format!("{RUN_PREFIX}{}", session.id),
                status: if working { "running" } else if error.is_some() { "failed" } else { "succeeded" }.into(),
                active: working,
                started_at: Some(iso_from_millis(session.created)),
                finished_at: (!working).then(|| iso_from_millis(session.updated)),
                last_output_at: Some(iso_from_millis(session.updated)),
                summary,
                error,
                issue_title: session_title(&session.title),
                ..LastRun::default()
            }),
            source: ID,
            model: session.model.clone(),
            waiting_on,
            session_ref: Some(session.id.clone()),
            created_ms: Some(session.created),
            cwd: Some(session.directory.clone()).filter(|directory| directory != "/"),
            ..Agent::default()
        }
    }

    fn read_usage(&self, session_id: &str, since: i64) -> rusqlite::Result<Usage> {
        let conn = self.open()?;
        if has_table(&conn, "session_v2") {
            self.read_usage_v2(&conn, session_id, since)
        } else {
            self.read_usage_legacy(&conn, session_id, since)
        }
    }

    /// The current schema: `session_message`, whose role is a column and whose token counts are
    /// in the message's JSON.
    fn read_usage_v2(&self, conn: &Connection, session_id: &str, since: i64) -> rusqlite::Result<Usage> {
        let mut statement = conn.prepare(
            "SELECT type, time_created, json_extract(data, '$.time.completed'),
                    json_extract(data, '$.tokens.input'), json_extract(data, '$.tokens.output'),
                    json_extract(data, '$.tokens.reasoning'), json_extract(data, '$.tokens.cache.read'),
                    json_extract(data, '$.tokens.cache.write')
             FROM session_message WHERE session_id = ?1 AND time_created >= ?2",
        )?;
        let mut usage = Usage::default();
        let rows = statement.query_map(params![session_id, since], |row| {
            let count = |index: usize| row.get::<_, Option<i64>>(index).map(|value| value.unwrap_or(0).max(0) as u64);
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                [count(3)?, count(4)?, count(5)?, count(6)?, count(7)?],
            ))
        })?;
        for (role, created, completed, [input, output, reasoning, cache_read, cache_write]) in rows.flatten() {
            match role.as_deref() {
                Some("user") => usage.runs += 1,
                Some("assistant") => {
                    usage.active_seconds += completed.map_or(0, |completed| ((completed - created).max(0) / 1000) as u64);
                    usage.input_tokens += input + cache_write;
                    usage.cached_input_tokens += cache_read;
                    usage.output_tokens += output + reasoning;
                }
                _ => {}
            }
        }
        Ok(usage)
    }

    /// The older schema: `message`, whose role and token counts are in its JSON.
    fn read_usage_legacy(&self, conn: &Connection, session_id: &str, since: i64) -> rusqlite::Result<Usage> {
        let mut statement = conn.prepare(
            "SELECT json_extract(data, '$.role'), time_created, json_extract(data, '$.time.completed'),
                    json_extract(data, '$.tokens.input'), json_extract(data, '$.tokens.output'),
                    json_extract(data, '$.tokens.reasoning'), json_extract(data, '$.tokens.cache.read'),
                    json_extract(data, '$.tokens.cache.write')
             FROM message WHERE session_id = ?1 AND time_created >= ?2",
        )?;
        let mut usage = Usage::default();
        let rows = statement.query_map(params![session_id, since], |row| {
            let count = |index: usize| row.get::<_, Option<i64>>(index).map(|value| value.unwrap_or(0).max(0) as u64);
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                [count(3)?, count(4)?, count(5)?, count(6)?, count(7)?],
            ))
        })?;
        for (role, created, completed, [input, output, reasoning, cache_read, cache_write]) in rows.flatten() {
            match role.as_deref() {
                Some("user") => usage.runs += 1,
                Some("assistant") => {
                    usage.active_seconds += completed.map_or(0, |completed| ((completed - created).max(0) / 1000) as u64);
                    usage.input_tokens += input + cache_write;
                    usage.cached_input_tokens += cache_read;
                    usage.output_tokens += output + reasoning;
                }
                _ => {}
            }
        }
        Ok(usage)
    }

    /// The error the session's last reply ended on, if any.
    ///
    /// In the current schema the newest message is an "idle" marker when the turn is over, so the
    /// error is on the last assistant message, which is looked up separately.
    fn last_error(&self, conn: &Connection, session: &SessionRow) -> Option<String> {
        if !session.v2 {
            return session.error();
        }
        let mut statement = conn
            .prepare(
                "SELECT data FROM session_message WHERE session_id = ?1 AND type = 'assistant'
                 ORDER BY time_created DESC, id DESC LIMIT 1",
            )
            .ok()?;
        let data: String = statement.query_row(params![session.id], |row| row.get(0)).ok()?;
        let message: Value = serde_json::from_str(&data).ok()?;
        message_error(&message)
    }

    /// The latest replies' text and tool calls, as OpenCode's own JSON events (`text` and
    /// `tool_use`, what the UI's runOutput.ts reads from Paperclip's OpenCode runs).
    fn read_events(&self, session_id: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.open()?;
        if has_table(&conn, "session_v2") {
            self.read_events_v2(&conn, session_id)
        } else {
            self.read_events_legacy(&conn, session_id)
        }
    }

    /// The current schema: the text and tool calls are in each message's content array.
    fn read_events_v2(&self, conn: &Connection, session_id: &str) -> rusqlite::Result<Vec<String>> {
        let mut statement = conn.prepare(
            "SELECT data FROM session_message WHERE session_id = ?1 AND type = 'assistant'
             ORDER BY time_created DESC, id DESC LIMIT ?2",
        )?;
        let messages: Vec<Value> = statement
            .query_map(params![session_id, LOG_PARTS as i64], |row| row.get::<_, String>(0))?
            .flatten()
            .filter_map(|data| serde_json::from_str(&data).ok())
            .collect();
        let mut events = Vec::new();
        for message in messages.iter().rev() {
            for block in message.get("content").and_then(Value::as_array).into_iter().flatten() {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            events.push(json!({ "type": "text", "part": { "text": text } }).to_string());
                        }
                    }
                    Some("tool") => {
                        let name = block.get("name").or_else(|| block.get("tool")).and_then(Value::as_str).unwrap_or("tool");
                        let state = block.get("state").cloned().unwrap_or(Value::Null);
                        events.push(json!({ "type": "tool_use", "part": { "tool": name, "state": state } }).to_string());
                    }
                    _ => {}
                }
            }
        }
        Ok(events)
    }

    /// The older schema: the text and tool calls are in `part` rows.
    fn read_events_legacy(&self, conn: &Connection, session_id: &str) -> rusqlite::Result<Vec<String>> {
        let mut statement = conn.prepare(
            "SELECT p.data FROM part p JOIN message m ON m.id = p.message_id
             WHERE p.session_id = ?1 AND json_extract(m.data, '$.role') = 'assistant'
               AND json_extract(p.data, '$.type') IN ('text', 'tool')
             ORDER BY p.time_created DESC, p.id DESC LIMIT ?2",
        )?;
        let parts: Vec<Value> = statement
            .query_map(params![session_id, LOG_PARTS as i64], |row| row.get::<_, String>(0))?
            .flatten()
            .filter_map(|data| serde_json::from_str(&data).ok())
            .collect();
        Ok(parts.into_iter().rev().filter_map(|part| part_event(&part)).map(|event| event.to_string()).collect())
    }
}

impl Source for OpenCode {
    fn process_pattern(&self) -> Option<&'static str> {
        Some("(^|/)opencode( |$)")
    }

    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "OpenCode"
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
        self.read_agents().err().map(|error| format!("Can't read OpenCode's database: {error}"))
    }

    fn watch_paths(&self) -> Vec<PathBuf> {
        // Writes land in the write-ahead log first
        vec![self.db.with_extension("db-wal"), self.db.clone()]
    }

    fn read_log(&self, run_id: &str, offset: u64, _limit: u64) -> Option<String> {
        let session_id = run_id.strip_prefix(RUN_PREFIX)?;
        // The log is made up from the latest parts, so it's all one chunk: there is nothing before it
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

#[derive(Clone)]
struct SessionRow {
    id: String,
    directory: String,
    title: String,
    created: i64,
    updated: i64,
    last_message: Option<Value>,
    /// The role of the latest message: "user" or "assistant" (a column in the current schema,
    /// in the message's JSON in the older one).
    last_role: Option<String>,
    /// The model of the latest reply.
    model: Option<String>,
    /// When the session last turned busy, in the current schema.
    busy_at: Option<i64>,
    /// When the session last turned idle, in the current schema.
    idle_at: Option<i64>,
    /// Whether this session came from the current schema.
    v2: bool,
}

impl SessionRow {
    /// Whether OpenCode is mid-reply.
    ///
    /// In the current schema OpenCode says so itself: the session's `time_busy` is newer than its
    /// `time_idle`. In the older one there's nothing to ask but the messages: the latest one is
    /// the person's (the reply hasn't started), or a reply without a completion time.
    fn replying(&self) -> bool {
        if self.v2 {
            return match (self.busy_at, self.idle_at) {
                // Busy since it last went idle: it's working
                (Some(busy), idle) => idle.is_none_or(|idle| busy > idle),
                // Never been busy: it isn't working
                _ => false,
            };
        }
        let Some(message) = &self.last_message else { return false };
        let role = self.last_role.as_deref().or_else(|| message.get("role").and_then(Value::as_str));
        match role {
            Some("user") => true,
            Some("assistant") => message.pointer("/time/completed").is_none_or(Value::is_null),
            _ => false,
        }
    }

    /// The error the latest reply ended on (a provider's rate limit, say), unless the person
    /// stopped it themselves.
    fn error(&self) -> Option<String> {
        let message = self.last_message.as_ref()?;
        let role = self.last_role.as_deref().or_else(|| message.get("role").and_then(Value::as_str));
        if role != Some("assistant") {
            return None;
        }
        message_error(message)
    }
}

/// The error a reply ended on (a provider's rate limit, say), unless the person stopped it
/// themselves.
fn message_error(message: &Value) -> Option<String> {
    let error = message.get("error").filter(|error| !error.is_null())?;
    let name = error.get("name").and_then(Value::as_str);
    if name == Some("MessageAbortedError") {
        return None;
    }
    let text = error.pointer("/data/message").and_then(Value::as_str).or(name).unwrap_or("Failed");
    Some(tidy(text, SUMMARY_MAX_CHARS))
}

/// Whether the database has a table, so the current schema can be told from the older one.
fn has_table(conn: &Connection, name: &str) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", params![name], |_| Ok(()))
        .is_ok()
}

/// The model a session runs on, from the session row's JSON (`{"id":..., "providerID":...}`).
fn session_model(model: &str) -> Option<String> {
    let model: Value = serde_json::from_str(model).ok()?;
    model.get("id").and_then(Value::as_str).map(str::to_owned)
}

/// The latest reply's text, tidied. In the current schema the text is in the message's content
/// array; in the older one it's in a `part` row.
fn last_reply_text(conn: &Connection, session_id: &str, v2: bool) -> Option<String> {
    let text: String = if v2 {
        let mut statement = conn
            .prepare(
                "SELECT data FROM session_message WHERE session_id = ?1 AND type = 'assistant'
                 ORDER BY time_created DESC, id DESC LIMIT 1",
            )
            .ok()?;
        let data: String = statement.query_row(params![session_id], |row| row.get(0)).ok()?;
        let message: Value = serde_json::from_str(&data).ok()?;
        message
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    } else {
        let mut statement = conn
            .prepare(
                "SELECT json_extract(p.data, '$.text') FROM part p JOIN message m ON m.id = p.message_id
                 WHERE p.session_id = ?1 AND json_extract(m.data, '$.role') = 'assistant' AND json_extract(p.data, '$.type') = 'text'
                   AND trim(coalesce(json_extract(p.data, '$.text'), '')) <> ''
                 ORDER BY p.time_created DESC, p.id DESC LIMIT 1",
            )
            .ok()?;
        statement.query_row(params![session_id], |row| row.get(0)).ok()?
    };
    (!text.trim().is_empty()).then(|| tidy(&text, SUMMARY_MAX_CHARS))
}

/// The question OpenCode's question tool is waiting on the person to answer in a session, if any.
fn open_question(conn: &Connection, session_id: &str, v2: bool) -> Option<String> {
    let input: String = if v2 {
        let mut statement = conn
            .prepare(
                "SELECT data FROM session_message WHERE session_id = ?1 AND type = 'assistant'
                 ORDER BY time_created DESC, id DESC",
            )
            .ok()?;
        let mut found = None;
        let rows = statement.query_map(params![session_id], |row| row.get::<_, String>(0)).ok()?;
        for data in rows.flatten() {
            let Ok(message) = serde_json::from_str::<Value>(&data) else { continue };
            for block in message.get("content").and_then(Value::as_array).into_iter().flatten() {
                let Some(state) = block.get("state") else { continue };
                let status = state.get("status").and_then(Value::as_str);
                if !matches!(status, Some("pending") | Some("running")) {
                    continue;
                }
                let is_question = block.get("name").and_then(Value::as_str) == Some("question")
                    || block.get("tool").and_then(Value::as_str) == Some("question");
                if is_question {
                    if let Some(input) = state.get("input") {
                        found = Some(input.clone());
                        break;
                    }
                }
            }
            if found.is_some() {
                break;
            }
        }
        found?.to_string()
    } else {
        let mut statement = conn
            .prepare(
                "SELECT json_extract(p.data, '$.state.input') FROM part p
                 WHERE p.session_id = ?1 AND json_extract(p.data, '$.type') = 'tool' AND json_extract(p.data, '$.tool') = 'question'
                   AND json_extract(p.data, '$.state.status') IN ('pending', 'running')
                 ORDER BY p.time_created DESC, p.id DESC LIMIT 1",
            )
            .ok()?;
        statement.query_row(params![session_id], |row| row.get(0)).ok()?
    };
    let input: Value = serde_json::from_str(&input).ok()?;
    Some(question_text(Some(&input)).unwrap_or_else(|| "Asked you a question".to_owned()))
}

/// A part as the event OpenCode's `run --format json` prints for it.
fn part_event(part: &Value) -> Option<Value> {
    match part.get("type")?.as_str()? {
        "text" => Some(json!({ "type": "text", "part": { "text": part.get("text")? } })),
        "tool" => Some(json!({ "type": "tool_use", "part": { "tool": part.get("tool")?, "state": part.get("state").cloned().unwrap_or(Value::Null) } })),
        _ => None,
    }
}

/// OpenCode titles a session "New session - <date>" until it has named it.
fn session_title(title: &str) -> Option<String> {
    let title = title.trim();
    (!title.is_empty() && !title.starts_with("New session")).then(|| title.to_owned())
}

/// Whether any OpenCode process is running; without one, no reply is in progress.
fn opencode_running() -> bool {
    Command::new("/usr/bin/pgrep").args(["-x", "opencode"]).output().is_ok_and(|output| output.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> (PathBuf, OpenCode) {
        let path = std::env::temp_dir().join(format!("officesim-opencode-{name}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
                                   time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);",
        )
        .unwrap();
        let now = now_millis();
        conn.execute("INSERT INTO session VALUES ('ses_a', NULL, '/Users/me/code/my-app', 'Fix the tests', ?1, ?2, NULL)", params![now - 60_000, now - 1_000]).unwrap();
        conn.execute("INSERT INTO session VALUES ('ses_child', 'ses_a', '/Users/me/code/my-app', 'Subtask', ?1, ?1, NULL)", params![now]).unwrap();
        conn.execute("INSERT INTO session VALUES ('ses_old', NULL, '/Users/me/code/my-app', 'Old', 0, 0, NULL)", []).unwrap();
        conn.execute("INSERT INTO message VALUES ('msg_1', 'ses_a', ?1, '{\"role\":\"user\"}')", params![now - 60_000]).unwrap();
        conn.execute(
            "INSERT INTO message VALUES ('msg_2', 'ses_a', ?1, ?2)",
            params![now - 50_000, json!({ "role": "assistant", "time": { "created": now - 50_000, "completed": now - 20_000 }, "tokens": { "input": 10, "output": 20, "reasoning": 5, "cache": { "read": 100, "write": 1 } } }).to_string()],
        )
        .unwrap();
        conn.execute("INSERT INTO part VALUES ('prt_1', 'msg_2', 'ses_a', ?1, '{\"type\":\"tool\",\"tool\":\"bash\",\"state\":{\"input\":{\"command\":\"npm test\"}}}')", params![now - 40_000]).unwrap();
        conn.execute("INSERT INTO part VALUES ('prt_2', 'msg_2', 'ses_a', ?1, '{\"type\":\"text\",\"text\":\"All **green** now.\"}')", params![now - 30_000]).unwrap();
        drop(conn);
        (path.clone(), OpenCode::at(path))
    }

    #[test]
    fn reads_sessions_usage_and_log() {
        let (path, source) = fixture("agents");
        let agents = source.agents();
        assert_eq!(agents.len(), 1, "{agents:?}");
        let agent = &agents[0];
        assert_eq!(agent.name, "My App");
        assert_eq!(agent.status, "idle");
        let run = agent.last_run.as_ref().unwrap();
        assert_eq!(run.summary.as_deref(), Some("All green now."));
        assert_eq!(run.issue_title.as_deref(), Some("Fix the tests"));

        let usage = source.usage(agent, 0);
        assert_eq!(usage, Usage { runs: 1, active_seconds: 30, input_tokens: 11, cached_input_tokens: 100, output_tokens: 25, ..Usage::default() });

        let log = source.read_log("opencode:ses_a", 0, 1000).unwrap();
        assert!(log.contains(r#"\"type\":\"tool_use\""#), "{log}");
        assert!(log.lines().last().unwrap().contains("All **green** now."), "{log}");
        assert_eq!(source.read_log("claude:ses_a", 0, 1000), None);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn finds_open_questions() {
        let (path, _) = fixture("questions");
        let conn = Connection::open(&path).unwrap();
        assert_eq!(open_question(&conn, "ses_a", false), None);
        conn.execute(
            "INSERT INTO part VALUES ('prt_3', 'msg_2', 'ses_a', 1, ?1)",
            params![json!({ "type": "tool", "tool": "question", "state": { "status": "running", "input": { "questions": [{ "question": "Which week?" }] } } }).to_string()],
        )
        .unwrap();
        assert_eq!(open_question(&conn, "ses_a", false).as_deref(), Some("Which week?"));
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn failed_replies_are_errors() {
        let (path, source) = fixture("errors");
        let conn = Connection::open(&path).unwrap();
        let now = now_millis();
        let reply = |error: Value| json!({ "role": "assistant", "time": { "created": now - 10_000, "completed": now - 5_000 }, "error": error }).to_string();
        conn.execute("INSERT INTO message VALUES ('msg_3', 'ses_a', ?1, ?2)", params![now - 10_000, reply(json!({ "name": "MessageAbortedError", "data": {} }))]).unwrap();
        assert_eq!(source.agents()[0].status, "idle");

        conn.execute(
            "UPDATE message SET data = ?1 WHERE id = 'msg_3'",
            params![reply(json!({ "name": "APIError", "data": { "message": "Usage limit reached", "statusCode": 429 } }))],
        )
        .unwrap();
        let agent = &source.agents()[0];
        assert_eq!(agent.status, "error");
        let run = agent.last_run.as_ref().unwrap();
        assert_eq!(run.status, "failed");
        assert_eq!(run.error.as_deref(), Some("Usage limit reached"));
        assert_eq!(run.summary.as_deref(), Some("Usage limit reached"));
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn titles_skip_placeholders() {
        assert_eq!(session_title("New session - 2026-10-01T10:00:00.000Z"), None);
        assert_eq!(session_title("Fix the tests").as_deref(), Some("Fix the tests"));
    }

    /// The current schema: sessions in `session_v2`, their messages in `session_message`.
    fn v2_fixture(name: &str) -> (PathBuf, OpenCode) {
        let path = std::env::temp_dir().join(format!("officesim-opencode-v2-{name}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL,
                                       model TEXT, parent_id TEXT, time_created INTEGER NOT NULL,
                                       time_updated INTEGER NOT NULL, time_archived INTEGER,
                                       time_busy INTEGER, time_idle INTEGER);
             CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
                                           seq INTEGER, time_created INTEGER NOT NULL, data TEXT NOT NULL);",
        )
        .unwrap();
        let now = now_millis();
        let model = json!({ "id": "MiniMax-M3", "providerID": "minimax-coding-plan" }).to_string();
        conn.execute(
            "INSERT INTO session_v2 VALUES ('ses_v2', '/Users/me/code/my-app', 'Fix the tests', ?1, NULL, ?2, ?3, NULL, NULL, NULL)",
            params![model, now - 60_000, now - 1_000],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_v2 VALUES ('ses_v2_child', '/Users/me/code/my-app', 'Subtask', NULL, 'ses_v2', ?1, ?1, NULL, NULL, NULL)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_v2 VALUES ('ses_v2_old', '/Users/me/code/my-app', 'Old', NULL, NULL, 0, 0, NULL, NULL, NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_message VALUES ('msg_v1', 'ses_v2', 'user', 1, ?1, ?2)",
            params![now - 60_000, json!({ "time": { "created": now - 60_000 }, "text": "Fix the tests" }).to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_message VALUES ('msg_v2', 'ses_v2', 'assistant', 2, ?1, ?2)",
            params![
                now - 50_000,
                json!({
                    "time": { "created": now - 50_000, "completed": now - 20_000 },
                    "model": { "id": "MiniMax-M3", "providerID": "minimax-coding-plan" },
                    "tokens": { "input": 10, "output": 20, "reasoning": 5, "cache": { "read": 100, "write": 1 } },
                    "content": [
                        { "type": "tool", "name": "shell", "state": { "status": "completed", "input": { "command": "npm test" } } },
                        { "type": "text", "text": "All **green** now." }
                    ]
                })
                .to_string()
            ],
        )
        .unwrap();
        drop(conn);
        (path.clone(), OpenCode::at(path))
    }

    #[test]
    fn reads_the_current_schema() {
        let (path, source) = v2_fixture("agents");
        let agents = source.agents();
        assert_eq!(agents.len(), 1, "{agents:?}");
        let agent = &agents[0];
        assert_eq!(agent.name, "My App");
        assert_eq!(agent.status, "idle");
        assert_eq!(agent.model.as_deref(), Some("MiniMax-M3"));
        assert_eq!(agent.session_ref.as_deref(), Some("ses_v2"));
        let run = agent.last_run.as_ref().unwrap();
        assert_eq!(run.summary.as_deref(), Some("All green now."));
        assert_eq!(run.issue_title.as_deref(), Some("Fix the tests"));

        let usage = source.usage(agent, 0);
        assert_eq!(usage, Usage { runs: 1, active_seconds: 30, input_tokens: 11, cached_input_tokens: 100, output_tokens: 25, ..Usage::default() });

        let log = source.read_log("opencode:ses_v2", 0, 1000).unwrap();
        assert!(log.contains(r#"\"type\":\"tool_use\""#), "{log}");
        assert!(log.lines().last().unwrap().contains("All **green** now."), "{log}");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn finds_open_questions_in_the_current_schema() {
        let (path, _) = v2_fixture("questions");
        let conn = Connection::open(&path).unwrap();
        assert_eq!(open_question(&conn, "ses_v2", true), None);
        let now = now_millis();
        conn.execute(
            "INSERT INTO session_message VALUES ('msg_v3', 'ses_v2', 'assistant', 3, ?1, ?2)",
            params![
                now - 10_000,
                json!({
                    "time": { "created": now - 10_000 },
                    "content": [
                        { "type": "tool", "name": "question", "state": { "status": "running", "input": { "questions": [{ "question": "Which week?" }] } } }
                    ]
                })
                .to_string()
            ],
        )
        .unwrap();
        assert_eq!(open_question(&conn, "ses_v2", true).as_deref(), Some("Which week?"));
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn failed_replies_are_errors_in_the_current_schema() {
        let (path, source) = v2_fixture("errors");
        let conn = Connection::open(&path).unwrap();
        let now = now_millis();
        let reply = |error: Value| {
            json!({
                "time": { "created": now - 10_000, "completed": now - 5_000 },
                "error": error,
                "content": []
            })
            .to_string()
        };
        conn.execute(
            "INSERT INTO session_message VALUES ('msg_v4', 'ses_v2', 'assistant', 4, ?1, ?2)",
            params![now - 10_000, reply(json!({ "name": "MessageAbortedError", "data": {} }))],
        )
        .unwrap();
        assert_eq!(source.agents()[0].status, "idle");

        conn.execute(
            "UPDATE session_message SET data = ?1 WHERE id = 'msg_v4'",
            params![reply(json!({ "name": "APIError", "data": { "message": "Usage limit reached", "statusCode": 429 } }))],
        )
        .unwrap();
        let agent = &source.agents()[0];
        assert_eq!(agent.status, "error");
        let run = agent.last_run.as_ref().unwrap();
        assert_eq!(run.status, "failed");
        assert_eq!(run.error.as_deref(), Some("Usage limit reached"));
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

    /// OpenCode writes a message per tool call, so the newest message is "not finished" and then
    /// "finished" several times a minute while the agent works steadily. The office should show
    /// it working the whole time, which is what OpenCode's own busy/idle times say.
    #[test]
    fn a_working_session_stays_working_between_tool_calls() {
        let (path, source) = v2_fixture("busy");
        let conn = Connection::open(&path).unwrap();
        let now = now_millis();
        // The session turned busy and hasn't gone idle since
        conn.execute(
            "UPDATE session_v2 SET time_busy = ?1, time_idle = ?2 WHERE id = 'ses_v2'",
            params![now - 5_000, now - 60_000],
        )
        .unwrap();
        // A stream of tool calls, each its own message, each finished except the last
        for step in 0..20i64 {
            let created = now - 40_000 + step * 1000;
            let completed = if step == 19 { Value::Null } else { json!(created + 100) };
            conn.execute(
                "INSERT INTO session_message VALUES (?1, 'ses_v2', 'assistant', ?2, ?3, ?4)",
                params![
                    format!("msg_busy_{step}"),
                    step + 10,
                    created,
                    json!({ "time": { "created": created, "completed": completed }, "content": [] }).to_string()
                ],
            )
            .unwrap();
        }
        drop(conn);
        let agents = source.agents();
        assert_eq!(agents.len(), 1, "{agents:?}");
        // The newest message has no completion time, but the session says it's busy, so it reads
        // as working (when OpenCode is running on this Mac, which it is).
        assert_eq!(agents[0].status, "running", "{agents:?}");

        // With OpenCode running, the busy time is what counts
        let busy = SessionRow {
            id: "ses_v2".to_owned(),
            directory: "/Users/me/code/my-app".to_owned(),
            title: "Fix the tests".to_owned(),
            created: now - 60_000,
            updated: now,
            last_message: None,
            last_role: Some("assistant".to_owned()),
            model: None,
            busy_at: Some(now - 5_000),
            idle_at: Some(now - 60_000),
            v2: true,
        };
        assert!(busy.replying(), "busy since it went idle: it's working");

        // And when it goes idle, it stops
        let idle = SessionRow { busy_at: Some(now - 60_000), idle_at: Some(now - 5_000), ..busy.clone() };
        assert!(!idle.replying(), "idle since it was busy: it isn't working");

        // Never busy at all
        let never = SessionRow { busy_at: None, idle_at: Some(now - 5_000), ..busy };
        assert!(!never.replying());
        std::fs::remove_file(path).unwrap();
    }
}
