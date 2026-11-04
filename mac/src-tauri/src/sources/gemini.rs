//! Gemini CLI sessions, from `~/.gemini/tmp/<project>/chats/session-*.json`: one JSON file per
//! session, rewritten as it goes, with its messages (`user` and `gemini`, the replies carrying
//! token counts and tool calls). The project folder is in `~/.gemini/tmp/<project>/.project_root`.
//!
//! Sessions written within the last hour are agents. One is working while a Gemini CLI process runs
//! and the session was written to moments ago, or is waiting on its reply.

use super::naming::{number_namesakes, project_name, tidy};
use super::Source;
use crate::model::{ActivityKind, Agent, LastRun, Usage};
use crate::time::{iso_from_millis, iso_from_system_time, millis_from_iso};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

pub const ID: &str = "gemini";
const RUN_PREFIX: &str = "gemini:";
/// An agent's name when its project isn't known.
const HARNESS_NAME: &str = "Gemini";
/// Sessions stay in the office this long after they were last written.
const RECENT: Duration = Duration::from_secs(60 * 60);
/// Written this recently, a session is mid-reply.
const JUST_WRITTEN: Duration = Duration::from_secs(30);
/// Waiting on a reply this long, a session was abandoned.
const STALE: Duration = Duration::from_secs(10 * 60);
const SUMMARY_MAX_CHARS: usize = 320;
const TITLE_MAX_CHARS: usize = 80;
/// Replies sent for the live speech bubble.
const LOG_MESSAGES: usize = 20;

pub struct GeminiCli {
    root: PathBuf,
}

impl GeminiCli {
    pub fn new() -> Self {
        Self { root: super::home().join(".gemini") }
    }

    #[cfg(test)]
    fn at(root: PathBuf) -> Self {
        Self { root }
    }

    fn tmp(&self) -> PathBuf {
        self.root.join("tmp")
    }

    /// Session files written within RECENT, with when they were written.
    fn recent_chats(&self) -> Vec<(PathBuf, SystemTime)> {
        let cutoff = SystemTime::now() - RECENT;
        let Ok(projects) = fs::read_dir(self.tmp()) else { return Vec::new() };
        projects
            .flatten()
            .filter_map(|project| fs::read_dir(project.path().join("chats")).ok())
            .flat_map(|chats| chats.flatten())
            .filter_map(|chat| {
                let path = chat.path();
                let name = path.file_name()?.to_str()?;
                if !name.starts_with("session-") || !name.ends_with(".json") {
                    return None;
                }
                let modified = chat.metadata().ok()?.modified().ok()?;
                (modified >= cutoff).then_some((path, modified))
            })
            .collect()
    }

    /// A session's file, by its session id.
    fn chat_for_run(&self, run_id: &str) -> Option<PathBuf> {
        let session_id = run_id.strip_prefix(RUN_PREFIX)?;
        // Session files are named after the start of the session id
        let short = session_id.split('-').next()?;
        if short.is_empty() || !short.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let projects = fs::read_dir(self.tmp()).ok()?;
        projects
            .flatten()
            .filter_map(|project| fs::read_dir(project.path().join("chats")).ok())
            .flat_map(|chats| chats.flatten())
            .map(|chat| chat.path())
            .filter(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.ends_with(&format!("-{short}.json"))))
            .find(|path| read_chat(path).is_some_and(|chat| chat.session_id == session_id))
    }
}

