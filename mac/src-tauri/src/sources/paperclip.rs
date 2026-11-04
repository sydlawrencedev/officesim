//! Paperclip companies' agents, from Paperclip's Postgres database (the connection string in
//! `~/.paperclip/instances/<instance>/config.json`), with the same queries the OfficeSim plugin
//! worker runs (src/worker.ts), across every active company. Run logs are read from the instance's
//! `data/run-logs` folder, already in the format the UI reads.
//!
//! Paperclip runs its agents in other harnesses (OpenCode, Claude Code, Gemini...). Its runs claim
//! those sessions, so they show once, as the Paperclip agent.

use super::Source;
use crate::model::{ActivityKind, Agent, Claims, LastRun, Usage};
use crate::time::iso_from_millis;
use postgres::{Client, NoTls};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const ID: &str = "paperclip";
const RUN_PREFIX: &str = "paperclip:";
/// Like the plugin worker's SUMMARY_MAX_CHARS.
const SUMMARY_MAX_CHARS: usize = 320;
/// Stats are read for every agent at once and reused for this long.
const STATS_TTL: Duration = Duration::from_secs(5);

/// Per agent: its in-progress run if it has one, otherwise its latest finished run, joined to the
/// issue it is or was working on. The plugin worker's LAST_RUNS_SQL, for every active company.
/// Agents that haven't run in 30 days (or, never having run, were created before then) are left
/// out, as the worker's RECENT_AGENTS_SQL does.
const AGENTS_SQL: &str = "
  SELECT a.id::text, a.name, a.status, coalesce(a.title, ''), coalesce(a.role, ''), coalesce(a.adapter_type, ''), c.name,
         r.id::text, r.status,
         (extract(epoch FROM r.started_at) * 1000)::int8, (extract(epoch FROM r.finished_at) * 1000)::int8,
         (extract(epoch FROM r.last_output_at) * 1000)::int8, r.last_output_bytes::int8, r.error, r.result_json::text,
         i.identifier, i.title,
         coalesce((SELECT mr.usage_json ->> 'model' FROM public.heartbeat_runs mr
                   WHERE mr.company_id = a.company_id AND mr.agent_id = a.id AND mr.finished_at IS NOT NULL AND mr.usage_json ->> 'model' <> ''
                   ORDER BY mr.finished_at DESC LIMIT 1),
                  nullif(a.adapter_config ->> 'model', '')),
         c.issue_prefix
  FROM public.agents a
  JOIN public.companies c ON c.id = a.company_id
  LEFT JOIN LATERAL (
    SELECT hr.id, hr.status, hr.started_at, hr.finished_at, hr.last_output_at, hr.last_output_bytes, hr.error,
           hr.result_json, hr.context_snapshot
    FROM public.heartbeat_runs hr
    WHERE hr.company_id = a.company_id AND hr.agent_id = a.id
      AND (hr.finished_at IS NOT NULL OR hr.status = 'running')
    ORDER BY (hr.status = 'running') DESC, COALESCE(hr.finished_at, hr.started_at, hr.created_at) DESC
    LIMIT 1
  ) r ON true
  LEFT JOIN LATERAL (
    SELECT iss.identifier, iss.title
    FROM public.issues iss
    WHERE r.id IS NOT NULL AND iss.company_id = a.company_id
      AND (iss.id::text = r.context_snapshot ->> 'issueId' OR iss.checkout_run_id = r.id OR iss.execution_run_id = r.id)
    ORDER BY (iss.id::text = r.context_snapshot ->> 'issueId') DESC NULLS LAST,
             (iss.checkout_run_id = r.id) DESC NULLS LAST,
             iss.updated_at DESC
    LIMIT 1
  ) i ON true
  WHERE a.status <> 'terminated' AND c.status = 'active'
    AND (r.status = 'running' OR coalesce(r.finished_at, r.started_at, a.created_at) > now() - interval '30 days')
  ORDER BY c.name, a.name
";

