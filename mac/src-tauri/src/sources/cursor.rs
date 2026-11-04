//! Cursor's agent CLI sessions, from `~/.cursor/chats/<md5 of the folder>/<chat id>/store.db`: a
//! small SQLite store per chat. Its `meta` row "0" is hex-encoded JSON (`name`, `createdAt`,
//! `latestRootBlobId`); `blobs` holds a content-addressed tree from that root, where each node
//! lists its children's 32-byte hashes (tag 0x12: a subtree, 0x0a: a message) and each message is
//! JSON with a role and content blocks. Layout as read by cursor-history (S2thend/cursor-history).
//!
//! Chats written within the last hour are agents. One is working while a cursor-agent process runs
//! and the chat was written to moments ago. The folder is only known as a hash, so agents are named
//! after the folder of a running cursor-agent with that hash, else "Cursor". Cursor keeps no token
//! counts or record of waiting on the person here.

use super::naming::{number_namesakes, project_name, tidy};
use super::Source;
use crate::model::{ActivityKind, Agent, LastRun, Usage};
use crate::time::{iso_from_millis, iso_from_system_time};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const ID: &str = "cursor";
const RUN_PREFIX: &str = "cursor:";
const HARNESS_NAME: &str = "Cursor";
/// Chats stay in the office this long after they were last written.
const RECENT: Duration = Duration::from_secs(60 * 60);
/// Written this recently, a chat is mid-reply.
const JUST_WRITTEN: Duration = Duration::from_secs(20);
const SUMMARY_MAX_CHARS: usize = 320;
const TITLE_MAX_CHARS: usize = 80;
/// Messages sent for the live speech bubble.
const LOG_MESSAGES: usize = 30;
/// A guard against a corrupt store looping or growing without end.
const MAX_BLOBS: usize = 20_000;

pub struct Cursor {
    root: PathBuf,
}

impl Cursor {
    pub fn new() -> Self {
        Self { root: super::home().join(".cursor") }
    }

    #[cfg(test)]
    fn at(root: PathBuf) -> Self {
        Self { root }
    }

    fn chats_dir(&self) -> PathBuf {
        self.root.join("chats")
    }

    /// Chat stores written within RECENT, with when.
    fn recent_chats(&self) -> Vec<(PathBuf, SystemTime)> {
        let cutoff = SystemTime::now() - RECENT;
        let Ok(workspaces) = fs::read_dir(self.chats_dir()) else { return Vec::new() };
        workspaces
            .flatten()
            .filter_map(|workspace| fs::read_dir(workspace.path()).ok())
            .flat_map(|chats| chats.flatten())
            .filter_map(|chat| {
                let store = chat.path().join("store.db");
                let modified = last_write(&store)?;
                (modified >= cutoff).then_some((store, modified))
            })
            .collect()
    }

    fn store_for_run(&self, run_id: &str) -> Option<PathBuf> {
        let chat = run_id.strip_prefix(RUN_PREFIX)?;
        if chat.is_empty() || !chat.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return None;
        }
        let workspaces = fs::read_dir(self.chats_dir()).ok()?;
        workspaces.flatten().map(|workspace| workspace.path().join(chat).join("store.db")).find(|store| store.is_file())
    }
}

