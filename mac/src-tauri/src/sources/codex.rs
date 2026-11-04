//! Codex CLI sessions, from its rollout files: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`
//! (or under `$CODEX_HOME`). Each line is `{timestamp, type, payload}`: `session_meta` (id, cwd),
//! `response_item` (messages and tool calls), `event_msg` (user and agent messages, turn
//! started/complete/aborted, token counts) and `turn_context`. Field names are from Codex's
//! protocol (codex-rs/protocol/src/protocol.rs, codex-rs/history/src/rollout_payload.rs).
//!
//! Sessions written within the last hour are agents. One is working while its latest turn has
//! started but not completed and a Codex process is running. Approval prompts aren't saved to the
//! rollout, so the only wait OfficeSim sees is an unanswered `request_user_input` call.

use super::naming::{number_namesakes, project_name, question_text, tidy};
use super::Source;
use crate::model::{ActivityKind, Agent, LastRun, Usage};
use crate::time::{iso_from_millis, iso_from_system_time, millis_from_iso, now_millis};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

pub const ID: &str = "codex";
const RUN_PREFIX: &str = "codex:";
const HARNESS_NAME: &str = "Codex";
/// Sessions stay in the office this long after they were last written.
const RECENT: Duration = Duration::from_secs(60 * 60);
/// A turn that started but hasn't been written to for this long was abandoned.
const STALE_MILLIS: i64 = 10 * 60 * 1000;
/// Rollouts are looked for in this many days' folders (for the Agents tab's 30 days).
const DAYS_KEPT: i64 = 31;
const SUMMARY_MAX_CHARS: usize = 320;
const TITLE_MAX_CHARS: usize = 80;
/// Messages and tool calls sent for the live speech bubble.
const LOG_EVENTS: usize = 40;

pub struct Codex {
    root: PathBuf,
}

impl Codex {
    pub fn new() -> Self {
        let root = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| super::home().join(".codex"));
        Self { root }
    }

    #[cfg(test)]
    fn at(root: PathBuf) -> Self {
        Self { root }
    }

    fn sessions_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }

    /// Rollout files in the date folders of the last `days` days.
    fn rollouts(&self, days: i64) -> Vec<PathBuf> {
        let oldest = crate::time::iso_from_millis(now_millis() - days * 86_400_000);
        // "2026-10-01" as "2026/10/01", to compare with the folders' paths
        let oldest = oldest[..10].replace('-', "/");
        let mut files = Vec::new();
        for year in read_dir_sorted(&self.sessions_dir()) {
            for month in read_dir_sorted(&year) {
                for day in read_dir_sorted(&month) {
                    let relative = day.strip_prefix(self.sessions_dir()).map(|path| path.to_string_lossy().into_owned()).unwrap_or_default();
                    if relative < oldest {
                        continue;
                    }
                    files.extend(read_dir_sorted(&day).into_iter().filter(|file| is_rollout(file)));
                }
            }
        }
        files
    }

    fn rollout_for_run(&self, run_id: &str) -> Option<PathBuf> {
        let id = run_id.strip_prefix(RUN_PREFIX)?;
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return None;
        }
        let suffix = format!("-{id}.jsonl");
        self.rollouts(DAYS_KEPT).into_iter().rev().find(|file| file.to_string_lossy().ends_with(&suffix))
    }
}

