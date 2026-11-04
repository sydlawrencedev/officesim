//! Claude Code sessions, from its local files:
//!
//! - `~/.claude/sessions/<pid>.json`: one per running Claude Code process (CLI or desktop), with its
//!   session id, working directory, name and status ("busy" while it works).
//! - `~/.claude/projects/<cwd slug>/<session id>.jsonl`: each session's transcript, one JSON event
//!   per line. Assistant lines carry `message.content` text and tool_use blocks, the same events the
//!   office UI already reads from Paperclip's Claude run logs, so the transcript doubles as the run
//!   log behind the live speech bubbles.
//!
//! Every running session is an agent; sessions closed within the last hour stay on as idle agents.
//! Agents are named after their project ("Claude: Agent Pixels"), numbered by start time when a
//! project has several sessions; each session's own title shows in its tooltip.

use super::naming::{number_namesakes, project_name, question_text, tidy};
use super::Source;
use crate::model::{ActivityKind, Agent, LastRun, Usage};
use crate::time::{iso_from_millis, iso_from_system_time};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const ID: &str = "claude";
const RUN_PREFIX: &str = "claude:";
/// An agent's name when its project isn't known.
const HARNESS_NAME: &str = "Claude";
/// Closed sessions stay in the office this long after their last transcript write.
const RECENT: Duration = Duration::from_secs(60 * 60);
/// How much of a transcript's end is read for its latest message, title and branch.
const TAIL_BYTES: u64 = 256 * 1024;
/// Like the plugin worker's SUMMARY_MAX_CHARS.
const SUMMARY_MAX_CHARS: usize = 320;
/// Claude Code's session status while it waits on the person (a permission prompt, a question in
/// the terminal...), with what for in `waitingFor`.
const WAITING_STATUS: &str = "waiting";
/// Tools that put a question to the person and wait for the answer. The desktop app shows these
/// itself, with the session still "busy", so an unanswered call in the transcript is the sign.
const QUESTION_TOOLS: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];

pub struct ClaudeCode {
    root: PathBuf,
}

impl ClaudeCode {
    pub fn new() -> Self {
        let root = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| super::home().join(".claude"));
        Self { root }
    }

    #[cfg(test)]
    fn at(root: PathBuf) -> Self {
        Self { root }
    }

    fn sessions_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }

    fn projects_dir(&self) -> PathBuf {
        self.root.join("projects")
    }

    /// Where a session's transcript is: under its working directory's slug, else wherever it is.
    fn transcript_path(&self, session_id: &str, cwd: Option<&str>) -> Option<PathBuf> {
        let file = format!("{session_id}.jsonl");
        if let Some(cwd) = cwd {
            let path = self.projects_dir().join(project_slug(cwd)).join(&file);
            if path.is_file() {
                return Some(path);
            }
        }
        fs::read_dir(self.projects_dir())
            .ok()?
            .flatten()
            .map(|entry| entry.path().join(&file))
            .find(|path| path.is_file())
    }

    /// The transcript of one of its runs, by run id.
    fn transcript_for_run(&self, run_id: &str) -> Option<PathBuf> {
        let session_id = run_id.strip_prefix(RUN_PREFIX)?;
        // Session ids are UUIDs; anything else isn't ours to read
        if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return None;
        }
        self.transcript_path(session_id, None)
    }

    fn live_sessions(&self) -> Vec<LiveSession> {
        let Ok(entries) = fs::read_dir(self.sessions_dir()) else { return Vec::new() };
        let sessions: Vec<LiveSession> = entries
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .filter_map(|entry| serde_json::from_slice(&fs::read(entry.path()).ok()?).ok())
            .collect();
        let running = running_processes(sessions.iter().map(|session| session.pid));
        sessions
            .into_iter()
            // A session file outlives a crashed process; and a reused pid is another program
            .filter(|session| match (running.get(&session.pid), &session.proc_start) {
                (Some(started), Some(expected)) => same_start(started, expected),
                (Some(_), None) => true,
                (None, _) => false,
            })
            .collect()
    }

    /// Transcripts written within RECENT for sessions no longer running: session id, path, when it
    /// was created (the session's start) and last written.
    fn recent_transcripts(&self, live: &HashSet<String>) -> Vec<(String, PathBuf, Option<SystemTime>, SystemTime)> {
        let cutoff = SystemTime::now() - RECENT;
        let Ok(projects) = fs::read_dir(self.projects_dir()) else { return Vec::new() };
        projects
            .flatten()
            .filter_map(|project| fs::read_dir(project.path()).ok())
            .flat_map(|files| files.flatten())
            .filter_map(|file| {
                let path = file.path();
                let session_id = path.file_stem()?.to_str()?.to_owned();
                if path.extension()? != "jsonl" || live.contains(&session_id) {
                    return None;
                }
                let meta = file.metadata().ok()?;
                let modified = meta.modified().ok()?;
                (modified >= cutoff).then_some((session_id, path, meta.created().ok(), modified))
            })
            .collect()
    }
}

