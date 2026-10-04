use crate::{
    provider_unavailable, public_auth_error, run_auth_blocking, AppState, AuthSnapshot,
    PublicError, PublicLogoutResult, QrLoginStart, QrLoginState, RecoveryState, State,
};

#[tauri::command]
pub(crate) fn auth_status(state: State<'_, AppState>) -> AuthSnapshot {
    state
        .auth_snapshot
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

#[tauri::command]
pub(crate) async fn auth_recover(state: State<'_, AppState>) -> Result<AuthSnapshot, PublicError> {
    if let Some(session) = &state.playback_session {
        session.clear_shuffle_likes();
    }
    let auth = state.auth.clone().ok_or_else(provider_unavailable)?;
    let snapshot = match run_auth_blocking(move || auth.recover()).await? {
        RecoveryState::SignedOut => AuthSnapshot::signed_out(),
        RecoveryState::Authenticated { account } => AuthSnapshot::authenticated(Some(account)),
    };
    *state
        .auth_snapshot
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = snapshot.clone();
    if let (Some(session), Some(library)) = (state.playback_session.clone(), state.library.clone())
    {
        if session.smart_shuffle_status().enabled {
            let epoch = session.shuffle_likes_epoch();
            tauri::async_runtime::spawn_blocking(move || {
                session.refresh_shuffle_likes(library.all_liked_ids().ok(), epoch);
            });
        }
    }
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn auth_qr_start(
    login_method: String,
    state: State<'_, AppState>,
) -> Result<QrLoginStart, PublicError> {
    if let Some(session) = &state.playback_session {
        session.clear_shuffle_likes();
    }
    let auth = state.auth.clone().ok_or_else(provider_unavailable)?;
    run_auth_blocking(move || auth.start_qr(&login_method)).await
}

#[tauri::command]
pub(crate) async fn auth_qr_poll(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<QrLoginState, PublicError> {
    let auth = state.auth.clone().ok_or_else(provider_unavailable)?;
    let login_state = tauri::async_runtime::spawn_blocking(move || auth.poll_qr(&session_id))
        .await
        .map_err(|_| {
            #[cfg(debug_assertions)]
            eprintln!(
                r#"{{"level":"debug","code":"auth_qr_poll_failed","authCode":"auth_provider_unavailable"}}"#
            );
            provider_unavailable()
        })?
        .map_err(|error| {
            #[cfg(debug_assertions)]
            eprintln!(
                r#"{{"level":"debug","code":"auth_qr_poll_failed","authCode":"{}"}}"#,
                error.code()
            );
            public_auth_error(error)
        })?;
    if let QrLoginState::Authenticated { account, .. } = &login_state {
        *state
            .auth_snapshot
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            AuthSnapshot::authenticated(Some(account.clone()));
    }
    Ok(login_state)
}

#[tauri::command]
pub(crate) async fn auth_qr_cancel(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<QrLoginState, PublicError> {
    let auth = state.auth.clone().ok_or_else(provider_unavailable)?;
    run_auth_blocking(move || auth.cancel_qr(&session_id)).await
}

#[tauri::command]
pub(crate) async fn auth_logout(
    state: State<'_, AppState>,
) -> Result<PublicLogoutResult, PublicError> {
    if let Some(session) = &state.playback_session {
        session.clear_shuffle_likes();
    }
    let auth = state.auth.clone().ok_or_else(provider_unavailable)?;
    let result = run_auth_blocking(move || auth.logout()).await?;
    *state
        .auth_snapshot
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = AuthSnapshot::signed_out();
    #[cfg(windows)]
    if let Some(artwork) = &state.smtc_artwork {
        artwork.clear_for_logout();
    }
    #[cfg(windows)]
    if let Some(dynamic_lyrics) = &state.smtc_dynamic_lyrics {
        dynamic_lyrics.clear_for_logout();
    }
    let cover_cache_cleared = state
        .cover
        .as_ref()
        .map(|cover| cover.clear().is_ok())
        .unwrap_or(false);
    Ok(PublicLogoutResult {
        upstream_revoked: result.upstream_revoked,
        cover_cache_cleared,
    })
}
