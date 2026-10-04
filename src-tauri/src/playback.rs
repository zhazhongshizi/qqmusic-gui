use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{Map, Value};
use zeroize::Zeroize;

use crate::{
    network_policy::{DnsResolver, RemoteUrlPurpose, SystemDnsResolver, TrustedRemoteUrl},
    player::{
        LocalMediaFile, NativePlayerEvent, PlayerCommand, PlayerEngine, PlayerError,
        PlayerSnapshot, RemoteMediaUrl, SeekPositionMs, SmtcLyricTimeline, SmtcMetadata,
        TrackSummary, VolumeLevel,
    },
    provider::{ProviderError, ProviderReply, ProviderRequest, ProviderRequestPort},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackQuality {
    Auto,
    Flac,
    Kbps320,
    Kbps128,
}

impl PlaybackQuality {
    pub fn parse(value: &str) -> Result<Self, PlaybackError> {
        match value {
            "auto" => Ok(Self::Auto),
            "flac" => Ok(Self::Flac),
            "320k" => Ok(Self::Kbps320),
            "128k" => Ok(Self::Kbps128),
            _ => Err(PlaybackError::InvalidRequest),
        }
    }

    fn wire(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Flac => "flac",
            Self::Kbps320 => "320k",
            Self::Kbps128 => "128k",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackError {
    InvalidRequest,
    ProviderUnavailable,
    NetworkUnavailable,
    AuthenticationRequired,
    EntitlementDenied,
    DeviceLimit,
    Unavailable,
    UpstreamSchemaChanged,
    UnsafeMediaUrl,
    LocalFileMissing,
    LocalCodecUnavailable,
    NativePlayerUnavailable,
}

impl PlaybackError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "playback_invalid_request",
            Self::ProviderUnavailable => "playback_provider_unavailable",
            Self::NetworkUnavailable => "playback_network_unavailable",
            Self::AuthenticationRequired => "playback_authentication_required",
            Self::EntitlementDenied => "playback_entitlement_denied",
            Self::DeviceLimit => "playback_device_limit",
            Self::Unavailable => "playback_unavailable",
            Self::UpstreamSchemaChanged => "playback_upstream_schema_changed",
            Self::UnsafeMediaUrl => "playback_unsafe_media_url",
            Self::LocalFileMissing => "local_music_file_missing",
            Self::LocalCodecUnavailable => "local_music_codec_unavailable",
            Self::NativePlayerUnavailable => "playback_native_unavailable",
        }
    }
}

impl std::fmt::Display for PlaybackError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for PlaybackError {}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackLoadResult {
    pub quality: String,
    pub expires_in_seconds: u64,
    pub player: PlayerSnapshot,
}

pub struct PlaybackController {
    provider: Arc<dyn ProviderRequestPort>,
    player: Mutex<Box<dyn PlayerEngine>>,
    resolver: Arc<dyn DnsResolver>,
    actual_quality: Mutex<Option<(u64, String)>>,
    mv_fallback_enabled: std::sync::atomic::AtomicBool,
}

pub(crate) struct ResolvedPlayback {
    remote: RemoteMediaUrl,
    track: TrackSummary,
    smtc_metadata: SmtcMetadata,
    quality: String,
    expires_in_seconds: u64,
    media_duration_ms: Option<u64>,
}

impl ResolvedPlayback {
    pub(crate) fn with_smtc_metadata(mut self, album: String, duration_ms: u64) -> Self {
        self.smtc_metadata =
            SmtcMetadata::from_queue_track(album, self.media_duration_ms.unwrap_or(duration_ms));
        self
    }
}

impl PlaybackController {
    pub fn new(provider: Arc<dyn ProviderRequestPort>, player: Box<dyn PlayerEngine>) -> Self {
        Self::with_resolver(provider, player, Arc::new(SystemDnsResolver))
    }

    pub(crate) fn with_resolver(
        provider: Arc<dyn ProviderRequestPort>,
        player: Box<dyn PlayerEngine>,
        resolver: Arc<dyn DnsResolver>,
    ) -> Self {
        Self {
            provider,
            player: Mutex::new(player),
            resolver,
            actual_quality: Mutex::new(None),
            mv_fallback_enabled: std::sync::atomic::AtomicBool::new(true),
        }
    }

