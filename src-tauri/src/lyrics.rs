use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Condvar, Mutex},
};

use serde::Serialize;
use serde_json::{Map, Value};
use zeroize::Zeroizing;

use crate::provider::{ProviderError, ProviderReply, ProviderRequest, ProviderRequestPort};

const MAX_TRACK_ID_BYTES: usize = 128;
const MAX_RAW_LYRIC_BYTES: usize = 512_000;
const MAX_TIMED_LINES: usize = 5_000;
const MAX_LINE_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LyricError {
    InvalidRequest,
    ProviderUnavailable,
    NetworkUnavailable,
    UpstreamUnavailable,
    AuthenticationRequired,
    Unavailable,
    UpstreamSchemaChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub at_ms: u64,
    pub original: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub romanization: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricTimeline {
    pub generation: u64,
    pub track_id: String,
    pub lines: Vec<LyricLine>,
}

pub struct LyricService {
    provider: Arc<dyn ProviderRequestPort>,
    shared: Mutex<LyricState>,
    mv_offset: Mutex<Option<(String, u64, i64)>>,
}

struct LyricState {
    cached: Option<CachedLyrics>,
    in_flight: HashMap<String, Arc<LyricFlight>>,
}

struct CachedLyrics {
    track_id: String,
    lines: Arc<Vec<LyricLine>>,
}

struct LyricFlight {
    result: Mutex<Option<Result<Arc<Vec<LyricLine>>, LyricError>>>,
    wake: Condvar,
    waiters: std::sync::atomic::AtomicUsize,
}

impl LyricService {
    pub fn new(provider: Arc<dyn ProviderRequestPort>) -> Self {
        Self {
            provider,
            mv_offset: Mutex::new(None),
            shared: Mutex::new(LyricState {
                cached: None,
                in_flight: HashMap::new(),
            }),
        }
    }

    pub fn timeline(&self, track_id: &str, generation: u64) -> Result<LyricTimeline, LyricError> {
        let lines = self.lines(track_id)?;
        let offset = self
            .mv_offset
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|(id, gen, _)| id == track_id && *gen == generation)
            .map_or(0, |(_, _, value)| *value);
        let mut lines = lines.as_ref().clone();
        if offset != 0 {
            for line in &mut lines {
                line.at_ms = line.at_ms.saturating_add_signed(offset);
            }
            // Negative offsets can collapse early timestamps; keep the latest line at each time.
            let mut merged = BTreeMap::new();
            for line in lines {
                merged.insert(line.at_ms, line);
            }
            lines = merged.into_values().collect();
        }
        Ok(LyricTimeline {
            generation,
            track_id: track_id.to_owned(),
            lines,
        })
    }

    pub(crate) fn set_mv_offset(&self, id: String, generation: u64, offset: i64) {
        *self
            .mv_offset
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((id, generation, offset));
    }

    pub(crate) fn lines(&self, track_id: &str) -> Result<Arc<Vec<LyricLine>>, LyricError> {
        validate_track_id(track_id)?;
        let (flight, owner) = {
            let mut shared = self
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(cached) = shared
                .cached
                .as_ref()
                .filter(|cached| cached.track_id == track_id)
            {
                return Ok(cached.lines.clone());
            }
            if let Some(flight) = shared.in_flight.get(track_id) {
                (flight.clone(), false)
            } else {
                let flight = Arc::new(LyricFlight {
                    result: Mutex::new(None),
                    wake: Condvar::new(),
                    waiters: std::sync::atomic::AtomicUsize::new(0),
                });
                shared.in_flight.insert(track_id.to_owned(), flight.clone());
                (flight, true)
            }
        };

        if owner {
            let result = self.load_lines(track_id).map(Arc::new);
            {
                let mut flight_result = flight
                    .result
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                *flight_result = Some(result.clone());
            }
            flight.wake.notify_all();

            let mut shared = self
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Ok(lines) = &result {
                shared.cached = Some(CachedLyrics {
                    track_id: track_id.to_owned(),
                    lines: lines.clone(),
                });
            }
            shared.in_flight.remove(track_id);
            result
        } else {
            flight
                .waiters
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            let mut flight_result = flight
                .result
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            while flight_result.is_none() {
                flight_result = flight
                    .wake
                    .wait(flight_result)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            let result = flight_result
                .as_ref()
                .expect("single-flight result must be published")
                .clone();
            flight
                .waiters
                .fetch_sub(1, std::sync::atomic::Ordering::Release);
            result
        }
    }

    fn load_lines(&self, track_id: &str) -> Result<Vec<LyricLine>, LyricError> {
        let reply = self
            .provider
            .request(ProviderRequest::read_only(
                "lyrics.get",
                Map::from_iter([("id".to_owned(), Value::String(track_id.to_owned()))]),
            ))
            .map_err(map_provider_error)?;
        let mut result = match reply {
            ProviderReply::Success { result, .. } => result,
            ProviderReply::Failure { code, .. } => return Err(map_provider_failure(&code)),
        };
        if result.len() != 4
            || !["trackId", "lyric", "translation", "romanization"]
                .iter()
                .all(|key| result.contains_key(*key))
        {
            return Err(LyricError::UpstreamSchemaChanged);
        }
        let response_track_id = take_string(&mut result, "trackId", MAX_TRACK_ID_BYTES)?;
        if response_track_id.as_str() != track_id {
            return Err(LyricError::UpstreamSchemaChanged);
        }
        let original = take_string(&mut result, "lyric", MAX_RAW_LYRIC_BYTES)?;
        let translation = take_string(&mut result, "translation", MAX_RAW_LYRIC_BYTES)?;
        let romanization = take_string(&mut result, "romanization", MAX_RAW_LYRIC_BYTES)?;
        let original_lines = parse_lrc(&original)?;
        if original_lines.is_empty() {
            return Err(LyricError::Unavailable);
        }
        let translations = parse_lrc(&translation)?;
        let romanizations = parse_lrc(&romanization)?;
        let lines = original_lines
            .into_iter()
            .map(|(at_ms, original)| LyricLine {
                at_ms,
                original,
                translation: translations.get(&at_ms).cloned(),
                romanization: romanizations.get(&at_ms).cloned(),
            })
            .collect();
        Ok(lines)
    }
}

fn take_string(
    result: &mut Map<String, Value>,
    key: &str,
    maximum_bytes: usize,
) -> Result<Zeroizing<String>, LyricError> {
    match result.remove(key) {
        Some(Value::String(value)) if value.len() <= maximum_bytes && !value.contains('\0') => {
            Ok(Zeroizing::new(value))
        }
        _ => Err(LyricError::UpstreamSchemaChanged),
    }
}

fn parse_lrc(raw: &str) -> Result<BTreeMap<u64, String>, LyricError> {
    if raw.is_empty() {
        return Ok(BTreeMap::new());
    }
    let offset_ms = parse_offset(raw)?;
    let mut result = BTreeMap::new();
    for raw_line in raw.lines() {
        let line = raw_line.trim_end_matches('\r');
        let (timestamps, text) = parse_line(line)?;
        if timestamps.is_empty() {
            continue;
        }
        let text = text.trim();
        if text.is_empty() || text.len() > MAX_LINE_BYTES || text.contains(['\r', '\n', '\0']) {
            if text.is_empty() {
                continue;
            }
            return Err(LyricError::UpstreamSchemaChanged);
        }
        for timestamp in timestamps {
            let adjusted = apply_offset(timestamp, offset_ms);
            result.entry(adjusted).or_insert_with(|| text.to_owned());
            if result.len() > MAX_TIMED_LINES {
                return Err(LyricError::UpstreamSchemaChanged);
            }
        }
    }
    Ok(result)
}

fn parse_offset(raw: &str) -> Result<i64, LyricError> {
    let mut offset = 0_i64;
    for line in raw.lines() {
        let trimmed = line.trim();
        let Some(value) = trimmed
            .strip_prefix("[offset:")
            .and_then(|value| value.strip_suffix(']'))
        else {
            continue;
        };
        offset = value
            .parse::<i64>()
            .map_err(|_| LyricError::UpstreamSchemaChanged)?;
        if !(-3_600_000..=3_600_000).contains(&offset) {
            return Err(LyricError::UpstreamSchemaChanged);
        }
    }
    Ok(offset)
}

fn parse_line(line: &str) -> Result<(Vec<u64>, &str), LyricError> {
    let mut remaining = line;
    let mut timestamps = Vec::new();
    while let Some(after_open) = remaining.strip_prefix('[') {
        let Some(close) = after_open.find(']') else {
            return Err(LyricError::UpstreamSchemaChanged);
        };
        let tag = &after_open[..close];
        let Some(timestamp) = parse_timestamp(tag)? else {
            break;
        };
        timestamps.push(timestamp);
        remaining = &after_open[close + 1..];
    }
    Ok((timestamps, remaining))
}

fn parse_timestamp(value: &str) -> Result<Option<u64>, LyricError> {
    let Some((minutes, seconds)) = value.split_once(':') else {
        return Ok(None);
    };
    if minutes.is_empty() || !minutes.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(None);
    }
    let minutes = minutes
        .parse::<u64>()
        .map_err(|_| LyricError::UpstreamSchemaChanged)?;
    if minutes > 9_999 {
        return Err(LyricError::UpstreamSchemaChanged);
    }
    let (whole_seconds, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    if whole_seconds.is_empty()
        || whole_seconds.len() > 2
        || !whole_seconds.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.len() > 3
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(LyricError::UpstreamSchemaChanged);
    }
    let whole_seconds = whole_seconds
        .parse::<u64>()
        .map_err(|_| LyricError::UpstreamSchemaChanged)?;
    if whole_seconds >= 60 {
        return Err(LyricError::UpstreamSchemaChanged);
    }
    let fraction_ms = match fraction.len() {
        0 => 0,
        1 => fraction.parse::<u64>().unwrap_or_default() * 100,
        2 => fraction.parse::<u64>().unwrap_or_default() * 10,
        3 => fraction.parse::<u64>().unwrap_or_default(),
        _ => unreachable!(),
    };
    let timestamp = minutes
        .checked_mul(60_000)
        .and_then(|value| value.checked_add(whole_seconds * 1_000))
        .and_then(|value| value.checked_add(fraction_ms))
        .ok_or(LyricError::UpstreamSchemaChanged)?;
    Ok(Some(timestamp))
}

