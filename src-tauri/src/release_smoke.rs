//! Explicit package-check mode. All runtime files live beside the copied EXE;
//! Windows account credentials are never read or written in this mode.
use crate::credentials::{CredentialError, CredentialStore, SecretBlob};
use std::path::PathBuf;
pub const PROTOCOL: &str = "QQMusicGUI/IsolatedSmoke/v1";
pub fn active() -> bool {
    std::env::args_os().any(|arg| arg == "--release-smoke")
}
pub fn data_directory() -> Option<PathBuf> {
    Some(
        std::env::current_exe()
            .ok()?
            .parent()?
            .join(".release-smoke/data"),
    )
}
pub struct NoCredentials;
impl CredentialStore for NoCredentials {
    fn read(&self) -> Result<Option<SecretBlob>, CredentialError> {
        Ok(None)
    }
    fn replace(&self, _secret: &SecretBlob) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable)
    }
    fn delete(&self) -> Result<(), CredentialError> {
        Ok(())
    }
}
#[cfg(windows)]
pub fn schedule(app: tauri::AppHandle) {
    use tauri::Manager;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        let state = app.state::<crate::AppState>();
        let queue_ok = state.queue.as_ref().is_some_and(|queue| {
            if !queue.snapshot().items.is_empty() {
                return false;
            }
            let track = crate::queue::QueueTrack {
                id: "release_smoke_track".into(),
                media_mid: None,
                title: "发行检查".into(),
                artist: "检查".into(),
                album: String::new(),
                duration_ms: 1000,
                cover_cache_key: None,
            };
            queue.enqueue(track).is_ok_and(|q| q.items.len() == 1)
                && queue.remove(0).is_ok_and(|q| q.items.is_empty())
        });
        let settings_ok = state
            .persistence
            .as_ref()
            .is_some_and(|p| p.load_settings().is_ok_and(|s| p.save_settings(&s).is_ok()));
        let local_ok = state
            .local_music
            .as_ref()
            .is_some_and(|s| s.list().is_ok_and(|l| l.tracks.is_empty()));
        let provider_ready = state.provider.as_ref().is_some_and(|provider| {
            serde_json::to_value(provider.snapshot()).is_ok_and(|value| value["state"] == "ready")
        });
        let passed = queue_ok
            && settings_ok
            && local_ok
            && provider_ready
            && state.playback_session.is_some()
            && state.updates.is_some();
        let report = serde_json::json!({"protocol":PROTOCOL,"passed":passed,"version":env!("CARGO_PKG_VERSION"),"channel":if cfg!(debug_assertions){"Debug"}else{"Release"},"providerReady":provider_ready,"playbackSessionReady":state.playback_session.is_some(),"queueRoundTrip":queue_ok,"settingsRoundTrip":settings_ok,"localLibraryRead":local_ok,"updatesReady":state.updates.is_some(),"isolatedData":true,"accountCredentialsAccessed":false});
        let saved = data_directory()
            .and_then(|dir| {
                std::fs::create_dir_all(&dir).ok()?;
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(dir.join("result.json"))
                    .ok()?;
                use std::io::Write;
                file.write_all(serde_json::to_string_pretty(&report).ok()?.as_bytes())
                    .ok()?;
                file.sync_all().ok()?;
                Some(())
            })
            .is_some();
        app.exit(if passed && saved { 0 } else { 1 });
    });
}