    pub fn resolve_load_and_play(
        &self,
        track: TrackSummary,
        quality: PlaybackQuality,
    ) -> Result<PlaybackLoadResult, PlaybackError> {
        let resolved = self.resolve(track, quality)?;
        self.load_and_play(resolved)
    }

    pub(crate) fn resolve(
        &self,
        mut track: TrackSummary,
        quality: PlaybackQuality,
    ) -> Result<ResolvedPlayback, PlaybackError> {
        validate_track(&track)?;
        let mut params = Map::from_iter([
            ("id".to_owned(), Value::String(track.id.clone())),
            (
                "preferredQuality".to_owned(),
                Value::String(quality.wire().to_owned()),
            ),
        ]);
        if !self
            .mv_fallback_enabled
            .load(std::sync::atomic::Ordering::Acquire)
        {
            params.insert("allowMvFallback".to_owned(), Value::Bool(false));
        }
        let result = match self
            .provider
            .request(ProviderRequest::read_only("playback.resolve", params))
            .map_err(map_provider_error)?
        {
            ProviderReply::Success { result, warnings } if warnings.is_empty() => result,
            ProviderReply::Success { .. } => return Err(PlaybackError::UpstreamSchemaChanged),
            ProviderReply::Failure { code, .. } => return Err(map_provider_failure(&code)),
        };
        let mut resolved = parse_resolution(result)?;
        if resolved.track_id != track.id
            || !matches!(
                resolved.quality.as_str(),
                "flac" | "320k" | "128k" | "qq-mv"
            )
            || resolved.expires_in_seconds > 86_400
            || (resolved.quality == "qq-mv") != resolved.duration_ms.is_some()
        {
            resolved.url.zeroize();
            return Err(PlaybackError::UpstreamSchemaChanged);
        }
        let is_mv = resolved.quality == "qq-mv";
        track.source = is_mv.then_some(crate::player::TrackSource::QqMv);
        let trusted = TrustedRemoteUrl::validate(
            &resolved.url,
            if is_mv {
                RemoteUrlPurpose::MvMedia
            } else {
                RemoteUrlPurpose::Media
            },
            self.resolver.as_ref(),
        )
        .map_err(|_| PlaybackError::UnsafeMediaUrl);
        resolved.url.zeroize();
        let remote =
            RemoteMediaUrl::parse(trusted?.expose_to_trusted_backend().as_str().to_owned())
                .map_err(map_player_error)?;
        Ok(ResolvedPlayback {
            remote,
            track,
            smtc_metadata: SmtcMetadata::default(),
            quality: resolved.quality,
            expires_in_seconds: resolved.expires_in_seconds,
            media_duration_ms: resolved.duration_ms,
        })
    }

    pub(crate) fn load_and_play(
        &self,
        resolved: ResolvedPlayback,
    ) -> Result<PlaybackLoadResult, PlaybackError> {
        self.load_with_transport(resolved, true)
    }

