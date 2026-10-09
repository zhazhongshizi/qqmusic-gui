use crate::updates::{UpdateRequest, UpdateSnapshot};
use crate::{AppState, State};
#[tauri::command]
pub(crate) async fn updates_control(
    request: UpdateRequest,
    state: State<'_, AppState>,
) -> Result<UpdateSnapshot, String> {
    let service = state.updates.clone().ok_or("update_unavailable")?;
    tauri::async_runtime::spawn_blocking(move || service.control(request))
        .await
        .map_err(|_| "update_unavailable")?
        .map_err(str::to_owned)
}
