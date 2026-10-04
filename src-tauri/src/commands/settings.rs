use crate::{
    persistence_unavailable, playback_quality_from_preferred, preferred_quality_from_playback,
    public_persistence_error, public_playback_error, AppSnapshot, AppState, PersistenceError,
    PlaybackError, PlaybackQuality, PublicError, SettingsSnapshot, SmtcDynamicLyricsSetting, State,
};

#[tauri::command]
pub(crate) fn app_snapshot(state: State<'_, AppState>) -> AppSnapshot {
    state.snapshot()
}

#[tauri::command]
pub(crate) async fn smtc_dynamic_lyrics_set_enabled(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<SmtcDynamicLyricsSetting, PublicError> {
    #[cfg(windows)]
    let enabled = state
        .smtc_dynamic_lyrics
        .as_ref()
        .map(|coordinator| coordinator.set_enabled(enabled))
        .unwrap_or(false);
    #[cfg(not(windows))]
    let enabled = {
        let _ = (enabled, state);
        false
    };
    Ok(SmtcDynamicLyricsSetting { enabled })
}

#[tauri::command]
pub(crate) fn settings_snapshot(
    state: State<'_, AppState>,
) -> Result<SettingsSnapshot, PublicError> {
    let persistence = state
        .persistence
        .as_ref()
        .ok_or_else(persistence_unavailable)?;
    persistence
        .load_settings()
        .map(|settings| SettingsSnapshot::from_settings(&settings))
        .map_err(public_persistence_error)
}

#[tauri::command]
pub(crate) async fn settings_set_preferred_quality(
    preferred_quality: String,
    state: State<'_, AppState>,
) -> Result<SettingsSnapshot, PublicError> {
    let quality = PlaybackQuality::parse(&preferred_quality).map_err(public_playback_error)?;
    let preferred = preferred_quality_from_playback(quality)
        .ok_or_else(|| public_playback_error(PlaybackError::InvalidRequest))?;
    let persistence = state
        .persistence
        .clone()
        .ok_or_else(persistence_unavailable)?;
    let settings = tauri::async_runtime::spawn_blocking(move || {
        let mut settings = persistence.load_settings()?;
        settings.preferred_quality = preferred;
        persistence.save_settings(&settings)?;
        Ok::<_, PersistenceError>(settings)
    })
    .await
    .map_err(|_| persistence_unavailable())?
    .map_err(public_persistence_error)?;
    if let Some(session) = &state.playback_session {
        session.set_default_quality(playback_quality_from_preferred(settings.preferred_quality));
    }
    Ok(SettingsSnapshot::from_settings(&settings))
}

#[tauri::command]
pub(crate) async fn settings_set_live_spectrum_enabled(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<SettingsSnapshot, PublicError> {
    #[cfg(debug_assertions)]
    eprintln!("[spectrum] setting=requested enabled={enabled}");
    let persistence = state
        .persistence
        .clone()
        .ok_or_else(persistence_unavailable)?;
    let settings = tauri::async_runtime::spawn_blocking(move || {
        let mut settings = persistence.load_settings()?;
        settings.live_spectrum_enabled = enabled;
        persistence.save_settings(&settings)?;
        Ok::<_, PersistenceError>(settings)
    })
    .await
    .map_err(|_| persistence_unavailable())?
    .map_err(public_persistence_error)?;
    #[cfg(all(windows, not(test)))]
    if let Some(spectrum) = &state.spectrum {
        spectrum.set_enabled(enabled);
    }
    #[cfg(debug_assertions)]
    eprintln!("[spectrum] setting=confirmed enabled={enabled}");
    Ok(SettingsSnapshot::from_settings(&settings))
}

#[tauri::command]
pub(crate) async fn spectrum_set_stage_active(
    active: bool,
    state: State<'_, AppState>,
) -> Result<(), PublicError> {
    #[cfg(debug_assertions)]
    eprintln!("[spectrum] stage_active=requested active={active}");
    #[cfg(all(windows, not(test)))]
    if let Some(spectrum) = &state.spectrum {
        let spectrum = spectrum.clone();
        let _ =
            tauri::async_runtime::spawn_blocking(move || spectrum.set_stage_active(active)).await;
    }
    #[cfg(any(not(windows), test))]
    let _ = (active, state);
    Ok(())
}

#[tauri::command]
pub(crate) async fn settings_set_mv_fallback_enabled(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<SettingsSnapshot, PublicError> {
    let persistence = state
        .persistence
        .clone()
        .ok_or_else(persistence_unavailable)?;
    let settings = tauri::async_runtime::spawn_blocking(move || {
        let mut settings = persistence.load_settings()?;
        settings.mv_fallback_enabled = enabled;
        persistence.save_settings(&settings)?;
        Ok::<_, PersistenceError>(settings)
    })
    .await
    .map_err(|_| persistence_unavailable())?
    .map_err(public_persistence_error)?;
    if let Some(playback) = &state.playback {
        playback.set_mv_fallback_enabled(enabled);
    }
    Ok(SettingsSnapshot::from_settings(&settings))
}