fn apply_offset(timestamp: u64, offset_ms: i64) -> u64 {
    if offset_ms >= 0 {
        timestamp.saturating_add(offset_ms as u64)
    } else {
        timestamp.saturating_sub(offset_ms.unsigned_abs())
    }
}

fn validate_track_id(track_id: &str) -> Result<(), LyricError> {
    if track_id.is_empty()
        || track_id.len() > MAX_TRACK_ID_BYTES
        || !track_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(LyricError::InvalidRequest);
    }
    Ok(())
}

fn map_provider_error(_error: ProviderError) -> LyricError {
    LyricError::ProviderUnavailable
}

fn map_provider_failure(code: &str) -> LyricError {
    match code {
        "network_unavailable" | "rate_limited" => LyricError::NetworkUnavailable,
        "authentication_required" => LyricError::AuthenticationRequired,
        "upstream_schema_changed" => LyricError::UpstreamSchemaChanged,
        "upstream_unavailable" => LyricError::UpstreamUnavailable,
        _ => LyricError::ProviderUnavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc, Mutex,
        },
        thread,
    };

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

    fn service(result: Value) -> LyricService {
        LyricService::new(Arc::new(FakeProvider {
            reply: Mutex::new(Some(Ok(ProviderReply::Success {
                result: result.as_object().expect("result object").clone(),
                warnings: Vec::<WarningFrame>::new(),
            }))),
        }))
    }

    struct SequencedProvider {
        replies: Mutex<VecDeque<Result<ProviderReply, ProviderError>>>,
        requests: AtomicUsize,
    }

    impl SequencedProvider {
        fn new(replies: Vec<Result<ProviderReply, ProviderError>>) -> Arc<Self> {
            Arc::new(Self {
                replies: Mutex::new(replies.into()),
                requests: AtomicUsize::new(0),
            })
        }
    }

    impl ProviderRequestPort for SequencedProvider {
        fn request(&self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            self.replies
                .lock()
                .expect("sequenced replies")
                .pop_front()
                .expect("sequenced reply")
        }
    }

    struct BlockingProvider {
        track_id: &'static str,
        failure: bool,
        started: mpsc::Sender<()>,
        release: Arc<AtomicBool>,
        requests: AtomicUsize,
    }

    impl ProviderRequestPort for BlockingProvider {
        fn request(&self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            self.started.send(()).expect("blocking request observer");
            while !self.release.load(Ordering::Acquire) {
                thread::yield_now();
            }
            if self.failure {
                return Ok(ProviderReply::Failure {
                    code: "upstream_unavailable".to_owned(),
                    retryable: true,
                });
            }
            Ok(ProviderReply::Success {
                result: json!({
                    "trackId": self.track_id,
                    "lyric": "[00:01]原文",
                    "translation": "",
                    "romanization": ""
                })
                .as_object()
                .expect("blocking result")
                .clone(),
                warnings: Vec::new(),
            })
        }
    }

    fn lyric_reply(track_id: &str, original: &str) -> ProviderReply {
        ProviderReply::Success {
            result: json!({
                "trackId": track_id,
                "lyric": format!("[00:01]{original}"),
                "translation": "",
                "romanization": ""
            })
            .as_object()
            .expect("lyric result")
            .clone(),
            warnings: Vec::new(),
        }
    }

    fn wait_for_waiter(service: &LyricService, track_id: &str) {
        for _ in 0..100_000 {
            let flight = service
                .shared
                .lock()
                .expect("lyric state")
                .in_flight
                .get(track_id)
                .cloned()
                .expect("in-flight request");
            if flight.waiters.load(Ordering::Acquire) > 0 {
                return;
            }
            thread::yield_now();
        }
        panic!("single-flight waiter did not register");
    }

    #[test]
    fn mv_offset_is_generation_scoped_and_does_not_modify_raw_cache() {
        let service = service(
            json!({"trackId":"one", "lyric":"[00:00]a\n[00:01]b\n[00:02]c", "translation":"", "romanization":""}),
        );
        service.set_mv_offset("one".into(), 7, -1500);
        let shifted = service.timeline("one", 7).unwrap();
        assert_eq!(
            shifted
                .lines
                .iter()
                .map(|line| line.at_ms)
                .collect::<Vec<_>>(),
            vec![0, 500]
        );
        assert_eq!(shifted.lines[0].original, "b");
        assert_eq!(
            service
                .timeline("one", 8)
                .unwrap()
                .lines
                .iter()
                .map(|line| line.at_ms)
                .collect::<Vec<_>>(),
            vec![0, 1000, 2000]
        );
        service.set_mv_offset("other".into(), 7, 500);
        assert_eq!(service.timeline("one", 7).unwrap().lines[1].at_ms, 1000);
        service.set_mv_offset("one".into(), 7, 500);
        assert_eq!(service.timeline("one", 7).unwrap().lines[1].at_ms, 1500);
        service.set_mv_offset("one".into(), 7, 0);
        assert_eq!(service.timeline("one", 7).unwrap().lines[1].at_ms, 1000);
    }

    #[test]
    fn current_track_cache_reuses_results_and_evicts_as_a_single_slot() {
        let provider = SequencedProvider::new(vec![
            Ok(lyric_reply("one", "第一首")),
            Ok(lyric_reply("two", "第二首")),
            Ok(lyric_reply("one", "第一首再次请求")),
        ]);
        let service = LyricService::new(provider.clone());

        let first = service.timeline("one", 1).expect("first timeline");
        let cached = service.timeline("one", 2).expect("cached timeline");
        let second = service.timeline("two", 3).expect("second timeline");
        let evicted = service.timeline("one", 4).expect("evicted timeline");

        assert_eq!(provider.requests.load(Ordering::SeqCst), 3);
        assert_eq!(first.lines[0].original, "第一首");
        assert_eq!(cached.generation, 2);
        assert_eq!(cached.lines, first.lines);
        assert_eq!(second.lines[0].original, "第二首");
        assert_eq!(evicted.lines[0].original, "第一首再次请求");
    }

    #[test]
    fn same_track_concurrent_requests_share_one_provider_call_before_cache_write() {
        let (started, started_receiver) = mpsc::channel();
        let release = Arc::new(AtomicBool::new(false));
        let provider = Arc::new(BlockingProvider {
            track_id: "one",
            failure: false,
            started,
            release: release.clone(),
            requests: AtomicUsize::new(0),
        });
        let service = Arc::new(LyricService::new(provider.clone()));

        let first_service = service.clone();
        let first = thread::spawn(move || first_service.timeline("one", 1));
        started_receiver
            .recv()
            .expect("first provider call started");

        let (second_ready, second_ready_receiver) = mpsc::channel();
        let second_service = service.clone();
        let second = thread::spawn(move || {
            second_ready.send(()).expect("second thread started");
            second_service.timeline("one", 2)
        });
        second_ready_receiver
            .recv()
            .expect("second request thread started");
        wait_for_waiter(&service, "one");

        release.store(true, Ordering::Release);
        let first = first
            .join()
            .expect("first timeline thread")
            .expect("first timeline");
        let second = second
            .join()
            .expect("second timeline thread")
            .expect("second timeline");

        assert_eq!(provider.requests.load(Ordering::SeqCst), 1);
        assert_eq!(first.lines, second.lines);
        assert_eq!(first.generation, 1);
        assert_eq!(second.generation, 2);
    }

    #[test]
    fn same_track_concurrent_failures_share_one_provider_call_without_caching() {
        let (started, started_receiver) = mpsc::channel();
        let release = Arc::new(AtomicBool::new(false));
        let provider = Arc::new(BlockingProvider {
            track_id: "one",
            failure: true,
            started,
            release: release.clone(),
            requests: AtomicUsize::new(0),
        });
        let service = Arc::new(LyricService::new(provider.clone()));

        let first_service = service.clone();
        let first = thread::spawn(move || first_service.timeline("one", 1));
        started_receiver
            .recv()
            .expect("first provider call started");

        let (second_ready, second_ready_receiver) = mpsc::channel();
        let second_service = service.clone();
        let second = thread::spawn(move || {
            second_ready.send(()).expect("second thread started");
            second_service.timeline("one", 2)
        });
        second_ready_receiver
            .recv()
            .expect("second request thread started");
        wait_for_waiter(&service, "one");

        release.store(true, Ordering::Release);
        assert_eq!(
            first.join().expect("first timeline thread"),
            Err(LyricError::UpstreamUnavailable)
        );
        assert_eq!(
            second.join().expect("second timeline thread"),
            Err(LyricError::UpstreamUnavailable)
        );
        assert_eq!(provider.requests.load(Ordering::SeqCst), 1);

        assert_eq!(
            service.timeline("one", 3),
            Err(LyricError::UpstreamUnavailable)
        );
        assert_eq!(provider.requests.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn failed_results_are_shared_but_not_cached() {
        let provider = SequencedProvider::new(vec![
            Ok(ProviderReply::Failure {
                code: "upstream_unavailable".to_owned(),
                retryable: true,
            }),
            Ok(ProviderReply::Failure {
                code: "upstream_unavailable".to_owned(),
                retryable: true,
            }),
        ]);
        let service = LyricService::new(provider.clone());

        assert_eq!(
            service.timeline("one", 1),
            Err(LyricError::UpstreamUnavailable)
        );
        assert_eq!(
            service.timeline("one", 2),
            Err(LyricError::UpstreamUnavailable)
        );
        assert_eq!(provider.requests.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn parses_sorts_offsets_and_aligns_variants_without_exposing_raw_lrc() {
        let timeline = service(json!({
            "trackId": "song-mid-1",
            "lyric": "[offset:100]\n[00:02.50]第二句\n[00:01][00:03.005]第一句",
            "translation": "[00:01.00]First line\n[00:02.500]Second line",
            "romanization": "[00:01]di yi ju"
        }))
        .timeline("song-mid-1", 7)
        .expect("timeline");

        assert_eq!(timeline.generation, 7);
        assert_eq!(timeline.lines.len(), 3);
        assert_eq!(timeline.lines[0].at_ms, 1_100);
        assert_eq!(timeline.lines[0].original, "第一句");
        assert_eq!(timeline.lines[0].translation, None);
        assert_eq!(timeline.lines[2].at_ms, 3_105);
        let json = serde_json::to_string(&timeline).expect("timeline json");
        assert!(!json.contains("offset:"));
        assert!(!json.contains("lyric"));
    }

    #[test]
    fn variants_align_when_their_own_offsets_match_the_original_timeline() {
        let timeline = service(json!({
            "trackId": "song-mid-1",
            "lyric": "[00:01]原文",
            "translation": "[offset:100]\n[00:00.900]Translation",
            "romanization": "[00:01.000]yuan wen"
        }))
        .timeline("song-mid-1", 1)
        .expect("timeline");
        assert_eq!(
            timeline.lines[0].translation.as_deref(),
            Some("Translation")
        );
        assert_eq!(timeline.lines[0].romanization.as_deref(), Some("yuan wen"));
    }

    #[test]
    fn mismatched_track_unknown_fields_and_malformed_lrc_are_rejected() {
        for value in [
            json!({"trackId":"other","lyric":"[00:01]x","translation":"","romanization":""}),
            json!({"trackId":"song-mid-1","lyric":"[00:61]x","translation":"","romanization":""}),
            json!({"trackId":"song-mid-1","lyric":"[00:01]x","translation":"","romanization":"","url":"SENTINEL"}),
        ] {
            assert_eq!(
                service(value).timeline("song-mid-1", 1),
                Err(LyricError::UpstreamSchemaChanged)
            );
        }
    }

    #[test]
    fn upstream_unavailable_is_mapped_to_transient_error() {
        assert_eq!(
            map_provider_failure("upstream_unavailable"),
            LyricError::UpstreamUnavailable
        );
    }

    #[test]
    fn missing_timed_original_is_a_stable_unavailable_result() {
        assert_eq!(
            service(json!({
                "trackId": "song-mid-1",
                "lyric": "[ar:artist]metadata only",
                "translation": "",
                "romanization": ""
            }))
            .timeline("song-mid-1", 1),
            Err(LyricError::Unavailable)
        );
    }
}