impl Source for ClaudeCode {
    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Claude Code"
    }

    fn location(&self) -> String {
        self.root.display().to_string()
    }

    fn detect(&self) -> bool {
        self.root.is_dir()
    }

    fn agents(&self) -> Vec<Agent> {
        let live = self.live_sessions();
        let live_ids: HashSet<String> = live.iter().map(|session| session.session_id.clone()).collect();
        let mut agents: Vec<Agent> = live
            .iter()
            .map(|session| {
                let transcript = self.transcript_path(&session.session_id, session.cwd.as_deref());
                let tail = transcript.as_deref().map(read_tail).unwrap_or_default();
                let status = session.status.as_deref().unwrap_or("idle");
                let working = status == "busy";
                let waiting_on = if status == WAITING_STATUS {
                    Some(waiting_label(session.waiting_for.as_deref()))
                } else {
                    tail.pending_question.clone()
                };
                let last_output_at = transcript.as_deref().and_then(modified).map(iso_from_system_time);
                Agent {
                    id: agent_id(&session.session_id),
                    name: project_name(HARNESS_NAME, session.cwd.as_deref().or(tail.cwd.as_deref())),
                    status: if working { "running" } else { "idle" }.into(),
                    url_key: None,
                    activity_kind: if working { ActivityKind::Coding } else { ActivityKind::Idle },
                    last_run: Some(LastRun {
                        run_id: run_id(&session.session_id),
                        status: if working { "running" } else { "succeeded" }.into(),
                        active: working,
                        started_at: session.started_at.map(iso_from_millis),
                        // An idle session's turn ended when Claude last wrote to it
                        finished_at: if working { None } else { last_output_at.clone() },
                        last_output_at,
                        last_output_bytes: transcript.as_deref().and_then(file_len),
                        summary: if working { None } else { tail.last_message.clone() },
                        error: None,
                        issue_identifier: None,
                        issue_title: session_title(session.name.as_deref(), &tail),
                    }),
                    source: ID,
                    model: tail.model.clone(),
                    waiting_on,
                    session_ref: Some(session.session_id.clone()),
                    created_ms: session.started_at,
                    cwd: session.cwd.clone().or_else(|| tail.cwd.clone()),
                    pid: Some(session.pid),
                    ..Agent::default()
                }
            })
            .collect();

        agents.extend(self.recent_transcripts(&live_ids).into_iter().map(|(session_id, path, created, modified)| {
            let tail = read_tail(&path);
            let finished_at = Some(iso_from_system_time(modified));
            Agent {
                id: agent_id(&session_id),
                name: project_name(HARNESS_NAME, tail.cwd.as_deref()),
                status: "idle".into(),
                url_key: None,
                activity_kind: ActivityKind::Idle,
                last_run: Some(LastRun {
                    run_id: run_id(&session_id),
                    status: "succeeded".into(),
                    active: false,
                    started_at: created.map(iso_from_system_time),
                    finished_at: finished_at.clone(),
                    last_output_at: finished_at,
                    last_output_bytes: file_len(&path),
                    summary: tail.last_message.clone(),
                    error: None,
                    issue_identifier: None,
                    issue_title: session_title(None, &tail),
                }),
                source: ID,
                model: tail.model.clone(),
                waiting_on: None,
                session_ref: Some(session_id.clone()),
                created_ms: created.and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|age| age.as_millis() as i64),
                cwd: tail.cwd.clone(),
                ..Agent::default()
            }
        }));
        number_namesakes(&mut agents);
        agents
    }

    fn watch_paths(&self) -> Vec<PathBuf> {
        vec![self.sessions_dir(), self.projects_dir()]
    }

    fn usage(&self, agent: &Agent, since: i64) -> Usage {
        agent
            .last_run
            .as_ref()
            .and_then(|run| self.transcript_for_run(&run.run_id))
            .map(|transcript| super::claude_usage::usage_since(&transcript, since))
            .unwrap_or_default()
    }


    fn read_log(&self, run_id: &str, offset: u64, limit: u64) -> Option<String> {
        let mut file = fs::File::open(self.transcript_for_run(run_id)?).ok()?;
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut bytes = Vec::new();
        file.take(limit).read_to_end(&mut bytes).ok()?;
        Some(as_paperclip_log(&String::from_utf8_lossy(&bytes), offset > 0))
    }
}

