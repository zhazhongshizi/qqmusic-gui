use crate::{remote, AppState, Arc, State};

#[tauri::command]
pub(crate) fn remote_status(state: State<'_, AppState>) -> remote::RemoteStatus {
    state.remote.status()
}

#[tauri::command]
pub(crate) async fn remote_set_enabled(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<remote::RemoteStatus, String> {
    let remote = state.remote.clone();
    let session = state.playback_session.clone();
    let cover = state.cover.clone();
    let lyrics = state.lyrics.clone();
    let library = Arc::new(remote::RemoteLibrary {
        local: state.local_music.clone(),
        catalog: state.catalog.clone(),
        library: state.library.clone(),
        queue: state.queue.clone(),
        auth: state.auth_snapshot.clone(),
        tracks: std::sync::Mutex::new(std::collections::HashMap::new()),
        covers: std::sync::Mutex::new(std::collections::HashSet::new()),
    });
    tauri::async_runtime::spawn_blocking(move || {
        remote.set_enabled(enabled, session, cover, lyrics, Some(library))
    })
    .await
    .map_err(|_| "遥控服务操作失败".to_owned())?
    .map_err(str::to_owned)
}
