//! The Mac app's own settings, kept as JSON in ~/Library/Application Support/com.officesim.mac.
//! (The office settings the UI edits are kept by the webview; these are the backend's.)

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    /// Agent sources turned off in the Settings tab; every detected source is on by default.
    #[serde(default)]
    disabled_sources: Vec<String>,
    /// Notify when an agent starts waiting on the person (on unless turned off).
    #[serde(default)]
    quiet: bool,
    /// The GitHub repos the office has seen an agent, an issue or any activity in.
    ///
    /// Remembered because the office only knows about a repo while an agent is in it, and a repo
    /// the agents have worked in but aren't in right now should still be one you can add an issue
    /// to.
    #[serde(default)]
    known_repos: Vec<String>,
}

fn path() -> PathBuf {
    crate::sources::home().join("Library/Application Support/com.officesim.mac/settings.json")
}

fn settings() -> &'static Mutex<Settings> {
    static SETTINGS: OnceLock<Mutex<Settings>> = OnceLock::new();
    SETTINGS.get_or_init(|| {
        let saved = std::fs::read(path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
        Mutex::new(saved.unwrap_or_default())
    })
}

pub fn source_enabled(id: &str) -> bool {
    settings().lock().map_or(true, |settings| !settings.disabled_sources.iter().any(|disabled| disabled == id))
}

pub fn set_source_enabled(id: &str, enabled: bool) -> Result<(), String> {
    update(|settings| {
        settings.disabled_sources.retain(|disabled| disabled != id);
        if !enabled {
            settings.disabled_sources.push(id.to_owned());
        }
    })
}

pub fn notify_waiting() -> bool {
    settings().lock().map_or(true, |settings| !settings.quiet)
}

pub fn set_notify_waiting(notify: bool) -> Result<(), String> {
    update(|settings| settings.quiet = !notify)
}

/// The GitHub repos the office has seen, so they stay available even when no agent is in them.
pub fn known_repos() -> Vec<String> {
    settings().lock().map(|settings| settings.known_repos.clone()).unwrap_or_default()
}

/// Remembers a GitHub repo, so it's still known after the agents leave it.
pub fn remember_repo(repo: &str) {
    if repo.is_empty() {
        return;
    }
    let _ = update(|settings| {
        if !settings.known_repos.iter().any(|known| known == repo) {
            settings.known_repos.push(repo.to_owned());
        }
    });
}

/// Changes the settings and saves them.
fn update(change: impl FnOnce(&mut Settings)) -> Result<(), String> {
    let mut settings = settings().lock().map_err(|_| "Settings are unavailable".to_owned())?;
    change(&mut settings);
    let path = path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_vec_pretty(&*settings).map_err(|error| error.to_string())?;
    std::fs::write(path, json).map_err(|error| error.to_string())
}