fn agent_id(session_id: &str) -> String {
    format!("claude:{session_id}")
}

fn run_id(session_id: &str) -> String {
    format!("{RUN_PREFIX}{session_id}")
}

/// A running session, from `~/.claude/sessions/<pid>.json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveSession {
    pid: u32,
    session_id: String,
    cwd: Option<String>,
    /// Milliseconds since the epoch.
    started_at: Option<i64>,
    /// When the process started, as `ps -o lstart` prints it; tells a reused pid apart.
    proc_start: Option<String>,
    name: Option<String>,
    status: Option<String>,
    /// What a "waiting" session waits for, e.g. "input needed" or a permission dialog.
    waiting_for: Option<String>,
}

/// What the end of a transcript says.
#[derive(Default, Debug)]
struct Tail {
    last_message: Option<String>,
    /// The question Claude's latest reply asks the person and is waiting on, if any.
    pending_question: Option<String>,
    title: Option<String>,
    cwd: Option<String>,
    git_branch: Option<String>,
    /// The model of the latest reply.
    model: Option<String>,
}

fn read_tail(path: &Path) -> Tail {
    let Ok(mut file) = fs::File::open(path) else { return Tail::default() };
    let len = file.metadata().map_or(0, |meta| meta.len());
    let start = len.saturating_sub(TAIL_BYTES);
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_to_end(&mut bytes).is_err() {
        return Tail::default();
    }
    parse_tail(&String::from_utf8_lossy(&bytes), start > 0)
}

/// The latest message, title, cwd and branch in a chunk of transcript. A chunk read from mid-file
/// starts mid-line, so its first line is skipped.
fn parse_tail(content: &str, starts_mid_line: bool) -> Tail {
    let mut tail = Tail::default();
    let lines: Vec<&str> = content.lines().skip(usize::from(starts_mid_line)).collect();
    // Tool calls answered after the line being read (lines are read newest first)
    let mut answered: HashSet<String> = HashSet::new();
    let mut seen_reply = false;
    for line in lines.into_iter().rev() {
        let Ok(event) = serde_json::from_str::<Value>(line) else { continue };
        let kind = event.get("type").and_then(Value::as_str);
        let sidechain = event.get("isSidechain") == Some(&Value::Bool(true));
        if kind == Some("user") {
            answered.extend(tool_result_ids(&event));
        }
        if kind == Some("assistant") && !sidechain && !seen_reply {
            // Only the latest reply can be waiting on the person
            seen_reply = true;
            tail.pending_question = unanswered_question(&event, &answered);
        }
        if tail.cwd.is_none() {
            tail.cwd = str_field(&event, "cwd");
        }
        if tail.git_branch.is_none() {
            tail.git_branch = str_field(&event, "gitBranch").filter(|branch| branch != "HEAD");
        }
        if tail.title.is_none() {
            tail.title = match kind {
                Some("custom-title") => str_field(&event, "customTitle"),
                Some("agent-name") => str_field(&event, "agentName"),
                Some("summary") => str_field(&event, "summary"),
                _ => None,
            };
        }
        if tail.model.is_none() && kind == Some("assistant") && !sidechain {
            // Claude Code's own messages (e.g. an interrupted turn) are "<synthetic>"
            tail.model = event.pointer("/message/model").and_then(Value::as_str).filter(|model| !model.starts_with('<')).map(str::to_owned);
        }
        if tail.last_message.is_none() && kind == Some("assistant") && !sidechain {
            tail.last_message = assistant_text(&event).map(|text| tidy(&text, SUMMARY_MAX_CHARS));
        }
        if tail.last_message.is_some() && tail.title.is_some() && tail.cwd.is_some() && tail.git_branch.is_some() && tail.model.is_some() {
            break;
        }
    }
    tail
}

