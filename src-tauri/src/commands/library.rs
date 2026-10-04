use crate::{
    authenticated_account_id, provider_unavailable, queue_unavailable, run_library_blocking,
    run_organizer_blocking, AppState, CatalogSongPage, OrganizerExecution, OrganizerPreview,
    OrganizerPreviewRequest, PlaylistKind, PlaylistPage, PublicError, State, WriteReceipt,
};

#[tauri::command]
pub(crate) async fn library_playlists(
    kind: PlaylistKind,
    page: u32,
    page_size: u32,
    state: State<'_, AppState>,
) -> Result<PlaylistPage, PublicError> {
    let library = state.library.clone().ok_or_else(provider_unavailable)?;
    run_library_blocking(move || library.playlists(kind, page, page_size)).await
}

#[tauri::command]
pub(crate) async fn library_liked_songs(
    page: u32,
    page_size: u32,
    generation: u64,
    state: State<'_, AppState>,
) -> Result<CatalogSongPage, PublicError> {
    let library = state.library.clone().ok_or_else(provider_unavailable)?;
    run_library_blocking(move || library.liked_songs(page, page_size, generation)).await
}

#[tauri::command]
pub(crate) async fn library_create_playlist(
    name: String,
    state: State<'_, AppState>,
) -> Result<WriteReceipt, PublicError> {
    let library = state.library.clone().ok_or_else(provider_unavailable)?;
    run_library_blocking(move || library.create_playlist_checked(&name)).await
}

#[tauri::command]
pub(crate) async fn library_delete_playlist(
    editable_id: String,
    state: State<'_, AppState>,
) -> Result<WriteReceipt, PublicError> {
    let library = state.library.clone().ok_or_else(provider_unavailable)?;
    run_library_blocking(move || library.delete_playlist_checked(&editable_id)).await
}

#[tauri::command]
pub(crate) async fn library_add_songs(
    playlist_id: String,
    editable_id: String,
    song_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<WriteReceipt, PublicError> {
    let library = state.library.clone().ok_or_else(provider_unavailable)?;
    run_library_blocking(move || {
        library.set_playlist_songs_checked(&playlist_id, &editable_id, &song_ids, true)
    })
    .await
}

#[tauri::command]
pub(crate) async fn library_remove_songs(
    playlist_id: String,
    editable_id: String,
    song_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<WriteReceipt, PublicError> {
    let library = state.library.clone().ok_or_else(provider_unavailable)?;
    run_library_blocking(move || {
        library.set_playlist_songs_checked(&playlist_id, &editable_id, &song_ids, false)
    })
    .await
}

#[tauri::command]
pub(crate) async fn library_set_liked(
    song_ids: Vec<String>,
    liked: bool,
    state: State<'_, AppState>,
) -> Result<WriteReceipt, PublicError> {
    let library = state.library.clone().ok_or_else(provider_unavailable)?;
    let session = state.playback_session.clone();
    let epoch = session
        .as_ref()
        .map_or(0, |session| session.shuffle_likes_epoch());
    run_library_blocking(move || {
        let result = library.set_liked_checked(&song_ids, liked)?;
        if let Some(session) = session {
            session.update_shuffle_likes(&song_ids, liked, epoch);
        }
        Ok(result)
    })
    .await
}

#[tauri::command]
pub(crate) async fn library_set_favorite_playlist(
    playlist_id: String,
    favorite: bool,
    state: State<'_, AppState>,
) -> Result<WriteReceipt, PublicError> {
    let library = state.library.clone().ok_or_else(provider_unavailable)?;
    run_library_blocking(move || library.set_favorite_playlist_checked(&playlist_id, favorite))
        .await
}

#[tauri::command]
pub(crate) async fn organizer_preview(
    request: OrganizerPreviewRequest,
    state: State<'_, AppState>,
) -> Result<OrganizerPreview, PublicError> {
    let account_id = authenticated_account_id(&state)?;
    let organizer = state.organizer.clone().ok_or_else(queue_unavailable)?;
    run_organizer_blocking(move || organizer.preview(&account_id, request)).await
}

#[tauri::command]
pub(crate) async fn organizer_execute(
    plan_id: String,
    confirm: bool,
    state: State<'_, AppState>,
) -> Result<OrganizerExecution, PublicError> {
    let account_id = authenticated_account_id(&state)?;
    let organizer = state.organizer.clone().ok_or_else(queue_unavailable)?;
    run_organizer_blocking(move || organizer.execute(&account_id, &plan_id, confirm)).await
}