/// Per agent since $1 (milliseconds since the epoch): issues done, run time inside the window,
/// runs, and tokens from its cost events. The plugin worker's AGENT_STATS_SQL, for every company.
const STATS_SQL: &str = "
  WITH w AS (SELECT to_timestamp($1::float8 / 1000) AS since),
  done AS (
    SELECT i.assignee_agent_id AS agent_id, count(*) AS issues_done
    FROM public.issues i, w
    WHERE i.status = 'done' AND i.completed_at >= w.since AND i.assignee_agent_id IS NOT NULL
    GROUP BY 1
  ),
  active AS (
    SELECT hr.agent_id, count(*) AS runs,
           sum(extract(epoch FROM least(coalesce(hr.finished_at, now()), now()) - greatest(hr.started_at, w.since))) AS active_seconds
    FROM public.heartbeat_runs hr, w
    WHERE hr.started_at IS NOT NULL AND (hr.finished_at IS NOT NULL OR hr.status = 'running')
      AND coalesce(hr.finished_at, now()) > w.since
    GROUP BY 1
  ),
  tokens AS (
    SELECT c.agent_id, sum(c.input_tokens) AS input_tokens, sum(c.cached_input_tokens) AS cached_input_tokens,
           sum(c.output_tokens) AS output_tokens
    FROM public.cost_events c, w
    WHERE c.occurred_at >= w.since
    GROUP BY 1
  )
  SELECT a.id::text, coalesce(done.issues_done, 0)::int8, coalesce(active.runs, 0)::int8,
         coalesce(active.active_seconds, 0)::float8, coalesce(tokens.input_tokens, 0)::int8,
         coalesce(tokens.cached_input_tokens, 0)::int8, coalesce(tokens.output_tokens, 0)::int8
  FROM public.agents a
  LEFT JOIN done ON done.agent_id = a.id
  LEFT JOIN active ON active.agent_id = a.id
  LEFT JOIN tokens ON tokens.agent_id = a.id
  WHERE a.status <> 'terminated'
";

/// Harness sessions recent runs used, started or resumed.
const CLAIMED_SESSIONS_SQL: &str = "
  SELECT hr.session_id_before, hr.session_id_after
  FROM public.heartbeat_runs hr
  WHERE hr.created_at > now() - interval '2 days'
    AND (hr.session_id_before IS NOT NULL OR hr.session_id_after IS NOT NULL)
";

/// Runs in progress that haven't reported a session yet, with their agent's harness.
const STARTING_RUNS_SQL: &str = "
  SELECT a.adapter_type, (extract(epoch FROM hr.started_at) * 1000)::int8
  FROM public.heartbeat_runs hr
  JOIN public.agents a ON a.id = hr.agent_id
  WHERE hr.status = 'running' AND hr.session_id_after IS NULL AND hr.session_id_before IS NULL AND hr.started_at IS NOT NULL
";

const ACTIVE_COMPANIES_SQL: &str = "SELECT id::text FROM public.companies WHERE status = 'active'";

const RUN_LOG_SQL: &str = "SELECT log_store, log_ref FROM public.heartbeat_runs WHERE id::text = $1";

pub struct Paperclip {
    /// The instance folder, e.g. ~/.paperclip/instances/default.
    instance: Option<PathBuf>,
    connection: Option<String>,
    /// Its local server, for the attention feed (what agents wait on the person for).
    server: Option<String>,
}

impl Paperclip {
    pub fn new() -> Self {
        let root = std::env::var_os("PAPERCLIP_HOME").map(PathBuf::from).unwrap_or_else(|| super::home().join(".paperclip"));
        // The default instance first, then any other
        let mut instances: Vec<PathBuf> = fs::read_dir(root.join("instances"))
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default();
        instances.sort_by_key(|path| path.file_name().is_none_or(|name| name != "default"));
        let found = instances.into_iter().find_map(|instance| {
            let config: Value = serde_json::from_slice(&fs::read(instance.join("config.json")).ok()?).ok()?;
            let connection = config.pointer("/database/connectionString")?.as_str()?.to_owned();
            let server = server_url(&instance, &config);
            Some((instance, connection, server))
        });
        match found {
            Some((instance, connection, server)) => Self { instance: Some(instance), connection: Some(connection), server },
            None => Self { instance: None, connection: None, server: None },
        }
    }

