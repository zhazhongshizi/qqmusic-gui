use std::{
    fmt,
    path::{Path, PathBuf},
};

use serde::Serialize;
use url::Url;
use zeroize::Zeroize;

#[cfg(windows)]
mod windows_native;
#[cfg(windows)]
pub use windows_native::WindowsMediaPlayerEngine;

/// Renderer-safe projection of the authoritative native player actor.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub(crate) state: PlayerState,
    pub(crate) generation: u64,
    pub(crate) position_ms: u64,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) volume: f32,
    pub(crate) muted: bool,
    pub(crate) current_track: Option<TrackSummary>,
    pub(crate) failure: Option<PlayerFailure>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PlayerState {
    Idle,
    Loading,
    Playing,
    Paused,
    Ended,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSummary {
    pub id: String,
    pub title: String,
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<TrackSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum TrackSource {
    #[serde(rename = "qq-mv")]
    QqMv,
}

/// Metadata used only by the native Windows media session. This deliberately
/// stays outside `TrackSummary`, which is the renderer-facing JSON contract.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SmtcMetadata {
    album: Option<String>,
    duration_ms: Option<u64>,
}

const MAX_SMTC_ARTWORK_BYTES: usize = 2 * 1024 * 1024;
const MAX_SMTC_LYRIC_LINES: usize = 5_000;
const MAX_SMTC_LYRIC_LINE_BYTES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtcLyricLine {
    at_ms: u64,
    text: String,
}

impl SmtcLyricLine {
    pub(crate) fn new(at_ms: u64, text: String) -> Result<Self, PlayerError> {
        let text = text.trim().to_owned();
        if text.is_empty()
            || text.len() > MAX_SMTC_LYRIC_LINE_BYTES
            || text.contains(['\r', '\n', '\0'])
        {
            return Err(PlayerError::InvalidLyrics);
        }
        Ok(Self { at_ms, text })
    }

    pub(crate) fn at_ms(&self) -> u64 {
        self.at_ms
    }

    pub(crate) fn text(&self) -> &str {
        &self.text
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtcLyricTimeline {
    lines: Vec<SmtcLyricLine>,
}

impl SmtcLyricTimeline {
    pub(crate) fn new(lines: Vec<SmtcLyricLine>) -> Result<Self, PlayerError> {
        if lines.is_empty()
            || lines.len() > MAX_SMTC_LYRIC_LINES
            || lines.windows(2).any(|pair| pair[0].at_ms >= pair[1].at_ms)
        {
            return Err(PlayerError::InvalidLyrics);
        }
        Ok(Self { lines })
    }

    pub(crate) fn lines(&self) -> &[SmtcLyricLine] {
        &self.lines
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct SmtcArtwork {
    mime_type: String,
    bytes: Vec<u8>,
}

impl SmtcArtwork {
    pub fn new(mime_type: String, bytes: Vec<u8>) -> Result<Self, PlayerError> {
        if bytes.is_empty() || bytes.len() > MAX_SMTC_ARTWORK_BYTES {
            return Err(PlayerError::InvalidArtwork);
        }
        let valid = match mime_type.as_str() {
            "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
            "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/webp" => {
                bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
            }
            _ => false,
        };
        if !valid {
            return Err(PlayerError::InvalidArtwork);
        }
        Ok(Self { mime_type, bytes })
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub(crate) fn mime_type(&self) -> &str {
        &self.mime_type
    }
}

impl fmt::Debug for SmtcArtwork {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SmtcArtwork")
            .field("mime_type", &self.mime_type)
            .field("bytes", &"[REDACTED]")
            .finish()
    }
}

/// A completed, internal-only artwork file for the Windows shell. The path is
/// never serialized or exposed to the renderer.
#[derive(Clone, PartialEq, Eq)]
pub struct SmtcArtworkFile {
    mime_type: String,
    path: PathBuf,
}

impl SmtcArtworkFile {
    pub(crate) fn new(mime_type: String, path: PathBuf) -> Result<Self, PlayerError> {
        if !path.is_absolute() || !path.is_file() {
            return Err(PlayerError::InvalidArtwork);
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        let expected = match mime_type.as_str() {
            "image/jpeg" => Some("jpg"),
            "image/png" => Some("png"),
            "image/webp" => Some("webp"),
            _ => None,
        };
        if expected != extension.as_deref() {
            return Err(PlayerError::InvalidArtwork);
        }
        Ok(Self { mime_type, path })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl fmt::Debug for SmtcArtworkFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SmtcArtworkFile")
            .field("mime_type", &self.mime_type)
            .field("path", &"[REDACTED]")
            .finish()
    }
}

impl SmtcMetadata {
    pub(crate) fn from_queue_track(album: String, duration_ms: u64) -> Self {
        let album = album.trim().to_owned();
        Self {
            album: (!album.is_empty()).then_some(album),
            duration_ms: (duration_ms > 0).then_some(duration_ms),
        }
    }

    pub(crate) fn album(&self) -> Option<&str> {
        self.album.as_deref()
    }

    pub(crate) fn duration_ms(&self) -> Option<u64> {
        self.duration_ms
    }
}

impl PlayerSnapshot {
    pub fn idle() -> Self {
        Self {
            state: PlayerState::Idle,
            generation: 0,
            position_ms: 0,
            duration_ms: None,
            volume: 1.0,
            muted: false,
            current_track: None,
            failure: None,
        }
    }
}

/// Serial control boundary for the future Windows MediaPlayer-backed actor.
/// Playback URLs remain internal to Rust and are never part of PlayerSnapshot.
pub trait PlayerEngine: Send {
    fn snapshot(&self) -> PlayerSnapshot;
    /// Returns the latest trusted state without forcing a native position sample.
    fn cached_snapshot(&self) -> PlayerSnapshot {
        self.snapshot()
    }
    fn handle(&mut self, command: PlayerCommand) -> Result<(), PlayerError>;
    fn try_event(&self) -> Option<NativePlayerEvent> {
        None
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct RemoteMediaUrl(String);

impl RemoteMediaUrl {
    pub fn parse(value: impl Into<String>) -> Result<Self, PlayerError> {
        let mut value = value.into();
        if value.len() > 2_048 {
            value.zeroize();
            return Err(PlayerError::InvalidMediaUrl);
        }
        let parsed = match Url::parse(&value) {
            Ok(parsed) => parsed,
            Err(_) => {
                value.zeroize();
                return Err(PlayerError::InvalidMediaUrl);
            }
        };
        if parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
        {
            value.zeroize();
            return Err(PlayerError::InvalidMediaUrl);
        }
        Ok(Self(value))
    }

    pub(crate) fn expose_to_native_player(&self) -> &str {
        &self.0
    }
}

impl Drop for RemoteMediaUrl {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for RemoteMediaUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RemoteMediaUrl([REDACTED])")
    }
}

/// An internal-only local media file approved by the Rust storage boundary.
/// The filesystem path is never serialized or included in debug output.
#[derive(Clone, PartialEq, Eq)]
pub struct LocalMediaFile(PathBuf);

impl LocalMediaFile {
    pub(crate) fn new(path: PathBuf) -> Result<Self, PlayerError> {
        if !path.is_absolute() || !path.is_file() {
            return Err(PlayerError::InvalidMediaFile);
        }
        Ok(Self(path))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

#[cfg(feature = "manual-spikes")]
pub fn local_media_file_for_smoke(path: PathBuf) -> Result<LocalMediaFile, PlayerError> {
    LocalMediaFile::new(path)
}

impl fmt::Debug for LocalMediaFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LocalMediaFile([REDACTED])")
    }
}

const WINDOWS_TICKS_PER_MILLISECOND: u64 = 10_000;
const MAX_SEEK_POSITION_MS: u64 = i64::MAX as u64 / WINDOWS_TICKS_PER_MILLISECOND;

/// A seek value that can be converted to a Windows `TimeSpan` without overflow.
/// The player actor must additionally clamp it to the active track duration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeekPositionMs(u64);

impl SeekPositionMs {
    pub fn new(position_ms: u64) -> Result<Self, PlayerError> {
        if position_ms <= MAX_SEEK_POSITION_MS {
            Ok(Self(position_ms))
        } else {
            Err(PlayerError::InvalidSeekPosition)
        }
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

/// Normalized finite player volume in the inclusive range 0.0..=1.0.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VolumeLevel(f32);

impl VolumeLevel {
    pub fn new(volume: f32) -> Result<Self, PlayerError> {
        if volume.is_finite() && (0.0..=1.0).contains(&volume) {
            Ok(Self(volume))
        } else {
            Err(PlayerError::InvalidVolume)
        }
    }

    pub fn get(self) -> f32 {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlayerCommand {
    LoadRemote {
        url: RemoteMediaUrl,
        track: TrackSummary,
        smtc_metadata: SmtcMetadata,
    },
    LoadLocal {
        file: LocalMediaFile,
        track: TrackSummary,
        smtc_metadata: SmtcMetadata,
    },
    SetArtwork {
        generation: u64,
        epoch: u64,
        artwork: SmtcArtworkFile,
    },
    ClearArtwork {
        generation: u64,
        epoch: u64,
    },
    SetDynamicLyrics {
        generation: u64,
        lyrics_epoch: u64,
        timeline: SmtcLyricTimeline,
    },
    ClearDynamicLyrics {
        generation: u64,
        lyrics_epoch: u64,
    },
    Play,
    Pause,
    Stop,
    Seek {
        position: SeekPositionMs,
    },
    SetVolume {
        volume: VolumeLevel,
    },
    SetMuted {
        muted: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativePlayerEvent {
    Opened {
        generation: u64,
    },
    Ended {
        generation: u64,
    },
    Failed {
        generation: u64,
        failure: PlayerFailure,
    },
    TransportPlay,
    TransportPause,
    TransportStop,
    TransportNext,
    TransportPrevious,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlayerFailureCode {
    Network,
    Decoding,
    Unsupported,
    Authentication,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerFailure {
    pub code: PlayerFailureCode,
    pub recoverable: bool,
    pub generation: u64,
}

impl PlayerFailure {
    pub const fn new(code: PlayerFailureCode, generation: u64) -> Self {
        Self {
            code,
            recoverable: matches!(
                code,
                PlayerFailureCode::Network | PlayerFailureCode::Authentication
            ),
            generation,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlayerError {
    NotReady,
    InvalidCommand,
    InvalidSeekPosition,
    InvalidVolume,
    InvalidMediaUrl,
    InvalidMediaFile,
    InvalidArtwork,
    InvalidLyrics,
    NativeUnavailable,
    NativeFailure,
    EngineStopped,
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakePlayerEngine {
        snapshot: PlayerSnapshot,
    }

    impl FakePlayerEngine {
        fn new() -> Self {
            Self {
                snapshot: PlayerSnapshot::idle(),
            }
        }
    }

    impl PlayerEngine for FakePlayerEngine {
        fn snapshot(&self) -> PlayerSnapshot {
            self.snapshot.clone()
        }

        fn handle(&mut self, command: PlayerCommand) -> Result<(), PlayerError> {
            match command {
                PlayerCommand::LoadRemote { track, .. }
                | PlayerCommand::LoadLocal { track, .. } => {
                    self.snapshot.generation = self.snapshot.generation.saturating_add(1);
                    self.snapshot.state = PlayerState::Paused;
                    self.snapshot.position_ms = 0;
                    self.snapshot.current_track = Some(track);
                    self.snapshot.failure = None;
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
                    let generation = self.snapshot.generation.saturating_add(1);
                    let volume = self.snapshot.volume;
                    let muted = self.snapshot.muted;
                    self.snapshot = PlayerSnapshot::idle();
                    self.snapshot.generation = generation;
                    self.snapshot.volume = volume;
                    self.snapshot.muted = muted;
                    Ok(())
                }
                PlayerCommand::Seek { position } if self.snapshot.current_track.is_some() => {
                    self.snapshot.position_ms = position.get();
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
                PlayerCommand::Play | PlayerCommand::Pause | PlayerCommand::Seek { .. } => {
                    Err(PlayerError::NotReady)
                }
            }
        }
    }

    #[test]
    fn idle_snapshot_has_no_track_or_media_location() {
        let value =
            serde_json::to_value(PlayerSnapshot::idle()).expect("player snapshot must serialize");

        assert_eq!(value["state"], "idle");
        assert_eq!(value["generation"], 0);
        assert!(value["currentTrack"].is_null());
        assert!(value["failure"].is_null());
        assert!(value.get("url").is_none());
        assert!(value.get("headers").is_none());
    }

    #[test]
    fn smtc_metadata_is_internal_and_does_not_expand_renderer_track_summary() {
        let metadata = SmtcMetadata::from_queue_track("Album".to_owned(), 123_000);
        assert_eq!(metadata.album(), Some("Album"));
        assert_eq!(metadata.duration_ms(), Some(123_000));
        assert_eq!(
            SmtcMetadata::from_queue_track("   ".to_owned(), 0),
            SmtcMetadata::default()
        );

        let track = TrackSummary {
            source: None,
            id: "track".to_owned(),
            title: "Title".to_owned(),
            artist: "Artist".to_owned(),
        };
        let value = serde_json::to_value(track).expect("track summary must serialize");
        assert_eq!(
            value,
            serde_json::json!({"id": "track", "title": "Title", "artist": "Artist"})
        );
        assert!(value.get("album").is_none());
        assert!(value.get("durationMs").is_none());
    }

    #[test]
    fn smtc_lyric_timeline_is_bounded_and_strictly_ordered() {
        let timeline = SmtcLyricTimeline::new(vec![
            SmtcLyricLine::new(1_000, " first ".to_owned()).expect("first line"),
            SmtcLyricLine::new(2_000, "second".to_owned()).expect("second line"),
        ])
        .expect("timeline");
        assert_eq!(timeline.lines()[0].at_ms(), 1_000);
        assert_eq!(timeline.lines()[0].text(), "first");
        assert_eq!(
            SmtcLyricTimeline::new(vec![
                SmtcLyricLine::new(2_000, "later".to_owned()).expect("later"),
                SmtcLyricLine::new(2_000, "duplicate".to_owned()).expect("duplicate"),
            ]),
            Err(PlayerError::InvalidLyrics)
        );
        assert_eq!(
            SmtcLyricLine::new(0, "\n".to_owned()),
            Err(PlayerError::InvalidLyrics)
        );
    }

    #[test]
    fn smtc_artwork_rejects_bad_mime_signature_and_redacts_bytes() {
        assert_eq!(
            SmtcArtwork::new("image/png".to_owned(), b"not-png".to_vec()),
            Err(PlayerError::InvalidArtwork)
        );
        let artwork = SmtcArtwork::new("image/jpeg".to_owned(), vec![0xff, 0xd8, 0xff, 0xd9])
            .expect("jpeg fixture");
        assert_eq!(artwork.bytes(), &[0xff, 0xd8, 0xff, 0xd9]);
        assert!(!format!("{artwork:?}").contains("d8"));
    }

    #[test]
    fn smtc_artwork_file_requires_matching_extension_and_redacts_path() {
        let root = std::env::temp_dir().join(format!("qqmusic-smtc-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("test root");
        let path = root.join("art.jpg");
        std::fs::write(&path, [0xff, 0xd8, 0xff, 0xd9]).expect("test artwork");
        let artwork =
            SmtcArtworkFile::new("image/jpeg".to_owned(), path.clone()).expect("file artwork");
        assert_eq!(artwork.path(), path);
        assert!(!format!("{artwork:?}").contains("art.jpg"));
        assert_eq!(
            SmtcArtworkFile::new("image/png".to_owned(), path),
            Err(PlayerError::InvalidArtwork)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn player_failure_dto_is_strict_stable_and_redacted() {
        let failure = PlayerFailure::new(PlayerFailureCode::Network, 42);
        let value = serde_json::to_value(failure).expect("failure must serialize");

        assert_eq!(
            value,
            serde_json::json!({"code": "network", "recoverable": true, "generation": 42})
        );
        assert!(!value.to_string().contains("http"));
        assert!(!value.to_string().contains("HRESULT"));
    }

    #[test]
    fn seek_position_rejects_values_that_overflow_windows_timespan() {
        assert_eq!(SeekPositionMs::new(0).expect("zero is valid").get(), 0);
        assert_eq!(
            SeekPositionMs::new(MAX_SEEK_POSITION_MS)
                .expect("maximum convertible value is valid")
                .get(),
            MAX_SEEK_POSITION_MS
        );
        assert_eq!(
            SeekPositionMs::new(MAX_SEEK_POSITION_MS + 1),
            Err(PlayerError::InvalidSeekPosition)
        );
    }

    #[test]
    fn volume_level_accepts_only_finite_normalized_values() {
        assert_eq!(VolumeLevel::new(0.0).expect("silence is valid").get(), 0.0);
        assert_eq!(
            VolumeLevel::new(1.0).expect("full volume is valid").get(),
            1.0
        );

        for invalid in [-0.01, 1.01, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(VolumeLevel::new(invalid), Err(PlayerError::InvalidVolume));
        }
    }

    #[test]
    fn remote_media_url_is_https_only_and_redacted() {
        let valid = RemoteMediaUrl::parse("https://example.test/audio.mp3?token=sentinel")
            .expect("https media URL is valid");
        assert_eq!(format!("{valid:?}"), "RemoteMediaUrl([REDACTED])");
        assert!(!format!("{valid:?}").contains("sentinel"));

        for invalid in [
            "http://example.test/audio.mp3",
            "https://user:secret@example.test/audio.mp3",
            "https://example.test/audio.mp3#fragment",
            "not a url",
        ] {
            assert_eq!(
                RemoteMediaUrl::parse(invalid),
                Err(PlayerError::InvalidMediaUrl)
            );
        }
    }

    #[test]
    fn local_media_file_requires_an_absolute_file_and_redacts_debug_output() {
        let root =
            std::env::temp_dir().join(format!("qqmusic-local-player-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create local player root");
        let path = root.join("track.mp3");
        std::fs::write(&path, b"fixture").expect("write local player fixture");

        let file = LocalMediaFile::new(path.clone()).expect("absolute file is valid");
        assert_eq!(format!("{file:?}"), "LocalMediaFile([REDACTED])");
        assert!(!format!("{file:?}").contains(path.to_string_lossy().as_ref()));
        assert_eq!(
            LocalMediaFile::new(root.join("missing.mp3")),
            Err(PlayerError::InvalidMediaFile)
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn fake_player_proves_state_transitions_without_shipping_a_fixture_engine() {
        let mut engine = FakePlayerEngine::new();
        assert_eq!(
            engine.handle(PlayerCommand::Play),
            Err(PlayerError::NotReady)
        );
        engine
            .handle(PlayerCommand::LoadRemote {
                url: RemoteMediaUrl::parse("https://example.test/audio.mp3?token=sentinel")
                    .expect("fixture URL"),
                track: TrackSummary {
                    source: None,
                    id: "fixture-track".to_owned(),
                    title: "Fixture title".to_owned(),
                    artist: "Fixture artist".to_owned(),
                },
                smtc_metadata: SmtcMetadata::default(),
            })
            .expect("load fixture");
        engine.handle(PlayerCommand::Play).expect("play fixture");
        engine
            .handle(PlayerCommand::Seek {
                position: SeekPositionMs::new(1_234).expect("fixture seek"),
            })
            .expect("seek fixture");
        engine
            .handle(PlayerCommand::SetVolume {
                volume: VolumeLevel::new(0.4).expect("fixture volume"),
            })
            .expect("set fixture volume");
        engine
            .handle(PlayerCommand::SetMuted { muted: true })
            .expect("mute fixture");

        let value = serde_json::to_value(engine.snapshot()).expect("serialize fixture snapshot");
        assert_eq!(value["state"], "playing");
        assert_eq!(value["generation"], 1);
        assert_eq!(value["positionMs"], 1_234);
        let serialized_volume = value["volume"].as_f64().expect("volume is numeric");
        assert!((serialized_volume - 0.4).abs() <= f64::from(f32::EPSILON));
        assert_eq!(value["muted"], true);
        assert!(value.get("url").is_none());

        engine.handle(PlayerCommand::Stop).expect("stop fixture");
        assert_eq!(engine.snapshot().state, PlayerState::Idle);
    }
}
