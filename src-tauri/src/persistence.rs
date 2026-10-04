use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

pub const LOCAL_SCHEMA_VERSION: u32 = 9;
const MAX_QUEUE_ITEMS: usize = 1_000;
const MAX_HISTORY_ITEMS: i64 = 5_000;
const MAX_METADATA_CACHE_ITEMS: i64 = 2_000;
const MAX_TEXT_BYTES: usize = 512;
const MAX_STABLE_ID_BYTES: usize = 128;

const MIGRATION_V1: &str = r#"
CREATE TABLE settings (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    preferred_quality TEXT NOT NULL CHECK (preferred_quality IN ('flac', '320k', '128k')),
    play_mode TEXT NOT NULL CHECK (play_mode IN ('sequence', 'repeat_one', 'shuffle')),
    close_behavior TEXT NOT NULL CHECK (close_behavior IN ('ask', 'tray', 'exit')),
    reduced_motion INTEGER NOT NULL CHECK (reduced_motion IN (0, 1)),
    volume_basis_points INTEGER NOT NULL CHECK (volume_basis_points BETWEEN 0 AND 10000),
    last_position_ms INTEGER NOT NULL CHECK (last_position_ms >= 0),
    updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0)
) STRICT;

CREATE TABLE queue_items (
    position INTEGER PRIMARY KEY CHECK (position >= 0),
    track_id TEXT NOT NULL CHECK (length(track_id) BETWEEN 1 AND 128),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
    artist TEXT NOT NULL CHECK (length(artist) BETWEEN 1 AND 512),
    album TEXT NOT NULL CHECK (length(album) <= 512),
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    cover_cache_key TEXT CHECK (cover_cache_key IS NULL OR length(cover_cache_key) BETWEEN 1 AND 128)
) STRICT;

CREATE TABLE playback_history (
    history_id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL CHECK (length(track_id) BETWEEN 1 AND 128),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
    artist TEXT NOT NULL CHECK (length(artist) BETWEEN 1 AND 512),
    played_at_unix_ms INTEGER NOT NULL CHECK (played_at_unix_ms >= 0),
    completed INTEGER NOT NULL CHECK (completed IN (0, 1))
) STRICT;
CREATE INDEX playback_history_played_at ON playback_history(played_at_unix_ms DESC);

CREATE TABLE organizer_plans (
    plan_id TEXT PRIMARY KEY CHECK (length(plan_id) BETWEEN 1 AND 128),
    operation TEXT NOT NULL CHECK (operation IN ('copy', 'move', 'remove', 'deduplicate')),
    source_playlist_id TEXT NOT NULL CHECK (length(source_playlist_id) BETWEEN 1 AND 128),
    target_playlist_id TEXT CHECK (target_playlist_id IS NULL OR length(target_playlist_id) BETWEEN 1 AND 128),
    item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 10000),
    completed_count INTEGER NOT NULL CHECK (completed_count BETWEEN 0 AND item_count),
    failed_count INTEGER NOT NULL CHECK (failed_count BETWEEN 0 AND item_count),
    expires_at_unix_ms INTEGER NOT NULL CHECK (expires_at_unix_ms >= 0),
    state TEXT NOT NULL CHECK (state IN ('preview', 'running', 'partial', 'complete', 'expired'))
) STRICT;

CREATE TABLE metadata_cache (
    cache_key TEXT PRIMARY KEY CHECK (length(cache_key) BETWEEN 1 AND 128),
    kind TEXT NOT NULL CHECK (kind IN ('track', 'album', 'artist', 'playlist')),
    stable_id TEXT NOT NULL CHECK (length(stable_id) BETWEEN 1 AND 128),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 512),
    subtitle TEXT NOT NULL CHECK (length(subtitle) <= 512),
    expires_at_unix_ms INTEGER NOT NULL CHECK (expires_at_unix_ms >= 0),
    last_accessed_unix_ms INTEGER NOT NULL CHECK (last_accessed_unix_ms >= 0)
) STRICT;
CREATE INDEX metadata_cache_expiry ON metadata_cache(expires_at_unix_ms);
"#;

const MIGRATION_V2: &str = r#"
CREATE TABLE organizer_plan_bindings (
    plan_id TEXT PRIMARY KEY REFERENCES organizer_plans(plan_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128),
    source_editable_id TEXT NOT NULL CHECK (length(source_editable_id) BETWEEN 1 AND 128),
    target_editable_id TEXT CHECK (target_editable_id IS NULL OR length(target_editable_id) BETWEEN 1 AND 128),
    source_snapshot_hash TEXT NOT NULL CHECK (length(source_snapshot_hash) = 64),
    target_snapshot_hash TEXT CHECK (target_snapshot_hash IS NULL OR length(target_snapshot_hash) = 64),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0)
) STRICT;