    /// Runs `query` on a shared connection, reconnecting once if the connection dropped.
    pub(crate) fn with_client<T>(&self, query: impl Fn(&mut Client) -> Result<T, postgres::Error>) -> Result<T, String> {
        static CLIENT: Mutex<Option<Client>> = Mutex::new(None);
        let connection = self.connection.as_deref().ok_or("No Paperclip database configured")?;
        let mut client = CLIENT.lock().map_err(|_| "Paperclip connection unavailable".to_owned())?;
        for attempt in 0..2 {
            if client.is_none() {
                let mut config = postgres::Config::from_str(connection).map_err(|error| error.to_string())?;
                config.connect_timeout(Duration::from_secs(2));
                *client = Some(config.connect(NoTls).map_err(|error| format!("Can't reach Paperclip's database: {error}"))?);
            }
            match query(client.as_mut().expect("connected above")) {
                Ok(result) => return Ok(result),
                Err(error) if attempt == 0 && error.is_closed() => *client = None,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("Can't reach Paperclip's database".to_owned())
    }

    fn read_agents(&self) -> Result<Vec<Agent>, String> {
        let rows = self.with_client(|client| client.query(AGENTS_SQL, &[]))?;
        let mut agents: Vec<Agent> = rows
            .iter()
            .map(|row| {
                let id: String = row.get(0);
                let status: String = row.get(2);
                let run_id: Option<String> = row.get(7);
                let run_status: Option<String> = row.get(8);
                let active = run_status.as_deref() == Some("running");
                let result: Option<String> = row.get(14);
                let prefix: Option<String> = row.get(18);
                Agent {
                    id: format!("paperclip:{id}"),
                    name: row.get(1),
                    activity_kind: activity_kind(&status, row.get(1), row.get(3), row.get(4)),
                    status,
                    last_run: run_id.map(|run_id| LastRun {
                        run_id: format!("{RUN_PREFIX}{run_id}"),
                        status: run_status.clone().unwrap_or_default(),
                        active,
                        started_at: row.get::<_, Option<i64>>(9).map(iso_from_millis),
                        finished_at: row.get::<_, Option<i64>>(10).map(iso_from_millis),
                        last_output_at: row.get::<_, Option<i64>>(11).map(iso_from_millis),
                        last_output_bytes: row.get::<_, Option<i64>>(12).map(|bytes| bytes.max(0) as u64),
                        summary: result.as_deref().and_then(summarize_run),
                        error: row.get::<_, Option<String>>(13).map(|error| tidy(&error)),
                        issue_identifier: row.get(15),
                        issue_title: row.get(16),
                    }),
                    source: ID,
                    // The model its harness session (e.g. OpenCode's) reported on its latest run, else its configured one
                    model: row.get(17),
                    // Its company, to tell apart agents with the same name
                    session_ref: Some(row.get(6)),
                    // Its page in Paperclip, under its company's prefix
                    open_url: self.server.as_ref().map(|server| match &prefix {
                        Some(prefix) => format!("{server}/{prefix}/agents/{id}"),
                        None => format!("{server}/agents/{id}"),
                    }),
                    ..Agent::default()
                }
            })
            .collect();
        name_by_company(&mut agents);
        let waiting = self.read_attention();
        for agent in &mut agents {
            agent.waiting_on = waiting.get(&agent.id).cloned();
        }
        Ok(agents)
    }

    /// What each agent is waiting on the person for, from Paperclip's attention feed (the Decisions
    /// page), by agent id: the first item's title. Read the way the plugin reads it (src/ui/index.tsx):
    /// credited to the agent that raised it, else the agent assigned to its issue; snoozed ones skipped.
    fn read_attention(&self) -> HashMap<String, String> {
        let mut waiting = HashMap::new();
        let Some(server) = &self.server else { return waiting };
        let Ok(rows) = self.with_client(|client| client.query(ACTIVE_COMPANIES_SQL, &[])) else { return waiting };
        let http: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(2))).build().into();
        let now = crate::time::now_millis();
        for row in rows {
            let company: String = row.get(0);
            let url = format!("{server}/api/companies/{company}/attention");
            let Ok(mut response) = http.get(&url).call() else { continue };
            let Ok(body) = response.body_mut().read_json::<Value>() else { continue };
            for item in body.get("items").and_then(Value::as_array).into_iter().flatten() {
                let snoozed = item.get("snoozedUntil").and_then(Value::as_str).and_then(crate::time::millis_from_iso);
                if snoozed.is_some_and(|until| until > now) {
                    continue;
                }
                let agent = item
                    .pointer("/subject/metadata/agentId")
                    .or_else(|| item.pointer("/relatedIssue/metadata/assigneeAgentId"))
                    .and_then(Value::as_str);
                let Some(agent) = agent else { continue };
                let title = item.pointer("/subject/title").and_then(Value::as_str).unwrap_or("Waiting on your decision");
                waiting.entry(format!("paperclip:{agent}")).or_insert_with(|| title.to_owned());
            }
        }
        waiting
    }

