//! Aider sessions. Aider keeps no central record: each run appends to `.aider.chat.history.md` in
//! the folder it runs in, a markdown log with a "# aider chat started at <local time>" header per
//! session, the person's prompts as "#### " lines, Aider's own notes (edits applied, token counts)
//! as "> " lines, and its replies as plain text.
//!
//! Each running Aider process is an agent, read from the history in its working folder. It's
//! working while the history was written moments ago. Aider asks its questions in the terminal and
//! only logs them once answered, so no decision bubbles.

use super::naming::{project_name, tidy};
use super::Source;
use crate::model::{ActivityKind, Agent, LastRun, Usage};
use crate::time::{iso_from_millis, iso_from_system_time, millis_from_sql_time};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const ID: &str = "aider";
const RUN_PREFIX: &str = "aider:";
const HARNESS_NAME: &str = "Aider";
const HISTORY_FILE: &str = ".aider.chat.history.md";
const SESSION_HEADER: &str = "# aider chat started at ";
/// Written this recently, Aider is mid-reply.
const JUST_WRITTEN: Duration = Duration::from_secs(20);
/// How much of a history's end is read: enough for the current session's latest exchanges.
const TAIL_BYTES: u64 = 512 * 1024;
const SUMMARY_MAX_CHARS: usize = 320;
const TITLE_MAX_CHARS: usize = 80;
/// Aider runs as `aider`, or `python -m aider`.
const PROCESS_PATTERN: &str = "/bin/aider( |$)|python[0-9.]* -m aider( |$)";

pub struct Aider;

impl Source for Aider {
    fn process_pattern(&self) -> Option<&'static str> {
        Some(PROCESS_PATTERN)
    }

    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Aider"
    }

    fn location(&self) -> String {
        format!("{HISTORY_FILE} in each running Aider's folder")
    }

    fn detect(&self) -> bool {
        // Nothing to find until Aider runs; it's cheap to look each time
        true
    }

    fn agents(&self) -> Vec<Agent> {
        super::process_cwds(PROCESS_PATTERN).iter().filter_map(|folder| agent_for(folder)).collect()
    }

    fn watch_paths(&self) -> Vec<PathBuf> {
        super::process_cwds(PROCESS_PATTERN).into_iter().map(|folder| folder.join(HISTORY_FILE)).collect()
    }

    fn read_log(&self, run_id: &str, offset: u64, _limit: u64) -> Option<String> {
        let folder = self.folder_for_run(run_id)?;
        if offset > 0 {
            return Some(String::new());
        }
        let session = Session::parse(&read_tail(&folder.join(HISTORY_FILE))?);
        let events: Vec<String> = session.replies.iter().rev().take(10).rev().map(|reply| super::claude_event(Some(reply), &[]).to_string()).collect();
        Some(super::as_run_log(events.iter().map(String::as_str)))
    }

    fn usage(&self, agent: &Agent, since: i64) -> Usage {
        let Some(run) = &agent.last_run else { return Usage::default() };
        let Some(session) = self.folder_for_run(&run.run_id).and_then(|folder| read_tail(&folder.join(HISTORY_FILE))).map(|text| Session::parse(&text)) else {
            return Usage::default();
        };
        if session.started.is_some_and(|started| started < since) {
            return Usage::default();
        }
        Usage { runs: session.prompts.len() as u64, input_tokens: session.sent, output_tokens: session.received, ..Usage::default() }
    }
}

impl Aider {
    /// The folder of a running Aider, by its run id (the folder's hash).
    fn folder_for_run(&self, run_id: &str) -> Option<PathBuf> {
        let hash = run_id.strip_prefix(RUN_PREFIX)?;
        super::process_cwds(PROCESS_PATTERN).into_iter().find(|folder| folder_hash(folder) == hash)
    }
}

fn folder_hash(folder: &Path) -> String {
    format!("{:x}", md5::compute(folder.to_string_lossy().as_bytes()))
}

fn agent_for(folder: &Path) -> Option<Agent> {
    let history = folder.join(HISTORY_FILE);
    let modified = fs::metadata(&history).and_then(|meta| meta.modified()).ok();
    let session = read_tail(&history).map(|text| Session::parse(&text)).unwrap_or_default();
    let working = modified.is_some_and(|modified| modified.elapsed().unwrap_or_default() <= JUST_WRITTEN);
    let hash = folder_hash(folder);
    Some(Agent {
        id: format!("aider:{hash}"),
        name: project_name(HARNESS_NAME, folder.to_str()),
        status: if working { "running" } else { "idle" }.into(),
        activity_kind: if working { ActivityKind::Coding } else { ActivityKind::Idle },
        last_run: Some(LastRun {
            run_id: format!("{RUN_PREFIX}{hash}"),
            status: if working { "running" } else { "succeeded" }.into(),
            active: working,
            started_at: session.started.map(iso_from_millis),
            finished_at: if working { None } else { modified.map(iso_from_system_time) },
            last_output_at: modified.map(iso_from_system_time),
            summary: if working { None } else { session.replies.last().map(|reply| tidy(reply, SUMMARY_MAX_CHARS)) },
            issue_title: session.prompts.last().map(|prompt| tidy(prompt, TITLE_MAX_CHARS)),
            ..LastRun::default()
        }),
        source: ID,
        session_ref: Some(hash),
        created_ms: session.started,
        cwd: folder.to_str().map(str::to_owned),
        ..Agent::default()
    })
}