impl Source for GeminiCli {
    fn process_pattern(&self) -> Option<&'static str> {
        Some("bin/gemini( |$)")
    }

    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Gemini CLI"
    }

    fn location(&self) -> String {
        self.tmp().display().to_string()
    }

    fn detect(&self) -> bool {
        self.tmp().is_dir()
    }

    fn agents(&self) -> Vec<Agent> {
        let running = gemini_running();
        let mut agents: Vec<Agent> = self
            .recent_chats()
            .into_iter()
            .filter_map(|(path, modified)| {
                let chat = read_chat(&path)?;
                let age = modified.elapsed().unwrap_or_default();
                let waiting_on_reply = chat.messages.last().is_some_and(|message| message.kind == "user");
                let working = running && (age <= JUST_WRITTEN || (waiting_on_reply && age <= STALE));
                let cwd = fs::read_to_string(path.parent()?.parent()?.join(".project_root")).ok();
                let created = chat.started;
                Some(Agent {
                    id: format!("gemini:{}", chat.session_id),
                    name: project_name(HARNESS_NAME, cwd.as_deref().map(str::trim)),
                    status: if working { "running" } else { "idle" }.into(),
                    activity_kind: if working { ActivityKind::Coding } else { ActivityKind::Idle },
                    last_run: Some(LastRun {
                        run_id: format!("{RUN_PREFIX}{}", chat.session_id),
                        status: if working { "running" } else { "succeeded" }.into(),
                        active: working,
                        started_at: created.map(iso_from_millis),
                        finished_at: (!working).then(|| iso_from_system_time(modified)),
                        last_output_at: Some(iso_from_system_time(modified)),
                        summary: if working { None } else { chat.last_reply().map(|text| tidy(&text, SUMMARY_MAX_CHARS)) },
                        issue_title: chat.first_prompt().map(|text| tidy(text.lines().find(|line| !line.trim().is_empty()).unwrap_or(""), TITLE_MAX_CHARS)),
                        ..LastRun::default()
                    }),
                    source: ID,
                    model: chat.model(),
                    session_ref: Some(chat.session_id),
                    created_ms: created,
                    cwd: cwd.as_deref().map(|cwd| cwd.trim().to_owned()),
                    ..Agent::default()
                })
            })
            .collect();
        number_namesakes(&mut agents);
        agents
    }

    fn watch_paths(&self) -> Vec<PathBuf> {
        vec![self.tmp()]
    }

    fn read_log(&self, run_id: &str, offset: u64, _limit: u64) -> Option<String> {
        let chat = read_chat(&self.chat_for_run(run_id)?)?;
        // Made up from the latest replies, so it's all one chunk
        if offset > 0 {
            return Some(String::new());
        }
        let events: Vec<String> = chat
            .messages
            .iter()
            .filter(|message| message.kind == "gemini")
            .rev()
            .take(LOG_MESSAGES)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|message| message.as_claude_event().to_string())
            .collect();
        Some(super::as_run_log(events.iter().map(String::as_str)))
    }

    fn usage(&self, agent: &Agent, since: i64) -> Usage {
        let Some(run) = &agent.last_run else { return Usage::default() };
        let Some(chat) = self.chat_for_run(&run.run_id).and_then(|path| read_chat(&path)) else { return Usage::default() };
        chat.usage_since(since)
    }

}

struct Chat {
    session_id: String,
    /// When the session started, in milliseconds since the epoch.
    started: Option<i64>,
    messages: Vec<Message>,
}

impl Chat {
    /// The model of the latest reply.
    fn model(&self) -> Option<String> {
        self.messages.iter().rev().find_map(|message| message.model.clone())
    }
}

struct Message {
    kind: String,
    at: Option<i64>,
    text: String,
    tool_calls: Vec<(String, Value)>,
    tokens: Value,
    /// The model of a reply.
    model: Option<String>,
}

fn read_chat(path: &Path) -> Option<Chat> {
    let chat: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let messages = chat.get("messages")?.as_array()?.iter().map(Message::from_json).collect();
    Some(Chat {
        session_id: chat.get("sessionId")?.as_str()?.to_owned(),
        started: chat.get("startTime").and_then(Value::as_str).and_then(millis_from_iso),
        messages,
    })
}

impl Message {
    fn from_json(message: &Value) -> Message {
        let tool_calls = message
            .get("toolCalls")
            .and_then(Value::as_array)
            .map(|calls| {
                calls
                    .iter()
                    .filter_map(|call| Some((call.get("name")?.as_str()?.to_owned(), call.get("args").cloned().unwrap_or(Value::Null))))
                    .collect()
            })
            .unwrap_or_default();
        Message {
            kind: message.get("type").and_then(Value::as_str).unwrap_or_default().to_owned(),
            at: message.get("timestamp").and_then(Value::as_str).and_then(millis_from_iso),
            text: content_text(message.get("content")),
            tool_calls,
            tokens: message.get("tokens").cloned().unwrap_or(Value::Null),
            model: message.get("model").and_then(Value::as_str).filter(|model| !model.is_empty()).map(str::to_owned),
        }
    }