    pub(crate) fn actual_quality(&self, generation: u64) -> Option<String> {
        self.actual_quality
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|(loaded, _)| *loaded == generation)
            .map(|(_, quality)| quality.clone())
    }

    pub(crate) fn set_mv_fallback_enabled(&self, enabled: bool) {
        self.mv_fallback_enabled
            .store(enabled, std::sync::atomic::Ordering::Release);
    }

    pub(crate) fn load_with_transport(
        &self,
        resolved: ResolvedPlayback,
        play: bool,
    ) -> Result<PlaybackLoadResult, PlaybackError> {
        let mut player = self
            .player
            .lock()
            .map_err(|_| PlaybackError::NativePlayerUnavailable)?;
        player
            .handle(PlayerCommand::LoadRemote {
                url: resolved.remote,
                track: resolved.track,
                smtc_metadata: resolved.smtc_metadata,
            })
            .map_err(map_player_error)?;
        if play {
            player
                .handle(PlayerCommand::Play)
                .map_err(map_player_error)?;
        }
        *self
            .actual_quality
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((player.snapshot().generation, resolved.quality.clone()));
        Ok(PlaybackLoadResult {
            quality: resolved.quality,
            expires_in_seconds: resolved.expires_in_seconds,
            player: player.snapshot(),
        })
    }

    pub(crate) fn load_local_with_transport(
        &self,
        file: LocalMediaFile,
        track: TrackSummary,
        album: String,
        duration_ms: u64,
        play: bool,
    ) -> Result<PlaybackLoadResult, PlaybackError> {
        validate_track(&track)?;
        let mut player = self
            .player
            .lock()
            .map_err(|_| PlaybackError::NativePlayerUnavailable)?;
        player
            .handle(PlayerCommand::LoadLocal {
                file,
                track,
                smtc_metadata: SmtcMetadata::from_queue_track(album, duration_ms),
            })
            .map_err(map_player_error)?;
        if play {
            player
                .handle(PlayerCommand::Play)
                .map_err(map_player_error)?;
        }
        Ok(PlaybackLoadResult {
            quality: "local".to_owned(),
            expires_in_seconds: 0,
            player: player.snapshot(),
        })
    }

    pub(crate) fn set_smtc_artwork(
        &self,
        generation: u64,
        epoch: u64,
        artwork: crate::player::SmtcArtworkFile,
    ) -> Result<(), PlaybackError> {
        self.player
            .lock()
            .map_err(|_| PlaybackError::NativePlayerUnavailable)?
            .handle(PlayerCommand::SetArtwork {
                generation,
                epoch,
                artwork,
            })
            .map_err(map_player_error)
    }

    pub(crate) fn clear_smtc_artwork(
        &self,
        generation: u64,
        epoch: u64,
    ) -> Result<(), PlaybackError> {
        self.player
            .lock()
            .map_err(|_| PlaybackError::NativePlayerUnavailable)?
            .handle(PlayerCommand::ClearArtwork { generation, epoch })
            .map_err(map_player_error)
    }

    pub(crate) fn set_smtc_dynamic_lyrics(
        &self,
        generation: u64,
        lyrics_epoch: u64,
        timeline: SmtcLyricTimeline,
    ) -> Result<(), PlaybackError> {
        self.player
            .lock()
            .map_err(|_| PlaybackError::NativePlayerUnavailable)?
            .handle(PlayerCommand::SetDynamicLyrics {
                generation,
                lyrics_epoch,
                timeline,
            })
            .map_err(map_player_error)
    }

    pub(crate) fn clear_smtc_dynamic_lyrics(
        &self,
        generation: u64,
        lyrics_epoch: u64,
    ) -> Result<(), PlaybackError> {
        self.player
            .lock()
            .map_err(|_| PlaybackError::NativePlayerUnavailable)?
            .handle(PlayerCommand::ClearDynamicLyrics {
                generation,
                lyrics_epoch,
            })
            .map_err(map_player_error)
    }

    pub fn snapshot(&self) -> PlayerSnapshot {
        self.player
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .snapshot()
    }

    pub(crate) fn cached_snapshot(&self) -> PlayerSnapshot {
        self.player
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .cached_snapshot()
    }

    pub fn try_native_event(&self) -> Option<NativePlayerEvent> {
        self.player
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .try_event()
    }

    pub fn play(&self) -> Result<PlayerSnapshot, PlaybackError> {
        let mut player = self
            .player
            .lock()
            .map_err(|_| PlaybackError::NativePlayerUnavailable)?;
        if player.snapshot().state == crate::player::PlayerState::Ended {
            let position = SeekPositionMs::new(0).map_err(map_player_error)?;
            player
                .handle(PlayerCommand::Seek { position })
                .map_err(map_player_error)?;
        }
        player
            .handle(PlayerCommand::Play)
            .map_err(map_player_error)?;
        Ok(player.snapshot())
    }

    pub fn pause(&self) -> Result<PlayerSnapshot, PlaybackError> {
        self.command(PlayerCommand::Pause)
    }

    pub fn stop(&self) -> Result<PlayerSnapshot, PlaybackError> {
        self.command(PlayerCommand::Stop)
    }

    pub fn seek(&self, position_ms: u64) -> Result<PlayerSnapshot, PlaybackError> {
        let position = SeekPositionMs::new(position_ms).map_err(map_player_error)?;
        self.command(PlayerCommand::Seek { position })
    }

    pub fn set_volume(&self, volume: f32) -> Result<PlayerSnapshot, PlaybackError> {
        let volume = VolumeLevel::new(volume).map_err(map_player_error)?;
        self.command(PlayerCommand::SetVolume { volume })
    }

    pub fn set_muted(&self, muted: bool) -> Result<PlayerSnapshot, PlaybackError> {
        self.command(PlayerCommand::SetMuted { muted })
    }

    fn command(&self, command: PlayerCommand) -> Result<PlayerSnapshot, PlaybackError> {
        let mut player = self
            .player
            .lock()
            .map_err(|_| PlaybackError::NativePlayerUnavailable)?;
        player.handle(command).map_err(map_player_error)?;
        Ok(player.snapshot())
    }
}