impl Source for Codex {
    fn process_pattern(&self) -> Option<&'static str> {
        Some("(^|/)codex( |$)")
    }

    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Codex"
    }

    fn location(&self) -> String {
        self.sessions_dir().display().to_string()
    }

    fn detect(&self) -> bool {
        self.root.is_dir()
    }

    fn agents(&self) -> Vec<Agent> {
        let cutoff = SystemTime::now() - RECENT;
        let running = super::process_running(&["-x", "codex"]);
        let now = now_millis();
        let mut agents: Vec<Agent> = self
            .rollouts(2)
            .into_iter()
            .filter_map(|path| {
                let modified = fs::metadata(&path).ok()?.modified().ok()?;
                if modified < cutoff {
                    return None;
                }
                let rollout = parsed(&path)?;
                let id = rollout.id.clone()?;
                let last_write = modified.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |age| age.as_millis() as i64);
                let working = running && rollout.turn_open && now - last_write <= STALE_MILLIS;
                let waiting_on = if running { rollout.open_question() } else { None };
                Some(Agent {
                    id: format!("codex:{id}"),
                    name: project_name(HARNESS_NAME, rollout.cwd.as_deref()),
                    status: if working { "running" } else { "idle" }.into(),
                    activity_kind: if working { ActivityKind::Coding } else { ActivityKind::Idle },
                    last_run: Some(LastRun {
                        run_id: format!("{RUN_PREFIX}{id}"),
                        status: if working { "running" } else { "succeeded" }.into(),
                        active: working,
                        started_at: rollout.started.map(iso_from_millis),
                        finished_at: (!working).then(|| iso_from_system_time(modified)),
                        last_output_at: Some(iso_from_system_time(modified)),
                        summary: if working { None } else { rollout.last_agent_message().map(|text| tidy(&text, SUMMARY_MAX_CHARS)) },
                        issue_title: rollout.first_prompt().map(|text| tidy(text.lines().find(|line| !line.trim().is_empty()).unwrap_or(""), TITLE_MAX_CHARS)),
                        ..LastRun::default()
                    }),
                    source: ID,
                    waiting_on,
                    session_ref: Some(id),
                    created_ms: rollout.started,
                    cwd: rollout.cwd.clone(),
                    ..Agent::default()
                })
            })
            .collect();
        number_namesakes(&mut agents);
        agents
    }

    fn watch_paths(&self) -> Vec<PathBuf> {
        vec![self.sessions_dir()]
    }

    fn read_log(&self, run_id: &str, offset: u64, _limit: u64) -> Option<String> {
        let rollout = parsed(&self.rollout_for_run(run_id)?)?;
        // Made up from the latest events, so it's all one chunk
        if offset > 0 {
            return Some(String::new());
        }
        let events: Vec<String> = rollout.log_events(LOG_EVENTS).iter().map(Value::to_string).collect();
        Some(super::as_run_log(events.iter().map(String::as_str)))
    }

    fn usage(&self, agent: &Agent, since: i64) -> Usage {
        let Some(run) = &agent.last_run else { return Usage::default() };
        self.rollout_for_run(&run.run_id).and_then(|path| parsed(&path)).map(|rollout| rollout.usage_since(since)).unwrap_or_default()
    }
}

fn read_dir_sorted(dir: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir).map(|entries| entries.flatten().map(|entry| entry.path()).collect()).unwrap_or_default();
    entries.sort();
    entries
}

fn is_rollout(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
}

/// What a rollout says, read line by line as it grows.
#[derive(Default, Clone)]
struct Rollout {
    /// Bytes read so far, always at a line end.
    offset: u64,
    id: Option<String>,
    cwd: Option<String>,
    started: Option<i64>,
    /// A turn has started and not completed or been aborted.
    turn_open: bool,
    events: Vec<Event>,
}

#[derive(Clone, Debug)]
enum Event {
    TurnStarted(i64),
    TurnEnded(i64),
    UserMessage(i64, String),
    AgentMessage(String),
    ToolCall { name: String, input: Value, call_id: String },
    ToolOutput(String),
    Tokens { at: i64, input: u64, cached: u64, output: u64 },
}

