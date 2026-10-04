use std::{path::PathBuf, sync::Arc};

use qqmusic_gui_lib::{
    catalog::CatalogService,
    lyrics::LyricService,
    provider::{
        ProviderReply, ProviderRequest, ProviderSupervisor, SupervisorConfig,
        VerifiedProviderBundle,
    },
};
use serde_json::{json, Map};

#[test]
#[ignore = "performs an explicit anonymous read against the live QQ Music search and lyric APIs"]
fn frozen_provider_returns_a_timed_renderer_safe_lyric_timeline() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../provider/dist/qqmusic-provider");
    let launch = VerifiedProviderBundle::verify(root)
        .expect("verify frozen provider")
        .launch()
        .expect("provider launch");
    let provider = Arc::new(
        ProviderSupervisor::start(launch, SupervisorConfig::default())
            .expect("start provider supervisor"),
    );
    let params = json!({"keyword":"晴天","page":1,"pageSize":1})
        .as_object()
        .expect("search params")
        .clone();
    let search = provider
        .request(ProviderRequest::read_only("search.songs", params))
        .expect("live search");
    let mut result = match search {
        ProviderReply::Success { result, .. } => result,
        ProviderReply::Failure { code, .. } => panic!("live search failed: {code}"),
    };
    let track_id = take_first_track_id(&mut result).expect("first live track ID");
    let timeline = LyricService::new(provider)
        .timeline(&track_id, 42)
        .expect("live timed lyrics");

    assert_eq!(timeline.generation, 42);
    assert_eq!(timeline.track_id, track_id);
    assert!(!timeline.lines.is_empty());
    assert!(timeline
        .lines
        .windows(2)
        .all(|pair| pair[0].at_ms < pair[1].at_ms));
    let public_json = serde_json::to_string(&timeline).expect("public timeline JSON");
    assert!(!public_json.contains("[00:"));
    assert!(!public_json.contains("https://"));
    assert!(!public_json.to_ascii_lowercase().contains("cookie"));
}

#[test]
#[ignore = "performs an explicit anonymous read against the live QQ Music song search API"]
fn frozen_provider_returns_a_renderer_safe_catalog_page() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../provider/dist/qqmusic-provider");
    let launch = VerifiedProviderBundle::verify(root)
        .expect("verify frozen provider")
        .launch()
        .expect("provider launch");
    let provider = Arc::new(
        ProviderSupervisor::start(launch, SupervisorConfig::default())
            .expect("start provider supervisor"),
    );
    let page = CatalogService::new(provider)
        .search_songs("晴天", 1, 3, 77)
        .expect("live catalog page");

    assert_eq!(page.generation, 77);
    assert!(!page.items.is_empty());
    assert!(page.items.len() <= 3);
    let public_json = serde_json::to_string(&page).expect("public catalog JSON");
    assert!(!public_json.contains("https://"));
    assert!(!public_json.to_ascii_lowercase().contains("cookie"));
    assert!(!public_json.to_ascii_lowercase().contains("authorization"));
}

fn take_first_track_id(result: &mut Map<String, serde_json::Value>) -> Option<String> {
    result
        .remove("items")?
        .as_array()?
        .first()?
        .as_object()?
        .get("id")?
        .as_str()
        .map(str::to_owned)
}