struct ResolvedPlaybackWire {
    track_id: String,
    quality: String,
    url: String,
    expires_in_seconds: u64,
    duration_ms: Option<u64>,
}

fn parse_resolution(mut result: Map<String, Value>) -> Result<ResolvedPlaybackWire, PlaybackError> {
    const EXPECTED: [&str; 4] = ["trackId", "quality", "url", "expiresInSeconds"];
    let duration_ms = match result.remove("durationMs") {
        None => None,
        Some(value) => match value
            .as_u64()
            .filter(|duration| (1..=86_400_000).contains(duration))
        {
            Some(duration) => Some(duration),
            None => {
                zeroize_json_map(&mut result);
                return Err(PlaybackError::UpstreamSchemaChanged);
            }
        },
    };
    if result.len() != EXPECTED.len() || result.keys().any(|key| !EXPECTED.contains(&key.as_str()))
    {
        zeroize_json_map(&mut result);
        return Err(PlaybackError::UpstreamSchemaChanged);
    }
    let track_id = take_public_string(&mut result, "trackId")?;
    let quality = take_public_string(&mut result, "quality")?;
    let mut url = take_secret_string(&mut result, "url")?;
    let Some(expires_in_seconds) = result
        .remove("expiresInSeconds")
        .and_then(|value| value.as_u64())
    else {
        url.zeroize();
        return Err(PlaybackError::UpstreamSchemaChanged);
    };
    Ok(ResolvedPlaybackWire {
        track_id,
        quality,
        url,
        expires_in_seconds,
        duration_ms,
    })
}

fn take_public_string(result: &mut Map<String, Value>, key: &str) -> Result<String, PlaybackError> {
    match result.remove(key) {
        Some(Value::String(value)) => Ok(value),
        Some(mut value) => {
            zeroize_json_value(&mut value);
            zeroize_json_map(result);
            Err(PlaybackError::UpstreamSchemaChanged)
        }
        None => {
            zeroize_json_map(result);
            Err(PlaybackError::UpstreamSchemaChanged)
        }
    }
}

fn take_secret_string(result: &mut Map<String, Value>, key: &str) -> Result<String, PlaybackError> {
    take_public_string(result, key)
}

fn zeroize_json_map(map: &mut Map<String, Value>) {
    for value in map.values_mut() {
        zeroize_json_value(value);
    }
    map.clear();
}