    /// Paperclip's own page for an issue ("DEL-776": under the DEL company), else its dashboard.
    pub fn page_url(&self, issue: Option<&str>) -> Option<String> {
        let server = self.server.as_ref()?;
        Some(match issue.and_then(|issue| Some((issue.split_once('-')?.0, issue))) {
            Some((prefix, issue)) => format!("{server}/{prefix}/issues/{issue}"),
            None => server.clone(),
        })
    }

    fn read_stats(&self, since: i64) -> Result<HashMap<String, Usage>, String> {
        // Rounded to a minute, so the per-agent calls of one refresh share a query
        let since = since - since.rem_euclid(60_000);
        static CACHE: Mutex<Option<(i64, Instant, HashMap<String, Usage>)>> = Mutex::new(None);
        if let Ok(cache) = CACHE.lock() {
            if let Some((cached_since, at, stats)) = cache.as_ref() {
                if *cached_since == since && at.elapsed() < STATS_TTL {
                    return Ok(stats.clone());
                }
            }
        }
        let rows = self.with_client(|client| client.query(STATS_SQL, &[&(since as f64)]))?;
        let count = |value: i64| value.max(0) as u64;
        let stats: HashMap<String, Usage> = rows
            .iter()
            .map(|row| {
                (
                    format!("paperclip:{}", row.get::<_, String>(0)),
                    Usage {
                        issues_done: count(row.get(1)),
                        runs: count(row.get(2)),
                        active_seconds: row.get::<_, f64>(3).max(0.0).round() as u64,
                        input_tokens: count(row.get(4)),
                        cached_input_tokens: count(row.get(5)),
                        output_tokens: count(row.get(6)),
                    },
                )
            })
            .collect();
        if let Ok(mut cache) = CACHE.lock() {
            *cache = Some((since, Instant::now(), stats.clone()));
        }
        Ok(stats)
    }

    fn run_log_path(&self, run_id: &str) -> Option<PathBuf> {
        let run_id = run_id.strip_prefix(RUN_PREFIX)?;
        let rows = self.with_client(|client| client.query(RUN_LOG_SQL, &[&run_id])).ok()?;
        let row = rows.first()?;
        let (store, log_ref): (Option<String>, Option<String>) = (row.get(0), row.get(1));
        if store.as_deref() != Some("local_file") {
            return None;
        }
        run_log_file(self.instance.as_ref()?, &log_ref?)
    }
}