impl Source for Cursor {
    fn process_pattern(&self) -> Option<&'static str> {
        Some("cursor-agent")
    }

    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Cursor CLI"
    }

    fn location(&self) -> String {
        self.chats_dir().display().to_string()
    }

    fn detect(&self) -> bool {
        self.chats_dir().is_dir()
    }

    fn agents(&self) -> Vec<Agent> {
        let folders: Vec<PathBuf> = super::process_cwds("cursor-agent");
        let running = !folders.is_empty();
        let by_hash: HashMap<String, PathBuf> = folders.into_iter().map(|folder| (format!("{:x}", md5::compute(folder.to_string_lossy().as_bytes())), folder)).collect();
        let mut agents: Vec<Agent> = self
            .recent_chats()
            .into_iter()
            .filter_map(|(store, modified)| {
                let chat_dir = store.parent()?;
                let chat_id = chat_dir.file_name()?.to_str()?.to_owned();
                let hash = chat_dir.parent()?.file_name()?.to_str()?.to_owned();
                let chat = read_chat(&store).ok()?;
                let working = running && modified.elapsed().unwrap_or_default() <= JUST_WRITTEN;
                let folder = by_hash.get(&hash).map(|folder| folder.to_string_lossy().into_owned());
                Some(Agent {
                    id: format!("cursor:{chat_id}"),
                    name: project_name(HARNESS_NAME, folder.as_deref()),
                    status: if working { "running" } else { "idle" }.into(),
                    activity_kind: if working { ActivityKind::Coding } else { ActivityKind::Idle },
                    last_run: Some(LastRun {
                        run_id: format!("{RUN_PREFIX}{chat_id}"),
                        status: if working { "running" } else { "succeeded" }.into(),
                        active: working,
                        started_at: chat.created.map(iso_from_millis),
                        finished_at: (!working).then(|| iso_from_system_time(modified)),
                        last_output_at: Some(iso_from_system_time(modified)),
                        summary: if working { None } else { chat.last_reply().map(|text| tidy(&text, SUMMARY_MAX_CHARS)) },
                        issue_title: chat.name.clone().or_else(|| chat.first_prompt().map(|text| tidy(text, TITLE_MAX_CHARS))),
                        ..LastRun::default()
                    }),
                    source: ID,
                    session_ref: Some(chat_id),
                    created_ms: chat.created,
                    cwd: folder,
                    ..Agent::default()
                })
            })
            .collect();
        number_namesakes(&mut agents);
        agents
    }

    fn watch_paths(&self) -> Vec<PathBuf> {
        vec![self.chats_dir()]
    }

    fn read_log(&self, run_id: &str, offset: u64, _limit: u64) -> Option<String> {
        let chat = read_chat(&self.store_for_run(run_id)?).ok()?;
        if offset > 0 {
            return Some(String::new());
        }
        let replies: Vec<&ChatMessage> = chat.messages.iter().filter(|message| message.role == "assistant").collect();
        let events: Vec<String> = replies[replies.len().saturating_sub(LOG_MESSAGES)..]
            .iter()
            .map(|message| super::claude_event(Some(&message.text), &message.tools).to_string())
            .collect();
        Some(super::as_run_log(events.iter().map(String::as_str)))
    }

    fn usage(&self, agent: &Agent, since: i64) -> Usage {
        // No timestamps per message: a chat's prompts count when it started in the time frame
        let Some(run) = &agent.last_run else { return Usage::default() };
        let Some(chat) = self.store_for_run(&run.run_id).and_then(|store| read_chat(&store).ok()) else { return Usage::default() };
        if chat.created.is_some_and(|created| created < since) {
            return Usage::default();
        }
        Usage { runs: chat.messages.iter().filter(|message| message.role == "user").count() as u64, ..Usage::default() }
    }
}

/// When a store was last written: its write-ahead log or the database itself.
fn last_write(store: &Path) -> Option<SystemTime> {
    let modified = |path: PathBuf| fs::metadata(path).and_then(|meta| meta.modified()).ok();
    let db = modified(store.to_path_buf())?;
    Some(modified(store.with_extension("db-wal")).map_or(db, |wal| wal.max(db)))
}

struct Chat {
    name: Option<String>,
    created: Option<i64>,
    messages: Vec<ChatMessage>,
}

struct ChatMessage {
    role: String,
    text: String,
    tools: Vec<(String, Value)>,
}

impl Chat {
    fn last_reply(&self) -> Option<String> {
        self.messages.iter().rev().find(|message| message.role == "assistant" && !message.text.trim().is_empty()).map(|message| message.text.clone())
    }

    fn first_prompt(&self) -> Option<&str> {
        self.messages.iter().find(|message| message.role == "user" && !message.text.trim().is_empty()).map(|message| message.text.as_str())
    }
}

fn read_chat(store: &Path) -> rusqlite::Result<Chat> {
    let conn = super::open_sqlite(store)?;
    let meta: Option<String> = conn.query_row("SELECT value FROM meta WHERE key = '0'", [], |row| row.get(0)).optional()?;
    let meta: Value = meta.as_deref().and_then(hex_json).unwrap_or(Value::Null);
    let mut messages = Vec::new();
    if let Some(root) = meta.get("latestRootBlobId").and_then(Value::as_str) {
        let mut visited = HashSet::new();
        walk(&conn, root, &mut visited, &mut messages);
    }
    Ok(Chat {
        name: meta.get("name").and_then(Value::as_str).map(str::to_owned).filter(|name| !name.trim().is_empty()),
        created: meta.get("createdAt").and_then(Value::as_i64),
        messages,
    })
}

/// Hex-encoded JSON (the meta row's value).
fn hex_json(hex: &str) -> Option<Value> {
    let bytes: Option<Vec<u8>> = (0..hex.len()).step_by(2).map(|at| hex.get(at..at + 2).and_then(|pair| u8::from_str_radix(pair, 16).ok())).collect();
    serde_json::from_slice(&bytes?).ok()
}

fn blob(conn: &Connection, id: &str) -> Option<Vec<u8>> {
    conn.query_row("SELECT data FROM blobs WHERE id = ?1", params![id], |row| row.get(0)).ok()
}

/// Reads the messages under a tree node, in order.
fn walk(conn: &Connection, node: &str, visited: &mut HashSet<String>, messages: &mut Vec<ChatMessage>) {
    if visited.len() >= MAX_BLOBS || !visited.insert(node.to_owned()) {
        return;
    }
    let Some(data) = blob(conn, node) else { return };
    for (tag, child) in children(&data) {
        if tag == 0x12 {
            walk(conn, &child, visited, messages);
        } else if visited.insert(child.clone()) {
            if let Some(message) = blob(conn, &child).and_then(|data| serde_json::from_slice::<Value>(&data).ok()).and_then(|leaf| message_from(&leaf)) {
                messages.push(message);
            }
        }
    }
}

