use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::provider::{ProviderError, ProviderReply, ProviderRequest, ProviderRequestPort};

const MAX_KEYWORD_CHARS: usize = 100;
const MAX_PAGE: u32 = 100;
const MAX_PAGE_SIZE: u32 = 50;
const MAX_ARTISTS_PER_SONG: usize = 32;
const MAX_TEXT_BYTES: usize = 512;
const MAX_ID_BYTES: usize = 128;
const MAX_WARNINGS: usize = 128;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

mod browse;
pub use browse::{CatalogAlbum, CatalogEntity, CatalogEntityPage, CatalogSearchKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogError {
    InvalidRequest,
    ProviderUnavailable,
    NetworkUnavailable,
    AuthenticationRequired,
    Unavailable,
    UpstreamSchemaChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogQualityCandidate {
    pub quality: String,
    pub available: bool,
    pub requires_subscription: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAvailability {
    pub status: String,
    pub requires_subscription: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogArtistRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogArtist {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_cache_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSong {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_mid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_cache_key: Option<String>,
    pub title: String,
    pub subtitle: String,
    pub artists: Vec<CatalogArtistRef>,
    pub artist: String,
    pub album: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_publish_date: Option<String>,
    pub duration_ms: u64,
    pub quality_candidates: Vec<CatalogQualityCandidate>,
    pub availability: CatalogAvailability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSongPage {
    pub generation: u64,
    pub page: u32,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    pub warning_count: usize,
    pub items: Vec<CatalogSong>,
}

pub struct CatalogService {
    provider: Arc<dyn ProviderRequestPort>,
}

impl CatalogService {
    pub fn new(provider: Arc<dyn ProviderRequestPort>) -> Self {
        Self { provider }
    }

    pub fn search_songs(
        &self,
        keyword: &str,
        page: u32,
        page_size: u32,
        generation: u64,
    ) -> Result<CatalogSongPage, CatalogError> {
        let keyword = validate_keyword(keyword)?;
        validate_pagination(page, page_size)?;
        self.request_page(
            "search.songs",
            Map::from_iter([
                ("keyword".to_owned(), Value::String(keyword.to_owned())),
                ("page".to_owned(), Value::from(page)),
                ("pageSize".to_owned(), Value::from(page_size)),
            ]),
            generation,
        )
    }

    pub fn discover_new_songs(
        &self,
        area: u8,
        generation: u64,
    ) -> Result<CatalogSongPage, CatalogError> {
        if !(1..=6).contains(&area) {
            return Err(CatalogError::InvalidRequest);
        }
        self.request_page(
            "recommend.newSongs",
            Map::from_iter([("area".to_owned(), Value::from(area))]),
            generation,
        )
    }

    pub fn playlist_songs(
        &self,
        playlist_id: &str,
        editable_id: Option<&str>,
        page: u32,
        page_size: u32,
        generation: u64,
    ) -> Result<CatalogSongPage, CatalogError> {
        let playlist_id = validate_numeric_id(playlist_id)?;
        let editable_id = editable_id.map(validate_numeric_id).transpose()?;
        validate_pagination(page, page_size)?;
        if editable_id == Some(201) {
            return self.request_page(
                "library.liked",
                Map::from_iter([
                    ("page".to_owned(), Value::from(page)),
                    ("pageSize".to_owned(), Value::from(page_size)),
                ]),
                generation,
            );
        }
        let mut params = Map::from_iter([
            ("id".to_owned(), Value::from(playlist_id)),
            ("page".to_owned(), Value::from(page)),
            ("pageSize".to_owned(), Value::from(page_size)),
        ]);
        if let Some(editable_id) = editable_id {
            params.insert("dirId".to_owned(), Value::from(editable_id));
        }
        let reply = self
            .provider
            .request(ProviderRequest::read_only("playlist.detail", params))
            .map_err(map_provider_error)?;
        let (result, warning_count) = match reply {
            ProviderReply::Success { result, warnings } => (result, warnings.len()),
            ProviderReply::Failure { code, .. } => return Err(map_provider_failure(&code)),
        };
        let wire: WirePlaylistDetail = serde_json::from_value(Value::Object(result))
            .map_err(|_| CatalogError::UpstreamSchemaChanged)?;
        wire.normalize(generation, warning_count)
    }

    pub fn song_artists(&self, song_id: &str) -> Result<Vec<CatalogArtistRef>, CatalogError> {
        let song_id = validate_request_id(song_id)?;
        if song_id.starts_with("local_") || song_id.starts_with("fixture-") {
            return Err(CatalogError::InvalidRequest);
        }
        let reply = self
            .provider
            .request(ProviderRequest::read_only(
                "song.detail",
                Map::from_iter([("id".to_owned(), Value::String(song_id.to_owned()))]),
            ))
            .map_err(map_provider_error)?;
        let result = match reply {
            ProviderReply::Success { result, .. } => result,
            ProviderReply::Failure { code, .. } => return Err(map_provider_failure(&code)),
        };
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Detail {
            song: WireSong,
        }
        let detail: Detail = serde_json::from_value(Value::Object(result))
            .map_err(|_| CatalogError::UpstreamSchemaChanged)?;
        let song = detail.song.normalize()?;
        if song.id != song_id {
            return Err(CatalogError::UpstreamSchemaChanged);
        }
        Ok(song.artists)
    }

    pub fn artist_detail(&self, artist_id: &str) -> Result<Option<CatalogArtist>, CatalogError> {
        let artist_id = validate_request_id(artist_id)?;
        let reply = self
            .provider
            .request(ProviderRequest::read_only(
                "artist.detail",
                Map::from_iter([("id".to_owned(), Value::String(artist_id.to_owned()))]),
            ))
            .map_err(map_provider_error)?;
        let result = match reply {
            ProviderReply::Success { result, .. } => result,
            ProviderReply::Failure { code, .. } => return Err(map_provider_failure(&code)),
        };
        let wire: WireArtistDetail = serde_json::from_value(Value::Object(result))
            .map_err(|_| CatalogError::UpstreamSchemaChanged)?;
        wire.normalize()
    }

    pub fn artist_songs(
        &self,
        artist_id: &str,
        page: u32,
        page_size: u32,
        generation: u64,
    ) -> Result<CatalogSongPage, CatalogError> {
        let artist_id = validate_request_id(artist_id)?;
        validate_pagination(page, page_size)?;
        self.request_page(
            "artist.songs",
            Map::from_iter([
                ("id".to_owned(), Value::String(artist_id.to_owned())),
                ("page".to_owned(), Value::from(page)),
                ("pageSize".to_owned(), Value::from(page_size)),
            ]),
            generation,
        )
    }

    fn request_page(
        &self,
        method: &'static str,
        params: Map<String, Value>,
        generation: u64,
    ) -> Result<CatalogSongPage, CatalogError> {
        let reply = self
            .provider
            .request(ProviderRequest::read_only(method, params))
            .map_err(map_provider_error)?;
        let (result, warning_count) = match reply {
            ProviderReply::Success { result, warnings } => (result, warnings.len()),
            ProviderReply::Failure { code, .. } => return Err(map_provider_failure(&code)),
        };
        normalize_song_page(result, generation, warning_count)
    }
}

fn validate_numeric_id(value: &str) -> Result<u64, CatalogError> {
    if value.is_empty() || value.len() > 32 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CatalogError::InvalidRequest);
    }
    let parsed = value
        .parse::<u64>()
        .map_err(|_| CatalogError::InvalidRequest)?;
    if parsed == 0 || parsed > JAVASCRIPT_MAX_SAFE_INTEGER {
        return Err(CatalogError::InvalidRequest);
    }
    Ok(parsed)
}

pub(crate) fn normalize_song_page(
    result: Map<String, Value>,
    generation: u64,
    warning_count: usize,
) -> Result<CatalogSongPage, CatalogError> {
    let wire: WireSongPage = serde_json::from_value(Value::Object(result))
        .map_err(|_| CatalogError::UpstreamSchemaChanged)?;
    wire.normalize(generation, warning_count)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireSongPage {
    items: Vec<WireSong>,
    page: u32,
    has_more: bool,
    #[serde(default)]
    total: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WirePlaylistDetail {
    summary: WirePlaylistSummary,
    songs: WireSongPage,
}

impl WirePlaylistDetail {
    fn normalize(
        self,
        generation: u64,
        warning_count: usize,
    ) -> Result<CatalogSongPage, CatalogError> {
        self.summary.validate()?;
        self.songs.normalize(generation, warning_count)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WirePlaylistSummary {
    id: String,
    title: String,
    description: String,
    cover_url: Option<String>,
    song_count: u64,
    listen_count: u64,
}

impl WirePlaylistSummary {
    fn validate(self) -> Result<(), CatalogError> {
        validate_id(&self.id)?;
        validate_text(&self.title, false)?;
        validate_discarded_description(&self.description)?;
        if let Some(url) = &self.cover_url {
            validate_discarded_cover_url(url)?;
        }
        if self.song_count > JAVASCRIPT_MAX_SAFE_INTEGER
            || self.listen_count > JAVASCRIPT_MAX_SAFE_INTEGER
        {
            return Err(CatalogError::UpstreamSchemaChanged);
        }
        Ok(())
    }
}

impl WireSongPage {
    fn normalize(
        self,
        generation: u64,
        warning_count: usize,
    ) -> Result<CatalogSongPage, CatalogError> {
        if self.page == 0
            || self.page > MAX_PAGE
            || self.items.len() > MAX_PAGE_SIZE as usize
            || warning_count > MAX_WARNINGS
            || self
                .total
                .is_some_and(|total| total > JAVASCRIPT_MAX_SAFE_INTEGER)
        {
            return Err(CatalogError::UpstreamSchemaChanged);
        }
        let items = self
            .items
            .into_iter()
            .map(WireSong::normalize)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(CatalogSongPage {
            generation,
            page: self.page,
            has_more: self.has_more,
            total: self.total,
            warning_count,
            items,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireSong {
    id: String,
    #[serde(default)]
    media_mid: Option<String>,
    #[serde(default)]
    cover_cache_key: Option<String>,
    title: String,
    subtitle: String,
    artists: Vec<WireArtist>,
    album: WireAlbum,
    duration_ms: u64,
    quality_candidates: Vec<WireQualityCandidate>,
    availability: WireAvailability,
}

impl WireSong {
    fn normalize(self) -> Result<CatalogSong, CatalogError> {
        validate_id(&self.id)?;
        if let Some(media_mid) = &self.media_mid {
            validate_id(media_mid)?;
        }
        if let Some(cover_cache_key) = &self.cover_cache_key {
            validate_id(cover_cache_key)?;
        }
        validate_text(&self.title, false)?;
        validate_text(&self.subtitle, true)?;
        if self.artists.is_empty()
            || self.artists.len() > MAX_ARTISTS_PER_SONG
            || self.duration_ms > 86_400_000
        {
            return Err(CatalogError::UpstreamSchemaChanged);
        }
        let artists = self
            .artists
            .into_iter()
            .map(WireArtist::normalize)
            .collect::<Result<Vec<_>, _>>()?;
        let artist = artists
            .iter()
            .map(|artist| artist.name.as_str())
            .collect::<Vec<_>>()
            .join(" / ");
        validate_text(&artist, false)?;
        let album_id = self.album.id.clone();
        let album_publish_date = self.album.publish_date.clone();
        let album = self.album.normalize()?;
        if self.quality_candidates.len() != 3 {
            return Err(CatalogError::UpstreamSchemaChanged);
        }
        let qualities = self
            .quality_candidates
            .into_iter()
            .enumerate()
            .map(|(index, value)| value.normalize(index))
            .collect::<Result<Vec<_>, _>>()?;
        let availability = self.availability.normalize()?;
        Ok(CatalogSong {
            id: self.id,
            media_mid: self.media_mid,
            cover_cache_key: self.cover_cache_key,
            title: self.title,
            subtitle: self.subtitle,
            artists,
            artist,
            album,
            album_id: Some(album_id),
            album_publish_date: (!album_publish_date.is_empty()).then_some(album_publish_date),
            duration_ms: self.duration_ms,
            quality_candidates: qualities,
            availability,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireArtist {
    id: String,
    name: String,
}

impl WireArtist {
    fn normalize(self) -> Result<CatalogArtistRef, CatalogError> {
        validate_id(&self.id)?;
        validate_text(&self.name, false)?;
        Ok(CatalogArtistRef {
            id: self.id,
            name: self.name,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireArtistDetail {
    artist: Option<WireArtistDetailValue>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireArtistDetailValue {
    id: String,
    name: String,
    #[serde(default)]
    cover_url: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

impl WireArtistDetail {
    fn normalize(self) -> Result<Option<CatalogArtist>, CatalogError> {
        let Some(artist) = self.artist else {
            return Ok(None);
        };
        validate_id(&artist.id)?;
        validate_text(&artist.name, false)?;
        if let Some(url) = &artist.cover_url {
            validate_discarded_cover_url(url)?;
        }
        if let Some(description) = &artist.description {
            validate_discarded_description(description)?;
        }
        Ok(Some(CatalogArtist {
            id: artist.id.clone(),
            name: artist.name,
            avatar_cache_key: artist.cover_url.map(|_| artist.id),
            description: artist.description,
        }))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireAlbum {
    id: String,
    title: String,
    publish_date: String,
}

impl WireAlbum {
    fn normalize(self) -> Result<String, CatalogError> {
        validate_id(&self.id)?;
        validate_text(&self.title, false)?;
        validate_text(&self.publish_date, true)?;
        Ok(self.title)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireQualityCandidate {
    quality: String,
    available: bool,
    requires_subscription: bool,
}

impl WireQualityCandidate {
    fn normalize(self, index: usize) -> Result<CatalogQualityCandidate, CatalogError> {
        let expected = ["flac", "320k", "128k"];
        if expected.get(index).copied() != Some(self.quality.as_str()) {
            return Err(CatalogError::UpstreamSchemaChanged);
        }
        Ok(CatalogQualityCandidate {
            quality: self.quality,
            available: self.available,
            requires_subscription: self.requires_subscription,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireAvailability {
    status: String,
    requires_subscription: bool,
}

impl WireAvailability {
    fn normalize(self) -> Result<CatalogAvailability, CatalogError> {
        if self.status != "unknown" && self.status != "unavailable" {
            return Err(CatalogError::UpstreamSchemaChanged);
        }
        Ok(CatalogAvailability {
            status: self.status,
            requires_subscription: self.requires_subscription,
        })
    }
}

fn validate_keyword(keyword: &str) -> Result<&str, CatalogError> {
    let keyword = keyword.trim();
    if keyword.is_empty()
        || keyword.chars().count() > MAX_KEYWORD_CHARS
        || keyword.contains(['\r', '\n', '\0'])
    {
        return Err(CatalogError::InvalidRequest);
    }
    Ok(keyword)
}

fn validate_pagination(page: u32, page_size: u32) -> Result<(), CatalogError> {
    if page == 0 || page > MAX_PAGE || page_size == 0 || page_size > MAX_PAGE_SIZE {
        return Err(CatalogError::InvalidRequest);
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), CatalogError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(CatalogError::UpstreamSchemaChanged);
    }
    Ok(())
}

fn validate_request_id(value: &str) -> Result<&str, CatalogError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(CatalogError::InvalidRequest);
    }
    Ok(value)
}

fn validate_text(value: &str, allow_empty: bool) -> Result<(), CatalogError> {
    if (!allow_empty && value.is_empty())
        || value.len() > MAX_TEXT_BYTES
        || value.contains(['\r', '\n', '\0'])
    {
        return Err(CatalogError::UpstreamSchemaChanged);
    }
    Ok(())
}

fn validate_discarded_cover_url(value: &str) -> Result<(), CatalogError> {
    // Cover locations are deliberately discarded before the public DTO. Only
    // bound their allocation and require HTTPS here; a later Rust cache fetcher
    // must apply its own reviewed host/DNS/redirect policy before using one.
    if value.len() > 2_048 || !value.starts_with("https://") {
        return Err(CatalogError::UpstreamSchemaChanged);
    }
    Ok(())
}

fn validate_discarded_description(value: &str) -> Result<(), CatalogError> {
    if value.len() > 16_384 || value.contains('\0') {
        return Err(CatalogError::UpstreamSchemaChanged);
    }
    Ok(())
}

fn map_provider_error(_error: ProviderError) -> CatalogError {
    CatalogError::ProviderUnavailable
}

fn map_provider_failure(code: &str) -> CatalogError {
    match code {
        "invalid_params" => CatalogError::InvalidRequest,
        "network_unavailable" | "rate_limited" => CatalogError::NetworkUnavailable,
        "authentication_required" => CatalogError::AuthenticationRequired,
        "upstream_schema_changed" => CatalogError::UpstreamSchemaChanged,
        "upstream_unavailable" => CatalogError::Unavailable,
        _ => CatalogError::ProviderUnavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::provider::WarningFrame;

    struct FakeProvider {
        reply: Mutex<Option<Result<ProviderReply, ProviderError>>>,
    }

    impl ProviderRequestPort for FakeProvider {
        fn request(&self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            self.reply
                .lock()
                .expect("reply lock")
                .take()
                .expect("reply")
        }
    }

    fn service(result: Value) -> CatalogService {
        CatalogService::new(Arc::new(FakeProvider {
            reply: Mutex::new(Some(Ok(ProviderReply::Success {
                result: result.as_object().expect("result object").clone(),
                warnings: vec![WarningFrame {
                    code: "item_invalid".to_owned(),
                    count: None,
                    message: None,
                    entity: None,
                    index: None,
                }],
            }))),
        }))
    }

    fn song() -> Value {
        json!({
            "id":"song-mid-1","title":"纸月光","subtitle":"夜间版本",
            "coverCacheKey":"album-mid-1",
            "artists":[{"id":"artist-1","name":"林间电台"}],
            "album":{"id":"album-1","title":"温室唱片","publishDate":"2026-08-12"},
            "durationMs":234000,
            "qualityCandidates":[
                {"quality":"flac","available":false,"requiresSubscription":true},
                {"quality":"320k","available":true,"requiresSubscription":true},
                {"quality":"128k","available":true,"requiresSubscription":false}
            ],
            "availability":{"status":"unknown","requiresSubscription":true}
        })
    }

    fn song_with_artist_count(count: usize) -> Value {
        let mut value = song();
        value["artists"] = Value::Array(
            (0..count)
                .map(|index| {
                    json!({
                        "id": format!("artist-{index}"),
                        "name": format!("Artist {index}")
                    })
                })
                .collect(),
        );
        value
    }

    #[test]
    fn song_artist_lookup_returns_exact_references_and_rejects_other_tracks() {
        let artists = service(json!({ "song": song() }))
            .song_artists("song-mid-1")
            .unwrap();
        assert_eq!(
            artists,
            vec![CatalogArtistRef {
                id: "artist-1".into(),
                name: "林间电台".into()
            }]
        );
        assert_eq!(
            service(json!({ "song": song() })).song_artists("other-song"),
            Err(CatalogError::UpstreamSchemaChanged)
        );
        assert_eq!(
            service(json!({ "song": song_with_artist_count(33) })).song_artists("song-mid-1"),
            Err(CatalogError::UpstreamSchemaChanged)
        );
        assert_eq!(
            service(json!({ "song": song() })).song_artists("local_test"),
            Err(CatalogError::InvalidRequest)
        );
    }

    #[test]
    fn normalizes_song_page_and_discards_all_remote_cover_locations() {
        let page = service(json!({"items":[song()],"page":1,"hasMore":false,"total":1}))
            .search_songs(" 纸月光 ", 1, 20, 9)
            .expect("catalog page");
        assert_eq!(page.generation, 9);
        assert_eq!(page.warning_count, 1);
        assert_eq!(page.items[0].artist, "林间电台");
        assert_eq!(
            page.items[0].cover_cache_key.as_deref(),
            Some("album-mid-1")
        );
        let public_json = serde_json::to_string(&page).expect("public page JSON");
        assert!(!public_json.contains("https://"));
        assert!(public_json.contains("coverCacheKey"));
    }

    #[test]
    fn unknown_fields_invalid_quality_order_and_untrusted_cover_are_rejected() {
        let mut unknown = song();
        unknown
            .as_object_mut()
            .expect("song")
            .insert("url".to_owned(), json!("SENTINEL"));
        let mut wrong_quality = song();
        wrong_quality["qualityCandidates"]
            .as_array_mut()
            .expect("quality")
            .swap(0, 1);
        let mut cover = song();
        cover["coverCacheKey"] = json!("bad/key");
        for item in [unknown, wrong_quality, cover] {
            assert_eq!(
                service(json!({"items":[item],"page":1,"hasMore":false}))
                    .search_songs("valid", 1, 20, 1),
                Err(CatalogError::UpstreamSchemaChanged)
            );
        }
    }

    #[test]
    fn artist_count_allows_nine_but_rejects_more_than_thirty_two() {
        let page = service(json!({
            "items": [song_with_artist_count(9)],
            "page": 1,
            "hasMore": false,
            "total": 1
        }))
        .artist_songs("artist-mid-1", 1, 50, 1)
        .expect("nine-artist song page");
        assert_eq!(page.items[0].artists.len(), 9);

        let too_many = service(json!({
            "items": [song_with_artist_count(33)],
            "page": 1,
            "hasMore": false,
            "total": 1
        }))
        .artist_songs("artist-mid-1", 1, 50, 1);
        assert_eq!(too_many, Err(CatalogError::UpstreamSchemaChanged));
    }

    #[test]
    fn request_validation_rejects_bad_keyword_paging_and_area_before_provider_use() {
        let provider = Arc::new(FakeProvider {
            reply: Mutex::new(Some(Err(ProviderError::Unavailable))),
        });
        let service = CatalogService::new(provider);
        assert_eq!(
            service.search_songs("", 1, 20, 1),
            Err(CatalogError::InvalidRequest)
        );
        assert_eq!(
            service.search_songs("valid", 0, 20, 1),
            Err(CatalogError::InvalidRequest)
        );
        assert_eq!(
            service.discover_new_songs(0, 1),
            Err(CatalogError::InvalidRequest)
        );
        assert_eq!(
            service.playlist_songs("not-numeric", None, 1, 50, 1),
            Err(CatalogError::InvalidRequest)
        );
        assert_eq!(
            service.playlist_songs("0", None, 1, 50, 1),
            Err(CatalogError::InvalidRequest)
        );
    }

    #[test]
    fn normalizes_playlist_song_page_with_renderer_generation() {
        let page = service(json!({
            "summary": {
                "id": "99123456",
                "title": "我喜欢",
                "description": "",
                "coverUrl": "https://y.gtimg.cn/music/playlist.jpg",
                "songCount": 612,
                "listenCount": 10
            },
            "songs": {"items":[song()],"page":2,"hasMore":true,"total":612}
        }))
        .playlist_songs("99123456", Some("88"), 2, 50, 17)
        .expect("playlist page");
        assert_eq!(page.generation, 17);
        assert_eq!(page.page, 2);
        assert!(page.has_more);
        assert_eq!(page.total, Some(612));
    }

    #[test]
    fn normalizes_artist_detail_and_projects_only_a_controlled_avatar_key() {
        let artist = service(json!({
            "artist": {
                "id": "artist-mid-1",
                "name": "林间电台",
                "coverUrl": "https://y.gtimg.cn/music/artist.jpg",
                "description": "来自温室的声音"
            }
        }))
        .artist_detail("artist-mid-1")
        .expect("artist detail")
        .expect("artist");
        assert_eq!(
            artist,
            CatalogArtist {
                id: "artist-mid-1".to_owned(),
                name: "林间电台".to_owned(),
                avatar_cache_key: Some("artist-mid-1".to_owned()),
                description: Some("来自温室的声音".to_owned()),
            }
        );
        let public_json = serde_json::to_string(&artist).expect("artist JSON");
        assert!(!public_json.contains("https://"));
        assert!(public_json.contains("来自温室的声音"));

        let unicode_description = "歌".repeat(512);
        assert!(service(json!({
            "artist": {
                "id": "artist-mid-1",
                "name": "林间电台",
                "coverUrl": null,
                "description": unicode_description
            }
        }))
        .artist_detail("artist-mid-1")
        .expect("bounded unicode description")
        .is_some());
    }

    #[test]
    fn known_empty_artist_detail_is_not_found_but_schema_drift_is_rejected() {
        assert_eq!(
            service(json!({"artist": null}))
                .artist_detail("artist-mid-1")
                .expect("empty artist detail"),
            None
        );

        let mut unknown = json!({
            "artist": {
                "id": "artist-mid-1",
                "name": "林间电台",
                "coverUrl": null,
                "description": ""
            }
        });
        unknown["artist"]["unexpected"] = json!(true);
        assert_eq!(
            service(unknown).artist_detail("artist-mid-1"),
            Err(CatalogError::UpstreamSchemaChanged)
        );

        let bad_cover = json!({
            "artist": {
                "id": "artist-mid-1",
                "name": "林间电台",
                "coverUrl": "http://example.com/artist.jpg",
                "description": ""
            }
        });
        assert_eq!(
            service(bad_cover).artist_detail("artist-mid-1"),
            Err(CatalogError::UpstreamSchemaChanged)
        );
    }

    #[test]
    fn normalizes_artist_song_page_with_structured_artist_refs() {
        let page = service(json!({
            "items": [song()],
            "page": 2,
            "hasMore": true,
            "total": 612
        }))
        .artist_songs("artist-mid-1", 2, 50, 19)
        .expect("artist song page");
        assert_eq!(page.generation, 19);
        assert_eq!(page.page, 2);
        assert!(page.has_more);
        assert_eq!(page.total, Some(612));
        assert_eq!(
            page.items[0].artists,
            vec![CatalogArtistRef {
                id: "artist-1".to_owned(),
                name: "林间电台".to_owned(),
            }]
        );
        assert_eq!(page.items[0].artist, "林间电台");
    }

    #[test]
    fn artist_song_request_validation_happens_before_provider_use() {
        let provider = Arc::new(FakeProvider {
            reply: Mutex::new(Some(Err(ProviderError::Unavailable))),
        });
        let service = CatalogService::new(provider);
        assert_eq!(
            service.artist_detail("bad/id"),
            Err(CatalogError::InvalidRequest)
        );
        assert_eq!(
            service.artist_songs("artist-mid-1", 0, 50, 1),
            Err(CatalogError::InvalidRequest)
        );
        assert_eq!(
            service.artist_songs("artist-mid-1", 1, 51, 1),
            Err(CatalogError::InvalidRequest)
        );
    }

    #[test]
    fn liked_directory_uses_the_authenticated_liked_song_page_shape() {
        let page = service(json!({"items":[song()],"page":1,"hasMore":true,"total":612}))
            .playlist_songs("99123456", Some("201"), 1, 50, 18)
            .expect("liked song page");
        assert_eq!(page.generation, 18);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.total, Some(612));
    }

    #[test]
    fn playlist_detail_rejects_flat_pages_and_unknown_summary_fields() {
        assert_eq!(
            service(json!({"items":[song()],"page":1,"hasMore":false}))
                .playlist_songs("99123456", None, 1, 50, 1),
            Err(CatalogError::UpstreamSchemaChanged)
        );
        assert_eq!(
            service(json!({
                "summary": {
                    "id": "99123456",
                    "title": "我喜欢",
                    "description": "",
                    "coverUrl": null,
                    "songCount": 1,
                    "listenCount": 1,
                    "credential": "SENTINEL"
                },
                "songs": {"items":[song()],"page":1,"hasMore":false}
            }))
            .playlist_songs("99123456", None, 1, 50, 1),
            Err(CatalogError::UpstreamSchemaChanged)
        );
    }

    #[test]
    fn browse_searches_normalize_entities_and_do_not_expose_cover_urls() {
        let items = [
            (
                CatalogSearchKind::Artists,
                json!({"id":"artist-1","name":"歌手","coverUrl":null}),
            ),
            (
                CatalogSearchKind::Albums,
                json!({"id":"album-mid-1","title":"专辑","publishDate":"2026-10-01","coverUrl":null}),
            ),
            (
                CatalogSearchKind::Playlists,
                json!({"id":"123","title":"歌单","description":"第一段\n第二段","coverUrl":null,"songCount":2,"listenCount":3}),
            ),
        ];
        for (kind, item) in items {
            let result = service(json!({"items":[item],"page":2,"hasMore":false,"total":21}))
                .search_entities(kind, "测试", 2, 20, 7)
                .unwrap();
            assert_eq!(result.generation, 7);
            assert_eq!(result.page, 2);
            assert_eq!(result.total, Some(21));
            assert_eq!(result.items.len(), 1);
            assert!(!serde_json::to_string(&result).unwrap().contains("coverUrl"));
        }
    }
    #[test]
    fn albums_and_artist_biographies_preserve_metadata_and_paragraphs() {
        let result = service(json!({"album":{"id":"album-1","title":"专辑","publishDate":"2026-10-01","description":"第一段\n第二段","coverUrl":null}})).album_detail("album-1").unwrap();
        assert_eq!(result.description, "第一段\n第二段");
        assert_eq!(result.publish_date, "2026-10-01");
        let artist = service(
            json!({"artist":{"id":"artist-1","name":"歌手","description":"第一段\n第二段"}}),
        )
        .artist_detail("artist-1")
        .unwrap()
        .unwrap();
        assert_eq!(artist.description.as_deref(), Some("第一段\n第二段"));
        let songs = service(json!({"items":[song()],"page":1,"hasMore":false}))
            .album_songs("album-1", 1, 20, 7)
            .unwrap();
        assert_eq!(songs.items[0].album_id.as_deref(), Some("album-1"));
        assert_eq!(
            songs.items[0].album_publish_date.as_deref(),
            Some("2026-08-12")
        );
    }
    #[test]
    fn browse_rejects_invalid_pagination_and_untrusted_entity_fields() {
        assert_eq!(
            service(json!({}))
                .search_entities(CatalogSearchKind::Albums, "test", 0, 20, 1)
                .unwrap_err(),
            CatalogError::InvalidRequest
        );
        assert_eq!(service(json!({"items":[{"id":"album-1","title":"专辑","publishDate":"","url":"SENTINEL"}],"page":1,"hasMore":false})).search_entities(CatalogSearchKind::Albums,"test",1,20,1).unwrap_err(), CatalogError::UpstreamSchemaChanged);
        let result = service(json!({"items":[{"id":"album-1","title":"专辑","publishDate":""}],"page":1,"hasMore":false})).artist_albums("artist-1",1,20,1).unwrap();
        assert_eq!(result.items.len(), 1);
    }
}
