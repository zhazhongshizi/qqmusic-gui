use super::*;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecommendationKind {
    Guess,
    Radar,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSuggestions {
    pub generation: u64,
    pub keyword: String,
    pub items: Vec<String>,
    pub warning_count: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireSuggestions {
    items: Vec<WireSuggestion>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireSuggestion {
    keyword: String,
}

impl CatalogService {
    pub fn search_suggestions(
        &self,
        keyword: &str,
        generation: u64,
    ) -> Result<CatalogSuggestions, CatalogError> {
        let keyword = validate_keyword(keyword)?;
        let reply = self
            .provider
            .request(ProviderRequest::read_only(
                "search.complete",
                Map::from_iter([("keyword".to_owned(), Value::String(keyword.to_owned()))]),
            ))
            .map_err(map_provider_error)?;
        let (result, warning_count) = match reply {
            ProviderReply::Success { result, warnings } => (result, warnings.len()),
            ProviderReply::Failure { code, .. } => return Err(map_provider_failure(&code)),
        };
        let wire: WireSuggestions = serde_json::from_value(Value::Object(result))
            .map_err(|_| CatalogError::UpstreamSchemaChanged)?;
        if wire.items.len() > 20 || warning_count > MAX_WARNINGS {
            return Err(CatalogError::UpstreamSchemaChanged);
        }
        let mut items = Vec::new();
        for item in wire.items {
            validate_text(&item.keyword, false)?;
            let value = item.keyword.trim().to_owned();
            if !value.is_empty()
                && value.chars().count() <= MAX_KEYWORD_CHARS
                && !items.contains(&value)
            {
                items.push(value);
            }
        }
        Ok(CatalogSuggestions {
            generation,
            keyword: keyword.to_owned(),
            items,
            warning_count,
        })
    }

    pub fn recommend_songs(
        &self,
        kind: RecommendationKind,
        page: u32,
        generation: u64,
    ) -> Result<CatalogSongPage, CatalogError> {
        validate_pagination(page, 20)?;
        let (method, params) = match kind {
            RecommendationKind::Guess => {
                if page != 1 {
                    return Err(CatalogError::InvalidRequest);
                }
                ("recommend.guess", Map::new())
            }
            RecommendationKind::Radar => (
                "recommend.radar",
                Map::from_iter([("page".to_owned(), Value::from(page))]),
            ),
        };
        self.request_page(method, params, generation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::RequestSemantics;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Recorder {
        result: Value,
        calls: AtomicUsize,
    }
    impl ProviderRequestPort for Recorder {
        fn request(&self, request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            assert_eq!(request.semantics(), RequestSemantics::ReadOnlyReplayable);
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(ProviderReply::Success {
                result: self.result.as_object().unwrap().clone(),
                warnings: Vec::new(),
            })
        }
    }
    fn provider(result: Value) -> Arc<Recorder> {
        Arc::new(Recorder {
            result,
            calls: AtomicUsize::new(0),
        })
    }
    #[test]
    fn suggestions_are_trimmed_deduplicated_and_bounded() {
        let catalog = CatalogService::new(provider(json!({"items":[
            {"keyword":" 晴天 "},{"keyword":"晴天"},{"keyword":"晴天 周杰伦"}
        ]})));
        let result = catalog.search_suggestions(" 晴 ", 7).unwrap();
        assert_eq!(result.keyword, "晴");
        assert_eq!(result.generation, 7);
        assert_eq!(result.items, ["晴天", "晴天 周杰伦"]);
        for result in [
            json!({"items":[{"keyword":"valid","url":"SENTINEL"}]}),
            json!({"items":[{"keyword":"bad\nvalue"}]}),
            json!({"items":vec![json!({"keyword":"valid"});21]}),
        ] {
            assert!(CatalogService::new(provider(result))
                .search_suggestions("晴", 1)
                .is_err());
        }
    }
    #[test]
    fn invalid_inputs_never_reach_provider() {
        let port = provider(json!({"items":[]}));
        let catalog = CatalogService::new(port.clone());
        assert!(catalog.search_suggestions("", 1).is_err());
        assert!(catalog.search_suggestions(&"a".repeat(101), 1).is_err());
        assert!(catalog
            .recommend_songs(RecommendationKind::Guess, 2, 1)
            .is_err());
        assert!(catalog
            .recommend_songs(RecommendationKind::Radar, 101, 1)
            .is_err());
        assert!(catalog.recommend_playlists(1, 51, 1).is_err());
        assert_eq!(port.calls.load(Ordering::Relaxed), 0);
    }
    #[test]
    fn recommendations_preserve_generation_and_validate_playlist_fields() {
        let catalog = CatalogService::new(provider(json!({"items":[],"page":2,"hasMore":true})));
        let result = catalog
            .recommend_songs(RecommendationKind::Radar, 2, 9)
            .unwrap();
        assert_eq!(result.generation, 9);
        assert_eq!(result.page, 2);
        assert!(result.has_more);
        let catalog = CatalogService::new(provider(json!({"items":[{
            "id":"123","title":"推荐","description":"描述","coverUrl":null,
            "songCount":20,"listenCount":100
        }],"page":1,"hasMore":false})));
        let result = catalog.recommend_playlists(1, 20, 4).unwrap();
        assert_eq!(result.generation, 4);
        assert!(matches!(&result.items[0], CatalogEntity::Playlist(p) if p.id == "123"));
        let catalog = CatalogService::new(provider(json!({"items":[{
            "id":"123","title":"推荐","description":"","coverUrl":null,
            "songCount":20,"listenCount":100,"url":"SENTINEL"
        }],"page":1,"hasMore":false})));
        assert!(catalog.recommend_playlists(1, 20, 4).is_err());
    }
}