/// The ids of the tool calls a user event answers.
fn tool_result_ids(event: &Value) -> Vec<String> {
    let Some(blocks) = event.pointer("/message/content").and_then(Value::as_array) else { return Vec::new() };
    blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        .filter_map(|block| block.get("tool_use_id").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

/// A question an assistant event puts to the person that hasn't been answered: what it asks.
fn unanswered_question(event: &Value, answered: &HashSet<String>) -> Option<String> {
    let blocks = event.pointer("/message/content")?.as_array()?;
    blocks.iter().find_map(|block| {
        let name = block.get("name")?.as_str()?;
        let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
        if block.get("type")?.as_str()? != "tool_use" || !QUESTION_TOOLS.contains(&name) || answered.contains(id) {
            return None;
        }
        Some(match name {
            "ExitPlanMode" => "Plan ready for your review".to_owned(),
            _ => question_text(block.get("input")).unwrap_or_else(|| "Asked you a question".to_owned()),
        })
    })
}

/// "input needed" as "Waiting: input needed".
fn waiting_label(waiting_for: Option<&str>) -> String {
    match waiting_for.map(str::trim).filter(|reason| !reason.is_empty()) {
        Some(reason) => format!("Waiting: {reason}"),
        None => "Waiting for you".to_owned(),
    }
}

fn str_field(event: &Value, key: &str) -> Option<String> {
    event.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// The text blocks of an assistant event, joined.
fn assistant_text(event: &Value) -> Option<String> {
    let blocks = event.pointer("/message/content")?.as_array()?;
    let text: Vec<&str> = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect();
    let joined = text.join("\n");
    (!joined.trim().is_empty()).then_some(joined)
}

/// A transcript chunk as Paperclip's run log has it (each line wrapped, see `Source::read_log`). A
/// chunk from mid-file starts with the end of a cut line; that is left as it is, since the UI steps
/// back through the log by that line's length in bytes.
fn as_paperclip_log(content: &str, starts_mid_line: bool) -> String {
    let (cut, whole) = match content.find('\n') {
        Some(end) if starts_mid_line => content.split_at(end + 1),
        None if starts_mid_line => (content, ""),
        _ => ("", content),
    };
    format!("{cut}{}", super::as_run_log(whole.lines()))
}

/// What the session is about: its name, else its transcript's title.
fn session_title(session_name: Option<&str>, tail: &Tail) -> Option<String> {
    session_name.map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned).or_else(|| tail.title.clone())
}

/// Claude Code names a project's folder after its path with every other character made a dash.
fn project_slug(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok()?.modified().ok()
}

fn file_len(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|meta| meta.len())
}

/// The given pids that are running, with their start times as `ps -o lstart` prints them.
fn running_processes(pids: impl Iterator<Item = u32>) -> HashMap<u32, String> {
    let pids: Vec<String> = pids.filter(|&pid| is_alive(pid)).map(|pid| pid.to_string()).collect();
    if pids.is_empty() {
        return HashMap::new();
    }
    let Ok(output) = Command::new("/bin/ps").args(["-o", "pid=,lstart=", "-p", &pids.join(",")]).output() else {
        // Can't tell start times apart; trust the pids
        return pids.iter().filter_map(|pid| Some((pid.parse().ok()?, String::new()))).collect();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (pid, start) = line.trim().split_once(' ')?;
            Some((pid.parse().ok()?, start.trim().to_owned()))
        })
        .collect()
}