fn read_tail(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES))).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The latest session in a chat history.
#[derive(Default, Debug)]
struct Session {
    started: Option<i64>,
    prompts: Vec<String>,
    replies: Vec<String>,
    sent: u64,
    received: u64,
}

impl Session {
    fn parse(history: &str) -> Session {
        let latest = history.rfind(SESSION_HEADER).map_or(history, |at| &history[at..]);
        let mut session = Session::default();
        let mut reply = String::new();
        let finish_reply = |reply: &mut String, replies: &mut Vec<String>| {
            if !reply.trim().is_empty() {
                replies.push(reply.trim().to_owned());
            }
            reply.clear();
        };
        for line in latest.lines() {
            if let Some(started) = line.strip_prefix(SESSION_HEADER) {
                session.started = millis_from_sql_time(started.trim()).map(|millis| millis - local_offset_millis());
            } else if let Some(prompt) = line.strip_prefix("#### ") {
                finish_reply(&mut reply, &mut session.replies);
                session.prompts.push(prompt.trim().to_owned());
            } else if let Some(note) = line.strip_prefix('>') {
                finish_reply(&mut reply, &mut session.replies);
                if let Some((sent, received)) = token_note(note) {
                    session.sent += sent;
                    session.received += received;
                }
            } else if !session.prompts.is_empty() {
                reply.push_str(line);
                reply.push('\n');
            }
        }
        finish_reply(&mut reply, &mut session.replies);
        session
    }
}

/// "Tokens: 2.1k sent, 300 received. Cost: ..." as (sent, received).
fn token_note(note: &str) -> Option<(u64, u64)> {
    let rest = note.trim().strip_prefix("Tokens:")?;
    let mut sent = None;
    let mut received = None;
    for part in rest.split(',') {
        if let Some(end) = part.find(" sent") {
            sent = parse_count(&part[..end]);
        } else if let Some(end) = part.find(" received") {
            received = parse_count(&part[..end]);
        }
    }
    Some((sent?, received.unwrap_or(0)))
}

/// "2.1k" as 2100, "1.2M" as 1200000.
fn parse_count(text: &str) -> Option<u64> {
    let text = text.trim();
    let (number, scale) = match text.chars().last()? {
        'k' | 'K' => (&text[..text.len() - 1], 1_000.0),
        'm' | 'M' => (&text[..text.len() - 1], 1_000_000.0),
        _ => (text, 1.0),
    };
    number.parse::<f64>().ok().map(|value| (value * scale).round() as u64)
}

/// This Mac's offset from UTC now, as Aider writes local times.
fn local_offset_millis() -> i64 {
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |age| age.as_secs() as libc::time_t);
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&now, &mut local) };
    local.tm_gmtoff * 1000
}

#[cfg(test)]
mod tests {
    use super::*;

    const HISTORY: &str = "\
# aider chat started at 2026-09-30 09:00:00

#### old prompt

Old reply.

# aider chat started at 2026-10-01 10:00:00

> Aider v0.86.0
> Main model: sonnet

#### fix the flaky test

I'll make the **test** wait for the server.

> Applied edit to tests/app.test.ts
> Tokens: 2.1k sent, 300 received. Cost: $0.01 message, $0.01 session.

#### now run it

It passes now.

> Tokens: 1.5k sent, 1.2k received.
";

    #[test]
    fn reads_the_latest_session() {
        let session = Session::parse(HISTORY);
        assert_eq!(session.prompts, ["fix the flaky test", "now run it"]);
        assert_eq!(session.replies, ["I'll make the **test** wait for the server.", "It passes now."]);
        assert_eq!((session.sent, session.received), (3600, 1500));
        assert_eq!(session.started, millis_from_sql_time("2026-10-01 10:00:00").map(|millis| millis - local_offset_millis()));
    }

    #[test]
    fn reads_token_counts() {
        assert_eq!(token_note(" Tokens: 12k sent, 1.2M received. Cost: $1"), Some((12_000, 1_200_000)));
        assert_eq!(token_note(" Applied edit to x"), None);
    }
}
