//! Tells the office UI when an agent source's files change, so it re-reads agents right away
//! instead of waiting for its next poll.

use crate::sources;
use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// The event the UI listens for (AGENTS_CHANGED_EVENT in mac/src/host/bridge.ts).
pub const AGENTS_CHANGED: &str = "agents-changed";
/// Harnesses write their transcripts in bursts; one refresh per burst is plenty.
const DEBOUNCE: Duration = Duration::from_millis(750);

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut debouncer = match new_debouncer(DEBOUNCE, tx) {
            Ok(debouncer) => debouncer,
            Err(error) => {
                eprintln!("officesim: can't watch agent files: {error}");
                return;
            }
        };
        for source in sources::detected() {
            for path in source.watch_paths().into_iter().filter(|path| path.exists()) {
                if let Err(error) = debouncer.watcher().watch(&path, RecursiveMode::Recursive) {
                    eprintln!("officesim: can't watch {} for {}: {error}", path.display(), source.id());
                }
            }
        }
        for events in rx {
            if events.is_ok() {
                let _ = app.emit(AGENTS_CHANGED, ());
                crate::monitor::nudge();
            }
        }
    });
}
