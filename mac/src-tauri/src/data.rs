//! The office UI's data keys and actions, answered from local agent sources. Keys without a local
//! source yet answer with the same empty shapes the plugin worker returns when it has no data.

use crate::sources;
use crate::tasks;
use crate::time::now_millis;
use serde_json::{json, Value};

/// The UI reads logs in chunks of a few hundred KB; more than this in one go is a mistake.
const MAX_LOG_READ: u64 = 4 * 1024 * 1024;

/// Reads what the slow panels need, so it's ready before anyone clicks on them.
///
/// Reading GitHub takes a second or so, which is long enough to feel slow when you click a tab.
/// Doing it while the office is opening means the tab has its numbers straight away.
pub fn warm_up() {
    let repos = crate::github::tracked_repos();
    if repos.is_empty() {
        return;
    }
    // The open issues, the closed ones and the pull requests, all side by side
    let _ = crate::github::issues_for_repos(&repos, "open");
    let _ = crate::github::issues_for_repos(&repos, "closed");
    // The work in progress: which issues are being worked on
    let _ = crate::work::look();
    // The git activity of every folder
    let _ = crate::git_activity::git_commits();
}

pub fn get(key: &str, params: &Value) -> Result<Value, String> {
    let range = params.get("range").and_then(Value::as_str).unwrap_or("7d");
    Ok(match key {
        "camera-room" => json!({ "room": "Office", "agents": sources::agents() }),
        "character-settings" => {
            let agents: Vec<Value> = sources::agents()
                .into_iter()
                .map(|agent| json!({ "id": agent.id, "name": agent.name, "status": agent.status, "urlKey": agent.url_key }))
                .collect();
            json!({ "agents": agents })
        }
        "agent-stats" => {
            let hours = match range {
                "24h" => 24,
                "30d" => 24 * 30,
                _ => 24 * 7,
            };
            let since = now_millis() - hours * 60 * 60 * 1000;
            let agents: Vec<Value> = sources::agents_with_usage(since)
                .into_iter()
                .map(|(agent, usage)| {
                    json!({
                        "id": agent.id,
                        "name": agent.name,
                        "source": agent.source,
                        "model": agent.model,
                        "status": agent.status,
                        "issuesDone": usage.issues_done,
                        "activeSeconds": usage.active_seconds,
                        "runs": usage.runs,
                        "inputTokens": usage.input_tokens,
                        "cachedInputTokens": usage.cached_input_tokens,
                        "outputTokens": usage.output_tokens,
                        "lastRunFinishedAt": agent.last_run.and_then(|run| run.finished_at),
                        // No source can start a run yet (Claude Code sessions are started by a person)
                        "canStart": false,
                    })
                })
                .collect();
            json!({ "range": if hours == 24 { "24h" } else if hours == 24 * 30 { "30d" } else { "7d" }, "agents": agents })
        }
        "game-high-scores" => json!({
            "range": range,
            "leaderboards": { "arcade": [], "pool": [], "pingpong": [] },
            "leisureByAgent": {},
            "topPotters": [],
        }),
        "scorecard" => json!({ "scorecard": null }),
        "kanban-board" => tasks::kanban_board(),
        "issues-board" => crate::issues_board::issues_board(),
        "issues-done" => tasks::issues_done(),
        "done-tasks" => tasks::done_tasks(),
        "closed-issues" => crate::closed_issues::closed_issues(),
        "git-log" => json!({ "state": "unconfigured" }),
        "git-activity" => crate::git_activity::git_activity(),
        "git-commits" => crate::git_activity::git_commits(),
        "wall-charts" => json!({ "charts": {} }),
        "logins" => json!({ "live": false, "recent": [] }),
        // The Settings tab's agent sources, to turn on and off
        "harnesses" => json!({ "harnesses": sources::harnesses(), "taskSources": tasks::infos() }),
        // Paperclip's attention feed (/api/companies/:id/attention), which puts a decision bubble
        // over agents waiting on a person
        "attention" => {
            let items: Vec<Value> = sources::agents()
                .into_iter()
                .filter_map(|agent| {
                    let title = agent.waiting_on?;
                    Some(json!({ "subject": { "title": title, "metadata": { "agentId": agent.id } } }))
                })
                .collect();
            json!({ "items": items })
        }
        _ => return Err(format!("Unknown data key: {key}")),
    })
}

