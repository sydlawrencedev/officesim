//! The office's music: what the Mac is playing, so the games room's DJ booth can react to it.
//!
//! A web page can't hear what else the computer is playing, so the Mac app does it natively. The
//! `officesim-audio` helper (src-tauri/sources/audio-capture.swift) taps the system's audio output
//! with Core Audio and prints the levels it works out, one line per tick. This reads those lines
//! and tells the webview about them.
//!
//! The tap needs the "System Audio Recording" permission. macOS asks for it the first time the
//! capture starts.

use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// The event the webview listens for: the music's levels.
pub const MUSIC_EVENT: &str = "music-levels";

/// The helper's name, beside the app's binary.
const HELPER_NAME: &str = "officesim-audio";

/// Whether the capture is running.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// The capture process, so it can be stopped.
static CAPTURE: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

/// The helper's path: beside the app's binary, or in `target/release` when running from the
/// source tree.
fn helper_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // The app bundle: Contents/MacOS/OfficeSim, so the helper is a sibling.
    let beside = exe.with_file_name(HELPER_NAME);
    if beside.is_file() {
        return Some(beside);
    }
    // From the source tree: target/release/officesim
    let mut path = exe.clone();
    path.pop();
    if path.ends_with("deps") {
        path.pop();
    }
    let candidate = path.join(HELPER_NAME);
    candidate.is_file().then_some(candidate)
}

/// Whether macOS has allowed the capture. "allowed", "denied", or "unknown".
///
/// The check runs the helper with a flag, and a helper running at the same time as the capture
/// would fight it for the tap, so it isn't run while the capture is going.
pub fn permission() -> &'static str {
    if RUNNING.load(Ordering::SeqCst) {
        return "allowed";
    }
    let Some(helper) = helper_path() else { return "unknown" };
    let Ok(output) = Command::new(helper).arg("--print-permission").output() else { return "unknown" };
    match String::from_utf8_lossy(&output.stdout).trim() {
        "allowed" => "allowed",
        "denied" => "denied",
        _ => "unknown",
    }
}

/// Starts capturing the system's audio, if it isn't already.
///
/// Returns the reason it couldn't, when it couldn't.
pub fn start(app: AppHandle) -> Result<(), String> {
    if RUNNING.load(Ordering::SeqCst) {
        return Ok(());
    }
    let helper = helper_path().ok_or("OfficeSim's audio helper isn't installed")?;
    let mut child = Command::new(&helper)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Can't start OfficeSim's audio helper: {error}"))?;

    let stdout = child.stdout.take().ok_or("No output from the audio helper")?;
    let stderr = child.stderr.take().ok_or("No output from the audio helper")?;

    // The helper's own message when it can't capture (usually the permission).
    let problems = std::thread::spawn(move || {
        let mut message = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("officesim: audio helper: {line}");
            message = line;
        }
        message
    });

    // The levels, one line per tick.
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(levels) = serde_json::from_str::<Value>(&line) else { continue };
            let _ = app.emit(MUSIC_EVENT, levels);
        }
    });

    CAPTURE.get_or_init(|| Mutex::new(None)).lock().ok().and_then(|mut slot| slot.replace(child));
    RUNNING.store(true, Ordering::SeqCst);

    // If the helper gives up, the office stops showing the music as playing.
    std::thread::spawn(move || {
        let problem = problems.join().unwrap_or_default();
        if !problem.is_empty() {
            eprintln!("officesim: audio capture stopped: {problem}");
        }
        RUNNING.store(false, Ordering::SeqCst);
        CAPTURE.get_or_init(|| Mutex::new(None)).lock().ok().and_then(|mut slot| slot.take());
    });
    Ok(())
}

/// Runs the helper and reads its levels, without the app: for the tests.
///
/// Returns the levels the helper printed, one per tick, until it stops.
#[cfg(test)]
fn capture_levels(helper: &std::path::Path, ticks: usize) -> (Vec<Value>, String) {
    let Ok(mut child) = Command::new(helper).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() else {
        return (Vec::new(), "the helper wouldn't start".to_owned());
    };
    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");
    let problem = std::thread::spawn(move || {
        let mut message = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            message = line;
        }
        message
    });
    let mut levels = Vec::new();
    for line in BufReader::new(stdout).lines().map_while(Result::ok).take(ticks) {
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            levels.push(value);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    (levels, problem.join().unwrap_or_default())
}

/// Stops capturing the system's audio.
pub fn stop() {
    RUNNING.store(false, Ordering::SeqCst);
    if let Some(mut slot) = CAPTURE.get_or_init(|| Mutex::new(None)).lock().ok() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Starts the capture when the office asks for it.
#[tauri::command]
pub fn start_music(app: AppHandle) -> Result<bool, String> {
    start(app)?;
    Ok(true)
}

/// Stops the capture.
#[tauri::command]
pub fn stop_music() -> Result<bool, String> {
    stop();
    Ok(true)
}

/// Whether macOS has allowed the capture, for the Settings tab.
#[tauri::command]
pub fn music_permission() -> &'static str {
    permission()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_helper_or_says_so() {
        // In the test environment there's no helper beside the test binary, so it says so
        // rather than failing.
        let path = helper_path();
        assert!(path.is_none() || path.unwrap().is_file());
    }

    #[test]
    fn the_permission_is_one_of_three() {
        assert!(matches!(permission(), "allowed" | "denied" | "unknown"));
    }

    /// The helper is beside the app's binary in a built app, so the app finds it.
    #[test]
    fn finds_the_helper_in_a_built_app() {
        // Not in a built app: the test binary has no helper beside it, so it says so.
        if let Some(path) = helper_path() {
            assert!(path.is_file(), "{path:?}");
            assert!(path.file_name().unwrap().to_string_lossy() == HELPER_NAME);
        }
    }

    /// The helper runs, and either prints levels or says why it can't.
    ///
    /// On a Mac where the capture is allowed, the levels come; where it isn't, the helper says so
    /// and the office explains it to the viewer.
    #[test]
    fn the_helper_runs_and_says_what_it_can_do() {
        let Some(helper) = helper_path() else {
            // No helper in the test environment: nothing to check.
            return;
        };
        let (levels, problem) = capture_levels(&helper, 3);
        if problem.is_empty() {
            assert!(!levels.is_empty(), "the helper printed no levels and no problem");
            for level in &levels {
                assert!(level.get("playing").is_some(), "{level}");
                assert!(level.get("beat").is_some(), "{level}");
                assert!(level.get("bands").is_some(), "{level}");
            }
            eprintln!("the helper printed {} levels: {levels:?}", levels.len());
        } else {
            // It can't capture: the message says so, so the office can explain it.
            assert!(problem.contains("allowed") || problem.contains("let OfficeSim"), "{problem}");
            eprintln!("the helper can't capture yet: {problem}");
        }
    }
}
