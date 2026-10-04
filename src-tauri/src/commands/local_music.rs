use crate::{
    local_music_unavailable, public_local_music_error, public_session_error, AppState,
    LocalMusicDeleteResult, LocalMusicImportResult, LocalMusicListResult, PublicError, State,
};

#[tauri::command]
pub(crate) async fn local_music_list(
    state: State<'_, AppState>,
) -> Result<LocalMusicListResult, PublicError> {
    let service = state
        .local_music
        .clone()
        .ok_or_else(local_music_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || service.list())
        .await
        .map_err(|_| local_music_unavailable())?
        .map_err(public_local_music_error)
}

#[tauri::command]
pub(crate) async fn local_music_import(
    state: State<'_, AppState>,
) -> Result<LocalMusicImportResult, PublicError> {
    let service = state
        .local_music
        .clone()
        .ok_or_else(local_music_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || service.import_selected())
        .await
        .map_err(|_| local_music_unavailable())?
        .map(|result| {
            result.unwrap_or(LocalMusicImportResult {
                imported: Vec::new(),
                existing_count: 0,
                failures: Vec::new(),
            })
        })
        .map_err(public_local_music_error)
}

#[tauri::command]
pub(crate) async fn local_music_delete(
    track_id: String,
    state: State<'_, AppState>,
) -> Result<LocalMusicDeleteResult, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(local_music_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || session.delete_local_track(&track_id))
        .await
        .map_err(|_| local_music_unavailable())?
        .map_err(public_session_error)
}
