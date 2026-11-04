//! The app around the office: the menu bar icon (who's working, who's waiting on you, and quick
//! ways in), a macOS notification when an agent starts waiting on you, the always-on-top mini
//! camera window, and launch at login. Closing the main window leaves OfficeSim in the menu bar.

use crate::model::Agent;
use crate::{settings, sources};
use std::collections::HashSet;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;

/// How often the menu bar looks again without a file change prompting it.
const TICK: Duration = Duration::from_secs(5);
const TRAY_ID: &str = "officesim";
const MINI_LABEL: &str = "mini";
/// Started at login: stay in the menu bar until opened.
pub const HIDDEN_ARG: &str = "--hidden";

/// Wakes the monitor early (an agent source's files changed).
static NUDGE: OnceLock<Mutex<Sender<()>>> = OnceLock::new();

pub fn nudge() {
    if let Some(sender) = NUDGE.get().and_then(|sender| sender.lock().ok()) {
        let _ = sender.send(());
    }
}

pub fn start(app: AppHandle) {
    let (sender, receiver) = channel();
    let _ = NUDGE.set(Mutex::new(sender));
    let tray = match TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().expect("the app has an icon"))
        .icon_as_template(false)
        .tooltip("OfficeSim")
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .build(&app)
    {
        Ok(tray) => tray,
        Err(error) => {
            eprintln!("officesim: no menu bar icon: {error}");
            return;
        }
    };
    std::thread::spawn(move || {
        // Agents waiting on the person at the last look; the first look only takes note
        let mut waiting: Option<HashSet<String>> = None;
        loop {
            let agents = sources::agents();
            let now_waiting: HashSet<String> = agents.iter().filter(|agent| agent.waiting_on.is_some()).map(|agent| agent.id.clone()).collect();
            if let Some(before) = &waiting {
                for agent in agents.iter().filter(|agent| agent.waiting_on.is_some() && !before.contains(&agent.id)) {
                    notify_waiting(&app, agent);
                }
            }
            waiting = Some(now_waiting);
            update_tray(&app, &tray, &agents);
            match receiver.recv_timeout(TICK) {
                Ok(()) | Err(RecvTimeoutError::Timeout) => {
                    // Several nudges in a row are one look
                    while receiver.try_recv().is_ok() {}
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}

fn notify_waiting(app: &AppHandle, agent: &Agent) {
    if !settings::notify_waiting() {
        return;
    }
    let reason = agent.waiting_on.clone().unwrap_or_default();
    let _ = app.notification().builder().title(format!("{} needs you", agent.name)).body(reason).show();
}

fn update_tray(app: &AppHandle, tray: &TrayIcon, agents: &[Agent]) {
    let working = agents.iter().filter(|agent| agent.status == "running").count();
    let waiting: Vec<&Agent> = agents.iter().filter(|agent| agent.waiting_on.is_some()).collect();
    let title = match (working, waiting.len()) {
        (0, 0) => String::new(),
        (working, 0) => format!("{working}"),
        (working, waiting) => format!("{working} · {waiting}✋"),
    };
    let _ = tray.set_title(Some(title));
    let _ = tray.set_tooltip(Some(format!("OfficeSim: {working} working, {} waiting on you", waiting.len())));
    // Replaced only when what it shows changes, so an open menu isn't pulled from under the pointer
    static SHOWN: Mutex<String> = Mutex::new(String::new());
    let mini_open = app.get_webview_window(MINI_LABEL).is_some();
    let shows = format!(
        "{}|{working}|{}|{mini_open}|{}|{}",
        agents.len(),
        waiting.iter().map(|agent| format!("{}={}", agent.id, agent.waiting_on.as_deref().unwrap_or_default())).collect::<Vec<_>>().join(","),
        settings::notify_waiting(),
        launch_at_login(app)
    );
    let Ok(mut shown) = SHOWN.lock() else { return };
    if *shown == shows {
        return;
    }
    if let Ok(menu) = build_menu(app, agents.len(), working, &waiting) {
        let _ = tray.set_menu(Some(menu));
        *shown = shows;
    }
}

fn build_menu(app: &AppHandle, total: usize, working: usize, waiting: &[&Agent]) -> tauri::Result<Menu<Wry>> {
    let summary = MenuItem::with_id(app, "summary", format!("{total} agents · {working} working · {} waiting", waiting.len()), false, None::<&str>)?;
    let waiting_items: Vec<MenuItem<Wry>> = waiting
        .iter()
        .map(|agent| {
            let label = format!("✋ {} — {}", agent.name, agent.waiting_on.as_deref().unwrap_or_default());
            MenuItem::with_id(app, format!("agent:{}", agent.id), truncate(&label, 70), true, None::<&str>)
        })
        .collect::<tauri::Result<_>>()?;
    let open = MenuItem::with_id(app, "open", "Open OfficeSim", true, None::<&str>)?;
    let mini_open = app.get_webview_window(MINI_LABEL).is_some();
    let mini = CheckMenuItem::with_id(app, "mini", "Mini camera", true, mini_open, None::<&str>)?;
    let notify = CheckMenuItem::with_id(app, "notify", "Notify when an agent needs you", true, settings::notify_waiting(), None::<&str>)?;
    let login = CheckMenuItem::with_id(app, "login", "Launch at login", true, launch_at_login(app), None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit OfficeSim", true, None::<&str>)?;
    let separator = || PredefinedMenuItem::separator(app);
    let (separator_1, separator_2, separator_3) = (separator()?, separator()?, separator()?);
    let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&summary];
    items.extend(waiting_items.iter().map(|item| item as &dyn IsMenuItem<Wry>));
    items.extend([&separator_1 as &dyn IsMenuItem<Wry>, &open, &mini, &separator_2, &notify, &login, &separator_3, &quit]);
    Menu::with_items(app, &items)
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    format!("{}…", text.chars().take(max - 1).collect::<String>().trim_end())
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => show_main(app),
        "mini" => toggle_mini(app),
        "notify" => {
            let _ = settings::set_notify_waiting(!settings::notify_waiting());
        }
        "login" => {
            let _ = set_launch_at_login(app, !launch_at_login(app));
        }
        "quit" => app.exit(0),
        _ => {
            if let Some(agent_id) = id.strip_prefix("agent:") {
                if crate::open::navigate(&format!("/agents/{agent_id}")).is_err() {
                    show_main(app);
                }
            }
        }
    }
    nudge();
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Opens the mini camera window, or closes it if it's open.
pub fn toggle_mini(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MINI_LABEL) {
        let _ = window.close();
        return;
    }
    let built = WebviewWindowBuilder::new(app, MINI_LABEL, WebviewUrl::App("index.html?mini=1".into()))
        .title("OfficeSim camera")
        .inner_size(480.0, 330.0)
        .min_inner_size(320.0, 220.0)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .build();
    if let Err(error) = built {
        eprintln!("officesim: can't open the mini camera: {error}");
    }
}

pub fn launch_at_login(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

pub fn set_launch_at_login(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    let result = if enabled { autolaunch.enable() } else { autolaunch.disable() };
    result.map_err(|error| error.to_string())
}