impl Source for Paperclip {
    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Paperclip"
    }

    fn location(&self) -> String {
        self.connection.clone().unwrap_or_else(|| "~/.paperclip".into())
    }

    fn detect(&self) -> bool {
        self.connection.is_some()
    }

    fn agents(&self) -> Vec<Agent> {
        self.read_agents().unwrap_or_default()
    }

    fn problem(&self) -> Option<String> {
        self.read_agents().err()
    }

    fn watch_paths(&self) -> Vec<PathBuf> {
        self.instance.iter().map(|instance| instance.join("data/run-logs")).collect()
    }

    fn read_log(&self, run_id: &str, offset: u64, limit: u64) -> Option<String> {
        let mut file = fs::File::open(self.run_log_path(run_id)?).ok()?;
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut bytes = Vec::new();
        file.take(limit).read_to_end(&mut bytes).ok()?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }

    fn usage(&self, agent: &Agent, since: i64) -> Usage {
        self.read_stats(since).ok().and_then(|stats| stats.get(&agent.id).copied()).unwrap_or_default()
    }


    fn claims(&self) -> Claims {
        let mut claims = Claims::default();
        if let Ok(rows) = self.with_client(|client| client.query(CLAIMED_SESSIONS_SQL, &[])) {
            for row in rows {
                claims.session_ids.extend([row.get::<_, Option<String>>(0), row.get::<_, Option<String>>(1)].into_iter().flatten());
            }
        }
        if let Ok(rows) = self.with_client(|client| client.query(STARTING_RUNS_SQL, &[])) {
            claims.starting_runs = rows
                .iter()
                .filter_map(|row| Some((harness_source(row.get::<_, Option<String>>(0)?.as_str())?, row.get::<_, Option<i64>>(1)?)))
                .collect();
        }
        claims
    }
}

/// The instance's local server: where it says it's running, else its configured host and port.
fn server_url(instance: &Path, config: &Value) -> Option<String> {
    let running: Option<Value> = fs::read(instance.join("runtime-info.json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
    if let Some(url) = running.as_ref().and_then(|info| info.get("dashboardUrl")).and_then(Value::as_str) {
        return Some(url.trim_end_matches('/').to_owned());
    }
    let host = config.pointer("/server/host").and_then(Value::as_str).unwrap_or("127.0.0.1");
    let port = config.pointer("/server/port").and_then(Value::as_u64)?;
    Some(format!("http://{host}:{port}"))
}

/// The OfficeSim source of a Paperclip adapter type.
fn harness_source(adapter_type: &str) -> Option<&'static str> {
    match adapter_type {
        "opencode_local" => Some(super::opencode::ID),
        "claude_local" => Some(super::claude::ID),
        "gemini_local" => Some(super::gemini::ID),
        "codex_local" => Some(super::codex::ID),
        "cursor" | "cursor_local" => Some(super::cursor::ID),
        _ => None,
    }
}

/// Agents with the same name in different companies get their company's name too.
fn name_by_company(agents: &mut [Agent]) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for agent in agents.iter() {
        *counts.entry(agent.name.clone()).or_default() += 1;
    }
    for agent in agents.iter_mut() {
        let company = agent.session_ref.take();
        if counts[&agent.name] > 1 {
            if let Some(company) = company {
                agent.name = format!("{} ({company})", agent.name);
            }
        }
    }
}

/// Where in the office an agent works, from what it does. The plugin worker's inferActivityKind.
fn activity_kind(status: &str, name: &str, title: &str, role: &str) -> ActivityKind {
    if status != "running" {
        return ActivityKind::Idle;
    }
    let text = format!("{name} {title} {role}").to_lowercase();
    let has = |words: &[&str]| words.iter().any(|word| text.contains(word));
    if has(&["research", "seo", "analyst"]) {
        ActivityKind::Research
    } else if has(&["copy", "content", "writer", "email"]) {
        ActivityKind::Writing
    } else if has(&["ceo", "cmo", "strateg"]) {
        ActivityKind::Meeting
    } else {
        ActivityKind::Coding
    }
}

