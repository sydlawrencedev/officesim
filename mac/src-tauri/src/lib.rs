mod data;
mod git_activity;
mod github;
mod issues_board;
mod model;
mod monitor;
mod music;
mod open;
mod settings;
mod sources;
mod tasks;
mod time;
mod watcher;

use serde_json::Value;
use tauri::Emitter;

/// Answers the office UI's data keys (the ones the Paperclip plugin worker answers in Paperclip).
#[tauri::command]
fn get_data(app: tauri::AppHandle, key: String, params: Value) -> Result<Value, String> {
    if key == "app-settings" {
        return Ok(serde_json::json!({ "launchAtLogin": monitor::launch_at_login(&app), "notifyWaiting": settings::notify_waiting() }));
    }
    data::get(&key, &params)
}

/// Runs an office UI action (recording a game, following a link...).
#[tauri::command]
fn run_action(app: tauri::AppHandle, key: String, params: Value) -> Result<Value, String> {
    // The app's own settings, which need the app
    match key.as_str() {
        "set-launch-at-login" => {
            let enabled = params.get("enabled").and_then(Value::as_bool).ok_or("On or off?")?;
            monitor::set_launch_at_login(&app, enabled)?;
            monitor::nudge();
            return Ok(Value::Null);
        }
        "set-notify-waiting" => {
            let enabled = params.get("enabled").and_then(Value::as_bool).ok_or("On or off?")?;
            settings::set_notify_waiting(enabled)?;
            monitor::nudge();
            return Ok(Value::Null);
        }
        "toggle-mini-camera" => {
            monitor::toggle_mini(&app);
            return Ok(Value::Null);
        }
        _ => {}
    }
    let result = data::act(&key, &params)?;
    // Turning a source on or off changes who's in the office
    if key == "set-harness-enabled" {
        let _ = app.emit(watcher::AGENTS_CHANGED, ());
    }
    Ok(result)
}

/// A chunk of a run's log, for the live speech bubbles (Paperclip's /heartbeat-runs/:id/log).
#[tauri::command]
fn read_run_log(run_id: String, offset: u64, limit_bytes: u64) -> Result<Value, String> {
    data::run_log(&run_id, offset, limit_bytes)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![monitor::HIDDEN_ARG])))
        .invoke_handler(tauri::generate_handler![get_data, run_action, read_run_log, music::start_music, music::stop_music, music::music_permission])
        .setup(|app| {
            watcher::start(app.handle().clone());
            monitor::start(app.handle().clone());
            // Started at login, it waits in the menu bar; otherwise the office opens
            if !std::env::args().any(|arg| arg == monitor::HIDDEN_ARG) {
                monitor::show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the office leaves OfficeSim in the menu bar; Quit is in its menu
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building OfficeSim")
        .run(|app, event| {
            // Clicking the Dock icon brings the office back
            if let tauri::RunEvent::Reopen { .. } = event {
                monitor::show_main(app);
            }
        });
}