    /// The reply as a Claude assistant event (text and tool_use blocks), which the UI's
    /// runOutput.ts already understands.
    fn as_claude_event(&self) -> Value {
        let mut content = Vec::new();
        if !self.text.trim().is_empty() {
            content.push(json!({ "type": "text", "text": self.text }));
        }
        for (name, args) in &self.tool_calls {
            content.push(json!({ "type": "tool_use", "name": name, "input": args }));
        }
        json!({ "type": "assistant", "message": { "content": content } })
    }
}

impl Chat {
    fn last_reply(&self) -> Option<String> {
        self.messages.iter().rev().find(|message| message.kind == "gemini" && !message.text.trim().is_empty()).map(|message| message.text.clone())
    }

    fn first_prompt(&self) -> Option<&str> {
        self.messages.iter().find(|message| message.kind == "user").map(|message| message.text.as_str())
    }

    /// Tokens from each reply, runs as prompts, and active time as each reply's wait after the
    /// message before it.
    fn usage_since(&self, since: i64) -> Usage {
        let mut usage = Usage::default();
        let mut previous: Option<i64> = None;
        for message in &self.messages {
            let at = message.at.unwrap_or(0);
            if at >= since {
                let count = |key: &str| message.tokens.get(key).and_then(Value::as_u64).unwrap_or(0);
                match message.kind.as_str() {
                    "user" => usage.runs += 1,
                    "gemini" => {
                        if let Some(previous) = previous {
                            usage.active_seconds += ((at - previous).max(0) / 1000) as u64;
                        }
                        usage.input_tokens += count("input").saturating_sub(count("cached"));
                        usage.cached_input_tokens += count("cached");
                        usage.output_tokens += count("output") + count("thoughts");
                    }
                    _ => {}
                }
            }
            previous = message.at;
        }
        usage
    }
}

/// A message's text: a string, or a list of `{text}` parts.
fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts.iter().filter_map(|part| part.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// Whether a Gemini CLI process is running; without one, nothing is mid-reply.
fn gemini_running() -> bool {
    Command::new("/usr/bin/pgrep").args(["-f", "bin/gemini( |$)"]).output().is_ok_and(|output| output.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_chats_usage_and_log() {
        let root = std::env::temp_dir().join(format!("officesim-gemini-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let project = root.join("tmp/my-app");
        fs::create_dir_all(project.join("chats")).unwrap();
        fs::write(project.join(".project_root"), "/Users/me/code/my-app").unwrap();
        let chat = json!({
            "sessionId": "5f3bc3e5-fd47-4818-b79f-4ab1adf17548",
            "startTime": "2026-10-01T10:00:00.000Z",
            "messages": [
                { "type": "user", "timestamp": "2026-10-01T10:00:00.000Z", "content": [{ "text": "Write the docs\nfor the app" }] },
                { "type": "gemini", "timestamp": "2026-10-01T10:00:20.000Z", "content": "Reading the code first.",
                  "toolCalls": [{ "name": "read_file", "args": { "file_path": "/a/src/main.rs" } }],
                  "tokens": { "input": 120, "output": 30, "cached": 100, "thoughts": 5 } },
                { "type": "gemini", "timestamp": "2026-10-01T10:00:50.000Z", "content": "The **docs** are written.",
                  "tokens": { "input": 200, "output": 40, "cached": 150, "thoughts": 0 } },
            ],
        });
        fs::write(project.join("chats/session-2026-10-01T10-00-5f3bc3e5.json"), chat.to_string()).unwrap();

        let source = GeminiCli::at(root.clone());
        let agents = source.agents();
        assert_eq!(agents.len(), 1);
        let agent = &agents[0];
        assert_eq!(agent.name, "My App");
        let run = agent.last_run.as_ref().unwrap();
        assert_eq!(run.issue_title.as_deref(), Some("Write the docs"));
        assert_eq!(run.started_at.as_deref(), Some("2026-10-01T10:00:00.000Z"));

        let usage = source.usage(agent, 0);
        assert_eq!(usage, Usage { runs: 1, active_seconds: 50, input_tokens: 70, cached_input_tokens: 250, output_tokens: 75, ..Usage::default() });

        let log = source.read_log(&run.run_id, 0, 1000).unwrap();
        assert!(log.contains(r#"\"name\":\"read_file\""#), "{log}");
        assert_eq!(log.lines().count(), 2);
        assert_eq!(source.read_log("gemini:../../x", 0, 1000), None);
        fs::remove_dir_all(&root).unwrap();
    }
}
