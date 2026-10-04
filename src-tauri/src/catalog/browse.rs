use super::*;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CatalogSearchKind {
    Artists,
    Albums,
    Playlists,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAlbum {
    pub id: String,
    pub title: String,
    pub publish_date: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_cache_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPlaylist {
    pub id: String,
    pub title: String,
    pub description: String,
    pub song_count: u64,
    pub listen_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CatalogEntity {
    Artist(CatalogArtist),
    Album(CatalogAlbum),
    Playlist(CatalogPlaylist),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntityPage {
    pub generation: u64,
    pub page: u32,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    pub warning_count: usize,
    pub items: Vec<CatalogEntity>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireEntityPage {
    items: Vec<Value>,
    page: u32,
    has_more: bool,
    #[serde(default)]
    total: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireBrowseAlbum {
    id: String,
    title: String,
    publish_date: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    cover_url: Option<String>,
}

impl WireBrowseAlbum {
    fn normalize(self) -> Result<CatalogAlbum, CatalogError> {
        validate_id(&self.id)?;
        validate_text(&self.title, false)?;
        validate_text(&self.publish_date, true)?;
        validate_discarded_description(&self.description)?;
        if let Some(url) = &self.cover_url {
            validate_discarded_cover_url(url)?;
        }
        // Only an album MID can address the controlled image cache.
        let cover_cache_key =
            (!self.id.bytes().all(|b| b.is_ascii_digit())).then(|| self.id.clone());
        Ok(CatalogAlbum {
            id: self.id,
            title: self.title,
            publish_date: self.publish_date,
            description: self.description,
            cover_cache_key,
        })
    }
}

impl CatalogService {
    fn browse_reply(
        &self,
        method: &'static str,
        params: Map<String, Value>,
    ) -> Result<(Map<String, Value>, usize), CatalogError> {
        match self
            .provider
            .request(ProviderRequest::read_only(method, params))
            .map_err(map_provider_error)?
        {
            ProviderReply::Success { result, warnings } => Ok((result, warnings.len())),
            ProviderReply::Failure { code, .. } => Err(map_provider_failure(&code)),
        }
    }

    pub fn search_entities(
        &self,
        kind: CatalogSearchKind,
        keyword: &str,
        page: u32,
        page_size: u32,
        generation: u64,
    ) -> Result<CatalogEntityPage, CatalogError> {
        let keyword = validate_keyword(keyword)?;
        validate_pagination(page, page_size)?;
        let method = match kind {
            CatalogSearchKind::Artists => "search.artists",
            CatalogSearchKind::Albums => "search.albums",
            CatalogSearchKind::Playlists => "search.playlists",
        };
        self.entity_page(
            method,
            Map::from_iter([
                ("keyword".into(), Value::String(keyword.into())),
                ("page".into(), Value::from(page)),
                ("pageSize".into(), Value::from(page_size)),
            ]),
            kind,
            generation,
        )
    }

    fn entity_page(
        &self,
        method: &'static str,
        params: Map<String, Value>,
        kind: CatalogSearchKind,
        generation: u64,
    ) -> Result<CatalogEntityPage, CatalogError> {
        let (result, warning_count) = self.browse_reply(method, params)?;
        let wire: WireEntityPage = serde_json::from_value(Value::Object(result))
            .map_err(|_| CatalogError::UpstreamSchemaChanged)?;
        validate_pagination(wire.page, 1).map_err(|_| CatalogError::UpstreamSchemaChanged)?;
        if wire.items.len() > 50
            || warning_count > MAX_WARNINGS
            || wire.total.is_some_and(|n| n > JAVASCRIPT_MAX_SAFE_INTEGER)
        {
            return Err(CatalogError::UpstreamSchemaChanged);
        }
        let items = wire
            .items
            .into_iter()
            .map(|value| {
                let schema = |_| CatalogError::UpstreamSchemaChanged;
                match kind {
                    CatalogSearchKind::Artists => {
                        let artist: WireArtistDetailValue =
                            serde_json::from_value(value).map_err(schema)?;
                        let normalized = WireArtistDetail {
                            artist: Some(artist),
                        }
                        .normalize()?
                        .ok_or(CatalogError::UpstreamSchemaChanged)?;
                        Ok(CatalogEntity::Artist(normalized))
                    }
                    CatalogSearchKind::Albums => {
                        let album: WireBrowseAlbum =
                            serde_json::from_value(value).map_err(schema)?;
                        Ok(CatalogEntity::Album(album.normalize()?))
                    }
                    CatalogSearchKind::Playlists => {
                        let playlist: WirePlaylistSummary =
                            serde_json::from_value(value).map_err(schema)?;
                        validate_numeric_id(&playlist.id)
                            .map_err(|_| CatalogError::UpstreamSchemaChanged)?;
                        let result = CatalogPlaylist {
                            id: playlist.id.clone(),
                            title: playlist.title.clone(),
                            description: playlist.description.clone(),
                            song_count: playlist.song_count,
                            listen_count: playlist.listen_count,
                        };
                        playlist.validate()?;
                        Ok(CatalogEntity::Playlist(result))
                    }
                }
            })
            .collect::<Result<Vec<_>, CatalogError>>()?;
        Ok(CatalogEntityPage {
            generation,
            page: wire.page,
            has_more: wire.has_more,
            total: wire.total,
            warning_count,
            items,
        })
    }

    pub fn album_detail(&self, id: &str) -> Result<CatalogAlbum, CatalogError> {
        let id = validate_request_id(id)?;
        let (mut reply, _) = self.browse_reply(
            "album.detail",
            Map::from_iter([("id".into(), Value::String(id.into()))]),
        )?;
        if reply.len() != 1 {
            return Err(CatalogError::UpstreamSchemaChanged);
        }
        let wire: WireBrowseAlbum = serde_json::from_value(
            reply
                .remove("album")
                .ok_or(CatalogError::UpstreamSchemaChanged)?,
        )
        .map_err(|_| CatalogError::UpstreamSchemaChanged)?;
        wire.normalize()
    }

    pub fn album_songs(
        &self,
        id: &str,
        page: u32,
        page_size: u32,
        generation: u64,
    ) -> Result<CatalogSongPage, CatalogError> {
        let id = validate_request_id(id)?;
        validate_pagination(page, page_size)?;
        self.request_page(
            "album.songs",
            Map::from_iter([
                ("id".into(), Value::String(id.into())),
                ("page".into(), Value::from(page)),
                ("pageSize".into(), Value::from(page_size)),
            ]),
            generation,
        )
    }

    pub fn artist_albums(
        &self,
        id: &str,
        page: u32,
        page_size: u32,
        generation: u64,
    ) -> Result<CatalogEntityPage, CatalogError> {
        let id = validate_request_id(id)?;
        validate_pagination(page, page_size)?;
        self.entity_page(
            "artist.albums",
            Map::from_iter([
                ("id".into(), Value::String(id.into())),
                ("page".into(), Value::from(page)),
                ("pageSize".into(), Value::from(page_size)),
            ]),
            CatalogSearchKind::Albums,
            generation,
        )
    }
}