/// A node's children: (tag, hex hash) for each 0x0a/0x12 field holding a 32-byte hash.
fn children(data: &[u8]) -> Vec<(u8, String)> {
    let mut found = Vec::new();
    let mut at = 0;
    while at + 1 < data.len() {
        let (tag, len) = (data[at], data[at + 1]);
        if (tag == 0x0a || tag == 0x12) && len == 0x20 && at + 34 <= data.len() {
            found.push((tag, data[at + 2..at + 34].iter().map(|byte| format!("{byte:02x}")).collect()));
            at += 34;
        } else {
            at += 1;
        }
    }
    found
}

fn message_from(leaf: &Value) -> Option<ChatMessage> {
    let role = leaf.get("role")?.as_str()?.to_owned();
    if role != "user" && role != "assistant" {
        return None;
    }
    let mut text = Vec::new();
    let mut tools = Vec::new();
    match leaf.get("content") {
        Some(Value::String(content)) => text.push(content.clone()),
        Some(Value::Array(blocks)) => {
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => text.extend(block.get("text").and_then(Value::as_str).map(str::to_owned)),
                    Some("tool_use" | "tool-call" | "tool_call") => {
                        if let Some(name) = block.get("toolName").or_else(|| block.get("name")).and_then(Value::as_str) {
                            let input = block.get("args").or_else(|| block.get("input")).or_else(|| block.get("arguments")).cloned().unwrap_or(Value::Null);
                            tools.push((name.to_owned(), input));
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    // OpenAI-style calls alongside the content
    tools.extend(super::hermes::openai_tool_calls(leaf.get("tool_calls").map(Value::to_string).as_deref()));
    Some(ChatMessage { role, text: text.join("\n"), tools })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hash(data: &[u8]) -> String {
        format!("{:x}", md5::compute(data)).repeat(2)
    }

    #[test]
    fn reads_the_blob_tree() {
        let root = std::env::temp_dir().join(format!("officesim-cursor-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let chat_dir = root.join("chats/abc123/chat-1");
        fs::create_dir_all(&chat_dir).unwrap();
        let conn = Connection::open(chat_dir.join("store.db")).unwrap();
        conn.execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);").unwrap();

        let user = json!({ "role": "user", "content": [{ "type": "text", "text": "Add a dark mode" }] }).to_string();
        let reply = json!({ "role": "assistant", "content": [{ "type": "text", "text": "Added **dark mode**." }, { "type": "tool-call", "toolName": "edit_file", "args": { "path": "a.css" } }] }).to_string();
        let (user_id, reply_id) = (hash(user.as_bytes()), hash(reply.as_bytes()));
        let child_ref = |tag: u8, id: &str| {
            let mut bytes = vec![tag, 0x20];
            bytes.extend((0..64).step_by(2).map(|at| u8::from_str_radix(&id[at..at + 2], 16).unwrap()));
            bytes
        };
        // A subtree holding the reply, under a root holding the prompt then the subtree
        let subtree: Vec<u8> = child_ref(0x0a, &reply_id);
        let subtree_id = hash(&subtree);
        let mut root_node = child_ref(0x0a, &user_id);
        root_node.extend(child_ref(0x12, &subtree_id));
        let root_id = hash(&root_node);
        for (id, data) in [(&user_id, user.as_bytes().to_vec()), (&reply_id, reply.as_bytes().to_vec()), (&subtree_id, subtree), (&root_id, root_node)] {
            conn.execute("INSERT INTO blobs VALUES (?1, ?2)", params![id, data]).unwrap();
        }
        let meta = json!({ "name": "Dark mode", "createdAt": 1_790_848_844_503_i64, "latestRootBlobId": root_id }).to_string();
        let meta_hex: String = meta.bytes().map(|byte| format!("{byte:02x}")).collect();
        conn.execute("INSERT INTO meta VALUES ('0', ?1)", params![meta_hex]).unwrap();
        drop(conn);

        let source = Cursor::at(root.clone());
        let agents = source.agents();
        assert_eq!(agents.len(), 1);
        let agent = &agents[0];
        assert_eq!(agent.name, "Cursor");
        let run = agent.last_run.as_ref().unwrap();
        assert_eq!(run.issue_title.as_deref(), Some("Dark mode"));
        assert_eq!(run.summary.as_deref(), Some("Added dark mode."));
        let log = source.read_log("cursor:chat-1", 0, 1000).unwrap();
        assert!(log.contains(r#"\"name\":\"edit_file\""#), "{log}");
        assert_eq!(source.read_log("cursor:../x", 0, 1000), None);
        fs::remove_dir_all(&root).unwrap();
    }
}
