use crate::{playback_unavailable, run_session_blocking, AppState, PublicError, State};

#[tauri::command]
pub(crate) async fn personal_library(
    request: crate::personal::PersonalRequest,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, PublicError> {
    let session = state
        .playback_session
        .clone()
        .ok_or_else(playback_unavailable)?;
    run_session_blocking(move || session.personal_library(request)).await
}