fn zeroize_json_value(value: &mut Value) {
    match value {
        Value::String(secret) => secret.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_json_value),
        Value::Object(map) => zeroize_json_map(map),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn validate_track(track: &TrackSummary) -> Result<(), PlaybackError> {
    if track.id.is_empty()
        || track.id.len() > 128
        || !track
            .id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        || track.title.is_empty()
        || track.title.chars().count() > 512
        || track.artist.is_empty()
        || track.artist.chars().count() > 512
    {
        return Err(PlaybackError::InvalidRequest);
    }
    Ok(())
}

fn map_provider_error(_error: ProviderError) -> PlaybackError {
    PlaybackError::ProviderUnavailable
}

fn map_provider_failure(code: &str) -> PlaybackError {
    match code {
        "network_unavailable" | "rate_limited" => PlaybackError::NetworkUnavailable,
        "authentication_required" => PlaybackError::AuthenticationRequired,
        "entitlement_denied" => PlaybackError::EntitlementDenied,
        "playback_device_limit" => PlaybackError::DeviceLimit,
        "playback_unavailable" => PlaybackError::Unavailable,
        "upstream_schema_changed" => PlaybackError::UpstreamSchemaChanged,
        _ => PlaybackError::ProviderUnavailable,
    }
}

fn map_player_error(error: PlayerError) -> PlaybackError {
    match error {
        PlayerError::InvalidCommand
        | PlayerError::InvalidSeekPosition
        | PlayerError::InvalidVolume
        | PlayerError::NotReady => PlaybackError::InvalidRequest,
        PlayerError::InvalidMediaUrl => PlaybackError::UnsafeMediaUrl,
        PlayerError::InvalidMediaFile => PlaybackError::LocalFileMissing,
        PlayerError::InvalidArtwork | PlayerError::InvalidLyrics => {
            PlaybackError::NativePlayerUnavailable
        }
        PlayerError::NativeUnavailable
        | PlayerError::NativeFailure
        | PlayerError::EngineStopped => PlaybackError::NativePlayerUnavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::net::{IpAddr, Ipv4Addr};

    use serde_json::json;

    use super::*;
    use crate::player::PlayerState;

    struct FakeProvider {
        replies: Mutex<VecDeque<ProviderReply>>,
    }

    impl ProviderRequestPort for FakeProvider {
        fn request(&self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            Ok(self
                .replies
                .lock()
                .expect("fake replies")
                .pop_front()
                .expect("expected fake reply"))
        }
    }

    struct FakeResolver;

    impl DnsResolver for FakeResolver {
        fn resolve(
            &self,
            _host: &str,
            _port: u16,
        ) -> Result<Vec<IpAddr>, crate::network_policy::RemoteUrlError> {
            Ok(vec![IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))])
        }
    }

    struct FakePlayer {
        snapshot: PlayerSnapshot,
    }

    impl PlayerEngine for FakePlayer {
        fn snapshot(&self) -> PlayerSnapshot {
            self.snapshot.clone()
        }

        fn handle(&mut self, command: PlayerCommand) -> Result<(), PlayerError> {
            match command {
                PlayerCommand::LoadRemote { track, .. }
                | PlayerCommand::LoadLocal { track, .. } => {
                    self.snapshot.current_track = Some(track);
                    self.snapshot.state = PlayerState::Paused;
                    self.snapshot.generation += 1;
                    Ok(())
                }
                PlayerCommand::Play if self.snapshot.current_track.is_some() => {
                    self.snapshot.state = PlayerState::Playing;
                    Ok(())
                }
                PlayerCommand::Pause if self.snapshot.current_track.is_some() => {
                    self.snapshot.state = PlayerState::Paused;
                    Ok(())
                }
                PlayerCommand::Stop => {
                    self.snapshot = PlayerSnapshot::idle();
                    Ok(())
                }
                PlayerCommand::Seek { position } => {
                    self.snapshot.position_ms = position.get();
                    if position.get() == 9_999 {
                        self.snapshot.state = PlayerState::Ended;
                    }
                    Ok(())
                }
                PlayerCommand::SetVolume { volume } => {
                    self.snapshot.volume = volume.get();
                    Ok(())
                }
                PlayerCommand::SetMuted { muted } => {
                    self.snapshot.muted = muted;
                    Ok(())
                }
                PlayerCommand::SetArtwork { .. }
                | PlayerCommand::ClearArtwork { .. }
                | PlayerCommand::SetDynamicLyrics { .. }
                | PlayerCommand::ClearDynamicLyrics { .. } => Ok(()),
                PlayerCommand::Play | PlayerCommand::Pause => Err(PlayerError::NotReady),
            }
        }
    }

    fn controller(reply: ProviderReply) -> PlaybackController {
        PlaybackController::with_resolver(
            Arc::new(FakeProvider {
                replies: Mutex::new(VecDeque::from([reply])),
            }),
            Box::new(FakePlayer {
                snapshot: PlayerSnapshot::idle(),
            }),
            Arc::new(FakeResolver),
        )
    }

    fn success(url: &str) -> ProviderReply {
        ProviderReply::Success {
            result: json!({
                "trackId": "trackMid",
                "quality": "320k",
                "url": url,
                "expiresInSeconds": 7200
            })
            .as_object()
            .expect("object")
            .clone(),
            warnings: Vec::new(),
        }
    }

    fn track() -> TrackSummary {
        TrackSummary {
            source: None,
            id: "trackMid".to_owned(),
            title: "纸月光".to_owned(),
            artist: "方格岛".to_owned(),
        }
    }

    #[test]
    fn mv_resolution_keeps_song_identity_and_reports_actual_source_without_url() {
        let mut reply = success("https://mv.music.tc.qq.com/test.mp4?vkey=SENTINEL");
        if let ProviderReply::Success { result, .. } = &mut reply {
            result.insert("quality".to_owned(), json!("qq-mv"));
            result.insert("durationMs".to_owned(), json!(317000));
        }
        let controller = controller(reply);
        let resolved = controller
            .resolve(track(), PlaybackQuality::Auto)
            .expect("resolve MV")
            .with_smtc_metadata("album".to_owned(), 240000);
        assert_eq!(resolved.smtc_metadata.duration_ms(), Some(317000));
        let result = controller.load_and_play(resolved).expect("load MV");
        let value = serde_json::to_value(result).expect("public result");
        assert_eq!(value["quality"], "qq-mv");
        assert_eq!(value["player"]["currentTrack"]["id"], "trackMid");
        assert_eq!(value["player"]["currentTrack"]["source"], "qq-mv");
        assert!(!value.to_string().contains("SENTINEL"));
        assert!(!value.to_string().contains("test.mp4"));
    }

    #[test]
    fn mv_duration_is_required_and_mv_domains_cannot_be_used_as_song_sources() {
        let controller = controller(success("https://mv.music.tc.qq.com/test.mp4"));
        assert!(matches!(
            controller.resolve(track(), PlaybackQuality::Auto),
            Err(PlaybackError::UnsafeMediaUrl)
        ));
        let mut reply = success("https://mv.music.tc.qq.com/test.mp4");
        if let ProviderReply::Success { result, .. } = &mut reply {
            result.insert("quality".to_owned(), json!("qq-mv"));
        }
        assert!(matches!(
            super::tests::controller(reply).resolve(track(), PlaybackQuality::Auto),
            Err(PlaybackError::UpstreamSchemaChanged)
        ));
    }

    #[test]
    fn resolved_url_loads_native_player_but_never_enters_public_result() {
        let controller = controller(success(
            "https://isure.stream.qqmusic.qq.com/M800fixture.mp3?vkey=SENTINEL_VKEY",
        ));
        let loaded = controller
            .resolve_load_and_play(track(), PlaybackQuality::Auto)
            .expect("load and play");
        let value = serde_json::to_value(&loaded).expect("public result");

        assert_eq!(value["quality"], "320k");
        assert_eq!(value["player"]["state"], "playing");
        assert!(value.get("url").is_none());
        assert!(!serde_json::to_string(&value)
            .expect("serialize public result")
            .contains("SENTINEL"));
    }

    #[test]
    fn unreviewed_host_is_rejected_before_player_load() {
        let controller = controller(success("https://attacker.example/audio.mp3?vkey=SENTINEL"));
        assert_eq!(
            controller.resolve_load_and_play(track(), PlaybackQuality::Auto),
            Err(PlaybackError::UnsafeMediaUrl)
        );
        assert_eq!(controller.snapshot().state, PlayerState::Idle);
    }

    #[test]
    fn stable_provider_failures_remain_renderer_safe() {
        for (code, expected) in [
            (
                "authentication_required",
                PlaybackError::AuthenticationRequired,
            ),
            ("entitlement_denied", PlaybackError::EntitlementDenied),
            ("playback_device_limit", PlaybackError::DeviceLimit),
            ("playback_unavailable", PlaybackError::Unavailable),
        ] {
            let controller = controller(ProviderReply::Failure {
                code: code.to_owned(),
                retryable: false,
            });
            assert_eq!(
                controller.resolve_load_and_play(track(), PlaybackQuality::Auto),
                Err(expected)
            );
        }
    }

    #[test]
    fn controls_use_checked_values_and_public_snapshots() {
        let controller = controller(success(
            "https://isure.stream.qqmusic.qq.com/M800fixture.mp3?vkey=v",
        ));
        controller
            .resolve_load_and_play(track(), PlaybackQuality::Auto)
            .expect("loaded");
        assert_eq!(
            controller.pause().expect("pause").state,
            PlayerState::Paused
        );
        assert_eq!(controller.seek(1234).expect("seek").position_ms, 1234);
        assert_eq!(controller.set_volume(0.4).expect("volume").volume, 0.4);
        assert!(controller.set_muted(true).expect("mute").muted);
        assert_eq!(controller.play().expect("play").state, PlayerState::Playing);
        assert_eq!(
            controller.seek(9_999).expect("simulate ended").state,
            PlayerState::Ended
        );
        let replayed = controller.play().expect("replay ended track");
        assert_eq!(replayed.state, PlayerState::Playing);
        assert_eq!(replayed.position_ms, 0);
        assert_eq!(controller.stop().expect("stop").state, PlayerState::Idle);
        assert_eq!(
            controller.set_volume(f32::NAN),
            Err(PlaybackError::InvalidRequest)
        );
    }
}
