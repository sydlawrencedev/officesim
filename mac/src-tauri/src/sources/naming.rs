//! Agent names for harnesses that run sessions in project folders (Claude Code, OpenCode, Gemini):
//! the project ("Agent Pixels"), numbered by start time when a project has several sessions. Which
//! harness an agent runs in shows as its icon, not in its name.

use crate::model::Agent;
use std::collections::HashMap;
use std::path::Path;

/// Longest project name in an agent's name, before any number.
const PROJECT_NAME_MAX_CHARS: usize = 20;

/// "Agent Pixels" for a session in .../agent-pixels. Without a project folder (or in /), the
/// harness's name.
pub fn project_name(harness: &str, cwd: Option<&str>) -> String {
    let project = cwd.and_then(project_folder).map(|folder| title_case(&folder)).unwrap_or_default();
    let project: String = project.chars().take(PROJECT_NAME_MAX_CHARS).collect();
    match project.trim_end() {
        "" => harness.to_owned(),
        project => project.to_owned(),
    }
}

/// The project's folder name. A worktree Claude Code made (`<repo>/.claude/worktrees/<name>`)
/// belongs to its repo's project.
pub fn project_folder(cwd: &str) -> Option<String> {
    let path = Path::new(cwd);
    let root = path
        .ancestors()
        .find(|dir| dir.parent().is_some_and(|parent| parent.ends_with(".claude/worktrees")))
        .and_then(|worktree| worktree.parent()?.parent()?.parent())
        .unwrap_or(path);
    Some(root.file_name()?.to_string_lossy().into_owned())
}

/// "agent-pixels" to "Agent Pixels".
pub fn title_case(folder: &str) -> String {
    folder
        .split(|c: char| c == '-' || c == '_' || c == '.' || c.is_whitespace())
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map(|first| first.to_uppercase().chain(chars).collect::<String>()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Several sessions with one name get numbered, oldest first: "Agent Pixels 1", "Agent Pixels 2".
pub fn number_namesakes(agents: &mut [Agent]) {
    let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, agent) in agents.iter().enumerate() {
        by_name.entry(agent.name.clone()).or_default().push(index);
    }
    for indexes in by_name.into_values().filter(|indexes| indexes.len() > 1) {
        let mut ordered = indexes;
        ordered.sort_by(|&a, &b| start_key(&agents[a]).cmp(&start_key(&agents[b])).then_with(|| agents[a].id.cmp(&agents[b].id)));
        for (number, index) in ordered.into_iter().enumerate() {
            agents[index].name = format!("{} {}", agents[index].name, number + 1);
        }
    }
}

/// When an agent's session started, for numbering; unknown starts sort last.
fn start_key(agent: &Agent) -> (bool, String) {
    let started = agent.last_run.as_ref().and_then(|run| run.started_at.clone());
    (started.is_none(), started.unwrap_or_default())
}

/// Markdown flattened to one line and shortened, like the UI's tidy() in runOutput.ts.
pub fn tidy(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut in_code = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        let line = line.trim_start().trim_start_matches(['#', '>']).trim_start();
        let line = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")).unwrap_or(line);
        out.push_str(&line.replace(['*', '`'], ""));
        out.push(' ');
    }
    let flat = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let cut: String = flat.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// The first question in a question tool's input (`{questions: [{question}]}`, as Claude Code's
/// AskUserQuestion and OpenCode's question tool have it), tidied.
pub fn question_text(input: Option<&serde_json::Value>) -> Option<String> {
    let question = input?.pointer("/questions/0/question")?.as_str()?.trim();
    (!question.is_empty()).then(|| tidy(question, QUESTION_MAX_CHARS))
}

/// Longest question shown in a decision bubble's tooltip.
const QUESTION_MAX_CHARS: usize = 200;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_agents_after_their_project() {
        assert_eq!(project_name("Claude", Some("/Users/me/code/agent-pixels")), "Agent Pixels");
        assert_eq!(project_name("Claude", Some("/Users/me/code/my_app.v2")), "My App V2");
        assert_eq!(project_name("Claude", Some("/Users/me/code/a-really-long-project-name-here")), "A Really Long Projec");
        assert_eq!(project_name("Claude", Some("/Users/me/delphina/.claude/worktrees/agitated-darwin-eca7cb")), "Delphina");
        assert_eq!(project_name("Claude", Some("/Users/me/delphina/.claude/worktrees/agitated-darwin/mac")), "Delphina");
        assert_eq!(project_name("OpenCode", Some("/")), "OpenCode");
        assert_eq!(project_name("Claude", None), "Claude");
    }

    #[test]
    fn tidies_markdown() {
        assert_eq!(tidy("# Done\n\n- **one**\n```\ncode\n```\n`two`", 100), "Done one two");
        assert_eq!(tidy("abcdefghij", 5), "abcd…");
    }
}