impl Rollout {
    fn read_line(&mut self, line: &[u8]) {
        let Ok(line) = serde_json::from_slice::<Value>(line) else { return };
        let at = line.get("timestamp").and_then(Value::as_str).and_then(millis_from_iso).unwrap_or(0);
        let Some(payload) = line.get("payload") else { return };
        let kind = payload.get("type").and_then(Value::as_str).unwrap_or_default();
        match line.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                self.id = payload.get("id").and_then(Value::as_str).map(str::to_owned).or(self.id.take());
                self.cwd = payload.get("cwd").and_then(Value::as_str).map(str::to_owned).or(self.cwd.take());
                self.started = payload.get("timestamp").and_then(Value::as_str).and_then(millis_from_iso).or(self.started);
            }
            Some("turn_context") => {
                if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                    self.cwd = Some(cwd.to_owned());
                }
            }
            Some("event_msg") => match kind {
                "turn_started" | "task_started" => {
                    self.turn_open = true;
                    self.events.push(Event::TurnStarted(at));
                }
                "turn_complete" | "task_complete" | "turn_aborted" => {
                    self.turn_open = false;
                    self.events.push(Event::TurnEnded(at));
                }
                "user_message" => {
                    if let Some(message) = payload.get("message").and_then(Value::as_str) {
                        self.events.push(Event::UserMessage(at, message.to_owned()));
                    }
                }
                "agent_message" => {
                    if let Some(message) = payload.get("message").and_then(Value::as_str) {
                        self.events.push(Event::AgentMessage(message.to_owned()));
                    }
                }
                "token_count" => {
                    if let Some(last) = payload.pointer("/info/last_token_usage") {
                        let count = |key: &str| last.get(key).and_then(Value::as_u64).unwrap_or(0);
                        let cached = count("cached_input_tokens");
                        self.events.push(Event::Tokens { at, input: count("input_tokens").saturating_sub(cached), cached, output: count("output_tokens") });
                    }
                }
                _ => {}
            },
            Some("response_item") => match kind {
                "function_call" | "custom_tool_call" => {
                    let name = payload.get("name").and_then(Value::as_str).unwrap_or("tool").to_owned();
                    let input = match payload.get("arguments").or_else(|| payload.get("input")) {
                        Some(Value::String(raw)) => serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.clone())),
                        Some(other) => other.clone(),
                        None => Value::Null,
                    };
                    let call_id = payload.get("call_id").and_then(Value::as_str).unwrap_or_default().to_owned();
                    self.events.push(Event::ToolCall { name, input: shell_input(input), call_id });
                }
                "local_shell_call" => {
                    let input = shell_input(payload.get("action").cloned().unwrap_or(Value::Null));
                    let call_id = payload.get("call_id").and_then(Value::as_str).unwrap_or_default().to_owned();
                    self.events.push(Event::ToolCall { name: "shell".into(), input, call_id });
                }
                "function_call_output" | "custom_tool_call_output" | "local_shell_call_output" => {
                    if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
                        self.events.push(Event::ToolOutput(call_id.to_owned()));
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }

    fn catch_up(&mut self, path: &Path) {
        let Ok(mut file) = fs::File::open(path) else { return };
        let len = file.metadata().map_or(0, |meta| meta.len());
        if len < self.offset {
            *self = Rollout::default();
        }
        let mut bytes = Vec::new();
        if file.seek(SeekFrom::Start(self.offset)).is_err() || file.read_to_end(&mut bytes).is_err() {
            return;
        }
        // Leave a line still being written for next time
        let Some(end) = bytes.iter().rposition(|&b| b == b'\n') else { return };
        for line in bytes[..=end].split(|&b| b == b'\n') {
            self.read_line(line);
        }
        self.offset += end as u64 + 1;
    }

    fn last_agent_message(&self) -> Option<String> {
        self.events.iter().rev().find_map(|event| match event {
            Event::AgentMessage(text) if !text.trim().is_empty() => Some(text.clone()),
            _ => None,
        })
    }

    fn first_prompt(&self) -> Option<&str> {
        self.events.iter().find_map(|event| match event {
            Event::UserMessage(_, text) => Some(text.as_str()),
            _ => None,
        })
    }

    /// A `request_user_input` call with no answer yet: what it asks.
    fn open_question(&self) -> Option<String> {
        let answered: HashSet<&str> = self
            .events
            .iter()
            .filter_map(|event| match event {
                Event::ToolOutput(call_id) => Some(call_id.as_str()),
                _ => None,
            })
            .collect();
        self.events.iter().rev().find_map(|event| match event {
            Event::ToolCall { name, input, call_id } if name == "request_user_input" && !answered.contains(call_id.as_str()) => {
                Some(question_text(Some(input)).unwrap_or_else(|| "Asked you a question".to_owned()))
            }
            _ => None,
        })
    }

    /// The latest messages and tool calls, as Claude-shaped events for the UI.
    fn log_events(&self, count: usize) -> Vec<Value> {
        let events: Vec<Value> = self
            .events
            .iter()
            .filter_map(|event| match event {
                Event::AgentMessage(text) => Some(super::claude_event(Some(text), &[])),
                Event::ToolCall { name, input, .. } => Some(super::claude_event(None, &[(name.clone(), input.clone())])),
                _ => None,
            })
            .collect();
        events[events.len().saturating_sub(count)..].to_vec()
    }

    /// Tokens from its token counts, runs as prompts, and active time as turns' lengths.
    fn usage_since(&self, since: i64) -> Usage {
        let mut usage = Usage::default();
        let mut turn_started: Option<i64> = None;
        for event in &self.events {
            match *event {
                Event::UserMessage(at, _) if at >= since => usage.runs += 1,
                Event::TurnStarted(at) => turn_started = Some(at),
                Event::TurnEnded(at) => {
                    if let Some(started) = turn_started.take() {
                        let started = started.max(since);
                        if at > started {
                            usage.active_seconds += ((at - started) / 1000) as u64;
                        }
                    }
                }
                Event::Tokens { at, input, cached, output } if at >= since => {
                    usage.input_tokens += input;
                    usage.cached_input_tokens += cached;
                    usage.output_tokens += output;
                }
                _ => {}
            }
        }
        usage
    }
}

