use super::*;
use crate::{
    catalog::{CatalogService, CatalogSongPage},
    library::LibraryService,
    queue::{QueueService, QueueTrack},
};
use std::{collections::HashMap, sync::RwLock};

pub(crate) struct RemoteLibrary {
    pub catalog: Option<Arc<CatalogService>>,
    pub library: Option<Arc<LibraryService>>,
    pub queue: Option<Arc<QueueService>>,
    pub local: Option<Arc<crate::local_music::LocalMusicService>>,
    pub auth: Arc<RwLock<crate::AuthSnapshot>>,
    pub tracks: Mutex<HashMap<String, QueueTrack>>,
    pub covers: Mutex<std::collections::HashSet<(String, String)>>,
}

#[derive(Deserialize)]
#[serde(tag = "command", deny_unknown_fields)]
pub(super) enum LibraryRequest {
    #[serde(rename = "personal_library")]
    Personal {
        request: crate::personal::PersonalRequest,
    },
    #[serde(rename = "auth_status")]
    Auth {},
    #[serde(rename = "catalog_discover_new_songs")]
    Discover { area: u8, generation: u64 },
    #[serde(rename = "catalog_search_songs", rename_all = "camelCase")]
    Search {
        keyword: String,
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "library_liked_songs", rename_all = "camelCase")]
    Liked {
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "library_set_liked", rename_all = "camelCase")]
    SetLiked { song_ids: Vec<String>, liked: bool },
    #[serde(rename = "queue_enqueue")]
    Enqueue { id: String },
    #[serde(rename = "queue_enqueue_next")]
    EnqueueNext { id: String },
    #[serde(rename = "queue_enqueue_many")]
    EnqueueMany { ids: Vec<String> },
    #[serde(rename = "queue_replace")]
    Replace { ids: Vec<String> },
    #[serde(rename = "library_playlists", rename_all = "camelCase")]
    Playlists {
        kind: crate::library::PlaylistKind,
        page: u32,
        page_size: u32,
    },
    #[serde(rename = "catalog_playlist_songs", rename_all = "camelCase")]
    PlaylistSongs {
        playlist_id: String,
        editable_id: Option<String>,
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "catalog_search_entities", rename_all = "camelCase")]
    SearchEntities {
        kind: crate::catalog::CatalogSearchKind,
        keyword: String,
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "catalog_album_detail", rename_all = "camelCase")]
    AlbumDetail { album_id: String },
    #[serde(rename = "catalog_album_songs", rename_all = "camelCase")]
    AlbumSongs {
        album_id: String,
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "catalog_artist_detail", rename_all = "camelCase")]
    ArtistDetail { artist_id: String },
    #[serde(rename = "catalog_song_artists", rename_all = "camelCase")]
    SongArtists { song_id: String },
    #[serde(rename = "catalog_artist_songs", rename_all = "camelCase")]
    ArtistSongs {
        artist_id: String,
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "catalog_artist_albums", rename_all = "camelCase")]
    ArtistAlbums {
        artist_id: String,
        page: u32,
        page_size: u32,
        generation: u64,
    },
    #[serde(rename = "local_music_list")]
    Local {},
}

