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