/// Agents often open their final message with narration before the outcome.
const NARRATION: [&str; 9] = ["let me", "let's", "i'll", "i will", "i need to", "i'm going to", "now let", "now i", "first,"];

/// A run's summary from its result, in Paperclip's own order (summary, result, message), with any
/// opening narration paragraphs left out. The plugin worker's summarizeRun.
fn summarize_run(result_json: &str) -> Option<String> {
    let result: Value = serde_json::from_str(result_json).ok()?;
    ["summary", "result", "message"].iter().find_map(|key| {
        let value = result.get(key)?.as_str()?.trim();
        if value.is_empty() {
            return None;
        }
        let paragraphs: Vec<&str> = value.split("\n\n").map(str::trim).filter(|part| !part.is_empty()).collect();
        let outcome: Vec<&str> = paragraphs
            .iter()
            .copied()
            .filter(|part| {
                let lower = part.to_lowercase();
                !NARRATION.iter().any(|start| lower.starts_with(start))
            })
            .collect();
        Some(tidy(&if outcome.is_empty() { paragraphs } else { outcome }.join("\n")))
    })
}

fn tidy(text: &str) -> String {
    super::naming::tidy(text, SUMMARY_MAX_CHARS)
}

/// A run's log file from its log ref, only ever inside the instance's run logs folder.
fn run_log_file(instance: &Path, log_ref: &str) -> Option<PathBuf> {
    let log_ref = Path::new(log_ref);
    let plain = log_ref.components().all(|part| matches!(part, Component::Normal(_)));
    plain.then(|| instance.join("data/run-logs").join(log_ref))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_runs_without_narration() {
        let result = r#"{"summary":"Let me check the tests.\n\nFixed the **flaky** checkout test."}"#;
        assert_eq!(summarize_run(result).as_deref(), Some("Fixed the flaky checkout test."));
        assert_eq!(summarize_run(r#"{"message":"Done"}"#).as_deref(), Some("Done"));
        assert_eq!(summarize_run("{}"), None);
    }

    #[test]
    fn works_where_its_role_says() {
        assert_eq!(activity_kind("running", "Ada", "SEO Analyst", ""), ActivityKind::Research);
        assert_eq!(activity_kind("running", "CEO", "", "ceo"), ActivityKind::Meeting);
        assert_eq!(activity_kind("running", "Builder", "Engineer", ""), ActivityKind::Coding);
        assert_eq!(activity_kind("idle", "CEO", "", ""), ActivityKind::Idle);
    }

    #[test]
    fn names_namesakes_by_company() {
        let agent = |name: &str, company: &str| Agent { name: name.into(), session_ref: Some(company.into()), ..Agent::default() };
        let mut agents = vec![agent("CTO", "Delphina"), agent("CTO", "OfficeSim"), agent("CEO", "Delphina")];
        name_by_company(&mut agents);
        let names: Vec<&str> = agents.iter().map(|agent| agent.name.as_str()).collect();
        assert_eq!(names, ["CTO (Delphina)", "CTO (OfficeSim)", "CEO"]);
    }

    #[test]
    fn reads_logs_only_inside_the_run_logs_folder() {
        let instance = Path::new("/p/instances/default");
        assert_eq!(run_log_file(instance, "c/a/r.ndjson"), Some(PathBuf::from("/p/instances/default/data/run-logs/c/a/r.ndjson")));
        assert_eq!(run_log_file(instance, "../../etc/passwd"), None);
        assert_eq!(run_log_file(instance, "/etc/passwd"), None);
    }

    /// `cargo test -- --ignored --nocapture` prints this Mac's Paperclip agents.
    #[test]
    #[ignore]
    fn prints_this_macs_agents() {
        let source = Paperclip::new();
        println!("problem: {:?}", source.problem());
        for agent in source.agents() {
            println!("{}", serde_json::to_string(&agent).unwrap());
        }
        let claims = source.claims();
        println!("claims {} sessions, {} starting runs", claims.session_ids.len(), claims.starting_runs.len());
    }
}