impl RemoteLibrary {
    fn remember_cover(&self, kind: &str, key: &str) {
        let mut covers = self
            .covers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if covers.len() >= 10000 {
            covers.clear();
        }
        covers.insert((kind.to_owned(), key.to_owned()));
    }
    fn remember_entities(&self, page: &crate::catalog::CatalogEntityPage) {
        for item in &page.items {
            match item {
                crate::catalog::CatalogEntity::Artist(a) => {
                    if let Some(key) = &a.avatar_cache_key {
                        self.remember_cover("artist", key);
                    }
                }
                crate::catalog::CatalogEntity::Album(a) => {
                    if let Some(key) = &a.cover_cache_key {
                        self.remember_cover("album", key);
                    }
                }
                crate::catalog::CatalogEntity::Playlist(_) => {}
            }
        }
    }
    fn remember(&self, page: &CatalogSongPage) {
        let mut tracks = self
            .tracks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if tracks.len() + page.items.len() > 10000 {
            tracks.clear();
        }
        for item in &page.items {
            tracks.insert(
                item.id.clone(),
                QueueTrack {
                    id: item.id.clone(),
                    media_mid: item.media_mid.clone(),
                    title: item.title.clone(),
                    artist: item.artist.clone(),
                    album: item.album.clone(),
                    duration_ms: item.duration_ms,
                    cover_cache_key: item.cover_cache_key.clone(),
                },
            );
        }
    }
    fn execute(
        &self,
        command: LibraryRequest,
        session: &PlaybackSession,
    ) -> Result<serde_json::Value, crate::PublicError> {
        let page = match command {
            LibraryRequest::Personal { request } => {
                let value = session
                    .personal_library(request)
                    .map_err(crate::public_session_error)?;
                // Only server-owned metadata is admitted to the remote playback allowlist.
                for field in ["items", "events", "forgotten"] {
                    if let Some(rows) = value[field].as_array() {
                        let mut tracks = self
                            .tracks
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        for row in rows {
                            if let (Some(id), Some(title), Some(artist)) = (
                                row["id"].as_str(),
                                row["title"].as_str(),
                                row["artist"].as_str(),
                            ) {
                                tracks.entry(id.to_owned()).or_insert_with(|| QueueTrack {
                                    id: id.into(),
                                    title: title.into(),
                                    artist: artist.into(),
                                    album: String::new(),
                                    duration_ms: 0,
                                    media_mid: None,
                                    cover_cache_key: None,
                                });
                            }
                        }
                    }
                }
                {
                    let mut tracks = self
                        .tracks
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    for item in session.snapshot().queue.items {
                        tracks.insert(item.id.clone(), item);
                    }
                }
                if let Some(rows) = value["bookmarks"].as_array() {
                    for row in rows {
                        if let (Some(kind), Some(key)) =
                            (row["kind"].as_str(), row["coverCacheKey"].as_str())
                        {
                            self.remember_cover(kind, key);
                        }
                    }
                }
                return Ok(value);
            }
            LibraryRequest::SongArtists { song_id } => {
                let artists = self
                    .catalog
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .song_artists(&song_id)
                    .map_err(crate::public_catalog_error)?;
                return Ok(serde_json::json!(artists));
            }
            LibraryRequest::SearchEntities {
                kind,
                keyword,
                page,
                page_size,
                generation,
            } => {
                let result = self
                    .catalog
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .search_entities(kind, &keyword, page, page_size, generation)
                    .map_err(crate::public_catalog_error)?;
                self.remember_entities(&result);
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::ArtistAlbums {
                artist_id,
                page,
                page_size,
                generation,
            } => {
                let result = self
                    .catalog
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .artist_albums(&artist_id, page, page_size, generation)
                    .map_err(crate::public_catalog_error)?;
                self.remember_entities(&result);
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::AlbumDetail { album_id } => {
                let result = self
                    .catalog
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .album_detail(&album_id)
                    .map_err(crate::public_catalog_error)?;
                if let Some(key) = &result.cover_cache_key {
                    self.remember_cover("album", key);
                }
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::ArtistDetail { artist_id } => {
                let result = self
                    .catalog
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .artist_detail(&artist_id)
                    .map_err(crate::public_catalog_error)?;
                if let Some(key) = result.as_ref().and_then(|a| a.avatar_cache_key.as_ref()) {
                    self.remember_cover("artist", key);
                }
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::AlbumSongs {
                album_id,
                page,
                page_size,
                generation,
            } => self
                .catalog
                .as_ref()
                .ok_or_else(crate::provider_unavailable)?
                .album_songs(&album_id, page, page_size, generation)
                .map_err(crate::public_catalog_error)?,
            LibraryRequest::ArtistSongs {
                artist_id,
                page,
                page_size,
                generation,
            } => self
                .catalog
                .as_ref()
                .ok_or_else(crate::provider_unavailable)?
                .artist_songs(&artist_id, page, page_size, generation)
                .map_err(crate::public_catalog_error)?,
            LibraryRequest::Playlists {
                kind,
                page,
                page_size,
            } => {
                return self
                    .library
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .playlists(kind, page, page_size)
                    .map(|value| serde_json::json!(value))
                    .map_err(crate::public_library_error)
            }
            LibraryRequest::PlaylistSongs {
                playlist_id,
                editable_id,
                page,
                page_size,
                generation,
            } => self
                .catalog
                .as_ref()
                .ok_or_else(crate::provider_unavailable)?
                .playlist_songs(
                    &playlist_id,
                    editable_id.as_deref(),
                    page,
                    page_size,
                    generation,
                )
                .map_err(crate::public_catalog_error)?,
            LibraryRequest::Local {} => {
                let result = self
                    .local
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .list()
                    .map_err(crate::public_local_music_error)?;
                let mut tracks = self
                    .tracks
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if tracks.len() + result.tracks.len() > 10000 {
                    tracks.clear();
                }
                for item in &result.tracks {
                    tracks.insert(
                        item.id.clone(),
                        QueueTrack {
                            id: item.id.clone(),
                            title: item.title.clone(),
                            artist: item.artist.clone(),
                            album: item.album.clone(),
                            duration_ms: item.duration_ms,
                            media_mid: None,
                            cover_cache_key: item.cover_cache_key.clone(),
                        },
                    );
                }
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::Replace { ref ids } | LibraryRequest::EnqueueMany { ref ids } => {
                if ids.is_empty() || ids.len() > 1000 {
                    return Err(crate::public_queue_error(
                        crate::queue::QueueError::LimitExceeded,
                    ));
                }
                let tracks = self
                    .tracks
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let items = ids
                    .iter()
                    .map(|id| {
                        tracks
                            .get(id)
                            .cloned()
                            .ok_or_else(crate::provider_unavailable)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                drop(tracks);
                if matches!(command, LibraryRequest::EnqueueMany { .. }) {
                    return self
                        .queue
                        .as_ref()
                        .ok_or_else(crate::provider_unavailable)?
                        .enqueue_many(items)
                        .map(|value| serde_json::json!(value))
                        .map_err(crate::public_queue_error);
                }
                return session
                    .replace_queue(items)
                    .map(|value| serde_json::json!(value))
                    .map_err(crate::public_session_error);
            }
            LibraryRequest::Auth {} => {
                return Ok(
                    serde_json::json!({"state": self.auth.read().unwrap_or_else(std::sync::PoisonError::into_inner).state}),
                )
            }
            LibraryRequest::Discover { area, generation } => self
                .catalog
                .as_ref()
                .ok_or_else(crate::provider_unavailable)?
                .discover_new_songs(area, generation)
                .map_err(crate::public_catalog_error)?,
            LibraryRequest::Search {
                keyword,
                page,
                page_size,
                generation,
            } => self
                .catalog
                .as_ref()
                .ok_or_else(crate::provider_unavailable)?
                .search_songs(&keyword, page, page_size, generation)
                .map_err(crate::public_catalog_error)?,
            LibraryRequest::Liked {
                page,
                page_size,
                generation,
            } => self
                .library
                .as_ref()
                .ok_or_else(crate::provider_unavailable)?
                .liked_songs(page, page_size, generation)
                .map_err(crate::public_library_error)?,
            LibraryRequest::SetLiked { song_ids, liked } => {
                let epoch = session.shuffle_likes_epoch();
                let result = self
                    .library
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .set_liked_checked(&song_ids, liked)
                    .map_err(crate::public_library_error)?;
                session.update_shuffle_likes(&song_ids, liked, epoch);
                return Ok(serde_json::json!(result));
            }
            LibraryRequest::Enqueue { ref id } | LibraryRequest::EnqueueNext { ref id } => {
                let item = self
                    .tracks
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .get(id)
                    .cloned()
                    .ok_or_else(crate::provider_unavailable)?;
                if matches!(command, LibraryRequest::EnqueueNext { .. }) {
                    return session
                        .enqueue_next(item)
                        .map(|value| serde_json::json!(value))
                        .map_err(crate::public_session_error);
                }
                return self
                    .queue
                    .as_ref()
                    .ok_or_else(crate::provider_unavailable)?
                    .enqueue(item)
                    .map(|value| serde_json::json!(value))
                    .map_err(crate::public_queue_error);
            }
        };
        self.remember(&page);
        Ok(serde_json::json!(page))
    }
}

pub(super) async fn request(
    State(state): State<Arc<RemoteState>>,
    Json(command): Json<LibraryRequest>,
) -> Response {
    let Some(library) = state.library.clone() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "曲库尚未就绪");
    };
    let Ok(permit) = state.permits.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "曲库繁忙，请稍后重试");
    };
    match tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        if !state.alive.load(Ordering::Acquire) {
            return Err(crate::provider_unavailable());
        }
        library.execute(command, &state.session)
    })
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(value)) => (StatusCode::BAD_REQUEST, Json(value)).into_response(),
        Err(_) => error(StatusCode::SERVICE_UNAVAILABLE, "曲库请求未完成"),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CoverQuery {
    key: String,
    kind: Option<String>,
}
pub(super) async fn cover(
    State(state): State<Arc<RemoteState>>,
    Query(query): Query<CoverQuery>,
) -> Response {
    let kind = query.kind.as_deref().unwrap_or("album");
    if !matches!(kind, "album" | "artist") {
        return error(StatusCode::NOT_FOUND, "暂无封面");
    }
    let allowed = state.library.as_ref().is_some_and(|library| {
        library
            .covers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(&(kind.to_owned(), query.key.clone()))
            || (kind == "album"
                && library
                    .tracks
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .values()
                    .any(|track| track.cover_cache_key.as_deref() == Some(query.key.as_str())))
    });
    if !allowed {
        return error(StatusCode::NOT_FOUND, "暂无封面");
    }
    let Some(cover) = state.cover.clone() else {
        return error(StatusCode::NOT_FOUND, "暂无封面");
    };
    let local = state
        .library
        .as_ref()
        .and_then(|library| library.local.clone());
    let Ok(permit) = state.permits.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "请稍后重试");
    };
    match tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        if query.key.starts_with("local_") && query.kind.as_deref() != Some("artist") {
            return local
                .ok_or(crate::cover::CoverError::CoverUnavailable)?
                .embedded_cover(&query.key)
                .map_err(|_| crate::cover::CoverError::CoverUnavailable);
        }
        match query.kind.as_deref() {
            Some("artist") => cover.get_artist(&query.key),
            _ => cover.get(&query.key),
        }
    })
    .await
    {
        Ok(Ok(value)) => ([("content-type", value.mime_type)], value.bytes).into_response(),
        _ => error(StatusCode::NOT_FOUND, "暂无封面"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_scoped_catalog_requests_are_accepted() {
        assert!(serde_json::from_str::<LibraryRequest>(r#"{"command":"catalog_search_songs","keyword":"test","page":1,"pageSize":20,"generation":1}"#).is_ok());
        for value in [
            r#"{"command":"catalog_search_entities","kind":"albums","keyword":"test","page":1,"pageSize":20,"generation":1}"#,
            r#"{"command":"catalog_album_detail","albumId":"album-1"}"#,
            r#"{"command":"catalog_album_songs","albumId":"album-1","page":1,"pageSize":20,"generation":1}"#,
            r#"{"command":"catalog_artist_detail","artistId":"artist-1"}"#,
            r#"{"command":"catalog_song_artists","songId":"song-mid-1"}"#,
            r#"{"command":"catalog_artist_albums","artistId":"artist-1","page":1,"pageSize":20,"generation":1}"#,
        ] {
            assert!(serde_json::from_str::<LibraryRequest>(value).is_ok());
        }
        for value in [
            r#"{"command":"local_music_catalog","request":{"action":"status"}}"#,
            r#"{"command":"local_music_catalog","request":{"action":"remove","id":"x"}}"#,
            r#"{"command":"catalog_search_entities","kind":"downloads","keyword":"test","page":1,"pageSize":20,"generation":1}"#,
            r#"{"command":"catalog_album_detail","albumId":"album-1","url":"SENTINEL"}"#,
            r#"{"command":"auth_logout"}"#,
            r#"{"command":"library_delete_playlist","editableId":"123"}"#,
            r#"{"command":"queue_enqueue","id":"test","url":"http://example.com"}"#,
        ] {
            assert!(serde_json::from_str::<LibraryRequest>(value).is_err());
        }
    }
}
