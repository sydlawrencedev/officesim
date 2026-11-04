//! Claude Code usage from its transcripts, for the Agents tab: tokens from each response's
//! `message.usage` (one response spans several transcript lines, one per content block, so each is
//! counted once by message id), runs as the person's prompts, and active time as the time from each
//! prompt to the end of Claude's reply (its `end_turn`), leaving out the wait for the next prompt.
//!
//! Transcripts only grow, so each is parsed once and then only its new lines are read.

use crate::model::Usage;
use crate::time::millis_from_iso;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Longest pause counted within a turn. A turn that never ended (interrupted, or the app quit) would
/// otherwise count the whole wait for the next prompt; real pauses (a long build) stay under this.
const MAX_GAP_MILLIS: i64 = 10 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EventKind {
    /// The person sent a prompt.
    Prompt,
    /// A response, with its token counts.
    Response { input: u64, cached: u64, output: u64 },
    Other,
}

#[derive(Clone, Copy, Debug)]
struct Event {
    at: i64,
    kind: EventKind,
    /// Claude finished its reply here.
    ends_turn: bool,
}

#[derive(Default)]
struct Parsed {
    /// Bytes read so far, always at a line end.
    offset: u64,
    events: Vec<Event>,
    seen_messages: HashSet<String>,
}

impl Parsed {
    /// Reads whatever was written since last time.
    fn catch_up(&mut self, path: &Path) {
        let Ok(mut file) = File::open(path) else { return };
        let len = file.metadata().map_or(0, |meta| meta.len());
        if len < self.offset {
            // Rewritten from scratch
            *self = Parsed::default();
        }
        let mut bytes = Vec::new();
        if file.seek(SeekFrom::Start(self.offset)).is_err() || file.read_to_end(&mut bytes).is_err() {
            return;
        }
        // Leave a line still being written for next time
        let Some(end) = bytes.iter().rposition(|&b| b == b'\n') else { return };
        for line in bytes[..=end].split(|&b| b == b'\n') {
            if let Some(event) = self.parse_line(line) {
                self.events.push(event);
            }
        }
        self.offset += end as u64 + 1;
    }

    fn parse_line(&mut self, line: &[u8]) -> Option<Event> {
        let event: Value = serde_json::from_slice(line).ok()?;
        let at = millis_from_iso(event.get("timestamp")?.as_str()?)?;
        let ends_turn = event.pointer("/message/stop_reason").and_then(Value::as_str) == Some("end_turn");
        let kind = match event.get("type").and_then(Value::as_str) {
            Some("user") if event.get("toolUseResult").is_none() && !is_tool_result(&event) => EventKind::Prompt,
            Some("assistant") => {
                let message = event.get("message")?;
                let id = message.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
                if !id.is_empty() && !self.seen_messages.insert(id) {
                    EventKind::Other
                } else {
                    let usage = message.get("usage");
                    let count = |key: &str| usage.and_then(|u| u.get(key)).and_then(Value::as_u64).unwrap_or(0);
                    EventKind::Response {
                        input: count("input_tokens") + count("cache_creation_input_tokens"),
                        cached: count("cache_read_input_tokens"),
                        output: count("output_tokens"),
                    }
                }
            }
            _ => EventKind::Other,
        };
        Some(Event { at, kind, ends_turn })
    }

    fn usage_since(&self, since: i64) -> Usage {
        let mut usage = Usage::default();
        let mut previous: Option<i64> = None;
        // A time frame can start mid-turn
        let mut in_turn = true;
        for event in self.events.iter().filter(|event| event.at >= since) {
            if event.kind == EventKind::Prompt {
                in_turn = true;
            } else if let (true, Some(previous)) = (in_turn, previous) {
                let gap = event.at - previous;
                if (0..=MAX_GAP_MILLIS).contains(&gap) {
                    usage.active_seconds += (gap / 1000) as u64;
                }
            }
            previous = Some(event.at);
            if event.ends_turn {
                in_turn = false;
            }
            match event.kind {
                EventKind::Prompt => usage.runs += 1,
                EventKind::Response { input, cached, output } => {
                    usage.input_tokens += input;
                    usage.cached_input_tokens += cached;
                    usage.output_tokens += output;
                }
                EventKind::Other => {}
            }
        }
        usage
    }
}

/// A prompt line that only carries tool results back to Claude.
fn is_tool_result(event: &Value) -> bool {
    event
        .pointer("/message/content")
        .and_then(Value::as_array)
        .is_some_and(|blocks| !blocks.is_empty() && blocks.iter().all(|block| block.get("type").and_then(Value::as_str) == Some("tool_result")))
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Parsed>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Parsed>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// A transcript's usage since `since` (milliseconds since the epoch).
pub fn usage_since(transcript: &Path, since: i64) -> Usage {
    let Ok(mut cache) = cache().lock() else { return Usage::default() };
    let parsed = cache.entry(transcript.to_path_buf()).or_default();
    parsed.catch_up(transcript);
    parsed.usage_since(since)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const LINES: &str = concat!(
        r#"{"type":"user","timestamp":"2026-10-01T10:00:00.000Z","message":{"content":"fix it"}}"#, "\n",
        r#"{"type":"assistant","timestamp":"2026-10-01T10:00:30.000Z","message":{"id":"m1","content":[{"type":"text","text":"On it"}],"usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":20}}}"#, "\n",
        r#"{"type":"assistant","timestamp":"2026-10-01T10:00:31.000Z","message":{"id":"m1","content":[{"type":"tool_use","name":"Bash"}],"usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":20}}}"#, "\n",
        r#"{"type":"user","timestamp":"2026-10-01T10:01:00.000Z","toolUseResult":{},"message":{"content":[{"type":"tool_result"}]}}"#, "\n",
        // A five minute build, then the reply ends the turn
        r#"{"type":"assistant","timestamp":"2026-10-01T10:06:00.000Z","message":{"id":"m2","stop_reason":"end_turn","content":[],"usage":{"input_tokens":1,"cache_read_input_tokens":200,"output_tokens":5}}}"#, "\n",
        // An hour later: waiting for the person isn't counted
        r#"{"type":"user","timestamp":"2026-10-01T11:01:30.000Z","message":{"content":[{"type":"text","text":"again"}]}}"#, "\n",
    );

    #[test]
    fn counts_tokens_runs_and_active_time() {
        let path = std::env::temp_dir().join(format!("officesim-usage-test-{}.jsonl", std::process::id()));
        let mut file = File::create(&path).unwrap();
        file.write_all(LINES.as_bytes()).unwrap();
        // A line still being written
        file.write_all(br#"{"type":"user","timestamp":"2026-10-01T11:02"#).unwrap();

        let all = usage_since(&path, 0);
        assert_eq!(all, Usage { issues_done: 0, active_seconds: 360, runs: 2, input_tokens: 16, cached_input_tokens: 300, output_tokens: 25 });
        let since_11 = usage_since(&path, millis_from_iso("2026-10-01T11:00:00Z").unwrap());
        assert_eq!(since_11.runs, 1);
        assert_eq!(since_11.output_tokens, 0);

        // The cut line gets finished; only it is read
        file.write_all(b":00.000Z\",\"message\":{\"content\":\"more\"}}\n").unwrap();
        assert_eq!(usage_since(&path, 0).runs, 3);
        std::fs::remove_file(&path).unwrap();
    }
}