/// A shell call's input with its command as one line (Codex gives `["bash", "-lc", "npm test"]`),
/// so the UI describes it as "Ran npm test".
fn shell_input(mut input: Value) -> Value {
    if let Some(parts) = input.get("command").and_then(Value::as_array) {
        let parts: Vec<&str> = parts.iter().filter_map(Value::as_str).collect();
        let command = match parts.as_slice() {
            [shell, flag, script] if shell.ends_with("sh") && flag.starts_with('-') => (*script).to_owned(),
            _ => parts.join(" "),
        };
        input["command"] = Value::String(command);
    }
    input
}

/// A rollout, parsed once and then read on from where it was left.
fn parsed(path: &Path) -> Option<Rollout> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Rollout>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().ok()?;
    let rollout = cache.entry(path.to_path_buf()).or_default();
    rollout.catch_up(path);
    Some(rollout.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn line(at: &str, kind: &str, payload: Value) -> String {
        format!("{}\n", json!({ "timestamp": at, "type": kind, "payload": payload }))
    }

    #[test]
    fn reads_rollouts() {
        let root = std::env::temp_dir().join(format!("officesim-codex-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let today = &iso_from_millis(now_millis())[..10];
        let day = root.join("sessions").join(today.replace('-', "/"));
        fs::create_dir_all(&day).unwrap();
        let path = day.join("rollout-2026-10-01T10-00-00-0199a1b2-c3d4.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        for line in [
            line("2026-10-01T10:00:00.000Z", "session_meta", json!({ "id": "0199a1b2-c3d4", "timestamp": "2026-10-01T10:00:00.000Z", "cwd": "/Users/me/code/my-app", "originator": "codex_cli_rs", "cli_version": "0.50.0" })),
            line("2026-10-01T10:00:01.000Z", "event_msg", json!({ "type": "task_started" })),
            line("2026-10-01T10:00:01.000Z", "event_msg", json!({ "type": "user_message", "message": "Fix the tests\nplease" })),
            line("2026-10-01T10:00:05.000Z", "response_item", json!({ "type": "function_call", "name": "shell", "arguments": "{\"command\":[\"bash\",\"-lc\",\"npm test\"]}", "call_id": "c1" })),
            line("2026-10-01T10:00:09.000Z", "response_item", json!({ "type": "function_call_output", "call_id": "c1", "output": "ok" })),
            line("2026-10-01T10:00:10.000Z", "event_msg", json!({ "type": "token_count", "info": { "last_token_usage": { "input_tokens": 1000, "cached_input_tokens": 800, "output_tokens": 50 }, "total_token_usage": {} } })),
            line("2026-10-01T10:00:11.000Z", "event_msg", json!({ "type": "agent_message", "message": "All **green** now." })),
            line("2026-10-01T10:00:41.000Z", "event_msg", json!({ "type": "task_complete" })),
        ] {
            file.write_all(line.as_bytes()).unwrap();
        }

        let source = Codex::at(root.clone());
        let agents = source.agents();
        assert_eq!(agents.len(), 1);
        let agent = &agents[0];
        assert_eq!(agent.id, "codex:0199a1b2-c3d4");
        assert_eq!(agent.name, "My App");
        assert_eq!(agent.status, "idle");
        let run = agent.last_run.as_ref().unwrap();
        assert_eq!(run.summary.as_deref(), Some("All green now."));
        assert_eq!(run.issue_title.as_deref(), Some("Fix the tests"));
        assert_eq!(source.usage(agent, 0), Usage { runs: 1, active_seconds: 40, input_tokens: 200, cached_input_tokens: 800, output_tokens: 50, ..Usage::default() });

        let log = source.read_log(&run.run_id, 0, 1000).unwrap();
        assert!(log.contains(r#"\"command\":\"npm test\""#), "{log}");

        // A question it's waiting on
        file.write_all(line("2026-10-01T10:01:00.000Z", "response_item", json!({ "type": "function_call", "name": "request_user_input", "arguments": "{\"questions\":[{\"question\":\"Which env?\"}]}", "call_id": "c2" })).as_bytes()).unwrap();
        assert_eq!(parsed(&path).unwrap().open_question().as_deref(), Some("Which env?"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn shell_commands_read_as_one_line() {
        assert_eq!(shell_input(json!({ "command": ["bash", "-lc", "npm test"] }))["command"], "npm test");
        assert_eq!(shell_input(json!({ "command": ["git", "status"] }))["command"], "git status");
    }
}