fn is_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    // Signal 0 only checks the process exists (EPERM: it does, but isn't ours)
    unsafe { libc::kill(pid, 0) == 0 || *libc::__error() == libc::EPERM }
}

/// Whether two `lstart` style start times ("Thu Oct  1 10:00:43 2026") are the same process start.
/// Claude Code may write its in another time zone than `ps` prints here, so the hour and date are
/// left out: the same year, minute and second is the same process (a reused pid starting at that
/// same second of an hour is too unlikely to matter).
fn same_start(running: &str, recorded: &str) -> bool {
    fn minute_second_year(lstart: &str) -> Option<(&str, &str)> {
        let fields: Vec<&str> = lstart.split_whitespace().collect();
        let time = fields.get(3)?;
        Some((time.get(time.find(':')? + 1..)?, fields.get(4)?))
    }
    running.is_empty() || matches!((minute_second_year(running), minute_second_year(recorded)), (Some(a), Some(b)) if a == b)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRANSCRIPT: &str = concat!(
        r#"{"type":"user","cwd":"/Users/me/code/my-app","gitBranch":"main","message":{"role":"user","content":"hi"}}"#, "\n",
        r#"{"type":"assistant","cwd":"/Users/me/code/my-app","gitBranch":"main","message":{"content":[{"type":"text","text":"Looking at the **tests** now."},{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}"#, "\n",
        r#"{"type":"custom-title","customTitle":"Fix the tests","sessionId":"abc"}"#, "\n",
        r#"{"type":"assistant","cwd":"/Users/me/code/my-app","gitBranch":"fix-tests","message":{"content":[{"type":"tool_use","name":"Edit","input":{}}]}}"#, "\n",
    );

    #[test]
    fn reads_latest_message_title_and_branch() {
        let tail = parse_tail(TRANSCRIPT, false);
        assert_eq!(tail.last_message.as_deref(), Some("Looking at the tests now."));
        assert_eq!(tail.title.as_deref(), Some("Fix the tests"));
        assert_eq!(tail.git_branch.as_deref(), Some("fix-tests"));
        assert_eq!(tail.cwd.as_deref(), Some("/Users/me/code/my-app"));
    }

    #[test]
    fn wraps_transcript_lines_like_paperclip() {
        let log = as_paperclip_log("t\"}\n{\"type\":\"assistant\"}\n", true);
        assert_eq!(log, "t\"}\n{\"chunk\":\"{\\\"type\\\":\\\"assistant\\\"}\",\"stream\":\"stdout\"}\n");
        assert_eq!(as_paperclip_log("no newline yet", true), "no newline yet");
    }

    #[test]
    fn spots_unanswered_questions() {
        let asked = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"AskUserQuestion","input":{"questions":[{"question":"Which **week** should I build?"}]}}]}}"#, "\n",
        );
        assert_eq!(parse_tail(asked, false).pending_question.as_deref(), Some("Which week should I build?"));
        let answered = format!("{asked}{}\n", r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}"#);
        assert_eq!(parse_tail(&answered, false).pending_question, None);
        let plan = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"ExitPlanMode","input":{}}]}}"#;
        assert_eq!(parse_tail(plan, false).pending_question.as_deref(), Some("Plan ready for your review"));
        // An older question doesn't count once Claude has replied since
        let later = format!("{asked}{}\n", r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Moving on."}]}}"#);
        assert_eq!(parse_tail(&later, false).pending_question, None);
        assert_eq!(waiting_label(Some("input needed")), "Waiting: input needed");
    }

    #[test]
    fn skips_the_cut_first_line() {
        let tail = parse_tail(&TRANSCRIPT[20..], true);
        assert_eq!(tail.last_message.as_deref(), Some("Looking at the tests now."));
    }

    #[test]
    fn slugs_match_claude_code() {
        assert_eq!(project_slug("/Users/me/minithlabs/delphina/.claude/worktrees/x"), "-Users-me-minithlabs-delphina--claude-worktrees-x");
    }

    #[test]
    fn titles_fall_back_to_the_transcript() {
        let tail = Tail { title: Some("From transcript".into()), ..Tail::default() };
        assert_eq!(session_title(Some("Session name"), &tail).as_deref(), Some("Session name"));
        assert_eq!(session_title(Some(" "), &tail).as_deref(), Some("From transcript"));
    }

    #[test]
    fn compares_start_times_loosely() {
        assert!(same_start("Thu Oct  1 10:00:43 2026", "Thu Oct 1 10:00:43 2026"));
        // Claude Code wrote it in UTC, ps prints British Summer Time
        assert!(same_start("Thu Oct  1 11:00:43 2026", "Thu Oct  1 10:00:43 2026"));
        assert!(!same_start("Thu Oct  1 10:00:43 2026", "Thu Oct  1 10:00:44 2026"));
        assert!(!same_start("Thu Oct  1 10:00:43 2026", "garbage"));
    }

    #[test]
    fn finds_live_and_recent_sessions() {
        let root = std::env::temp_dir().join(format!("officesim-claude-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let project = root.join("projects").join(project_slug("/Users/me/code/my-app"));
        fs::create_dir_all(root.join("sessions")).unwrap();
        fs::create_dir_all(&project).unwrap();
        // This test process stands in for a running Claude Code
        let pid = std::process::id();
        fs::write(
            root.join("sessions").join(format!("{pid}.json")),
            format!(r#"{{"pid":{pid},"sessionId":"aaaa-1111","cwd":"/Users/me/code/my-app","startedAt":1790848844503,"name":"Live one","status":"busy"}}"#),
        )
        .unwrap();
        // A dead process's leftover session file
        fs::write(root.join("sessions/999999.json"), r#"{"pid":999999,"sessionId":"dead-0000","status":"busy"}"#).unwrap();
        fs::write(project.join("aaaa-1111.jsonl"), TRANSCRIPT).unwrap();
        fs::write(project.join("bbbb-2222.jsonl"), TRANSCRIPT).unwrap();

        let source = ClaudeCode::at(root.clone());
        let mut agents = source.agents();
        agents.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(agents.len(), 2, "{agents:?}");

        let live = &agents[0];
        assert_eq!(live.id, "claude:aaaa-1111");
        // It started at 10:00 today, before the closed session's transcript was created (just now)
        assert_eq!(live.name, "My App 1");
        assert_eq!(live.status, "running");
        let run = live.last_run.as_ref().unwrap();
        assert!(run.active);
        assert_eq!(run.issue_title.as_deref(), Some("Live one"));
        assert_eq!(run.started_at.as_deref(), Some("2026-10-01T10:00:44.503Z"));

        let recent = &agents[1];
        assert_eq!(recent.id, "claude:bbbb-2222");
        assert_eq!(recent.name, "My App 2");
        assert_eq!(recent.last_run.as_ref().unwrap().issue_title.as_deref(), Some("Fix the tests"));
        assert_eq!(recent.status, "idle");
        assert_eq!(recent.last_run.as_ref().unwrap().summary.as_deref(), Some("Looking at the tests now."));

        assert_eq!(source.transcript_for_run("claude:aaaa-1111"), Some(project.join("aaaa-1111.jsonl")));
        assert_eq!(source.transcript_for_run("claude:../../etc/passwd"), None);
        let log = source.read_log("claude:aaaa-1111", 0, 10_000).unwrap();
        assert!(log.starts_with("{\"chunk\":\"{\\\"type\\\":\\\"user\\\""), "{log}");
        fs::remove_dir_all(&root).unwrap();
    }

    /// `cargo test -- --ignored --nocapture` prints this Mac's Claude Code agents, as the office sees them.
    #[test]
    #[ignore]
    fn prints_this_macs_sessions() {
        for agent in ClaudeCode::new().agents() {
            println!("{}", serde_json::to_string(&agent).unwrap());
        }
    }
}
