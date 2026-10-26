use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{ipc::Channel, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates {
    pending: tauri::async_runtime::Mutex<Option<Update>>,
    pub ready: AtomicBool,
}

#[derive(Clone, Serialize)]
pub struct AvailableUpdate {
    version: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum Progress {
    Downloading { downloaded: u64, total: Option<u64> },
    Installing,
}

#[tauri::command]
pub async fn check_app_update(
    app: tauri::AppHandle,
    updates: tauri::State<'_, Updates>,
) -> Result<Option<AvailableUpdate>, String> {
    let mut pending = updates.pending.lock().await;
    if let Some(update) = pending.as_ref() {
        return Ok(Some(AvailableUpdate { version: update.version.clone() }));
    }
    if updates.ready.load(Ordering::SeqCst) {
        return Err("Update check is only available before starting the gateway.".into());
    }
    let update = app.updater_builder().timeout(Duration::from_secs(15))
        .build().map_err(|e| e.to_string())?.check().await.map_err(|error| {
            eprintln!("Update check failed: {error}");
            error.to_string()
        })?;
    let update = update.map(|mut update| {
        update.timeout = Some(Duration::from_secs(600));
        update
    });
    let available = update.as_ref().map(|update| AvailableUpdate { version: update.version.clone() });
    *pending = update;
    Ok(available)
}

#[tauri::command]
pub async fn finish_update_check(updates: tauri::State<'_, Updates>) -> Result<(), String> {
    let pending = updates.pending.lock().await;
    if pending.is_some() {
        return Err("An available update must be installed before starting AuraChat.".into());
    }
    updates.ready.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn install_app_update(
    app: tauri::AppHandle,
    updates: tauri::State<'_, Updates>,
    progress: Channel<Progress>,
) -> Result<(), String> {
    // Hold the lock through installation: retries cannot launch two installers.
    let pending = updates.pending.lock().await;
    let update = pending.as_ref().ok_or("No checked update is available.")?;
    let state = app.state::<crate::AppState>();
    if !state.running_chats.lock().unwrap().is_empty() {
        return Err("The gateway is still running a conversation.".into());
    }
    let mut downloaded = 0;
    let bytes = update.download(
        |chunk, total| {
            downloaded += chunk as u64;
            if let Err(error) = progress.send(Progress::Downloading { downloaded, total }) {
                eprintln!("Cannot report update download progress: {error}");
            }
        },
        || {},
    ).await.map_err(|error| {
        eprintln!("Update download failed: {error}");
        error.to_string()
    })?;
    progress.send(Progress::Installing).map_err(|e| e.to_string())?;
    update.install(bytes).map_err(|error| {
        eprintln!("Update installation failed: {error}");
        error.to_string()
    })?;
    // Windows' installer restarts the app itself; macOS needs an explicit restart.
    #[cfg(not(target_os = "windows"))]
    app.restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_does_not_accept_remote_work_before_the_update_check() {
        let updates = Updates::default();
        assert!(!updates.ready.load(Ordering::SeqCst));
        assert!(updates.pending.try_lock().unwrap().is_none());
    }
}