/// Part of a run's log, like Paperclip's /heartbeat-runs/:id/log: `limit` bytes from `offset`.
pub fn run_log(run_id: &str, offset: u64, limit: u64) -> Result<Value, String> {
    let content = sources::read_log(run_id, offset, limit.min(MAX_LOG_READ)).ok_or_else(|| format!("No log for run {run_id}"))?;
    Ok(json!({ "content": content }))
}

pub fn act(key: &str, params: &Value) -> Result<Value, String> {
    match key {
        // Game scores aren't kept yet; the office plays on regardless
        "record-game" => Ok(json!({ "recorded": false })),
        "set-harness-enabled" => {
            let id = params.get("id").and_then(Value::as_str).ok_or("Which source?")?;
            let enabled = params.get("enabled").and_then(Value::as_bool).ok_or("On or off?")?;
            crate::settings::set_source_enabled(id, enabled)?;
            sources::forget_agents();
            Ok(json!({ "id": id, "enabled": enabled }))
        }
        // The office's links (Paperclip routes): agents open where they run, issues in Paperclip
        "navigate" => {
            let route = params.get("to").and_then(Value::as_str).ok_or("Where to?")?;
            crate::open::navigate(route)?;
            Ok(Value::Null)
        }
        // A new issue on one of the repos the agents work in
        "create-issue" => {
            let repo = params.get("repo").and_then(Value::as_str).ok_or("Which repo?")?;
            let title = params.get("title").and_then(Value::as_str).ok_or("The issue needs a title.")?;
            let body = params.get("body").and_then(Value::as_str);
            let labels: Vec<String> = params
                .get("labels")
                .and_then(Value::as_array)
                .map(|labels| labels.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default();
            let number = crate::github::create_issue(repo, title, body, &labels)?;
            Ok(json!({
                "repo": repo,
                "number": number,
                "identifier": format!("{repo}#{number}"),
                "url": format!("https://github.com/{repo}/issues/{number}"),
            }))
        }
        // Read GitHub again now, rather than waiting for the two-minute sync.
        //
        // The Issues tab's refresh button asks for this: the answers are kept for a couple of
        // minutes, and someone who has just changed something on GitHub wants to see it now.
        "refresh-github" => {
            crate::github::forget_all();
            crate::work::forget();
            Ok(json!({ "refreshed": true }))
        }
        _ => Err(format!("{key} isn't available in OfficeSim for Mac yet")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_ui_key_answers() {
        for key in ["camera-room", "character-settings", "agent-stats", "game-high-scores", "scorecard", "kanban-board", "issues-board", "issues-done", "done-tasks", "git-log", "git-activity", "wall-charts", "logins", "attention", "harnesses"] {
            assert!(get(key, &json!({})).is_ok(), "{key}");
        }
    }

    /// `cargo test -- --ignored --nocapture` reads GitHub again now.
    #[test]
    #[ignore]
    fn prints_the_refresh() {
        let result = act("refresh-github", &json!({})).unwrap();
        println!("refresh: {result}");
    }

    /// `cargo test -- --ignored --nocapture` prints the toolbar's Done count.
    #[test]
    #[ignore]
    fn prints_this_macs_done() {
        let done = get("issues-done", &json!({})).unwrap();
        println!("done total: {}", done["total"]);
        println!("done windows: {}", done["windows"]);
        println!("done recent: {}", done["recent"].as_array().unwrap().len());
    }

    /// `cargo test -- --ignored --nocapture` prints the boardroom's own kanban board.
    #[test]
    #[ignore]
    fn prints_this_macs_kanban() {
        let board = get("kanban-board", &json!({})).unwrap();
        for column in board["columns"].as_array().unwrap() {
            let issues = column["issues"].as_array().unwrap();
            println!("  {}: {}", column["status"], issues.len());
            for issue in issues.iter().take(2) {
                println!("      {} working={}", issue["identifier"], issue["workingAgent"]);
            }
        }
    }

    /// `cargo test -- --ignored --nocapture` prints the closed issues.
    #[test]
    #[ignore]
    fn prints_this_macs_closed() {
        let closed = get("closed-issues", &json!({})).unwrap();
        println!("closed issues: {}", closed["issues"].as_array().unwrap().len());
        println!("problems: {}", closed["problems"]);
        for issue in closed["issues"].as_array().unwrap().iter().take(3) {
            println!("  {} {} repo={} closed={}", issue["identifier"], issue["title"], issue["repo"], issue["completedAt"]);
        }
    }

    /// `cargo test -- --ignored --nocapture` prints the Issues tab's board and the git activity.
    #[test]
    #[ignore]
    fn prints_this_macs_issues_board() {
        let board = get("issues-board", &json!({})).unwrap();
        println!("repos: {}", board["repos"]);
        for column in board["columns"].as_array().unwrap() {
            let status = column["status"].as_str().unwrap_or("");
            let issues = column["issues"].as_array().unwrap();
            println!("  {status}: {}", issues.len());
            for issue in issues.iter().take(6) {
                println!(
                    "    {} {} [{}] status={} by={} labels={} comments={} updated={}",
                    issue["identifier"].as_str().unwrap_or(""),
                    issue["title"].as_str().unwrap_or(""),
                    issue["priority"].as_str().unwrap_or(""),
                    issue["status"].as_str().unwrap_or(""),
                    issue["workingAgent"].as_str().unwrap_or("-"),
                    issue["labels"],
                    issue["comments"],
                    issue["updatedAt"],
                );
            }
        }
        let activity = get("git-activity", &json!({})).unwrap();
        println!("repos with git: {}", activity["repos"].as_array().unwrap().len());
        for repo in activity["repos"].as_array().unwrap() {
            println!("  {} ({}): {} commits, {} changed files", repo["name"].as_str().unwrap_or(""), repo["branch"].as_str().unwrap_or("?"), repo["commits"].as_array().unwrap().len(), repo["changes"]["files"]);
        }
    }

    /// `cargo test -- --ignored --nocapture` prints the Agents tab's rows for this Mac.
    #[test]
    #[ignore]
    fn prints_this_macs_agent_stats() {
        for agent in get("agent-stats", &json!({ "range": "7d" })).unwrap()["agents"].as_array().unwrap() {
            println!("{agent}");
        }
    }

    /// `cargo test -- --ignored --nocapture` prints this Mac's agent sources and the office's agents.
    #[test]
    #[ignore]
    fn prints_this_macs_office() {
        let started = std::time::Instant::now();
        let room = get("camera-room", &json!({})).unwrap();
        eprintln!("camera-room took {:?}", started.elapsed());
        let started = std::time::Instant::now();
        let _ = get("agent-stats", &json!({ "range": "7d" })).unwrap();
        eprintln!("agent-stats took {:?}", started.elapsed());
        drop(room);
        println!("{}", get("harnesses", &json!({})).unwrap());
        for agent in get("camera-room", &json!({})).unwrap()["agents"].as_array().unwrap() {
            println!("{agent}");
        }
    }

    /// Writes the settings file under $HOME, so it's run on its own with a throwaway HOME (and an
    /// OpenCode database there to detect):
    /// `RUSTUP_HOME=~/.rustup CARGO_HOME=~/.cargo HOME=<temp dir> cargo test toggles_sources -- --ignored`
    #[test]
    #[ignore]
    fn toggles_sources_off_and_on() {
        let enabled = |id: &str| {
            get("harnesses", &json!({})).unwrap()["harnesses"].as_array().unwrap().iter().find(|h| h["id"] == id).unwrap()["enabled"].as_bool().unwrap()
        };
        assert!(enabled("opencode"));
        act("set-harness-enabled", &json!({ "id": "opencode", "enabled": false })).unwrap();
        assert!(!enabled("opencode"));
        assert!(crate::sources::active().iter().all(|source| source.id() != "opencode"));
        act("set-harness-enabled", &json!({ "id": "opencode", "enabled": true })).unwrap();
        assert!(enabled("opencode"));
        let saved = std::fs::read_to_string(crate::sources::home().join("Library/Application Support/com.officesim.mac/settings.json")).unwrap();
        assert!(saved.contains("disabledSources"), "{saved}");
    }
}