CREATE TABLE organizer_plan_items (
    plan_id TEXT NOT NULL REFERENCES organizer_plans(plan_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    track_id TEXT NOT NULL CHECK (length(track_id) BETWEEN 1 AND 128),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
    artist TEXT NOT NULL CHECK (length(artist) BETWEEN 1 AND 512),
    phase TEXT NOT NULL CHECK (phase IN ('pending', 'target_verified', 'complete', 'failed', 'pending_verification')),
    PRIMARY KEY (plan_id, position)
) STRICT;
CREATE INDEX organizer_plan_items_phase ON organizer_plan_items(plan_id, phase, position);
"#;

const MIGRATION_V3: &str = r#"
ALTER TABLE queue_items ADD COLUMN media_mid TEXT
    CHECK (media_mid IS NULL OR (
        length(media_mid) BETWEEN 1 AND 128
        AND media_mid NOT GLOB '*[^A-Za-z0-9_-]*'
    ));
"#;

const MIGRATION_V4: &str = r#"
ALTER TABLE settings ADD COLUMN live_spectrum_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (live_spectrum_enabled IN (0, 1));
"#;

const MIGRATION_V9: &str = r#"
ALTER TABLE playback_history ADD COLUMN album TEXT NOT NULL DEFAULT '' CHECK(length(album) <= 512);
ALTER TABLE playback_history ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(duration_ms >= 0);
ALTER TABLE playback_history ADD COLUMN cover_cache_key TEXT CHECK(cover_cache_key IS NULL OR length(cover_cache_key) BETWEEN 1 AND 128);
ALTER TABLE playback_history ADD COLUMN media_mid TEXT CHECK(media_mid IS NULL OR (length(media_mid) BETWEEN 1 AND 128 AND media_mid NOT GLOB '*[^A-Za-z0-9_-]*'));
UPDATE playback_history SET
    album = COALESCE((SELECT album FROM queue_items q WHERE q.track_id = playback_history.track_id LIMIT 1), ''),
    duration_ms = COALESCE((SELECT duration_ms FROM queue_items q WHERE q.track_id = playback_history.track_id LIMIT 1), 0),
    cover_cache_key = (SELECT cover_cache_key FROM queue_items q WHERE q.track_id = playback_history.track_id LIMIT 1),
    media_mid = (SELECT media_mid FROM queue_items q WHERE q.track_id = playback_history.track_id LIMIT 1);
"#;

#[cfg(test)]
pub(crate) const REMOVE_HISTORY_V9_COLUMNS: &str = "ALTER TABLE playback_history DROP COLUMN album;
ALTER TABLE playback_history DROP COLUMN duration_ms;
ALTER TABLE playback_history DROP COLUMN cover_cache_key;
ALTER TABLE playback_history DROP COLUMN media_mid;";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistenceError {
    Unavailable,
    IncompatibleSchema,
    InvalidData,
    LimitExceeded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreferredQuality {
    Flac,
    High320,
    Standard128,
}

impl PreferredQuality {
    fn as_db(self) -> &'static str {
        match self {
            Self::Flac => "flac",
            Self::High320 => "320k",
            Self::Standard128 => "128k",
        }
    }

    fn from_db(value: &str) -> Result<Self, PersistenceError> {
        match value {
            "flac" => Ok(Self::Flac),
            "320k" => Ok(Self::High320),
            "128k" => Ok(Self::Standard128),
            _ => Err(PersistenceError::InvalidData),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayMode {
    Sequence,
    RepeatOne,
    Shuffle,
}

impl PlayMode {
    fn as_db(self) -> &'static str {
        match self {
            Self::Sequence => "sequence",
            Self::RepeatOne => "repeat_one",
            Self::Shuffle => "shuffle",
        }
    }

    fn from_db(value: &str) -> Result<Self, PersistenceError> {
        match value {
            "sequence" => Ok(Self::Sequence),
            "repeat_one" => Ok(Self::RepeatOne),
            "shuffle" => Ok(Self::Shuffle),
            _ => Err(PersistenceError::InvalidData),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseBehavior {
    Ask,
    Tray,
    Exit,
}

impl CloseBehavior {
    fn as_db(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Tray => "tray",
            Self::Exit => "exit",
        }
    }

    fn from_db(value: &str) -> Result<Self, PersistenceError> {
        match value {
            "ask" => Ok(Self::Ask),
            "tray" => Ok(Self::Tray),
            "exit" => Ok(Self::Exit),
            _ => Err(PersistenceError::InvalidData),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppSettings {
    pub preferred_quality: PreferredQuality,
    pub play_mode: PlayMode,
    pub close_behavior: CloseBehavior,
    pub reduced_motion: bool,
    pub volume_basis_points: u16,
    pub last_position_ms: u64,
    pub live_spectrum_enabled: bool,
    pub mv_fallback_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            preferred_quality: PreferredQuality::High320,
            play_mode: PlayMode::Sequence,
            close_behavior: CloseBehavior::Ask,
            reduced_motion: false,
            volume_basis_points: 8_000,
            last_position_ms: 0,
            live_spectrum_enabled: false,
            mv_fallback_enabled: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedTrack {
    pub track_id: String,
    pub media_mid: Option<String>,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    pub cover_cache_key: Option<String>,
}

impl PersistedTrack {
    pub fn validate(&self) -> Result<(), PersistenceError> {
        validate_stable_id(&self.track_id)?;
        if let Some(media_mid) = &self.media_mid {
            validate_stable_id(media_mid)?;
        }
        validate_display_text(&self.title, false)?;
        validate_display_text(&self.artist, false)?;
        validate_display_text(&self.album, true)?;
        i64::try_from(self.duration_ms).map_err(|_| PersistenceError::InvalidData)?;
        if let Some(key) = &self.cover_cache_key {
            validate_cache_key(key)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrganizerOperation {
    Copy,
    Move,
    Remove,
    Deduplicate,
}

impl OrganizerOperation {
    fn as_db(self) -> &'static str {
        match self {
            Self::Copy => "copy",
            Self::Move => "move",
            Self::Remove => "remove",
            Self::Deduplicate => "deduplicate",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrganizerPlanState {
    Preview,
    Running,
    Partial,
    Complete,
    Expired,
}

impl OrganizerPlanState {
    fn as_db(self) -> &'static str {
        match self {
            Self::Preview => "preview",
            Self::Running => "running",
            Self::Partial => "partial",
            Self::Complete => "complete",
            Self::Expired => "expired",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrganizerPlanSummary {
    pub plan_id: String,
    pub operation: OrganizerOperation,
    pub source_playlist_id: String,
    pub target_playlist_id: Option<String>,
    pub item_count: u32,
    pub completed_count: u32,
    pub failed_count: u32,
    pub expires_at_unix_ms: u64,
    pub state: OrganizerPlanState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrganizerPlanBinding {
    pub account_id: String,
    pub source_editable_id: String,
    pub target_editable_id: Option<String>,
    pub source_snapshot_hash: String,
    pub target_snapshot_hash: Option<String>,
    pub created_at_unix_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrganizerItemPhase {
    Pending,
    TargetVerified,
    Complete,
    Failed,
    PendingVerification,
}

impl OrganizerItemPhase {
    fn as_db(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::TargetVerified => "target_verified",
            Self::Complete => "complete",
            Self::Failed => "failed",
            Self::PendingVerification => "pending_verification",
        }
    }

    fn from_db(value: &str) -> Result<Self, PersistenceError> {
        match value {
            "pending" => Ok(Self::Pending),
            "target_verified" => Ok(Self::TargetVerified),
            "complete" => Ok(Self::Complete),
            "failed" => Ok(Self::Failed),
            "pending_verification" => Ok(Self::PendingVerification),
            _ => Err(PersistenceError::InvalidData),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrganizerPlanItem {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub phase: OrganizerItemPhase,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedOrganizerPlan {
    pub summary: OrganizerPlanSummary,
    pub binding: OrganizerPlanBinding,
    pub items: Vec<OrganizerPlanItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataKind {
    Track,
    Album,
    Artist,
    Playlist,
}

impl MetadataKind {
    fn as_db(self) -> &'static str {
        match self {
            Self::Track => "track",
            Self::Album => "album",
            Self::Artist => "artist",
            Self::Playlist => "playlist",
        }
    }

    fn from_db(value: &str) -> Result<Self, PersistenceError> {
        match value {
            "track" => Ok(Self::Track),
            "album" => Ok(Self::Album),
            "artist" => Ok(Self::Artist),
            "playlist" => Ok(Self::Playlist),
            _ => Err(PersistenceError::InvalidData),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataCacheEntry {
    pub cache_key: String,
    pub kind: MetadataKind,
    pub stable_id: String,
    pub display_name: String,
    pub subtitle: String,
    pub expires_at_unix_ms: u64,
}

pub struct PersistenceService {
    connection: Mutex<Connection>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackHistoryEntry {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_cache_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_mid: Option<String>,
    pub played_at_unix_ms: i64,
}

impl PersistenceService {
    pub fn open(path: &Path) -> Result<Self, PersistenceError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| PersistenceError::Unavailable)?;
        }
        let mut connection = Connection::open(path).map_err(|_| PersistenceError::Unavailable)?;
        configure_connection(&connection)?;
        migrate(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn schema_version(&self) -> Result<u32, PersistenceError> {
        let connection = self.connection()?;
        read_schema_version(&connection)
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), PersistenceError> {
        if settings.volume_basis_points > 10_000 {
            return Err(PersistenceError::InvalidData);
        }
        let last_position =
            i64::try_from(settings.last_position_ms).map_err(|_| PersistenceError::InvalidData)?;
        self.connection()?
            .execute(
                "INSERT INTO settings (
                    singleton_id, preferred_quality, play_mode, close_behavior,
                    reduced_motion, volume_basis_points, last_position_ms,
                    live_spectrum_enabled, updated_at_unix_ms, mv_fallback_enabled
                 ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(singleton_id) DO UPDATE SET
                    preferred_quality = excluded.preferred_quality,
                    play_mode = excluded.play_mode,
                    close_behavior = excluded.close_behavior,
                    reduced_motion = excluded.reduced_motion,
                    volume_basis_points = excluded.volume_basis_points,
                    last_position_ms = excluded.last_position_ms,
                    live_spectrum_enabled = excluded.live_spectrum_enabled,
                    mv_fallback_enabled = excluded.mv_fallback_enabled,
                    updated_at_unix_ms = excluded.updated_at_unix_ms",
                params![
                    settings.preferred_quality.as_db(),
                    settings.play_mode.as_db(),
                    settings.close_behavior.as_db(),
                    settings.reduced_motion,
                    settings.volume_basis_points,
                    last_position,
                    settings.live_spectrum_enabled,
                    unix_time_ms()?,
                    settings.mv_fallback_enabled,
                ],
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        Ok(())
    }

    pub fn load_settings(&self) -> Result<AppSettings, PersistenceError> {
        let connection = self.connection()?;
        let row = connection
            .query_row(
                "SELECT preferred_quality, play_mode, close_behavior, reduced_motion,
                        volume_basis_points, last_position_ms, live_spectrum_enabled, mv_fallback_enabled
                 FROM settings WHERE singleton_id = 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, bool>(3)?,
                        row.get::<_, u16>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, bool>(6)?,
                        row.get::<_, bool>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| PersistenceError::Unavailable)?;
        let Some((
            quality,
            mode,
            close_behavior,
            reduced_motion,
            volume,
            position,
            live_spectrum_enabled,
            mv_fallback_enabled,
        )) = row
        else {
            return Ok(AppSettings::default());
        };
        Ok(AppSettings {
            preferred_quality: PreferredQuality::from_db(&quality)?,
            play_mode: PlayMode::from_db(&mode)?,
            close_behavior: CloseBehavior::from_db(&close_behavior)?,
            reduced_motion,
            volume_basis_points: volume,
            last_position_ms: u64::try_from(position).map_err(|_| PersistenceError::InvalidData)?,
            live_spectrum_enabled,
            mv_fallback_enabled,
        })
    }

    pub fn mv_lyric_offset(&self, id: &str) -> Result<i64, PersistenceError> {
        validate_stable_id(id)?;
        self.connection()?
            .query_row(
                "SELECT offset_ms FROM mv_lyric_offsets WHERE track_id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map(|offset| offset.unwrap_or(0))
            .map_err(|_| PersistenceError::Unavailable)
    }

    pub fn save_mv_lyric_offset(&self, id: &str, offset_ms: i64) -> Result<(), PersistenceError> {
        validate_stable_id(id)?;
        if !(-60_000..=60_000).contains(&offset_ms) {
            return Err(PersistenceError::InvalidData);
        }
        self.connection()?.execute("INSERT INTO mv_lyric_offsets(track_id, offset_ms) VALUES (?1, ?2) ON CONFLICT(track_id) DO UPDATE SET offset_ms = excluded.offset_ms", params![id, offset_ms])
            .map_err(|_| PersistenceError::Unavailable)?;
        Ok(())
    }

    pub fn load_playback_resume(&self) -> Result<(Option<String>, String, f32), PersistenceError> {
        self.connection()?.query_row("SELECT selected_track_id, mode, volume FROM playback_resume WHERE singleton_id = 1",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(|_| PersistenceError::Unavailable)
    }

    pub fn save_playback_mode(&self, mode: &str) -> Result<(), PersistenceError> {
        self.connection()?
            .execute(
                "UPDATE playback_resume SET mode = ?1 WHERE singleton_id = 1",
                [mode],
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        Ok(())
    }

    pub fn save_playback_volume(&self, volume: f32) -> Result<(), PersistenceError> {
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
            return Err(PersistenceError::InvalidData);
        }
        self.connection()?
            .execute(
                "UPDATE playback_resume SET volume = ?1 WHERE singleton_id = 1",
                [volume],
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        Ok(())
    }

    pub fn save_queue_selection(&self, id: &str) -> Result<(), PersistenceError> {
        validate_stable_id(id)?;
        self.connection()?
            .execute(
                "UPDATE playback_resume SET selected_track_id = ?1 WHERE singleton_id = 1",
                [id],
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        Ok(())
    }

    pub fn replace_queue(&self, tracks: &[PersistedTrack]) -> Result<(), PersistenceError> {
        self.replace_queue_selected(tracks, tracks.first().map(|track| track.track_id.as_str()))
    }

    pub fn replace_queue_selected(
        &self,
        tracks: &[PersistedTrack],
        selected: Option<&str>,
    ) -> Result<(), PersistenceError> {
        self.replace_queue_checkpoint(tracks, selected, None)
    }

    pub(crate) fn replace_queue_checkpoint(
        &self,
        tracks: &[PersistedTrack],
        selected: Option<&str>,
        previous: Option<&str>,
    ) -> Result<(), PersistenceError> {
        if tracks.len() > MAX_QUEUE_ITEMS {
            return Err(PersistenceError::LimitExceeded);
        }
        for track in tracks {
            track.validate()?;
        }

        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| PersistenceError::Unavailable)?;
        if let Some(previous) = previous {
            transaction.execute("INSERT INTO personal_items(kind, id, title, payload) VALUES ('previous', 'previous', '', ?1) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload", [previous])
                .map_err(|_| PersistenceError::Unavailable)?;
        }
        transaction
            .execute(
                "UPDATE playback_resume SET selected_track_id = ?1 WHERE singleton_id = 1",
                [selected],
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        transaction
            .execute("DELETE FROM queue_items", [])
            .map_err(|_| PersistenceError::Unavailable)?;
        {
            let mut statement = transaction
                .prepare_cached(
                    "INSERT INTO queue_items (
                        position, track_id, title, artist, album, duration_ms, cover_cache_key,
                        media_mid
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )
                .map_err(|_| PersistenceError::Unavailable)?;
            for (position, track) in tracks.iter().enumerate() {
                let position =
                    i64::try_from(position).map_err(|_| PersistenceError::LimitExceeded)?;
                let duration_ms =
                    i64::try_from(track.duration_ms).map_err(|_| PersistenceError::InvalidData)?;
                statement
                    .execute(params![
                        position,
                        track.track_id,
                        track.title,
                        track.artist,
                        track.album,
                        duration_ms,
                        track.cover_cache_key,
                        track.media_mid,
                    ])
                    .map_err(|_| PersistenceError::Unavailable)?;
            }
        }
        transaction
            .commit()
            .map_err(|_| PersistenceError::Unavailable)
    }

    pub fn load_queue(&self) -> Result<Vec<PersistedTrack>, PersistenceError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT track_id, title, artist, album, duration_ms, cover_cache_key, media_mid
                 FROM queue_items ORDER BY position ASC",
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        let rows = statement
            .query_map([], |row| {
                let duration_ms = row.get::<_, i64>(4)?;
                Ok(PersistedTrack {
                    track_id: row.get(0)?,
                    media_mid: row.get(6)?,
                    title: row.get(1)?,
                    artist: row.get(2)?,
                    album: row.get(3)?,
                    duration_ms: u64::try_from(duration_ms)
                        .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(4, duration_ms))?,
                    cover_cache_key: row.get(5)?,
                })
            })
            .map_err(|_| PersistenceError::Unavailable)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| PersistenceError::Unavailable)
    }

    /// Historical starts are only a bootstrap estimate; the experiment records qualified listens thereafter.
    pub fn last_history_plays(&self) -> Result<Vec<(String, u64)>, PersistenceError> {
        let connection = self.connection()?;
        let mut query = connection
            .prepare(
                "SELECT track_id, MAX(played_at_unix_ms) FROM playback_history GROUP BY track_id",
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        let rows = query
            .query_map([], |row| {
                Ok((row.get(0)?, row.get::<_, i64>(1)?.max(0) as u64))
            })
            .map_err(|_| PersistenceError::Unavailable)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| PersistenceError::Unavailable)
    }

    pub fn load_playback_history(&self) -> Result<Vec<PlaybackHistoryEntry>, PersistenceError> {
        let connection = self.connection()?;
        let mut query = connection
            .prepare(
                "SELECT track_id, title, artist, played_at_unix_ms, album, duration_ms, cover_cache_key, media_mid FROM playback_history
             WHERE history_id IN (SELECT MAX(history_id) FROM playback_history GROUP BY track_id)
             ORDER BY played_at_unix_ms DESC, history_id DESC LIMIT 5000",
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        let rows = query
            .query_map([], |row| {
                Ok(PlaybackHistoryEntry {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    artist: row.get(2)?,
                    played_at_unix_ms: row.get(3)?,
                    album: row.get(4)?,
                    duration_ms: u64::try_from(row.get::<_, i64>(5)?)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    cover_cache_key: row.get(6)?,
                    media_mid: row.get(7)?,
                })
            })
            .map_err(|_| PersistenceError::Unavailable)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| PersistenceError::Unavailable)
    }

    pub fn append_history(
        &self,
        track: &PersistedTrack,
        completed: bool,
    ) -> Result<(), PersistenceError> {
        track.validate()?;
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| PersistenceError::Unavailable)?;
        transaction
            .execute(
                "INSERT INTO playback_history (
                    track_id, title, artist, played_at_unix_ms, completed, album, duration_ms, cover_cache_key, media_mid
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    track.track_id,
                    track.title,
                    track.artist,
                    unix_time_ms()?,
                    completed,
                    track.album,
                    i64::try_from(track.duration_ms).map_err(|_| PersistenceError::InvalidData)?,
                    track.cover_cache_key,
                    track.media_mid,
                ],
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        transaction
            .execute(
                "DELETE FROM playback_history WHERE history_id IN (
                    SELECT history_id FROM playback_history
                    ORDER BY played_at_unix_ms DESC, history_id DESC
                    LIMIT -1 OFFSET ?1
                 )",
                [MAX_HISTORY_ITEMS],
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        transaction
            .commit()
            .map_err(|_| PersistenceError::Unavailable)
    }

    pub fn save_organizer_plan(&self, plan: &OrganizerPlanSummary) -> Result<(), PersistenceError> {
        validate_stable_id(&plan.plan_id)?;
        validate_stable_id(&plan.source_playlist_id)?;
        if let Some(target) = &plan.target_playlist_id {
            validate_stable_id(target)?;
        }
        if plan.item_count > 10_000
            || plan.completed_count > plan.item_count
            || plan.failed_count > plan.item_count
        {
            return Err(PersistenceError::InvalidData);
        }
        let expiry =
            i64::try_from(plan.expires_at_unix_ms).map_err(|_| PersistenceError::InvalidData)?;
        let changed = self
            .connection()?
            .execute(
                "INSERT INTO organizer_plans (
                    plan_id, operation, source_playlist_id, target_playlist_id,
                    item_count, completed_count, failed_count, expires_at_unix_ms, state
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(plan_id) DO UPDATE SET
                    completed_count = excluded.completed_count,
                    failed_count = excluded.failed_count,
                    state = excluded.state
                 WHERE organizer_plans.operation = excluded.operation
                   AND organizer_plans.source_playlist_id = excluded.source_playlist_id
                   AND organizer_plans.target_playlist_id IS excluded.target_playlist_id
                   AND organizer_plans.item_count = excluded.item_count
                   AND organizer_plans.expires_at_unix_ms = excluded.expires_at_unix_ms",
                params![
                    plan.plan_id,
                    plan.operation.as_db(),
                    plan.source_playlist_id,
                    plan.target_playlist_id,
                    plan.item_count,
                    plan.completed_count,
                    plan.failed_count,
                    expiry,
                    plan.state.as_db(),
                ],
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        if changed != 1 {
            return Err(PersistenceError::InvalidData);
        }
        Ok(())
    }

    pub fn save_organizer_plan_payload(
        &self,
        plan_id: &str,
        binding: &OrganizerPlanBinding,
        items: &[OrganizerPlanItem],
    ) -> Result<(), PersistenceError> {
        validate_stable_id(plan_id)?;
        validate_stable_id(&binding.account_id)?;
        validate_stable_id(&binding.source_editable_id)?;
        if let Some(target) = &binding.target_editable_id {
            validate_stable_id(target)?;
        }
        validate_hash(&binding.source_snapshot_hash)?;
        if let Some(target_hash) = &binding.target_snapshot_hash {
            validate_hash(target_hash)?;
        }
        if items.len() > 10_000 {
            return Err(PersistenceError::LimitExceeded);
        }
        for item in items {
            validate_stable_id(&item.track_id)?;
            validate_display_text(&item.title, false)?;
            validate_display_text(&item.artist, false)?;
        }
        let created_at =
            i64::try_from(binding.created_at_unix_ms).map_err(|_| PersistenceError::InvalidData)?;
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| PersistenceError::Unavailable)?;
        transaction
            .execute(
                "INSERT INTO organizer_plan_bindings (
                    plan_id, account_id, source_editable_id, target_editable_id,
                    source_snapshot_hash, target_snapshot_hash, created_at_unix_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    plan_id,
                    binding.account_id,
                    binding.source_editable_id,
                    binding.target_editable_id,
                    binding.source_snapshot_hash,
                    binding.target_snapshot_hash,
                    created_at,
                ],
            )
            .map_err(|_| PersistenceError::InvalidData)?;
        {
            let mut statement = transaction
                .prepare_cached(
                    "INSERT INTO organizer_plan_items (
                        plan_id, position, track_id, title, artist, phase
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )
                .map_err(|_| PersistenceError::Unavailable)?;
            for (position, item) in items.iter().enumerate() {
                statement
                    .execute(params![
                        plan_id,
                        i64::try_from(position).map_err(|_| PersistenceError::LimitExceeded)?,
                        item.track_id,
                        item.title,
                        item.artist,
                        item.phase.as_db(),
                    ])
                    .map_err(|_| PersistenceError::Unavailable)?;
            }
        }
        transaction
            .commit()
            .map_err(|_| PersistenceError::Unavailable)
    }

    pub fn load_organizer_plan(
        &self,
        plan_id: &str,
    ) -> Result<Option<PersistedOrganizerPlan>, PersistenceError> {
        validate_stable_id(plan_id)?;
        let connection = self.connection()?;
        let plan = connection
            .query_row(
                "SELECT p.operation, p.source_playlist_id, p.target_playlist_id,
                        p.item_count, p.completed_count, p.failed_count,
                        p.expires_at_unix_ms, p.state,
                        b.account_id, b.source_editable_id, b.target_editable_id,
                        b.source_snapshot_hash, b.target_snapshot_hash, b.created_at_unix_ms
                 FROM organizer_plans p
                 JOIN organizer_plan_bindings b ON b.plan_id = p.plan_id
                 WHERE p.plan_id = ?1",
                [plan_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, u32>(3)?,
                        row.get::<_, u32>(4)?,
                        row.get::<_, u32>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, Option<String>>(12)?,
                        row.get::<_, i64>(13)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| PersistenceError::Unavailable)?;
        let Some((
            operation,
            source_playlist_id,
            target_playlist_id,
            item_count,
            completed_count,
            failed_count,
            expires_at,
            state,
            account_id,
            source_editable_id,
            target_editable_id,
            source_snapshot_hash,
            target_snapshot_hash,
            created_at,
        )) = plan
        else {
            return Ok(None);
        };
        let mut statement = connection
            .prepare(
                "SELECT track_id, title, artist, phase
                 FROM organizer_plan_items WHERE plan_id = ?1 ORDER BY position",
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        let items = statement
            .query_map([plan_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|_| PersistenceError::Unavailable)?
            .map(|row| {
                let (track_id, title, artist, phase) =
                    row.map_err(|_| PersistenceError::Unavailable)?;
                Ok(OrganizerPlanItem {
                    track_id,
                    title,
                    artist,
                    phase: OrganizerItemPhase::from_db(&phase)?,
                })
            })
            .collect::<Result<Vec<_>, PersistenceError>>()?;
        if items.len() != item_count as usize {
            return Err(PersistenceError::InvalidData);
        }
        Ok(Some(PersistedOrganizerPlan {
            summary: OrganizerPlanSummary {
                plan_id: plan_id.to_owned(),
                operation: organizer_operation_from_db(&operation)?,
                source_playlist_id,
                target_playlist_id,
                item_count,
                completed_count,
                failed_count,
                expires_at_unix_ms: u64::try_from(expires_at)
                    .map_err(|_| PersistenceError::InvalidData)?,
                state: organizer_state_from_db(&state)?,
            },
            binding: OrganizerPlanBinding {
                account_id,
                source_editable_id,
                target_editable_id,
                source_snapshot_hash,
                target_snapshot_hash,
                created_at_unix_ms: u64::try_from(created_at)
                    .map_err(|_| PersistenceError::InvalidData)?,
            },
            items,
        }))
    }

    pub fn update_organizer_item_phase(
        &self,
        plan_id: &str,
        position: usize,
        phase: OrganizerItemPhase,
    ) -> Result<(), PersistenceError> {
        validate_stable_id(plan_id)?;
        let changed = self
            .connection()?
            .execute(
                "UPDATE organizer_plan_items SET phase = ?3
                 WHERE plan_id = ?1 AND position = ?2",
                params![
                    plan_id,
                    i64::try_from(position).map_err(|_| PersistenceError::LimitExceeded)?,
                    phase.as_db(),
                ],
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        if changed == 1 {
            Ok(())
        } else {
            Err(PersistenceError::InvalidData)
        }
    }

    pub fn upsert_metadata(
        &self,
        entry: &MetadataCacheEntry,
        now_unix_ms: u64,
    ) -> Result<(), PersistenceError> {
        validate_cache_key(&entry.cache_key)?;
        validate_stable_id(&entry.stable_id)?;
        validate_display_text(&entry.display_name, false)?;
        validate_display_text(&entry.subtitle, true)?;
        let expiry =
            i64::try_from(entry.expires_at_unix_ms).map_err(|_| PersistenceError::InvalidData)?;
        let now = i64::try_from(now_unix_ms).map_err(|_| PersistenceError::InvalidData)?;
        if expiry <= now {
            return Err(PersistenceError::InvalidData);
        }

        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| PersistenceError::Unavailable)?;
        transaction
            .execute(
                "INSERT INTO metadata_cache (
                    cache_key, kind, stable_id, display_name, subtitle,
                    expires_at_unix_ms, last_accessed_unix_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(cache_key) DO UPDATE SET
                    kind = excluded.kind,
                    stable_id = excluded.stable_id,
                    display_name = excluded.display_name,
                    subtitle = excluded.subtitle,
                    expires_at_unix_ms = excluded.expires_at_unix_ms,
                    last_accessed_unix_ms = excluded.last_accessed_unix_ms",
                params![
                    entry.cache_key,
                    entry.kind.as_db(),
                    entry.stable_id,
                    entry.display_name,
                    entry.subtitle,
                    expiry,
                    now,
                ],
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        transaction
            .execute(
                "DELETE FROM metadata_cache WHERE expires_at_unix_ms <= ?1",
                [now],
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        transaction
            .execute(
                "DELETE FROM metadata_cache WHERE cache_key IN (
                    SELECT cache_key FROM metadata_cache
                    ORDER BY last_accessed_unix_ms DESC, cache_key ASC
                    LIMIT -1 OFFSET ?1
                 )",
                [MAX_METADATA_CACHE_ITEMS],
            )
            .map_err(|_| PersistenceError::Unavailable)?;
        transaction
            .commit()
            .map_err(|_| PersistenceError::Unavailable)
    }

    pub fn load_metadata(
        &self,
        cache_key: &str,
        now_unix_ms: u64,
    ) -> Result<Option<MetadataCacheEntry>, PersistenceError> {
        validate_cache_key(cache_key)?;
        let now = i64::try_from(now_unix_ms).map_err(|_| PersistenceError::InvalidData)?;
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| PersistenceError::Unavailable)?;
        let row = transaction
            .query_row(
                "SELECT kind, stable_id, display_name, subtitle, expires_at_unix_ms
                 FROM metadata_cache
                 WHERE cache_key = ?1 AND expires_at_unix_ms > ?2",
                params![cache_key, now],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| PersistenceError::Unavailable)?;
        if row.is_some() {
            transaction
                .execute(
                    "UPDATE metadata_cache SET last_accessed_unix_ms = ?2 WHERE cache_key = ?1",
                    params![cache_key, now],
                )
                .map_err(|_| PersistenceError::Unavailable)?;
        }
        transaction
            .commit()
            .map_err(|_| PersistenceError::Unavailable)?;

        row.map(|(kind, stable_id, display_name, subtitle, expiry)| {
            Ok(MetadataCacheEntry {
                cache_key: cache_key.to_owned(),
                kind: MetadataKind::from_db(&kind)?,
                stable_id,
                display_name,
                subtitle,
                expires_at_unix_ms: u64::try_from(expiry)
                    .map_err(|_| PersistenceError::InvalidData)?,
            })
        })
        .transpose()
    }

    pub(crate) fn connection(&self) -> Result<MutexGuard<'_, Connection>, PersistenceError> {
        self.connection
            .lock()
            .map_err(|_| PersistenceError::Unavailable)
    }
}

fn configure_connection(connection: &Connection) -> Result<(), PersistenceError> {
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| PersistenceError::Unavailable)?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA trusted_schema = OFF;
             PRAGMA secure_delete = ON;
             PRAGMA synchronous = FULL;
             PRAGMA temp_store = MEMORY;
             PRAGMA journal_mode = WAL;",
        )
        .map_err(|_| PersistenceError::Unavailable)
}

fn migrate(connection: &mut Connection) -> Result<(), PersistenceError> {
    let version = read_schema_version(connection)?;
    if version > LOCAL_SCHEMA_VERSION {
        return Err(PersistenceError::IncompatibleSchema);
    }
    if version == LOCAL_SCHEMA_VERSION {
        return Ok(());
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| PersistenceError::Unavailable)?;
    if version == 0 {
        transaction
            .execute_batch(MIGRATION_V1)
            .map_err(|_| PersistenceError::Unavailable)?;
    }
    if version < 2 {
        transaction
            .execute_batch(MIGRATION_V2)
            .map_err(|_| PersistenceError::Unavailable)?;
    }
    if version < 3 {
        transaction
            .execute_batch(MIGRATION_V3)
            .map_err(|_| PersistenceError::Unavailable)?;
    }
    if version < 4 {
        transaction
            .execute_batch(MIGRATION_V4)
            .map_err(|_| PersistenceError::Unavailable)?;
    }
    if version < 5 {
        transaction.execute_batch("CREATE TABLE playback_resume (
            singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
            selected_track_id TEXT,
            mode TEXT NOT NULL CHECK (mode IN ('sequence', 'repeat-all', 'repeat-one', 'shuffle')),
            volume REAL NOT NULL CHECK (volume BETWEEN 0 AND 1)
        ) STRICT;
        INSERT INTO playback_resume VALUES (1, NULL, 'sequence', 0.8);
        UPDATE playback_resume SET
            mode = COALESCE((SELECT replace(play_mode, '_', '-') FROM settings WHERE singleton_id = 1), 'sequence'),
            volume = COALESCE((SELECT volume_basis_points / 10000.0 FROM settings WHERE singleton_id = 1), 0.8);")
            .map_err(|_| PersistenceError::Unavailable)?;
    }
    if version < 6 {
        transaction.execute_batch("ALTER TABLE settings ADD COLUMN mv_fallback_enabled INTEGER NOT NULL DEFAULT 1 CHECK (mv_fallback_enabled IN (0, 1));
            CREATE TABLE mv_lyric_offsets (track_id TEXT PRIMARY KEY CHECK(length(track_id) BETWEEN 1 AND 128), offset_ms INTEGER NOT NULL CHECK(offset_ms BETWEEN -60000 AND 60000)) STRICT;")
            .map_err(|_| PersistenceError::Unavailable)?;
    }
    if version < 7 {
        transaction
            .execute_batch(crate::personal::MIGRATION)
            .map_err(|_| PersistenceError::Unavailable)?;
    }
    if version < 8 {
        transaction
            .execute_batch(crate::personal::MIGRATION_V8)
            .map_err(|_| PersistenceError::Unavailable)?;
    }
    if version < 9 {
        transaction
            .execute_batch(MIGRATION_V9)
            .map_err(|_| PersistenceError::Unavailable)?;
    }
    transaction
        .pragma_update(None, "user_version", LOCAL_SCHEMA_VERSION)
        .map_err(|_| PersistenceError::Unavailable)?;
    transaction
        .commit()
        .map_err(|_| PersistenceError::Unavailable)
}

fn read_schema_version(connection: &Connection) -> Result<u32, PersistenceError> {
    connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| PersistenceError::Unavailable)
}

fn validate_stable_id(value: &str) -> Result<(), PersistenceError> {
    if value.is_empty()
        || value.len() > MAX_STABLE_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err(PersistenceError::InvalidData);
    }
    Ok(())
}

fn validate_hash(value: &str) -> Result<(), PersistenceError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Err(PersistenceError::InvalidData)
    } else {
        Ok(())
    }
}

fn organizer_operation_from_db(value: &str) -> Result<OrganizerOperation, PersistenceError> {
    match value {
        "copy" => Ok(OrganizerOperation::Copy),
        "move" => Ok(OrganizerOperation::Move),
        "remove" => Ok(OrganizerOperation::Remove),
        "deduplicate" => Ok(OrganizerOperation::Deduplicate),
        _ => Err(PersistenceError::InvalidData),
    }
}

fn organizer_state_from_db(value: &str) -> Result<OrganizerPlanState, PersistenceError> {
    match value {
        "preview" => Ok(OrganizerPlanState::Preview),
        "running" => Ok(OrganizerPlanState::Running),
        "partial" => Ok(OrganizerPlanState::Partial),
        "complete" => Ok(OrganizerPlanState::Complete),
        "expired" => Ok(OrganizerPlanState::Expired),
        _ => Err(PersistenceError::InvalidData),
    }
}

fn validate_cache_key(value: &str) -> Result<(), PersistenceError> {
    if value.is_empty()
        || value.len() > MAX_STABLE_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(PersistenceError::InvalidData);
    }
    Ok(())
}

fn validate_display_text(value: &str, allow_empty: bool) -> Result<(), PersistenceError> {
    if (!allow_empty && value.is_empty())
        || value.len() > MAX_TEXT_BYTES
        || value.contains(['\r', '\n', '\0'])
    {
        return Err(PersistenceError::InvalidData);
    }
    Ok(())
}

fn unix_time_ms() -> Result<i64, PersistenceError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| PersistenceError::Unavailable)?
        .as_millis();
    i64::try_from(millis).map_err(|_| PersistenceError::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    struct TestDatabase {
        root: PathBuf,
        path: PathBuf,
    }

    impl TestDatabase {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("qqmusic-gui-persistence-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).expect("create test database root");
            let path = root.join("state.sqlite3");
            Self { root, path }
        }
    }

    impl Drop for TestDatabase {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn track(id: &str) -> PersistedTrack {
        PersistedTrack {
            track_id: id.to_owned(),
            media_mid: None,
            title: "纸月光".to_owned(),
            artist: "林间电台".to_owned(),
            album: "温室唱片".to_owned(),
            duration_ms: 234_567,
            cover_cache_key: Some("cover_fixture_01".to_owned()),
        }
    }

    #[test]
    fn mv_preferences_survive_restart_and_validate_offsets() {
        let database = TestDatabase::new();
        let service = PersistenceService::open(&database.path).unwrap();
        let mut settings = service.load_settings().unwrap();
        assert!(settings.mv_fallback_enabled);
        settings.mv_fallback_enabled = false;
        service.save_settings(&settings).unwrap();
        service.save_mv_lyric_offset("one", -1500).unwrap();
        service.save_mv_lyric_offset("two", 2000).unwrap();
        assert!(service.save_mv_lyric_offset("one", 60001).is_err());
        drop(service);
        let reopened = PersistenceService::open(&database.path).unwrap();
        assert!(!reopened.load_settings().unwrap().mv_fallback_enabled);
        assert_eq!(reopened.mv_lyric_offset("one").unwrap(), -1500);
        assert_eq!(reopened.mv_lyric_offset("two").unwrap(), 2000);
        assert_eq!(reopened.mv_lyric_offset("missing").unwrap(), 0);
        reopened.save_mv_lyric_offset("one", 0).unwrap();
        assert_eq!(reopened.mv_lyric_offset("one").unwrap(), 0);
    }

    #[test]
    fn schema_five_migrates_mv_preferences_without_changing_queue() {
        let database = TestDatabase::new();
        let service = PersistenceService::open(&database.path).unwrap();
        service.replace_queue(&[track("one")]).unwrap();
        service
            .connection()
            .unwrap()
            .execute_batch(REMOVE_HISTORY_V9_COLUMNS)
            .unwrap();
        service.connection().unwrap().execute_batch("ALTER TABLE settings DROP COLUMN mv_fallback_enabled; DROP TABLE mv_lyric_offsets; PRAGMA user_version = 5;").unwrap();
        drop(service);
        let reopened = PersistenceService::open(&database.path).unwrap();
        assert_eq!(reopened.schema_version().unwrap(), LOCAL_SCHEMA_VERSION);
        assert!(reopened.load_settings().unwrap().mv_fallback_enabled);
        assert_eq!(reopened.mv_lyric_offset("one").unwrap(), 0);
        assert_eq!(reopened.load_queue().unwrap()[0].track_id, "one");
    }

    #[test]
    fn migration_is_idempotent_and_uses_wal() {
        let database = TestDatabase::new();
        let service = PersistenceService::open(&database.path).expect("open migrated database");
        assert_eq!(service.schema_version(), Ok(LOCAL_SCHEMA_VERSION));
        drop(service);

        let reopened = PersistenceService::open(&database.path).expect("reopen migrated database");
        assert_eq!(reopened.schema_version(), Ok(LOCAL_SCHEMA_VERSION));
        let connection = reopened.connection().expect("database lock");
        let journal_mode: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .expect("read journal mode");
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    }

    #[test]
    fn playback_history_reads_existing_rows_deduplicates_and_survives_restart() {
        let database = TestDatabase::new();
        let service = PersistenceService::open(&database.path).unwrap();
        assert!(service.load_playback_history().unwrap().is_empty());
        service.append_history(&track("first"), false).unwrap();
        service.append_history(&track("second"), false).unwrap();
        let mut updated = track("first");
        updated.title = "Recently replayed".into();
        updated.media_mid = Some("media_first".into());
        service.append_history(&updated, false).unwrap();
        service.replace_queue(&[]).unwrap();
        // Equal timestamps must retain deterministic newest-insertion ordering.
        service
            .connection()
            .unwrap()
            .execute("UPDATE playback_history SET played_at_unix_ms = 1000", [])
            .unwrap();
        drop(service);
        let reopened = PersistenceService::open(&database.path).unwrap();
        let rows = reopened.load_playback_history().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "first");
        assert_eq!(rows[0].title, "Recently replayed");
        assert_eq!(rows[0].album, updated.album);
        assert_eq!(rows[0].duration_ms, updated.duration_ms);
        assert_eq!(rows[0].cover_cache_key, updated.cover_cache_key);
        assert_eq!(rows[0].media_mid, updated.media_mid);
        assert_eq!(rows[0].played_at_unix_ms, 1000);
        assert_eq!(rows[1].id, "second");
        assert_eq!(reopened.schema_version().unwrap(), LOCAL_SCHEMA_VERSION);
    }

    #[test]
    fn history_v8_upgrade_recovers_available_covers_and_keeps_missing_metadata_empty() {
        let database = TestDatabase::new();
        let service = PersistenceService::open(&database.path).unwrap();
        let mut available = track("available");
        available.media_mid = Some("available_media".into());
        service.replace_queue(&[available.clone()]).unwrap();
        service.append_history(&available, false).unwrap();
        service.append_history(&track("missing"), false).unwrap();
        service
            .connection()
            .unwrap()
            .execute_batch(REMOVE_HISTORY_V9_COLUMNS)
            .unwrap();
        service
            .connection()
            .unwrap()
            .pragma_update(None, "user_version", 8)
            .unwrap();
        drop(service);
        let upgraded = PersistenceService::open(&database.path).unwrap();
        let rows = upgraded.load_playback_history().unwrap();
        let recovered = rows.iter().find(|row| row.id == "available").unwrap();
        assert_eq!(recovered.cover_cache_key, available.cover_cache_key);
        assert_eq!(recovered.media_mid, available.media_mid);
        assert_eq!(recovered.album, available.album);
        let missing = rows.iter().find(|row| row.id == "missing").unwrap();
        assert_eq!(missing.cover_cache_key, None);
        assert_eq!(missing.album, "");
        assert_eq!(missing.duration_ms, 0);
        assert_eq!(upgraded.schema_version().unwrap(), 9);
    }

    #[test]
    fn settings_and_queue_survive_reopen() {
        let database = TestDatabase::new();
        let service = PersistenceService::open(&database.path).expect("open database");
        let settings = AppSettings {
            preferred_quality: PreferredQuality::Flac,
            play_mode: PlayMode::Shuffle,
            close_behavior: CloseBehavior::Tray,
            reduced_motion: true,
            volume_basis_points: 4_200,
            last_position_ms: 12_345,
            live_spectrum_enabled: true,
            mv_fallback_enabled: false,
        };
        service.save_settings(&settings).expect("save settings");
        let mut media_track = track("track-1");
        media_track.media_mid = Some("C400track-1".to_owned());
        service
            .replace_queue(&[media_track.clone(), track("track-2")])
            .expect("save queue");
        drop(service);

        let reopened = PersistenceService::open(&database.path).expect("reopen database");
        assert_eq!(reopened.load_settings(), Ok(settings));
        let queue = reopened.load_queue().expect("load queue");
        assert_eq!(queue.len(), 2);
        assert_eq!(queue[0].media_mid, media_track.media_mid);
    }

    #[test]
    fn version_two_queue_migrates_with_missing_media_mid_as_none() {
        let database = TestDatabase::new();
        let connection = Connection::open(&database.path).expect("create v2 database");
        configure_connection(&connection).expect("configure v2 database");
        connection
            .execute_batch(MIGRATION_V1)
            .expect("install v1 schema");
        connection
            .execute_batch(MIGRATION_V2)
            .expect("install v2 schema");
        connection
            .pragma_update(None, "user_version", 2)
            .expect("mark schema v2");
        connection
            .execute(
                "INSERT INTO queue_items (
                    position, track_id, title, artist, album, duration_ms, cover_cache_key
                 ) VALUES (0, 'legacy-track', 'Legacy', 'Artist', 'Album', 1234, NULL)",
                [],
            )
            .expect("seed legacy queue");
        drop(connection);

        let migrated = PersistenceService::open(&database.path).expect("migrate v2 database");
        assert_eq!(migrated.schema_version(), Ok(LOCAL_SCHEMA_VERSION));
        let queue = migrated.load_queue().expect("load migrated queue");
        assert_eq!(queue[0].track_id, "legacy-track");
        assert_eq!(queue[0].media_mid, None);
        assert!(
            !migrated
                .load_settings()
                .expect("load migrated settings")
                .live_spectrum_enabled
        );
    }

    #[test]
    fn version_three_settings_migrate_with_live_spectrum_disabled() {
        let database = TestDatabase::new();
        let connection = Connection::open(&database.path).expect("create v3 database");
        configure_connection(&connection).expect("configure v3 database");
        connection
            .execute_batch(MIGRATION_V1)
            .expect("install v1 schema");
        connection
            .execute_batch(MIGRATION_V2)
            .expect("install v2 schema");
        connection
            .execute_batch(MIGRATION_V3)
            .expect("install v3 schema");
        connection
            .execute(
                "INSERT INTO settings (
                    singleton_id, preferred_quality, play_mode, close_behavior,
                    reduced_motion, volume_basis_points, last_position_ms, updated_at_unix_ms
                 ) VALUES (1, '320k', 'sequence', 'tray', 0, 8000, 0, 1)",
                [],
            )
            .expect("seed v3 settings");
        connection
            .pragma_update(None, "user_version", 3)
            .expect("mark schema v3");
        drop(connection);

        let migrated = PersistenceService::open(&database.path).expect("migrate v3 database");
        assert_eq!(migrated.schema_version(), Ok(LOCAL_SCHEMA_VERSION));
        assert!(
            !migrated
                .load_settings()
                .expect("load migrated settings")
                .live_spectrum_enabled
        );
    }

    #[test]
    fn invalid_queue_replacement_is_rejected_before_transaction() {
        let database = TestDatabase::new();
        let service = PersistenceService::open(&database.path).expect("open database");
        service
            .replace_queue(&[track("stable-track")])
            .expect("seed queue");
        let mut invalid = track("bad/id");
        invalid.title = "replacement".to_owned();

        assert_eq!(
            service.replace_queue(&[invalid]),
            Err(PersistenceError::InvalidData)
        );
        assert_eq!(
            service.load_queue().expect("load original queue")[0].track_id,
            "stable-track"
        );
    }

    #[test]
    fn newer_database_version_is_never_downgraded() {
        let database = TestDatabase::new();
        let connection = Connection::open(&database.path).expect("create future database");
        connection
            .pragma_update(None, "user_version", LOCAL_SCHEMA_VERSION + 1)
            .expect("set future version");
        drop(connection);

        assert!(matches!(
            PersistenceService::open(&database.path),
            Err(PersistenceError::IncompatibleSchema)
        ));
    }

    #[test]
    fn failed_migration_rolls_back_and_can_be_retried_after_repair() {
        let database = TestDatabase::new();
        let connection = Connection::open(&database.path).expect("create conflicting database");
        connection
            .execute("CREATE TABLE settings (broken INTEGER)", [])
            .expect("create migration conflict");
        drop(connection);

        assert!(matches!(
            PersistenceService::open(&database.path),
            Err(PersistenceError::Unavailable)
        ));
        let connection = Connection::open(&database.path).expect("inspect failed migration");
        assert_eq!(read_schema_version(&connection), Ok(0));
        let leaked_table_count: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_schema
                 WHERE type = 'table' AND name = 'queue_items'",
                [],
                |row| row.get(0),
            )
            .expect("count partially migrated tables");
        assert_eq!(leaked_table_count, 0);
        connection
            .execute("DROP TABLE settings", [])
            .expect("repair migration conflict");
        drop(connection);

        let recovered = PersistenceService::open(&database.path).expect("retry migration");
        assert_eq!(recovered.schema_version(), Ok(LOCAL_SCHEMA_VERSION));
    }

    #[test]
    fn metadata_cache_is_typed_and_expires_at_read_boundary() {
        let database = TestDatabase::new();
        let service = PersistenceService::open(&database.path).expect("open database");
        let entry = MetadataCacheEntry {
            cache_key: "track_fixture_1".to_owned(),
            kind: MetadataKind::Track,
            stable_id: "song-mid-1".to_owned(),
            display_name: "纸月光".to_owned(),
            subtitle: "林间电台".to_owned(),
            expires_at_unix_ms: 2_000,
        };
        service
            .upsert_metadata(&entry, 1_000)
            .expect("cache metadata");
        assert_eq!(
            service
                .load_metadata("track_fixture_1", 1_500)
                .expect("load cached metadata"),
            Some(entry)
        );
        assert_eq!(
            service
                .load_metadata("track_fixture_1", 2_000)
                .expect("expired cache miss"),
            None
        );
    }

    #[test]
    fn organizer_plan_identity_cannot_be_rebound_during_progress_update() {
        let database = TestDatabase::new();
        let service = PersistenceService::open(&database.path).expect("open database");
        let mut plan = OrganizerPlanSummary {
            plan_id: "plan-1".to_owned(),
            operation: OrganizerOperation::Move,
            source_playlist_id: "source-1".to_owned(),
            target_playlist_id: Some("target-1".to_owned()),
            item_count: 10,
            completed_count: 0,
            failed_count: 0,
            expires_at_unix_ms: 10_000,
            state: OrganizerPlanState::Preview,
        };
        service.save_organizer_plan(&plan).expect("save preview");
        plan.completed_count = 4;
        plan.state = OrganizerPlanState::Running;
        service.save_organizer_plan(&plan).expect("update progress");
        plan.target_playlist_id = Some("target-2".to_owned());
        assert_eq!(
            service.save_organizer_plan(&plan),
            Err(PersistenceError::InvalidData)
        );
    }

    #[test]
    fn organizer_payload_round_trips_account_snapshot_and_item_phases() {
        let database = TestDatabase::new();
        let service = PersistenceService::open(&database.path).expect("open database");
        let plan = OrganizerPlanSummary {
            plan_id: "plan-roundtrip".to_owned(),
            operation: OrganizerOperation::Move,
            source_playlist_id: "991".to_owned(),
            target_playlist_id: Some("992".to_owned()),
            item_count: 1,
            completed_count: 0,
            failed_count: 0,
            expires_at_unix_ms: 20_000,
            state: OrganizerPlanState::Preview,
        };
        service.save_organizer_plan(&plan).expect("save summary");
        let binding = OrganizerPlanBinding {
            account_id: "123456".to_owned(),
            source_editable_id: "88".to_owned(),
            target_editable_id: Some("89".to_owned()),
            source_snapshot_hash: "a".repeat(64),
            target_snapshot_hash: Some("b".repeat(64)),
            created_at_unix_ms: 10_000,
        };
        let items = vec![OrganizerPlanItem {
            track_id: "song-mid-1".to_owned(),
            title: "纸月光".to_owned(),
            artist: "林间电台".to_owned(),
            phase: OrganizerItemPhase::Pending,
        }];
        service
            .save_organizer_plan_payload(&plan.plan_id, &binding, &items)
            .expect("save payload");
        service
            .update_organizer_item_phase(&plan.plan_id, 0, OrganizerItemPhase::TargetVerified)
            .expect("update phase");

        let restored = service
            .load_organizer_plan(&plan.plan_id)
            .expect("load")
            .expect("plan");
        assert_eq!(restored.summary, plan);
        assert_eq!(restored.binding, binding);
        assert_eq!(restored.items[0].phase, OrganizerItemPhase::TargetVerified);
    }

    #[test]
    fn sqlite_schema_has_no_secret_or_remote_transport_columns() {
        let database = TestDatabase::new();
        let service = PersistenceService::open(&database.path).expect("open database");
        let connection = service.connection().expect("database lock");
        let schema: String = connection
            .query_row(
                "SELECT group_concat(sql, ' ') FROM sqlite_schema WHERE sql IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("read schema");
        let schema = schema.to_ascii_lowercase();
        for forbidden in [
            "credential",
            "cookie",
            "token",
            "password",
            "authorization",
            "play_url",
            "request_header",
            "qr_image",
        ] {
            assert!(
                !schema.contains(forbidden),
                "forbidden schema marker: {forbidden}"
            );
        }
    }
}
