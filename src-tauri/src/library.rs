use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    catalog::{normalize_song_page, CatalogError, CatalogSong, CatalogSongPage},
    provider::{ProviderError, ProviderReply, ProviderRequest, ProviderRequestPort},
};

const MAX_PAGE: u32 = 100;
const MAX_PAGE_SIZE: u32 = 50;
const MAX_PLAYLIST_NAME_CHARS: usize = 100;
const MAX_WRITE_SONGS: usize = 100;
const MAX_TEXT_BYTES: usize = 512;
const MAX_ID_BYTES: usize = 128;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LibraryError {
    InvalidRequest,
    ProviderUnavailable,
    NetworkUnavailable,
    AuthenticationRequired,
    WriteRejected,
    OutcomeUnknown,
    UpstreamSchemaChanged,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaylistKind {
    Created,
    Favorite,
}

impl PlaylistKind {
    fn as_wire(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Favorite => "favorite",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editable_id: Option<String>,
    pub title: String,
    pub description: String,
    pub song_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistPage {
    pub kind: PlaylistKind,
    pub page: u32,
    pub has_more: bool,
    pub total: u64,
    pub warning_count: usize,
    pub items: Vec<PlaylistSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistSnapshot {
    pub summary: PlaylistSummary,
    pub songs: Vec<CatalogSong>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReceipt {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlist: Option<CreatedPlaylist>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatedPlaylist {
    pub id: String,
    pub editable_id: String,
    pub title: String,
}

pub struct LibraryService {
    provider: Arc<dyn ProviderRequestPort>,
}

pub trait LibraryPort: Send + Sync {
    fn playlist_snapshot(&self, playlist_id: &str) -> Result<PlaylistSnapshot, LibraryError>;
    fn add_songs(
        &self,
        editable_id: &str,
        song_ids: &[String],
    ) -> Result<WriteReceipt, LibraryError>;
    fn remove_songs(
        &self,
        editable_id: &str,
        song_ids: &[String],
    ) -> Result<WriteReceipt, LibraryError>;
}

impl LibraryPort for LibraryService {
    fn playlist_snapshot(&self, playlist_id: &str) -> Result<PlaylistSnapshot, LibraryError> {
        LibraryService::playlist_snapshot(self, playlist_id)
    }

    fn add_songs(
        &self,
        editable_id: &str,
        song_ids: &[String],
    ) -> Result<WriteReceipt, LibraryError> {
        LibraryService::add_songs(self, editable_id, song_ids)
    }

    fn remove_songs(
        &self,
        editable_id: &str,
        song_ids: &[String],
    ) -> Result<WriteReceipt, LibraryError> {
        LibraryService::remove_songs(self, editable_id, song_ids)
    }
}

impl LibraryService {
    pub fn new(provider: Arc<dyn ProviderRequestPort>) -> Self {
        Self { provider }
    }

    pub fn playlists(
        &self,
        kind: PlaylistKind,
        page: u32,
        page_size: u32,
    ) -> Result<PlaylistPage, LibraryError> {
        validate_pagination(page, page_size)?;
        let result = self.read(
            "library.playlists",
            Map::from_iter([
                ("kind".to_owned(), Value::String(kind.as_wire().to_owned())),
                ("page".to_owned(), Value::from(page)),
                ("pageSize".to_owned(), Value::from(page_size)),
            ]),
        )?;
        let wire: WirePlaylistPage = serde_json::from_value(Value::Object(result.0))
            .map_err(|_| LibraryError::UpstreamSchemaChanged)?;
        wire.normalize(result.1)
    }

    pub fn liked_songs(
        &self,
        page: u32,
        page_size: u32,
        generation: u64,
    ) -> Result<CatalogSongPage, LibraryError> {
        validate_pagination(page, page_size)?;
        let (result, warnings) = self.read(
            "library.liked",
            Map::from_iter([
                ("page".to_owned(), Value::from(page)),
                ("pageSize".to_owned(), Value::from(page_size)),
            ]),
        )?;
        normalize_song_page(result, generation, warnings).map_err(map_catalog_error)
    }

    pub fn playlist_snapshot(&self, playlist_id: &str) -> Result<PlaylistSnapshot, LibraryError> {
        let numeric_id = validate_numeric_id(playlist_id)?;
        let mut page = 1;
        let mut summary: Option<PlaylistSummary> = None;
        let mut songs = Vec::new();
        loop {
            let (mut result, warnings) = self.read(
                "playlist.detail",
                Map::from_iter([
                    ("id".to_owned(), Value::from(numeric_id)),
                    ("page".to_owned(), Value::from(page)),
                    ("pageSize".to_owned(), Value::from(MAX_PAGE_SIZE)),
                ]),
            )?;
            let raw_summary = result
                .remove("summary")
                .ok_or(LibraryError::UpstreamSchemaChanged)?;
            let raw_songs = result
                .remove("songs")
                .and_then(|value| value.as_object().cloned())
                .ok_or(LibraryError::UpstreamSchemaChanged)?;
            if !result.is_empty() {
                return Err(LibraryError::UpstreamSchemaChanged);
            }
            let current_summary: WirePlaylistSummary = serde_json::from_value(raw_summary)
                .map_err(|_| LibraryError::UpstreamSchemaChanged)?;
            let current_summary = current_summary.normalize(None)?;
            if let Some(existing) = &summary {
                if existing != &current_summary {
                    return Err(LibraryError::UpstreamSchemaChanged);
                }
            } else {
                summary = Some(current_summary);
            }
            let song_page = normalize_song_page(raw_songs, u64::from(page), warnings)
                .map_err(map_catalog_error)?;
            songs.extend(song_page.items);
            if !song_page.has_more {
                break;
            }
            page += 1;
            if page > MAX_PAGE {
                return Err(LibraryError::UpstreamSchemaChanged);
            }
        }
        Ok(PlaylistSnapshot {
            summary: summary.ok_or(LibraryError::UpstreamSchemaChanged)?,
            songs,
        })
    }

    pub fn create_playlist(&self, name: &str) -> Result<WriteReceipt, LibraryError> {
        let name = name.trim();
        if name.is_empty()
            || name.chars().count() > MAX_PLAYLIST_NAME_CHARS
            || name.contains(['\r', '\n', '\0'])
        {
            return Err(LibraryError::InvalidRequest);
        }
        self.write(
            "playlist.create",
            Map::from_iter([("name".to_owned(), Value::String(name.to_owned()))]),
        )
    }

    pub fn create_playlist_checked(&self, name: &str) -> Result<WriteReceipt, LibraryError> {
        let before = self.all_playlists(PlaylistKind::Created)?;
        match self.create_playlist(name) {
            Ok(receipt) => {
                let created = receipt
                    .playlist
                    .as_ref()
                    .ok_or(LibraryError::UpstreamSchemaChanged)?;
                let after = self.all_playlists(PlaylistKind::Created)?;
                if after.iter().any(|playlist| {
                    playlist.id == created.id
                        && playlist.editable_id.as_deref() == Some(created.editable_id.as_str())
                }) {
                    Ok(receipt)
                } else {
                    Err(LibraryError::OutcomeUnknown)
                }
            }
            Err(LibraryError::OutcomeUnknown) => {
                let before_ids = before
                    .iter()
                    .map(|playlist| playlist.id.as_str())
                    .collect::<std::collections::HashSet<_>>();
                let candidates = self
                    .all_playlists(PlaylistKind::Created)?
                    .into_iter()
                    .filter(|playlist| {
                        !before_ids.contains(playlist.id.as_str()) && playlist.title == name.trim()
                    })
                    .collect::<Vec<_>>();
                if candidates.len() == 1 {
                    let candidate = &candidates[0];
                    Ok(WriteReceipt {
                        status: "applied".to_owned(),
                        affected_count: None,
                        playlist: Some(CreatedPlaylist {
                            id: candidate.id.clone(),
                            editable_id: candidate
                                .editable_id
                                .clone()
                                .ok_or(LibraryError::UpstreamSchemaChanged)?,
                            title: candidate.title.clone(),
                        }),
                    })
                } else {
                    Err(LibraryError::OutcomeUnknown)
                }
            }
            Err(error) => Err(error),
        }
    }

    pub fn delete_playlist(&self, editable_id: &str) -> Result<WriteReceipt, LibraryError> {
        self.write_playlist_only("playlist.delete", editable_id)
    }

    pub fn delete_playlist_checked(&self, editable_id: &str) -> Result<WriteReceipt, LibraryError> {
        let write = self.delete_playlist(editable_id);
        if !matches!(&write, Ok(_) | Err(LibraryError::OutcomeUnknown)) {
            return write;
        }
        let absent = self
            .all_playlists(PlaylistKind::Created)?
            .iter()
            .all(|playlist| playlist.editable_id.as_deref() != Some(editable_id));
        if absent {
            Ok(WriteReceipt {
                status: "applied".to_owned(),
                affected_count: None,
                playlist: None,
            })
        } else {
            Err(LibraryError::OutcomeUnknown)
        }
    }

    pub fn add_songs(
        &self,
        editable_id: &str,
        song_ids: &[String],
    ) -> Result<WriteReceipt, LibraryError> {
        self.write_songs("playlist.addSongs", Some(editable_id), song_ids)
    }

    pub fn remove_songs(
        &self,
        editable_id: &str,
        song_ids: &[String],
    ) -> Result<WriteReceipt, LibraryError> {
        self.write_songs("playlist.removeSongs", Some(editable_id), song_ids)
    }

    pub fn set_playlist_songs_checked(
        &self,
        playlist_id: &str,
        editable_id: &str,
        song_ids: &[String],
        present: bool,
    ) -> Result<WriteReceipt, LibraryError> {
        let write = if present {
            self.add_songs(editable_id, song_ids)
        } else {
            self.remove_songs(editable_id, song_ids)
        };
        if !matches!(&write, Ok(_) | Err(LibraryError::OutcomeUnknown)) {
            return write;
        }
        let snapshot = self.playlist_snapshot(playlist_id)?;
        let actual = snapshot
            .songs
            .iter()
            .map(|song| song.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        if song_ids
            .iter()
            .all(|song_id| actual.contains(song_id.as_str()) == present)
        {
            Ok(WriteReceipt {
                status: "applied".to_owned(),
                affected_count: Some(song_ids.len()),
                playlist: None,
            })
        } else {
            Err(LibraryError::OutcomeUnknown)
        }
    }

    pub fn set_liked(
        &self,
        song_ids: &[String],
        liked: bool,
    ) -> Result<WriteReceipt, LibraryError> {
        self.write_songs(
            if liked { "song.like" } else { "song.unlike" },
            None,
            song_ids,
        )
    }

    pub fn set_liked_checked(
        &self,
        song_ids: &[String],
        liked: bool,
    ) -> Result<WriteReceipt, LibraryError> {
        let write = self.set_liked(song_ids, liked);
        if !matches!(&write, Ok(_) | Err(LibraryError::OutcomeUnknown)) {
            return write;
        }
        let actual = self.all_liked_ids()?;
        if song_ids
            .iter()
            .all(|song_id| actual.contains(song_id) == liked)
        {
            Ok(WriteReceipt {
                status: "applied".to_owned(),
                affected_count: Some(song_ids.len()),
                playlist: None,
            })
        } else {
            Err(LibraryError::OutcomeUnknown)
        }
    }

    pub fn set_favorite_playlist(
        &self,
        playlist_id: &str,
        favorite: bool,
    ) -> Result<WriteReceipt, LibraryError> {
        self.write_playlist_only(
            if favorite {
                "playlist.favorite"
            } else {
                "playlist.unfavorite"
            },
            playlist_id,
        )
    }

    pub fn set_favorite_playlist_checked(
        &self,
        playlist_id: &str,
        favorite: bool,
    ) -> Result<WriteReceipt, LibraryError> {
        let write = self.set_favorite_playlist(playlist_id, favorite);
        if !matches!(&write, Ok(_) | Err(LibraryError::OutcomeUnknown)) {
            return write;
        }
        let present = self
            .all_playlists(PlaylistKind::Favorite)?
            .iter()
            .any(|playlist| playlist.id == playlist_id);
        if present == favorite {
            Ok(WriteReceipt {
                status: "applied".to_owned(),
                affected_count: None,
                playlist: None,
            })
        } else {
            Err(LibraryError::OutcomeUnknown)
        }
    }

    fn all_playlists(&self, kind: PlaylistKind) -> Result<Vec<PlaylistSummary>, LibraryError> {
        let mut items = Vec::new();
        for page in 1..=MAX_PAGE {
            let result = self.playlists(kind, page, MAX_PAGE_SIZE)?;
            items.extend(result.items);
            if !result.has_more {
                return Ok(items);
            }
        }
        Err(LibraryError::UpstreamSchemaChanged)
    }

    pub(crate) fn all_liked_ids(&self) -> Result<std::collections::HashSet<String>, LibraryError> {
        let mut items = std::collections::HashSet::new();
        for page in 1..=MAX_PAGE {
            let result = self.liked_songs(page, MAX_PAGE_SIZE, u64::from(page))?;
            items.extend(result.items.into_iter().map(|song| song.id));
            if !result.has_more {
                return Ok(items);
            }
        }
        Err(LibraryError::UpstreamSchemaChanged)
    }

    fn write_playlist_only(
        &self,
        method: &'static str,
        playlist_id: &str,
    ) -> Result<WriteReceipt, LibraryError> {
        let playlist_id = validate_numeric_id(playlist_id)?;
        self.write(
            method,
            Map::from_iter([("playlistId".to_owned(), Value::from(playlist_id))]),
        )
    }

    fn write_songs(
        &self,
        method: &'static str,
        editable_id: Option<&str>,
        song_ids: &[String],
    ) -> Result<WriteReceipt, LibraryError> {
        validate_song_ids(song_ids)?;
        let mut params = Map::from_iter([(
            "songIds".to_owned(),
            Value::Array(song_ids.iter().cloned().map(Value::String).collect()),
        )]);
        if let Some(editable_id) = editable_id {
            params.insert(
                "playlistId".to_owned(),
                Value::from(validate_numeric_id(editable_id)?),
            );
        }
        self.write(method, params)
    }

    fn read(
        &self,
        method: &'static str,
        params: Map<String, Value>,
    ) -> Result<(Map<String, Value>, usize), LibraryError> {
        match self
            .provider
            .request(ProviderRequest::read_only(method, params))
            .map_err(map_provider_read_error)?
        {
            ProviderReply::Success { result, warnings } => Ok((result, warnings.len())),
            ProviderReply::Failure { code, .. } => Err(map_provider_failure(&code)),
        }
    }

    fn write(
        &self,
        method: &'static str,
        params: Map<String, Value>,
    ) -> Result<WriteReceipt, LibraryError> {
        let result = match self
            .provider
            .request(ProviderRequest::write(method, params))
            .map_err(map_provider_write_error)?
        {
            ProviderReply::Success { result, warnings } if warnings.is_empty() => result,
            ProviderReply::Success { .. } => return Err(LibraryError::UpstreamSchemaChanged),
            ProviderReply::Failure { code, .. } => return Err(map_provider_failure(&code)),
        };
        let wire: WireWriteReceipt = serde_json::from_value(Value::Object(result))
            .map_err(|_| LibraryError::UpstreamSchemaChanged)?;
        wire.normalize()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WirePlaylistPage {
    kind: PlaylistKind,
    page: u32,
    has_more: bool,
    total: u64,
    items: Vec<WirePlaylistSummary>,
}

impl WirePlaylistPage {
    fn normalize(self, warning_count: usize) -> Result<PlaylistPage, LibraryError> {
        if self.page == 0
            || self.page > MAX_PAGE
            || self.items.len() > MAX_PAGE_SIZE as usize
            || self.total > JAVASCRIPT_MAX_SAFE_INTEGER
        {
            return Err(LibraryError::UpstreamSchemaChanged);
        }
        Ok(PlaylistPage {
            kind: self.kind,
            page: self.page,
            has_more: self.has_more,
            total: self.total,
            warning_count,
            items: self
                .items
                .into_iter()
                .map(|item| item.normalize(Some(self.kind)))
                .collect::<Result<Vec<_>, _>>()?,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WirePlaylistSummary {
    id: String,
    #[serde(default)]
    editable_id: Option<String>,
    title: String,
    description: String,
    cover_url: Option<String>,
    song_count: u64,
    listen_count: u64,
}

impl WirePlaylistSummary {
    fn normalize(self, kind: Option<PlaylistKind>) -> Result<PlaylistSummary, LibraryError> {
        validate_id(&self.id)?;
        validate_text(&self.title, false)?;
        validate_text(&self.description, true)?;
        if let Some(editable_id) = &self.editable_id {
            validate_numeric_id(editable_id).map_err(|_| LibraryError::UpstreamSchemaChanged)?;
        }
        if kind == Some(PlaylistKind::Created) && self.editable_id.is_none()
            || kind == Some(PlaylistKind::Favorite) && self.editable_id.is_some()
            || self.song_count > JAVASCRIPT_MAX_SAFE_INTEGER
            || self.listen_count > JAVASCRIPT_MAX_SAFE_INTEGER
        {
            return Err(LibraryError::UpstreamSchemaChanged);
        }
        if let Some(cover_url) = self.cover_url {
            if cover_url.len() > 2_048 || !cover_url.starts_with("https://") {
                return Err(LibraryError::UpstreamSchemaChanged);
            }
        }
        Ok(PlaylistSummary {
            id: self.id,
            editable_id: self.editable_id,
            title: self.title,
            description: self.description,
            song_count: self.song_count,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireWriteReceipt {
    status: String,
    #[serde(default)]
    affected_count: Option<usize>,
    #[serde(default)]
    playlist: Option<CreatedPlaylist>,
}

impl WireWriteReceipt {
    fn normalize(self) -> Result<WriteReceipt, LibraryError> {
        if self.status != "applied"
            || self
                .affected_count
                .is_some_and(|count| count > MAX_WRITE_SONGS)
        {
            return Err(LibraryError::UpstreamSchemaChanged);
        }
        if let Some(playlist) = &self.playlist {
            validate_numeric_id(&playlist.id).map_err(|_| LibraryError::UpstreamSchemaChanged)?;
            validate_numeric_id(&playlist.editable_id)
                .map_err(|_| LibraryError::UpstreamSchemaChanged)?;
            validate_text(&playlist.title, false)?;
        }
        Ok(WriteReceipt {
            status: self.status,
            affected_count: self.affected_count,
            playlist: self.playlist,
        })
    }
}

fn validate_pagination(page: u32, page_size: u32) -> Result<(), LibraryError> {
    if page == 0 || page > MAX_PAGE || page_size == 0 || page_size > MAX_PAGE_SIZE {
        Err(LibraryError::InvalidRequest)
    } else {
        Ok(())
    }
}

fn validate_numeric_id(value: &str) -> Result<u64, LibraryError> {
    validate_id(value).map_err(|_| LibraryError::InvalidRequest)?;
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0 && *value <= JAVASCRIPT_MAX_SAFE_INTEGER)
        .ok_or(LibraryError::InvalidRequest)
}

fn validate_id(value: &str) -> Result<(), LibraryError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Err(LibraryError::UpstreamSchemaChanged)
    } else {
        Ok(())
    }
}

fn validate_song_ids(song_ids: &[String]) -> Result<(), LibraryError> {
    if song_ids.is_empty() || song_ids.len() > MAX_WRITE_SONGS {
        return Err(LibraryError::InvalidRequest);
    }
    let numeric = song_ids[0].bytes().all(|byte| byte.is_ascii_digit());
    let mut unique = std::collections::HashSet::new();
    for song_id in song_ids {
        validate_id(song_id).map_err(|_| LibraryError::InvalidRequest)?;
        if song_id.bytes().all(|byte| byte.is_ascii_digit()) != numeric || !unique.insert(song_id) {
            return Err(LibraryError::InvalidRequest);
        }
    }
    Ok(())
}

fn validate_text(value: &str, allow_empty: bool) -> Result<(), LibraryError> {
    if (!allow_empty && value.is_empty())
        || value.len() > MAX_TEXT_BYTES
        || value.contains(['\r', '\n', '\0'])
    {
        Err(LibraryError::UpstreamSchemaChanged)
    } else {
        Ok(())
    }
}

fn map_catalog_error(error: CatalogError) -> LibraryError {
    match error {
        CatalogError::InvalidRequest => LibraryError::InvalidRequest,
        CatalogError::ProviderUnavailable => LibraryError::ProviderUnavailable,
        CatalogError::NetworkUnavailable => LibraryError::NetworkUnavailable,
        CatalogError::AuthenticationRequired => LibraryError::AuthenticationRequired,
        CatalogError::Unavailable => LibraryError::Unavailable,
        CatalogError::UpstreamSchemaChanged => LibraryError::UpstreamSchemaChanged,
    }
}

fn map_provider_read_error(_error: ProviderError) -> LibraryError {
    LibraryError::ProviderUnavailable
}

fn map_provider_write_error(error: ProviderError) -> LibraryError {
    match error {
        ProviderError::OutcomeUnknown | ProviderError::RequestTimeout => {
            LibraryError::OutcomeUnknown
        }
        _ => LibraryError::ProviderUnavailable,
    }
}

fn map_provider_failure(code: &str) -> LibraryError {
    match code {
        "invalid_params" => LibraryError::InvalidRequest,
        "network_unavailable" | "rate_limited" => LibraryError::NetworkUnavailable,
        "authentication_required" => LibraryError::AuthenticationRequired,
        "write_rejected" => LibraryError::WriteRejected,
        "upstream_schema_changed" => LibraryError::UpstreamSchemaChanged,
        "upstream_unavailable" => LibraryError::Unavailable,
        _ => LibraryError::ProviderUnavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    struct FakeProvider {
        requests: Mutex<Vec<ProviderRequest>>,
        replies: Mutex<Vec<Result<ProviderReply, ProviderError>>>,
    }

    impl FakeProvider {
        fn new(replies: Vec<Result<ProviderReply, ProviderError>>) -> Arc<Self> {
            Arc::new(Self {
                requests: Mutex::new(Vec::new()),
                replies: Mutex::new(replies.into_iter().rev().collect()),
            })
        }
    }

    impl ProviderRequestPort for FakeProvider {
        fn request(&self, request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            self.requests.lock().expect("requests").push(request);
            self.replies.lock().expect("replies").pop().expect("reply")
        }
    }

    fn success(value: Value) -> Result<ProviderReply, ProviderError> {
        Ok(ProviderReply::Success {
            result: value.as_object().expect("object").clone(),
            warnings: Vec::new(),
        })
    }

    #[test]
    fn created_playlists_require_separate_editable_ids() {
        let provider = FakeProvider::new(vec![success(json!({
            "kind":"created","items":[{
                "id":"991","editableId":"88","title":"夜航","description":"",
                "coverUrl":null,"songCount":12,"listenCount":3
            }],"page":1,"hasMore":false,"total":1
        }))]);
        let service = LibraryService::new(provider);

        let page = service
            .playlists(PlaylistKind::Created, 1, 20)
            .expect("page");
        assert_eq!(page.items[0].id, "991");
        assert_eq!(page.items[0].editable_id.as_deref(), Some("88"));
    }

    #[test]
    fn write_timeout_is_outcome_unknown_and_never_converted_to_success() {
        let provider = FakeProvider::new(vec![Err(ProviderError::RequestTimeout)]);
        let service = LibraryService::new(provider);
        assert_eq!(
            service.add_songs("88", &["song-mid".to_owned()]),
            Err(LibraryError::OutcomeUnknown)
        );
    }

    #[test]
    fn invalid_write_inputs_never_reach_provider() {
        let provider = FakeProvider::new(Vec::new());
        let service = LibraryService::new(provider.clone());
        assert_eq!(
            service.delete_playlist("playlist-mid"),
            Err(LibraryError::InvalidRequest)
        );
        assert_eq!(
            service.add_songs("88", &["101".to_owned(), "song-mid".to_owned()]),
            Err(LibraryError::InvalidRequest)
        );
        assert!(provider.requests.lock().expect("requests").is_empty());
    }

    #[test]
    fn delete_timeout_is_read_back_and_not_replayed() {
        let provider = FakeProvider::new(vec![
            Err(ProviderError::RequestTimeout),
            success(json!({
                "kind":"created","items":[],"page":1,"hasMore":false,"total":0
            })),
        ]);
        let service = LibraryService::new(provider.clone());

        let receipt = service
            .delete_playlist_checked("88")
            .expect("readback proves deletion");
        assert_eq!(receipt.status, "applied");
        assert_eq!(provider.requests.lock().expect("requests").len(), 2);
    }
}
