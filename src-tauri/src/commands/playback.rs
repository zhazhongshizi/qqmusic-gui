use crate::{
    persistence, persistence_unavailable, playback_session, playback_unavailable,
    preferred_quality_from_playback, public_persistence_error, public_playback_error,
    public_session_error, queue_unavailable, run_queue_blocking, run_session_blocking,
    smart_shuffle, AppState, PlaybackError, PlaybackMode, PlaybackQuality, PlaybackSessionError,
    PlaybackSessionSnapshot, PlayerSnapshot, PublicError, QueueSnapshot, QueueTrack,
    SessionPlayResult, State,
};

#[tauri::command]
pub(crate) fn player_snapshot(state: State<'_, AppState>) -> Result<PlayerSnapshot, PublicError> {
    state
        .playback_session
        .as_ref()
        .map(|session| session.snapshot().player)
        .ok_or_else(playback_unavailable)
}

#[tauri::command]
pub(crate) async fn player_play(state: State<'_, AppState>) -> Result<PlayerSnapshot, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    run_session_blocking(move || session.play()).await
}

#[tauri::command]
pub(crate) async fn player_pause(
    state: State<'_, AppState>,
) -> Result<PlayerSnapshot, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    run_session_blocking(move || session.pause()).await
}

#[tauri::command]
pub(crate) async fn player_stop(state: State<'_, AppState>) -> Result<PlayerSnapshot, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    run_session_blocking(move || session.stop()).await
}

#[tauri::command]
pub(crate) async fn player_seek(
    position_ms: u64,
    state: State<'_, AppState>,
) -> Result<PlayerSnapshot, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    run_session_blocking(move || session.seek(position_ms)).await
}

#[tauri::command]
pub(crate) async fn player_set_volume(
    volume: f32,
    state: State<'_, AppState>,
) -> Result<PlayerSnapshot, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    run_session_blocking(move || session.set_volume(volume)).await
}

#[tauri::command]
pub(crate) async fn player_set_muted(
    muted: bool,
    state: State<'_, AppState>,
) -> Result<PlayerSnapshot, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    run_session_blocking(move || session.set_muted(muted)).await
}

#[tauri::command]
pub(crate) fn queue_snapshot(state: State<'_, AppState>) -> Result<QueueSnapshot, PublicError> {
    state
        .queue
        .as_ref()
        .map(|queue| queue.snapshot())
        .ok_or_else(queue_unavailable)
}

#[tauri::command]
pub(crate) async fn queue_replace(
    items: Vec<QueueTrack>,
    state: State<'_, AppState>,
) -> Result<QueueSnapshot, PublicError> {
    if let Some(session) = state.playback_session.clone() {
        return run_session_blocking(move || session.replace_queue(items)).await;
    }
    let queue = state.queue.clone().ok_or_else(queue_unavailable)?;
    run_queue_blocking(move || queue.replace(items)).await
}

#[tauri::command]
pub(crate) async fn queue_enqueue_many(
    items: Vec<QueueTrack>,
    state: State<'_, AppState>,
) -> Result<QueueSnapshot, PublicError> {
    let queue = state.queue.clone().ok_or_else(queue_unavailable)?;
    run_queue_blocking(move || queue.enqueue_many(items)).await
}

#[tauri::command]
pub(crate) async fn queue_enqueue(
    item: QueueTrack,
    state: State<'_, AppState>,
) -> Result<QueueSnapshot, PublicError> {
    let queue = state.queue.clone().ok_or_else(queue_unavailable)?;
    run_queue_blocking(move || queue.enqueue(item)).await
}

#[tauri::command]
pub(crate) async fn queue_remove(
    index: usize,
    state: State<'_, AppState>,
) -> Result<QueueSnapshot, PublicError> {
    let queue = state.queue.clone().ok_or_else(queue_unavailable)?;
    run_queue_blocking(move || queue.remove(index)).await
}

#[tauri::command]
pub(crate) async fn queue_enqueue_next(
    item: QueueTrack,
    state: State<'_, AppState>,
) -> Result<QueueSnapshot, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    run_session_blocking(move || session.enqueue_next(item)).await
}

#[tauri::command]
pub(crate) async fn playback_set_mv_lyric_offset(
    track_id: String,
    generation: u64,
    offset_ms: i64,
    state: State<'_, AppState>,
) -> Result<PlaybackSessionSnapshot, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    run_session_blocking(move || session.set_mv_lyric_offset(&track_id, generation, offset_ms))
        .await
}

#[tauri::command]
pub(crate) async fn queue_move(
    from_index: usize,
    to_index: usize,
    state: State<'_, AppState>,
) -> Result<QueueSnapshot, PublicError> {
    let queue = state.queue.clone().ok_or_else(queue_unavailable)?;
    run_queue_blocking(move || queue.move_item(from_index, to_index)).await
}

