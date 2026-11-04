//! Following the office's links, which are Paperclip routes in the shared UI: an agent opens where
//! it runs (its terminal tab, the app it runs in, or its Paperclip page), and issues open their
//! Paperclip page.

use crate::model::Agent;
use crate::sources::{self, Source};
use std::path::Path;
use std::process::Command;

/// Follows a route like "/agents/claude%3A1234" or "/issues/DEL-776".
pub fn navigate(route: &str) -> Result<(), String> {
    let route = percent_decode(route);
    if let Some(agent_id) = route.strip_prefix("/agents/") {
        return open_agent(agent_id);
    }
    let issue = route.strip_prefix("/issues/").ok_or("That's not a route OfficeSim knows")?;
    // A GitHub issue: "owner/repo#42"
    if let Some(url) = github_issue_url(issue) {
        return open_url(&url);
    }
    let paperclip = sources::paperclip::Paperclip::new();
    let url = paperclip.page_url(Some(issue)).ok_or("Paperclip isn't set up on this Mac")?;
    open_url(&url)
}

/// The web page of a GitHub issue named "owner/repo#42", when it looks like one.
fn github_issue_url(issue: &str) -> Option<String> {
    let (repo, number) = issue.split_once('#')?;
    let (owner, name) = repo.split_once('/')?;
    let number: u64 = number.parse().ok()?;
    if owner.is_empty() || name.is_empty() || owner.contains(char::is_whitespace) || name.contains(char::is_whitespace) {
        return None;
    }
    Some(format!("https://github.com/{owner}/{name}/issues/{number}"))
}

fn open_agent(agent_id: &str) -> Result<(), String> {
    let sources = sources::active();
    let (source, agent) = sources
        .iter()
        .find_map(|source| source.agents().into_iter().find(|agent| agent.id == agent_id).map(|agent| (source, agent)))
        .ok_or("That agent has left the office")?;
    if let Some(url) = &agent.open_url {
        return open_url(url);
    }
    let pid = agent.pid.or_else(|| process_for(source.as_ref(), &agent, &sources));
    match pid {
        Some(pid) => focus_process(pid),
        None => Err(format!("{} isn't running anywhere OfficeSim can open", agent.name)),
    }
}

/// The process of a harness working in the agent's folder. An orchestrator's agent is looked for
/// in the harness it runs in (from its run id, e.g. "claude:...").
fn process_for(source: &dyn Source, agent: &Agent, sources: &[Box<dyn Source>]) -> Option<u32> {
    let cwd = agent.cwd.as_deref()?;
    let pattern = source.process_pattern().or_else(|| {
        let harness = agent.last_run.as_ref()?.run_id.split_once(':')?.0;
        sources.iter().find(|candidate| candidate.id() == harness)?.process_pattern()
    })?;
    sources::processes_in(pattern).into_iter().find(|(_, folder)| same_folder(folder, Path::new(cwd))).map(|(pid, _)| pid)
}

fn same_folder(a: &Path, b: &Path) -> bool {
    let canonical = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    canonical(a) == canonical(b)
}

/// Brings forward the window a process runs in: its exact tab in Terminal or iTerm2, else the app.
fn focus_process(pid: u32) -> Result<(), String> {
    let app = owning_app(pid).ok_or("It isn't running in an app OfficeSim can bring forward (tmux or ssh?)")?;
    let tty = ps(pid, "tty=").map(|tty| format!("/dev/{tty}")).filter(|tty| tty != "/dev/??");
    let name = Path::new(&app).file_stem().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    match (name.as_str(), tty) {
        ("Terminal", Some(tty)) => osascript(&format!(
            r#"tell application "Terminal"
                 repeat with w in windows
                   repeat with t in tabs of w
                     if tty of t is "{tty}" then
                       set selected of t to true
                       set index of w to 1
                       activate
                       return
                     end if
                   end repeat
                 end repeat
               end tell"#
        )),
        ("iTerm" | "iTerm2", Some(tty)) => osascript(&format!(
            r#"tell application "iTerm2"
                 repeat with w in windows
                   repeat with t in tabs of w
                     repeat with s in sessions of t
                       if tty of s is "{tty}" then
                         select w
                         select t
                         select s
                         activate
                         return
                       end if
                     end repeat
                   end repeat
                 end repeat
               end tell"#
        )),
        _ => run("/usr/bin/open", &[&app]),
    }
}

/// The .app a process runs under, from its parents: e.g. /Applications/iTerm.app. The walk starts
/// at the parent, since harnesses can ship as apps themselves (Claude Code's CLI is a claude.app).
fn owning_app(pid: u32) -> Option<String> {
    let mut current: u32 = ps(pid, "ppid=")?.parse().ok()?;
    for _ in 0..32 {
        let command = ps(current, "comm=")?;
        if let Some(end) = command.find(".app/") {
            return Some(command[..end + 4].to_owned());
        }
        let parent: u32 = ps(current, "ppid=")?.parse().ok()?;
        if parent <= 1 {
            return None;
        }
        current = parent;
    }
    None
}

fn ps(pid: u32, field: &str) -> Option<String> {
    let output = Command::new("/bin/ps").args(["-o", field, "-p", &pid.to_string()]).output().ok()?;
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn open_url(url: &str) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("Not a web page: {url}"));
    }
    run("/usr/bin/open", &[url])
}

fn osascript(script: &str) -> Result<(), String> {
    run("/usr/bin/osascript", &["-e", script])
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program).args(args).output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

/// "%3A" as ":", for agent ids the UI URL-encodes.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let decoded = (bytes[at] == b'%').then(|| text.get(at + 1..at + 3).and_then(|hex| u8::from_str_radix(hex, 16).ok())).flatten();
        match decoded {
            Some(byte) => {
                out.push(byte);
                at += 3;
            }
            None => {
                out.push(bytes[at]);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_routes() {
        assert_eq!(percent_decode("/agents/claude%3Aab-12"), "/agents/claude:ab-12");
        assert_eq!(percent_decode("/issues/DEL-776"), "/issues/DEL-776");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn finds_the_app_a_process_runs_in() {
        // This test runs under some app or none; either way the walk ends cleanly
        let app = owning_app(std::process::id());
        assert!(app.as_deref().is_none_or(|app| app.ends_with(".app")));
    }

    #[test]
    fn only_opens_web_pages() {
        assert!(open_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn temp_debug_navigate() {
        // What the UI sends for a GitHub issue: the identifier, URL-encoded
        let route = "/issues/sydlawrencedev%2Fdelphina%23497";
        let decoded = percent_decode(route);
        eprintln!("decoded = {decoded}");
        let issue = decoded.strip_prefix("/issues/").unwrap();
        eprintln!("issue = {issue}");
        eprintln!("url = {:?}", github_issue_url(issue));
    }

    #[test]
    fn tells_github_issues_from_paperclip_ones() {
        assert_eq!(
            github_issue_url("owner/repo#42"),
            Some("https://github.com/owner/repo/issues/42".to_owned())
        );
        // Paperclip's own identifiers aren't GitHub issues
        assert_eq!(github_issue_url("DEL-776"), None);
        assert_eq!(github_issue_url("owner/repo#notanumber"), None);
        assert_eq!(github_issue_url("norepo#42"), None);
    }
}
