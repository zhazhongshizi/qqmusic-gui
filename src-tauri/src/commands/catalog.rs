use crate::catalog::CatalogArtistRef;
use crate::catalog::{CatalogAlbum, CatalogEntityPage, CatalogSearchKind};
use crate::{
    cover_unavailable, provider_unavailable, public_catalog_error, public_cover_error,
    public_lyric_error, AppState, CatalogArtist, CatalogSongPage, CoverError, CoverPayload,
    LyricTimeline, PublicError, State,
};

#[tauri::command]
pub(crate) async fn catalog_song_artists(
    song_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CatalogArtistRef>, PublicError> {
    let catalog = state.catalog.clone().ok_or_else(provider_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || catalog.song_artists(&song_id))
        .await
        .map_err(|_| provider_unavailable())?
        .map_err(public_catalog_error)
}

#[tauri::command]
pub(crate) async fn catalog_search_entities(
    kind: CatalogSearchKind,
    keyword: String,
    page: u32,
    page_size: u32,
    generation: u64,
    state: State<'_, AppState>,
) -> Result<CatalogEntityPage, PublicError> {
    let catalog = state.catalog.clone().ok_or_else(provider_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || {
        catalog.search_entities(kind, &keyword, page, page_size, generation)
    })
    .await
    .map_err(|_| provider_unavailable())?
    .map_err(public_catalog_error)
}

#[tauri::command]
pub(crate) async fn catalog_album_detail(
    album_id: String,
    state: State<'_, AppState>,
) -> Result<CatalogAlbum, PublicError> {
    let catalog = state.catalog.clone().ok_or_else(provider_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || catalog.album_detail(&album_id))
        .await
        .map_err(|_| provider_unavailable())?
        .map_err(public_catalog_error)
}

#[tauri::command]
pub(crate) async fn catalog_album_songs(
    album_id: String,
    page: u32,
    page_size: u32,
    generation: u64,
    state: State<'_, AppState>,
) -> Result<CatalogSongPage, PublicError> {
    let catalog = state.catalog.clone().ok_or_else(provider_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || {
        catalog.album_songs(&album_id, page, page_size, generation)
    })
    .await
    .map_err(|_| provider_unavailable())?
    .map_err(public_catalog_error)
}

#[tauri::command]
pub(crate) async fn catalog_artist_albums(
    artist_id: String,
    page: u32,
    page_size: u32,
    generation: u64,
    state: State<'_, AppState>,
) -> Result<CatalogEntityPage, PublicError> {
    let catalog = state.catalog.clone().ok_or_else(provider_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || {
        catalog.artist_albums(&artist_id, page, page_size, generation)
    })
    .await
    .map_err(|_| provider_unavailable())?
    .map_err(public_catalog_error)
}

#[tauri::command]
pub(crate) async fn cover_get(
    cache_key: String,
    kind: Option<String>,
    state: State<'_, AppState>,
) -> Result<CoverPayload, PublicError> {
    if cache_key.starts_with("local_") && matches!(kind.as_deref(), None | Some("album")) {
        let local = state.local_music.clone().ok_or_else(cover_unavailable)?;
        return tauri::async_runtime::spawn_blocking(move || local.embedded_cover(&cache_key))
            .await
            .map_err(|_| cover_unavailable())?
            .map_err(|_| cover_unavailable());
    }
    let cover = state.cover.clone().ok_or_else(cover_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || match kind.as_deref() {
        None | Some("album") => cover.get(&cache_key),
        Some("artist") => cover.get_artist(&cache_key),
        Some(_) => Err(CoverError::InvalidKey),
    })
    .await
    .map_err(|_| cover_unavailable())?
    .map_err(public_cover_error)
}

#[tauri::command]
pub(crate) async fn lyrics_get(
    track_id: String,
    generation: u64,
    state: State<'_, AppState>,
) -> Result<LyricTimeline, PublicError> {
    let lyrics = state.lyrics.clone().ok_or_else(provider_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || lyrics.timeline(&track_id, generation))
        .await
        .map_err(|_| provider_unavailable())?
        .map_err(public_lyric_error)
}

#[tauri::command]
pub(crate) async fn catalog_search_songs(
    keyword: String,
    page: u32,
    page_size: u32,
    generation: u64,
    state: State<'_, AppState>,
) -> Result<CatalogSongPage, PublicError> {
    let catalog = state.catalog.clone().ok_or_else(provider_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || {
        catalog.search_songs(&keyword, page, page_size, generation)
    })
    .await
    .map_err(|_| provider_unavailable())?
    .map_err(public_catalog_error)
}

#[tauri::command]
pub(crate) async fn catalog_discover_new_songs(
    area: u8,
    generation: u64,
    state: State<'_, AppState>,
) -> Result<CatalogSongPage, PublicError> {
    let catalog = state.catalog.clone().ok_or_else(provider_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || catalog.discover_new_songs(area, generation))
        .await
        .map_err(|_| provider_unavailable())?
        .map_err(public_catalog_error)
}

#[tauri::command]
pub(crate) async fn catalog_playlist_songs(
    playlist_id: String,
    editable_id: Option<String>,
    page: u32,
    page_size: u32,
    generation: u64,
    state: State<'_, AppState>,
) -> Result<CatalogSongPage, PublicError> {
    let catalog = state.catalog.clone().ok_or_else(provider_unavailable)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        catalog.playlist_songs(
            &playlist_id,
            editable_id.as_deref(),
            page,
            page_size,
            generation,
        )
    })
    .await
    .map_err(|_| provider_unavailable())?;
    #[cfg(debug_assertions)]
    if let Err(error) = &result {
        eprintln!(
            "{{\"level\":\"debug\",\"code\":\"playlist_songs_error\",\"error\":\"{error:?}\"}}"
        );
    }
    result.map_err(public_catalog_error)
}

#[tauri::command]
pub(crate) async fn catalog_artist_detail(
    artist_id: String,
    state: State<'_, AppState>,
) -> Result<Option<CatalogArtist>, PublicError> {
    let catalog = state.catalog.clone().ok_or_else(provider_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || catalog.artist_detail(&artist_id))
        .await
        .map_err(|_| provider_unavailable())?
        .map_err(public_catalog_error)
}

#[tauri::command]
pub(crate) async fn catalog_artist_songs(
    artist_id: String,
    page: u32,
    page_size: u32,
    generation: u64,
    state: State<'_, AppState>,
) -> Result<CatalogSongPage, PublicError> {
    let catalog = state.catalog.clone().ok_or_else(provider_unavailable)?;
    tauri::async_runtime::spawn_blocking(move || {
        catalog.artist_songs(&artist_id, page, page_size, generation)
    })
    .await
    .map_err(|_| provider_unavailable())?
    .map_err(public_catalog_error)
}