#[tauri::command]
pub(crate) async fn queue_play(
    index: usize,
    preferred_quality: String,
    state: State<'_, AppState>,
) -> Result<Option<SessionPlayResult>, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    let quality = PlaybackQuality::parse(&preferred_quality).map_err(public_playback_error)?;
    match tauri::async_runtime::spawn_blocking(move || session.play_index(index, quality))
        .await
        .map_err(|_| playback_unavailable())?
    {
        Ok(result) => Ok(Some(result)),
        Err(PlaybackSessionError::Superseded) => Ok(None),
        Err(error) => Err(public_session_error(error)),
    }
}

#[tauri::command]
pub(crate) async fn playback_history(
    state: State<'_, AppState>,
) -> Result<Vec<persistence::PlaybackHistoryEntry>, PublicError> {
    let persistence = state
        .persistence
        .clone()
        .ok_or_else(persistence_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || persistence.load_playback_history())
        .await
        .map_err(|_| persistence_unavailable())?
        .map_err(public_persistence_error)
}

#[tauri::command]
pub(crate) async fn playback_change_quality(
    preferred_quality: String,
    state: State<'_, AppState>,
) -> Result<Option<SessionPlayResult>, PublicError> {
    let quality = PlaybackQuality::parse(&preferred_quality).map_err(public_playback_error)?;
    if preferred_quality_from_playback(quality).is_none() {
        return Err(public_playback_error(PlaybackError::InvalidRequest));
    }
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    match tauri::async_runtime::spawn_blocking(move || session.change_quality(quality))
        .await
        .map_err(|_| playback_unavailable())?
    {
        Ok(result) => Ok(Some(result)),
        Err(PlaybackSessionError::Superseded) => Ok(None),
        Err(error) => Err(public_session_error(error)),
    }
}

#[tauri::command]
pub(crate) fn playback_session_snapshot(
    state: State<'_, AppState>,
    known_queue_generation: Option<u64>,
) -> Result<playback_session::PlaybackSessionUpdate, PublicError> {
    state
        .playback_session
        .as_ref()
        .map(|session| session.snapshot_update(known_queue_generation))
        .ok_or_else(playback_unavailable)
}

#[tauri::command]
pub(crate) fn queue_preview_next(
    state: State<'_, AppState>,
) -> Result<Option<String>, PublicError> {
    state
        .playback_session
        .as_ref()
        .map(|session| session.preview_next_track())
        .ok_or_else(playback_unavailable)
}

#[tauri::command]
pub(crate) fn playback_set_mode(
    mode: String,
    state: State<'_, AppState>,
) -> Result<PlaybackSessionSnapshot, PublicError> {
    let session = state
        .playback_session
        .as_ref()
        .ok_or_else(playback_unavailable)?;
    let mode = PlaybackMode::parse(&mode).map_err(public_session_error)?;
    session.set_mode(mode).map_err(public_session_error)
}

#[tauri::command]
pub(crate) fn smart_shuffle_status(
    state: State<'_, AppState>,
) -> Result<smart_shuffle::SmartShuffleStatus, PublicError> {
    state
        .playback_session
        .as_ref()
        .map(|session| session.smart_shuffle_status())
        .ok_or_else(playback_unavailable)
}

#[tauri::command]
pub(crate) async fn smart_shuffle_set_enabled(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<smart_shuffle::SmartShuffleStatus, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    let epoch = session.shuffle_likes_epoch();
    let library = state.library.clone();
    run_session_blocking(move || {
        let likes = if enabled {
            library.and_then(|library| library.all_liked_ids().ok())
        } else {
            None
        };
        session.set_smart_shuffle(enabled, likes, epoch)
    })
    .await
}

#[tauri::command]
pub(crate) async fn queue_next(
    state: State<'_, AppState>,
) -> Result<Option<SessionPlayResult>, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    match tauri::async_runtime::spawn_blocking(move || session.next())
        .await
        .map_err(|_| playback_unavailable())?
    {
        Ok(result) => Ok(result),
        Err(PlaybackSessionError::Superseded) => Ok(None),
        Err(error) => Err(public_session_error(error)),
    }
}

#[tauri::command]
pub(crate) async fn queue_previous(
    state: State<'_, AppState>,
) -> Result<Option<SessionPlayResult>, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    match tauri::async_runtime::spawn_blocking(move || session.previous())
        .await
        .map_err(|_| playback_unavailable())?
    {
        Ok(result) => Ok(result),
        Err(PlaybackSessionError::Superseded) => Ok(None),
        Err(error) => Err(public_session_error(error)),
    }
}
