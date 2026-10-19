use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, RwLock, Weak,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::{
    local_music::{LocalMusicError, LocalMusicService, LocalTrackId},
    playback::{PlaybackController, PlaybackError, PlaybackLoadResult, PlaybackQuality},
    player::{
        LocalMediaFile, NativePlayerEvent, PlayerFailureCode, PlayerSnapshot, PlayerState,
        SeekPositionMs, TrackSummary,
    },
    queue::{QueueError, QueueService, QueueSnapshot, QueueTrack},
    smtc_artwork::SmtcArtworkPort,
    smtc_dynamic_lyrics::SmtcDynamicLyricsPort,
};

const AUTO_ADVANCE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const FAILED_TRACK_SKIP_DELAY: Duration = Duration::from_millis(1200);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSkipNotice {
    pub title: String,
    pub exhausted: bool,
}

#[derive(Default)]
struct FailedTracks {
    ids: HashSet<String>,
    pending: Option<(u64, String, Instant)>,
    resolving: bool,
    notice: Option<(PlaybackSkipNotice, Instant)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaybackMode {
    Sequence,
    RepeatAll,
    RepeatOne,
    Shuffle,
}

impl PlaybackMode {
    pub fn parse(value: &str) -> Result<Self, PlaybackSessionError> {
        match value {
            "sequence" => Ok(Self::Sequence),
            "repeat-all" => Ok(Self::RepeatAll),
            "repeat-one" => Ok(Self::RepeatOne),
            "shuffle" => Ok(Self::Shuffle),
            _ => Err(PlaybackSessionError::InvalidMode),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSessionSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_notice: Option<PlaybackSkipNotice>,
    #[serde(skip_serializing_if = "is_zero_offset")]
    pub lyric_offset_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_quality: Option<String>,
    pub mode: PlaybackMode,
    pub queue: QueueSnapshot,
    pub player: PlayerSnapshot,
    pub requested_quality: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSessionUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_notice: Option<PlaybackSkipNotice>,
    #[serde(skip_serializing_if = "is_zero_offset")]
    pub lyric_offset_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_quality: Option<String>,
    pub mode: PlaybackMode,
    /// Null means unchanged from the generation supplied by this request.
    pub queue: Option<QueueSnapshot>,
    pub player: PlayerSnapshot,
    pub requested_quality: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPlayResult {
    pub queue: QueueSnapshot,
    pub playback: PlaybackLoadResult,
    pub requested_quality: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMusicDeleteResult {
    pub deleted_id: String,
    pub session: PlaybackSessionSnapshot,
    pub auto_play_started: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackSessionError {
    InvalidMode,
    Superseded,
    Queue(QueueError),
    Playback(PlaybackError),
    LocalMusic(LocalMusicError),
}

pub struct PlaybackSession {
    lyrics: Option<Arc<crate::lyrics::LyricService>>,
    mv_lyric_offset: Mutex<i64>,
    next_override: Mutex<Option<String>>,
    smart_shuffle: Mutex<crate::smart_shuffle::SmartShuffle>,
    listening_stats: Mutex<crate::listening_stats::ListeningStats>,
    shuffle_likes_epoch: AtomicU64,
    queue: Arc<QueueService>,
    playback: Arc<PlaybackController>,
    artwork: Option<Arc<dyn SmtcArtworkPort>>,
    dynamic_lyrics: Option<Arc<dyn SmtcDynamicLyricsPort>>,
    local_music: Option<Arc<LocalMusicService>>,
    mode: RwLock<PlaybackMode>,
    handled_ended_generation: Mutex<Option<u64>>,
    handled_failed_generation: Mutex<Option<u64>>,
    auto_advance_retry: Mutex<Option<AutoAdvanceRetry>>,
    failed_tracks: Mutex<FailedTracks>,
    active_source: Mutex<Option<ActiveSource>>,
    pending_resume: Mutex<Option<PendingResume>>,
    resume_transport: Mutex<Option<(u64, bool)>>,
    default_quality: RwLock<PlaybackQuality>,
    requested_quality: RwLock<Option<PlaybackQuality>>,
    operation: Mutex<()>,
    play_intent: AtomicU64,
    auto_worker_stop: Arc<AtomicBool>,
    auto_worker: Mutex<Option<thread::JoinHandle<()>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ActiveSource {
    generation: u64,
    intent: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingResume {
    generation: u64,
    intent: u64,
    position_ms: u64,
    resume_play: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AutoAdvanceRetry {
    generation: u64,
    attempts: u8,
    next_retry_at: Instant,
}

impl PlaybackSession {
    pub fn new(queue: Arc<QueueService>, playback: Arc<PlaybackController>) -> Self {
        Self::with_artwork_port(queue, playback, None)
    }

    pub fn with_default_quality(
        queue: Arc<QueueService>,
        playback: Arc<PlaybackController>,
        default_quality: PlaybackQuality,
    ) -> Self {
        let session = Self::new(queue, playback);
        session.set_default_quality(default_quality);
        session
    }

    pub(crate) fn with_artwork_port(
        queue: Arc<QueueService>,
        playback: Arc<PlaybackController>,
        artwork: Option<Arc<dyn SmtcArtworkPort>>,
    ) -> Self {
        Self::with_ports(queue, playback, artwork, None)
    }

    pub(crate) fn with_ports(
        queue: Arc<QueueService>,
        playback: Arc<PlaybackController>,
        artwork: Option<Arc<dyn SmtcArtworkPort>>,
        dynamic_lyrics: Option<Arc<dyn SmtcDynamicLyricsPort>>,
    ) -> Self {
        Self::with_ports_and_local_music(queue, playback, artwork, dynamic_lyrics, None)
    }

    pub(crate) fn with_ports_and_local_music(
        queue: Arc<QueueService>,
        playback: Arc<PlaybackController>,
        artwork: Option<Arc<dyn SmtcArtworkPort>>,
        dynamic_lyrics: Option<Arc<dyn SmtcDynamicLyricsPort>>,
        local_music: Option<Arc<LocalMusicService>>,
    ) -> Self {
        let (mode, volume) = queue
            .load_playback_preferences()
            .unwrap_or(("sequence".to_owned(), 0.8));
        let _ = playback.set_volume(volume);
        playback.set_mv_fallback_enabled(queue.mv_fallback_enabled().unwrap_or(true));
        Self {
            lyrics: None,
            listening_stats: Mutex::new(crate::listening_stats::ListeningStats::new()),
            mv_lyric_offset: Mutex::new(0),
            next_override: Mutex::new(None),
            smart_shuffle: Mutex::new(crate::smart_shuffle::SmartShuffle::new(
                queue.shuffle_path.clone(),
            )),
            shuffle_likes_epoch: AtomicU64::new(0),
            queue,
            playback,
            artwork,
            dynamic_lyrics,
            local_music,
            mode: RwLock::new(PlaybackMode::parse(&mode).unwrap_or(PlaybackMode::Sequence)),
            handled_ended_generation: Mutex::new(None),
            handled_failed_generation: Mutex::new(None),
            auto_advance_retry: Mutex::new(None),
            failed_tracks: Mutex::new(FailedTracks::default()),
            active_source: Mutex::new(None),
            pending_resume: Mutex::new(None),
            resume_transport: Mutex::new(None),
            default_quality: RwLock::new(PlaybackQuality::Kbps320),
            requested_quality: RwLock::new(None),
            operation: Mutex::new(()),
            play_intent: AtomicU64::new(0),
            auto_worker_stop: Arc::new(AtomicBool::new(false)),
            auto_worker: Mutex::new(None),
        }
    }

    pub fn snapshot(&self) -> PlaybackSessionSnapshot {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.snapshot_unlocked()
    }

    pub(crate) fn with_lyric_service(
        mut self,
        lyrics: Option<Arc<crate::lyrics::LyricService>>,
    ) -> Self {
        self.lyrics = lyrics;
        self
    }

    pub fn enqueue_next(&self, item: QueueTrack) -> Result<QueueSnapshot, PlaybackSessionError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let player = self.playback.snapshot();
        let current = player.current_track.as_ref().map(|track| track.id.as_str());
        let id = item.id.clone();
        let queue = self
            .queue
            .enqueue_next(item, current)
            .map_err(PlaybackSessionError::Queue)?;
        if current != Some(id.as_str()) {
            *self
                .next_override
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(id);
        }
        Ok(queue)
    }

    pub fn replace_queue(
        &self,
        items: Vec<QueueTrack>,
    ) -> Result<QueueSnapshot, PlaybackSessionError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let queue = self
            .queue
            .replace(items)
            .map_err(PlaybackSessionError::Queue)?;
        *self
            .next_override
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        let recovering = {
            let failed = self
                .failed_tracks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            failed.pending.is_some() || failed.resolving
        };
        if recovering {
            self.new_play_intent();
        }
        *self
            .failed_tracks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = FailedTracks::default();
        Ok(queue)
    }

    pub fn set_mv_lyric_offset(
        &self,
        id: &str,
        generation: u64,
        offset: i64,
    ) -> Result<PlaybackSessionSnapshot, PlaybackSessionError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let player = self.playback.snapshot();
        if player.generation != generation
            || !player.current_track.as_ref().is_some_and(|track| {
                track.id == id && track.source == Some(crate::player::TrackSource::QqMv)
            })
        {
            return Err(PlaybackSessionError::Superseded);
        }
        self.queue
            .save_mv_lyric_offset(id, offset)
            .map_err(PlaybackSessionError::Queue)?;
        *self
            .mv_lyric_offset
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = offset;
        if let Some(lyrics) = &self.lyrics {
            lyrics.set_mv_offset(id.to_owned(), generation, offset);
        }
        if let Some(lyrics) = &self.dynamic_lyrics {
            lyrics.request(id.to_owned(), generation);
        }
        Ok(self.snapshot_unlocked())
    }

    /// Read-only preview using the same rule as natural end-of-track advancement.
    pub fn preview_next_track(&self) -> Option<String> {
        let snapshot = self.snapshot();
        self.next_index(&snapshot, None)
            .and_then(|index| snapshot.queue.items.get(index))
            .map(|track| track.id.clone())
    }

    pub fn smart_shuffle_status(&self) -> crate::smart_shuffle::SmartShuffleStatus {
        self.smart_shuffle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .status()
    }

    pub fn shuffle_likes_epoch(&self) -> u64 {
        self.shuffle_likes_epoch.load(Ordering::Acquire)
    }

    pub fn set_smart_shuffle(
        &self,
        enabled: bool,
        likes: Option<std::collections::HashSet<String>>,
        epoch: u64,
    ) -> Result<crate::smart_shuffle::SmartShuffleStatus, PlaybackSessionError> {
        let history = if enabled {
            self.queue
                .last_history_plays()
                .map_err(PlaybackSessionError::Queue)?
        } else {
            Vec::new()
        };
        let mut smart = self
            .smart_shuffle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let likes = if epoch == self.shuffle_likes_epoch() {
            likes
        } else {
            None
        };
        smart
            .set_enabled(enabled, &history, likes)
            .map_err(|_| PlaybackSessionError::Queue(QueueError::PersistenceUnavailable))
    }

    pub fn clear_shuffle_likes(&self) {
        let mut smart = self
            .smart_shuffle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.shuffle_likes_epoch.fetch_add(1, Ordering::AcqRel);
        smart.replace_likes(None);
    }

    pub fn refresh_shuffle_likes(
        &self,
        likes: Option<std::collections::HashSet<String>>,
        epoch: u64,
    ) {
        let mut smart = self
            .smart_shuffle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if smart.status().enabled && epoch == self.shuffle_likes_epoch() {
            smart.replace_likes(likes);
        }
    }

    pub fn update_shuffle_likes(&self, ids: &[String], liked: bool, epoch: u64) {
        let mut smart = self
            .smart_shuffle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if epoch == self.shuffle_likes_epoch() {
            smart.update_likes(ids, liked);
        }
    }

    fn next_index(
        &self,
        snapshot: &PlaybackSessionSnapshot,
        direction: Option<i8>,
    ) -> Option<usize> {
        if direction != Some(-1) {
            if let Some(id) = self
                .next_override
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
            {
                if let Some(index) = snapshot
                    .queue
                    .items
                    .iter()
                    .position(|track| &track.id == id)
                {
                    return Some(index);
                }
            }
        }
        if snapshot.mode == PlaybackMode::Shuffle {
            let smart = self
                .smart_shuffle
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if smart.status().enabled {
                return smart.index(
                    &snapshot.queue.items,
                    current_index(snapshot).unwrap_or(0),
                    snapshot.player.generation,
                    snapshot.queue.generation,
                );
            }
        }
        direction.map_or_else(
            || automatic_index(snapshot),
            |direction| manual_skip_index(snapshot, direction),
        )
    }

    fn observe_shuffle_listening(&self) {
        // Serialize native position sampling with explicit seek rebasing.
        let mut stats = self
            .listening_stats
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut snapshot = self.playback.cached_snapshot();
        let now = Instant::now();
        let stats_sample = stats.needs_sample(&snapshot, now);
        let sample = self
            .smart_shuffle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .needs_position_sample(&snapshot, Instant::now());
        if sample || stats_sample {
            snapshot = self.playback.snapshot();
        }
        self.smart_shuffle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .observe(&snapshot, Instant::now());
        stats.observe(&snapshot, now, &self.queue.persistence);
    }

    pub fn personal_library(
        &self,
        request: crate::personal::PersonalRequest,
    ) -> Result<serde_json::Value, PlaybackSessionError> {
        use crate::personal::{PersonalRequest, StoredQueue};
        let db = &self.queue.persistence;
        let error = |_| PlaybackSessionError::Queue(QueueError::PersistenceUnavailable);
        match request {
            PersonalRequest::MemoryTapes { before } => {
                return db
                    .memory_tapes(before.as_deref(), crate::personal::now_ms())
                    .map_err(error);
            }
            PersonalRequest::MemoryTape { month, offset } => {
                let mut detail = db
                    .memory_tape(&month, offset, crate::personal::now_ms())
                    .map_err(error)?;
                if let Some(songs) = detail["songs"].as_array_mut() {
                    for song in songs {
                        song["availability"] = serde_json::json!(
                            self.memory_track_availability(song["id"].as_str().unwrap_or_default())
                        );
                    }
                }
                return Ok(detail);
            }
            PersonalRequest::MemoryTapeEnqueue { month, ids } => {
                let mut tracks = db.memory_tape_tracks(&month, &ids).map_err(error)?;
                let history = db.load_playback_history().map_err(error)?;
                let existing = self.queue.snapshot();
                let mut skipped = Vec::new();
                tracks.retain(|track| {
                    if self.memory_track_availability(&track.id) == "unavailable" {
                        skipped.push(track.id.clone());
                        false
                    } else {
                        true
                    }
                });
                for track in &mut tracks {
                    if let Some(current) = existing.items.iter().find(|t| t.id == track.id) {
                        *track = current.clone();
                    } else if let Some(old) = history.iter().find(|t| t.id == track.id) {
                        track.album = old.album.clone();
                        track.duration_ms = old.duration_ms;
                        track.media_mid = old.media_mid.clone();
                        track.cover_cache_key = old.cover_cache_key.clone();
                    }
                }
                let accepted = tracks.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
                // QueueService provides deduplication, capacity checks and atomic
                // persistence. No playback request or history write occurs here.
                let queue = if tracks.is_empty() {
                    self.queue.snapshot()
                } else {
                    self.queue
                        .enqueue_many(tracks)
                        .map_err(PlaybackSessionError::Queue)?
                };
                return Ok(
                    serde_json::json!({"queue":queue,"acceptedIds":accepted,"skippedIds":skipped}),
                );
            }
            PersonalRequest::ListeningAnalytics {
                start_date,
                end_date,
            } => {
                let storage_available = self
                    .listening_stats
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .storage_available;
                let likes = self
                    .smart_shuffle
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .analytics_likes();
                return db
                    .listening_analytics(&start_date, &end_date, likes.as_ref(), storage_available)
                    .map_err(error);
            }
            PersonalRequest::Statistics { since_ms } => {
                let mut stats = self
                    .listening_stats
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                stats.flush(db);
                let mut report = db.listening_report_since(since_ms).map_err(error)?;
                report["storageAvailable"] = serde_json::json!(stats.storage_available);
                drop(stats);
                let snapshot = self.snapshot();
                let mut last_plays: std::collections::HashMap<String, u64> = self
                    .queue
                    .last_history_plays()
                    .map_err(PlaybackSessionError::Queue)?
                    .into_iter()
                    .collect();
                if let Some(rows) = report["items"].as_array() {
                    for row in rows {
                        if let (Some(id), Some(time)) =
                            (row["id"].as_str(), row["lastPlayedMs"].as_u64())
                        {
                            last_plays
                                .entry(id.to_owned())
                                .and_modify(|last| *last = (*last).max(time))
                                .or_insert(time);
                        }
                    }
                }
                report["forgotten"]=serde_json::json!(snapshot.queue.items.iter().filter_map(|track| last_plays.get(&track.id).map(|time| serde_json::json!({"id":track.id,"title":track.title,"artist":track.artist,"lastPlayedMs":time}))).collect::<Vec<_>>());
                let smart = self
                    .smart_shuffle
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                report["shuffle"] = smart.explanation(
                    &snapshot.queue.items,
                    current_index(&snapshot),
                    snapshot.mode == PlaybackMode::Shuffle,
                );
                report["nextOverride"] = serde_json::json!(*self
                    .next_override
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner));
                return Ok(report);
            }
            PersonalRequest::PreviewQueue { name } => {
                return db
                    .load_named_queue(name.as_deref())
                    .map(|q| serde_json::json!(q))
                    .map_err(error)
            }
            PersonalRequest::RenameQueue { name, target } => {
                db.rename_named_queue(&name, target.trim()).map_err(error)?
            }
            PersonalRequest::UndoDeleteQueue => db.undo_delete_queue().map_err(error)?,
            PersonalRequest::PinBookmark { kind, id, pinned } => {
                db.pin_bookmark(&kind, &id, pinned).map_err(error)?
            }
            PersonalRequest::LoadQueue { name } => return self.switch_personal_queue(Some(&name)),
            PersonalRequest::RestoreQueue => return self.switch_personal_queue(None),
            PersonalRequest::SaveQueue { name } => {
                let queue = self.queue.snapshot();
                db.save_named_queue(
                    name.trim(),
                    &StoredQueue {
                        saved_at_ms: crate::personal::now_ms(),
                        items: queue.items,
                        selected_index: queue.selected_index,
                    },
                )
                .map_err(error)?;
            }
            PersonalRequest::DeleteQueue { name } => db.delete_named_queue(&name).map_err(error)?,
            PersonalRequest::Bookmark {
                kind,
                id,
                title,
                saved,
                cover_cache_key,
            } => db
                .bookmark_with_cover(&kind, &id, &title, saved, cover_cache_key.as_deref())
                .map_err(error)?,
            PersonalRequest::Collections => {}
        }
        db.personal_collections().map_err(error)
    }

    fn memory_track_availability(&self, id: &str) -> &'static str {
        if id.starts_with("local_") {
            if self
                .local_music
                .as_ref()
                .is_some_and(|local| local.resolve_media_file(id).is_ok())
            {
                "local"
            } else {
                "unavailable"
            }
        } else if !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            "online"
        } else {
            "unavailable"
        }
    }

    fn switch_personal_queue(
        &self,
        name: Option<&str>,
    ) -> Result<serde_json::Value, PlaybackSessionError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let saved = self
            .queue
            .persistence
            .load_named_queue(name)
            .map_err(|_| PlaybackSessionError::Queue(QueueError::PersistenceUnavailable))?;
        self.queue
            .replace_selected(saved.items, saved.selected_index)
            .map_err(PlaybackSessionError::Queue)?;
        self.new_play_intent();
        self.stop_locked()?;
        *self
            .next_override
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        self.observe_shuffle_listening();
        Ok(serde_json::json!(self.snapshot_unlocked()))
    }

    fn snapshot_unlocked(&self) -> PlaybackSessionSnapshot {
        let player = self.player_snapshot_with_pending_seek();
        PlaybackSessionSnapshot {
            skip_notice: self.skip_notice(),
            lyric_offset_ms: *self
                .mv_lyric_offset
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            actual_quality: self.playback.actual_quality(player.generation),
            mode: *self
                .mode
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            queue: self.queue.snapshot(),
            player,
            requested_quality: self
                .requested_quality()
                .map(|quality| quality_wire(quality).to_owned())
                .unwrap_or_else(|| quality_wire(self.default_quality()).to_owned()),
        }
    }

    pub fn snapshot_update(&self, known_queue_generation: Option<u64>) -> PlaybackSessionUpdate {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let player = self.player_snapshot_with_pending_seek();
        PlaybackSessionUpdate {
            skip_notice: self.skip_notice(),
            lyric_offset_ms: *self
                .mv_lyric_offset
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            actual_quality: self.playback.actual_quality(player.generation),
            mode: *self
                .mode
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            queue: self.queue.snapshot_if_changed(known_queue_generation),
            player,
            requested_quality: self
                .requested_quality()
                .map(|quality| quality_wire(quality).to_owned())
                .unwrap_or_else(|| quality_wire(self.default_quality()).to_owned()),
        }
    }

    pub fn default_quality(&self) -> PlaybackQuality {
        *self
            .default_quality
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn set_default_quality(&self, quality: PlaybackQuality) {
        *self
            .default_quality
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = normalize_quality(quality);
    }

    pub fn requested_quality(&self) -> Option<PlaybackQuality> {
        *self
            .requested_quality
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn set_mode(
        &self,
        mode: PlaybackMode,
    ) -> Result<PlaybackSessionSnapshot, PlaybackSessionError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.queue
            .save_playback_mode(match mode {
                PlaybackMode::Sequence => "sequence",
                PlaybackMode::RepeatAll => "repeat-all",
                PlaybackMode::RepeatOne => "repeat-one",
                PlaybackMode::Shuffle => "shuffle",
            })
            .map_err(PlaybackSessionError::Queue)?;
        *self
            .mode
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = mode;
        Ok(self.snapshot_unlocked())
    }

    pub fn play_index(
        &self,
        index: usize,
        quality: PlaybackQuality,
    ) -> Result<SessionPlayResult, PlaybackSessionError> {
        let (intent, track) = {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let track = self
                .queue
                .select(index)
                .map_err(PlaybackSessionError::Queue)?;
            (self.new_play_intent(), track)
        };
        self.play_selected(intent, track, quality)
    }

    pub fn next(&self) -> Result<Option<SessionPlayResult>, PlaybackSessionError> {
        let prepared = {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let snapshot = self.snapshot_unlocked();
            let Some(index) = self.next_index(&snapshot, Some(1)) else {
                return Ok(None);
            };
            let track = self
                .queue
                .select(index)
                .map_err(PlaybackSessionError::Queue)?;
            (self.new_play_intent(), track)
        };
        self.play_selected(prepared.0, prepared.1, PlaybackQuality::Auto)
            .map(Some)
    }

    pub(crate) fn play_remote_track(
        &self,
        id: &str,
        generation: u64,
    ) -> Result<SessionPlayResult, PlaybackSessionError> {
        let (intent, track) = {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let track = self
                .queue
                .select_remote(id, generation)
                .map_err(PlaybackSessionError::Queue)?
                .ok_or(PlaybackSessionError::Superseded)?;
            (self.new_play_intent(), track)
        };
        self.play_selected(intent, track, PlaybackQuality::Auto)
    }

    pub fn previous(&self) -> Result<Option<SessionPlayResult>, PlaybackSessionError> {
        let prepared = {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let snapshot = self.snapshot_unlocked();
            if snapshot.player.position_ms > 5_000 && snapshot.player.current_track.is_some() {
                self.playback
                    .seek(0)
                    .map_err(PlaybackSessionError::Playback)?;
                return Ok(None);
            }
            let Some(index) = self.next_index(&snapshot, Some(-1)) else {
                return Ok(None);
            };
            let track = self
                .queue
                .select(index)
                .map_err(PlaybackSessionError::Queue)?;
            (self.new_play_intent(), track)
        };
        self.play_selected(prepared.0, prepared.1, PlaybackQuality::Auto)
            .map(Some)
    }

    /// Reloads the current track using a one-shot quality override. The
    /// persisted/default quality is deliberately left untouched.
    pub fn change_quality(
        &self,
        quality: PlaybackQuality,
    ) -> Result<SessionPlayResult, PlaybackSessionError> {
        let (intent, track, position_ms, resume_play) = {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let snapshot = self.snapshot_unlocked();
            let Some(current_track) = snapshot.player.current_track.as_ref() else {
                return Err(PlaybackSessionError::Playback(
                    PlaybackError::InvalidRequest,
                ));
            };
            let Some(track) = snapshot
                .queue
                .items
                .iter()
                .find(|track| track.id == current_track.id)
                .cloned()
            else {
                return Err(PlaybackSessionError::Playback(
                    PlaybackError::InvalidRequest,
                ));
            };
            // Loading alone does not imply autoplay when a previous reload began paused.
            let resume_play = self
                .resume_transport
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .map(|(_, playing)| playing)
                .unwrap_or(matches!(
                    snapshot.player.state,
                    PlayerState::Playing | PlayerState::Loading
                ));
            let position_ms = self
                .pending_resume
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .filter(|pending| pending.generation == snapshot.player.generation)
                .map_or(snapshot.player.position_ms, |pending| pending.position_ms);
            let intent = self.new_play_intent();
            *self
                .resume_transport
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((intent, resume_play));
            (intent, track, position_ms, resume_play)
        };
        self.play_selected_with_resume(
            intent,
            track,
            quality,
            Some(position_ms),
            false,
            resume_play,
        )
    }

    pub fn advance_if_ended(&self) -> Result<Option<SessionPlayResult>, PlaybackSessionError> {
        let recovering = {
            let failed = self
                .failed_tracks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            failed.pending.is_some() || failed.resolving
        };
        if recovering {
            return Ok(None);
        }
        if self.playback.cached_snapshot().state != PlayerState::Ended {
            return Ok(None);
        }
        let (intent, track, ended_generation, attempt) = {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let snapshot = self.snapshot_unlocked();
            if snapshot.player.state != PlayerState::Ended {
                return Ok(None);
            }
            let generation = snapshot.player.generation;
            let handled = self
                .handled_ended_generation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if *handled == Some(generation) {
                return Ok(None);
            }
            let retry_guard = self
                .auto_advance_retry
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let now = Instant::now();
            let attempt = match *retry_guard {
                Some(retry) if retry.generation == generation => {
                    if now < retry.next_retry_at {
                        return Ok(None);
                    }
                    retry.attempts
                }
                _ => 1,
            };
            let Some(index) = self.next_index(&snapshot, None) else {
                drop(handled);
                drop(retry_guard);
                let mut handled = self
                    .handled_ended_generation
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                *handled = Some(generation);
                return Ok(None);
            };
            let track = self
                .queue
                .select(index)
                .map_err(PlaybackSessionError::Queue)?;
            drop(handled);
            drop(retry_guard);
            (self.new_play_intent(), track, generation, attempt)
        };

        match self.play_selected(intent, track, PlaybackQuality::Auto) {
            Ok(result) => {
                let mut handled = self
                    .handled_ended_generation
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                *handled = Some(ended_generation);
                let mut retry_guard = self
                    .auto_advance_retry
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                *retry_guard = None;
                Ok(Some(result))
            }
            Err(error) => {
                if self.skip_notice().is_some() {
                    *self
                        .handled_ended_generation
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                        Some(ended_generation);
                    return Err(error);
                }
                let is_transient = playback_session_error_is_transient(&error);
                if is_transient && attempt < 3 {
                    let delay = if attempt == 1 {
                        Duration::from_millis(750)
                    } else {
                        Duration::from_millis(1500)
                    };
                    let mut retry_guard = self
                        .auto_advance_retry
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    *retry_guard = Some(AutoAdvanceRetry {
                        generation: ended_generation,
                        attempts: attempt + 1,
                        next_retry_at: Instant::now() + delay,
                    });
                    eprintln!("playback_auto_advance_retry");
                    crate::file_logging::event("playback_auto_advance_retry");
                } else {
                    let mut handled = self
                        .handled_ended_generation
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    *handled = Some(ended_generation);
                    let mut retry_guard = self
                        .auto_advance_retry
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    *retry_guard = None;
                    if is_transient && attempt >= 3 {
                        eprintln!("playback_auto_advance_exhausted");
                        crate::file_logging::event("playback_auto_advance_exhausted");
                    }
                }
                Err(error)
            }
        }
    }

    pub fn start_auto_advance_worker(session: &Arc<Self>) {
        let mut worker = session
            .auto_worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if worker.is_some() {
            return;
        }
        let weak = Arc::downgrade(session);
        let stop = Arc::clone(&session.auto_worker_stop);
        *worker = thread::Builder::new()
            .name("qqmusic-auto-advance".to_owned())
            .spawn(move || auto_advance_loop(weak, stop))
            .ok();
    }

    pub fn play(&self) -> Result<PlayerSnapshot, PlaybackSessionError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.play_unlocked()
    }

    pub(crate) fn toggle_playback(&self) -> Result<PlayerSnapshot, PlaybackSessionError> {
        let (intent, track) = {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let snapshot = self.snapshot_unlocked();
            if matches!(
                snapshot.player.state,
                crate::player::PlayerState::Playing | crate::player::PlayerState::Loading
            ) {
                return self.pause_unlocked();
            }
            if snapshot.player.current_track.is_some()
                && !matches!(
                    snapshot.player.state,
                    crate::player::PlayerState::Idle | crate::player::PlayerState::Failed
                )
            {
                return self.play_unlocked();
            }
            if snapshot.queue.items.is_empty() {
                return Ok(snapshot.player);
            }
            let index = snapshot.queue.selected_index.unwrap_or(0);
            let track = self
                .queue
                .select(index)
                .map_err(PlaybackSessionError::Queue)?;
            (self.new_play_intent(), track)
        };
        self.play_selected(intent, track, PlaybackQuality::Auto)?;
        Ok(self.snapshot().player)
    }

    fn play_unlocked(&self) -> Result<PlayerSnapshot, PlaybackSessionError> {
        let snapshot = self
            .playback
            .play()
            .map_err(PlaybackSessionError::Playback)?;
        self.reset_ended_generation(snapshot.generation);
        self.update_resume_transport(true);
        Ok(snapshot)
    }

    pub fn pause(&self) -> Result<PlayerSnapshot, PlaybackSessionError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.pause_unlocked()
    }

    fn pause_unlocked(&self) -> Result<PlayerSnapshot, PlaybackSessionError> {
        let cancel_skip = {
            let failed = self
                .failed_tracks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            failed.pending.is_some() || failed.resolving
        };
        if cancel_skip {
            self.new_play_intent();
        }
        let snapshot = self
            .playback
            .pause()
            .map_err(PlaybackSessionError::Playback)?;
        self.update_resume_transport(false);
        Ok(snapshot)
    }

    fn update_resume_transport(&self, playing: bool) {
        if let Some((_, value)) = self
            .resume_transport
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
        {
            *value = playing;
        }
        if let Some(pending) = self
            .pending_resume
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
        {
            pending.resume_play = playing;
        }
    }

    pub fn stop(&self) -> Result<PlayerSnapshot, PlaybackSessionError> {
        self.new_play_intent();
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.stop_locked()
    }

    fn stop_locked(&self) -> Result<PlayerSnapshot, PlaybackSessionError> {
        *self
            .active_source
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        *self
            .pending_resume
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        *self
            .requested_quality
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        if let Some(artwork) = &self.artwork {
            artwork.clear();
        }
        if let Some(dynamic_lyrics) = &self.dynamic_lyrics {
            dynamic_lyrics.clear();
        }
        self.playback.stop().map_err(PlaybackSessionError::Playback)
    }

    /// Deletes one managed local track and coordinates its queue/session state.
    /// The operation lock spans stop, tombstone preparation, queue persistence,
    /// rollback/commit, and any adjusted auto-play attempt.
    pub fn delete_local_track(
        &self,
        track_id: &str,
    ) -> Result<LocalMusicDeleteResult, PlaybackSessionError> {
        LocalTrackId::parse(track_id).map_err(PlaybackSessionError::LocalMusic)?;
        let local_music =
            self.local_music
                .as_ref()
                .cloned()
                .ok_or(PlaybackSessionError::LocalMusic(
                    LocalMusicError::StorageUnavailable,
                ))?;
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before = self.snapshot_unlocked();
        let queue_index = before
            .queue
            .items
            .iter()
            .position(|track| track.id == track_id);
        let current = before
            .player
            .current_track
            .as_ref()
            .is_some_and(|track| track.id == track_id);

        if current {
            self.new_play_intent();
            self.stop_locked()
                .map_err(|_| PlaybackSessionError::LocalMusic(LocalMusicError::DeleteFailed))?;
        }
        let deletion = local_music
            .prepare_delete(track_id)
            .map_err(PlaybackSessionError::LocalMusic)?;
        let queue_after = if let Some(index) = queue_index {
            match self.queue.remove(index) {
                Ok(snapshot) => snapshot,
                Err(_error) => {
                    return match deletion.rollback() {
                        Ok(()) => Err(PlaybackSessionError::LocalMusic(
                            LocalMusicError::DeleteFailed,
                        )),
                        Err(rollback_error) => {
                            Err(PlaybackSessionError::LocalMusic(rollback_error))
                        }
                    };
                }
            }
        } else {
            before.queue.clone()
        };
        deletion
            .commit()
            .map_err(PlaybackSessionError::LocalMusic)?;

        let mut auto_play_started = false;
        if current {
            if let Some(index) = queue_after.selected_index {
                if let Some(track) = queue_after.items.get(index).cloned() {
                    let intent = self.new_play_intent();
                    auto_play_started = self
                        .play_selected_with_resume_locked(
                            intent,
                            track,
                            PlaybackQuality::Auto,
                            None,
                            true,
                            true,
                        )
                        .is_ok();
                }
            }
        }
        Ok(LocalMusicDeleteResult {
            deleted_id: track_id.to_owned(),
            session: self.snapshot_unlocked(),
            auto_play_started,
        })
    }

    pub fn seek(&self, position_ms: u64) -> Result<PlayerSnapshot, PlaybackSessionError> {
        self.seek_internal(position_ms, None)
    }

    fn player_snapshot_with_pending_seek(&self) -> PlayerSnapshot {
        let mut player = self.playback.snapshot();
        if let Some(pending) = *self
            .pending_resume
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            if pending.generation == player.generation
                && pending.intent == self.play_intent.load(Ordering::SeqCst)
                && player.failure.is_none()
            {
                player.position_ms = pending.position_ms;
            }
        }
        player
    }

    fn seek_internal(
        &self,
        position_ms: u64,
        generation: Option<u64>,
    ) -> Result<PlayerSnapshot, PlaybackSessionError> {
        SeekPositionMs::new(position_ms)
            .map_err(|_| PlaybackSessionError::Playback(PlaybackError::InvalidRequest))?;
        let (intent, track, position_ms) = {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let snapshot = self.playback.snapshot();
            if generation.is_some_and(|value| value != snapshot.generation) {
                return Err(PlaybackSessionError::Superseded);
            }
            if snapshot.current_track.is_some() {
                let position_ms = snapshot
                    .duration_ms
                    .map_or(position_ms, |duration| position_ms.min(duration));
                let active = *self
                    .active_source
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut pending = self
                    .pending_resume
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(active) = active.filter(|active| {
                    active.generation == snapshot.generation
                        && active.intent == self.play_intent.load(Ordering::SeqCst)
                }) {
                    if snapshot.state == PlayerState::Loading
                        || pending.as_ref().is_some_and(|value| {
                            value.generation == active.generation && value.intent == active.intent
                        })
                    {
                        let resume_play = pending.as_ref().is_none_or(|value| value.resume_play);
                        *pending = Some(PendingResume {
                            generation: active.generation,
                            intent: active.intent,
                            position_ms,
                            resume_play,
                        });
                        return Ok(PlayerSnapshot {
                            position_ms,
                            ..snapshot
                        });
                    }
                }
                drop(pending);
                let mut stats = self
                    .listening_stats
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let result = self
                    .playback
                    .seek(position_ms)
                    .map_err(PlaybackSessionError::Playback)?;
                stats.reposition(&result, Instant::now());
                return Ok(result);
            }
            // A restored queue has metadata, but no native media source yet.
            // Resolve outside the operation lock and defer seeking until MediaOpened.
            let queue = self.queue.snapshot();
            let track = queue
                .selected_index
                .and_then(|index| queue.items.get(index))
                .cloned()
                .ok_or(PlaybackSessionError::Playback(
                    PlaybackError::InvalidRequest,
                ))?;
            let position_ms = if track.duration_ms > 0 {
                position_ms.min(track.duration_ms)
            } else {
                position_ms
            };
            (self.new_play_intent(), track, position_ms)
        };
        self.play_selected_with_resume(
            intent,
            track,
            PlaybackQuality::Auto,
            Some(position_ms),
            true,
            true,
        )?;
        Ok(self.snapshot().player)
    }

    pub fn set_volume(&self, volume: f32) -> Result<PlayerSnapshot, PlaybackSessionError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.set_volume_unlocked(volume)
    }

    /// Read and change volume under the same lock so rapid shortcuts retain every step.
    pub(crate) fn adjust_volume(&self, delta: f32) -> Result<PlayerSnapshot, PlaybackSessionError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let volume = (self.playback.snapshot().volume + delta).clamp(0.0, 1.0);
        self.set_volume_unlocked(volume)
    }

    fn set_volume_unlocked(&self, volume: f32) -> Result<PlayerSnapshot, PlaybackSessionError> {
        let snapshot = self
            .playback
            .set_volume(volume)
            .map_err(PlaybackSessionError::Playback)?;
        self.queue
            .save_playback_volume(snapshot.volume)
            .map_err(PlaybackSessionError::Queue)?;
        Ok(snapshot)
    }

    pub(crate) fn seek_generation(
        &self,
        position_ms: u64,
        generation: u64,
    ) -> Result<PlayerSnapshot, PlaybackSessionError> {
        self.seek_internal(position_ms, Some(generation))
    }

    pub fn set_muted(&self, muted: bool) -> Result<PlayerSnapshot, PlaybackSessionError> {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.playback
            .set_muted(muted)
            .map_err(PlaybackSessionError::Playback)
    }

    pub fn reset_ended_generation(&self, generation: u64) {
        let mut handled = self
            .handled_ended_generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *handled == Some(generation) {
            *handled = None;
        }
    }

    fn play_selected(
        &self,
        intent: u64,
        track: QueueTrack,
        quality: PlaybackQuality,
    ) -> Result<SessionPlayResult, PlaybackSessionError> {
        self.play_selected_with_resume(intent, track, quality, None, true, true)
    }

    fn play_selected_with_resume(
        &self,
        intent: u64,
        track: QueueTrack,
        quality: PlaybackQuality,
        resume_ms: Option<u64>,
        append_history: bool,
        resume_play: bool,
    ) -> Result<SessionPlayResult, PlaybackSessionError> {
        let result = self.play_selected_with_resume_internal(
            intent,
            track.clone(),
            quality,
            resume_ms,
            append_history,
            resume_play,
            false,
        );
        if result.as_ref().is_err_and(song_cannot_play) {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.schedule_failed_track(intent, &track);
        }
        result
    }

    fn play_selected_with_resume_locked(
        &self,
        intent: u64,
        track: QueueTrack,
        quality: PlaybackQuality,
        resume_ms: Option<u64>,
        append_history: bool,
        resume_play: bool,
    ) -> Result<SessionPlayResult, PlaybackSessionError> {
        let result = self.play_selected_with_resume_internal(
            intent,
            track.clone(),
            quality,
            resume_ms,
            append_history,
            resume_play,
            true,
        );
        if result.as_ref().is_err_and(song_cannot_play) {
            self.schedule_failed_track(intent, &track);
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn play_selected_with_resume_internal(
        &self,
        intent: u64,
        track: QueueTrack,
        quality: PlaybackQuality,
        resume_ms: Option<u64>,
        append_history: bool,
        resume_play: bool,
        operation_already_held: bool,
    ) -> Result<SessionPlayResult, PlaybackSessionError> {
        let requested_quality = self.resolve_quality(quality);
        let summary = TrackSummary {
            source: None,
            id: track.id.clone(),
            title: track.title.clone(),
            artist: track.artist.clone(),
        };
        let local_file = if track.id.starts_with("local_") {
            LocalTrackId::parse(&track.id).map_err(map_local_music_error)?;
            let local_music = self
                .local_music
                .as_ref()
                .ok_or(PlaybackSessionError::Playback(
                    PlaybackError::LocalFileMissing,
                ))?;
            let path = local_music
                .resolve_media_file(&track.id)
                .map_err(map_local_music_error)?;
            Some(
                LocalMediaFile::new(path)
                    .map_err(|_| PlaybackSessionError::Playback(PlaybackError::LocalFileMissing))?,
            )
        } else {
            None
        };
        let resolved = if local_file.is_none() {
            Some(
                self.playback
                    .resolve(summary.clone(), requested_quality)
                    .map_err(PlaybackSessionError::Playback)?
                    .with_smtc_metadata(track.album.clone(), track.duration_ms),
            )
        } else {
            None
        };
        let playback = if operation_already_held {
            self.submit_playback(
                intent,
                track.clone(),
                summary.clone(),
                local_file,
                resolved,
                resume_ms,
                resume_play,
                requested_quality,
            )?
        } else {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.submit_playback(
                intent,
                track.clone(),
                summary.clone(),
                local_file,
                resolved,
                resume_ms,
                resume_play,
                requested_quality,
            )?
        };
        // Playback has already started. History persistence is deliberately best-effort.
        if append_history {
            let _ = self.queue.append_history(&track);
        }
        Ok(SessionPlayResult {
            queue: self.queue.snapshot(),
            playback,
            requested_quality: quality_wire(requested_quality).to_owned(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn submit_playback(
        &self,
        intent: u64,
        track: QueueTrack,
        summary: TrackSummary,
        local_file: Option<LocalMediaFile>,
        resolved: Option<crate::playback::ResolvedPlayback>,
        resume_ms: Option<u64>,
        resume_play: bool,
        requested_quality: PlaybackQuality,
    ) -> Result<PlaybackLoadResult, PlaybackSessionError> {
        if self.play_intent.load(Ordering::SeqCst) != intent {
            return Err(PlaybackSessionError::Superseded);
        }
        let resume_play = self
            .resume_transport
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .filter(|(current, _)| *current == intent)
            .map(|(_, play)| play)
            .unwrap_or(resume_play);
        let playback = match (local_file, resolved) {
            (Some(file), None) => self.playback.load_local_with_transport(
                file,
                summary,
                track.album.clone(),
                track.duration_ms,
                resume_ms.is_none() && resume_play,
            ),
            (None, Some(resolved)) => self
                .playback
                .load_with_transport(resolved, resume_ms.is_none() && resume_play),
            _ => Err(PlaybackError::InvalidRequest),
        }
        .map_err(PlaybackSessionError::Playback)?;
        *self
            .requested_quality
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            (!track.id.starts_with("local_")).then_some(requested_quality);
        *self
            .active_source
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ActiveSource {
            generation: playback.player.generation,
            intent,
        });
        *self
            .pending_resume
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            resume_ms.map(|position_ms| PendingResume {
                generation: playback.player.generation,
                intent,
                position_ms,
                resume_play,
            });
        let is_local = track.id.starts_with("local_");
        let offset = if playback.quality == "qq-mv" {
            self.queue.mv_lyric_offset(&track.id).unwrap_or(0)
        } else {
            0
        };
        *self
            .mv_lyric_offset
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = offset;
        if let Some(lyrics) = &self.lyrics {
            lyrics.set_mv_offset(track.id.clone(), playback.player.generation, offset);
        }
        let mut next_override = self
            .next_override
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if next_override.as_deref() == Some(track.id.as_str()) {
            *next_override = None;
        }
        drop(next_override);
        if let Some(artwork) = &self.artwork {
            if is_local {
                artwork.clear();
            } else {
                artwork.request(playback.player.generation, track.cover_cache_key.clone());
            }
        }
        if let Some(dynamic_lyrics) = &self.dynamic_lyrics {
            if is_local {
                dynamic_lyrics.clear();
            } else {
                dynamic_lyrics.request(track.id.clone(), playback.player.generation);
            }
        }
        Ok(playback)
    }

    fn resolve_quality(&self, quality: PlaybackQuality) -> PlaybackQuality {
        match quality {
            PlaybackQuality::Auto => self.default_quality(),
            quality => quality,
        }
    }

    fn skip_notice(&self) -> Option<PlaybackSkipNotice> {
        self.failed_tracks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .notice
            .as_ref()
            .filter(|(_, until)| Instant::now() < *until)
            .map(|(notice, _)| notice.clone())
    }

    // Called with operation held. The failed recording may differ from the
    // still-loaded native source, so advancement starts at its queue ID.
    fn schedule_failed_track(&self, intent: u64, track: &QueueTrack) {
        if self.play_intent.load(Ordering::SeqCst) != intent {
            return;
        }
        let queue = self.queue.snapshot();
        if !queue.items.iter().any(|item| item.id == track.id) {
            return;
        }
        let mut next_override = self
            .next_override
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if next_override.as_deref() == Some(track.id.as_str()) {
            *next_override = None;
        }
        drop(next_override);
        let _ = self.stop_locked();
        let mode = *self
            .mode
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut failed = self
            .failed_tracks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.play_intent.load(Ordering::SeqCst) != intent {
            return;
        }
        failed.ids.insert(track.id.clone());
        let exhausted = failed_track_next_index(&queue, mode, &track.id, &failed.ids).is_none();
        failed.notice = Some((
            PlaybackSkipNotice {
                title: track.title.clone(),
                exhausted,
            },
            Instant::now() + Duration::from_secs(7),
        ));
        failed.pending = (!exhausted).then(|| {
            (
                intent,
                track.id.clone(),
                Instant::now() + FAILED_TRACK_SKIP_DELAY,
            )
        });
    }

    fn advance_after_failure(&self) {
        let prepared = {
            let _operation = self
                .operation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut failed = self
                .failed_tracks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some((intent, id, due)) = failed.pending.as_ref() else {
                return;
            };
            if Instant::now() < *due {
                return;
            }
            let (intent, id) = (*intent, id.clone());
            failed.pending = None;
            if self.play_intent.load(Ordering::SeqCst) != intent {
                return;
            }
            let queue = self.queue.snapshot();
            let mode = *self
                .mode
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some(index) = failed_track_next_index(&queue, mode, &id, &failed.ids) else {
                if let Some((notice, until)) = &mut failed.notice {
                    notice.exhausted = true;
                    *until = Instant::now() + Duration::from_secs(7);
                }
                return;
            };
            let Ok(track) = self.queue.select(index) else {
                return;
            };
            failed.resolving = true;
            (intent, track)
        };
        // Keep this intent across the chain. Manual playback/stop supersedes it;
        // successfully loading a file does not reset the visited recordings.
        let result = self.play_selected(prepared.0, prepared.1.clone(), PlaybackQuality::Auto);
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.play_intent.load(Ordering::SeqCst) == prepared.0 {
            let mut failed = self
                .failed_tracks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            failed.resolving = false;
            if result.as_ref().is_err_and(|error| {
                !song_cannot_play(error) && *error != PlaybackSessionError::Superseded
            }) {
                failed.notice = Some((
                    PlaybackSkipNotice {
                        title: prepared.1.title,
                        exhausted: true,
                    },
                    Instant::now() + Duration::from_secs(7),
                ));
            }
        }
    }

    fn new_play_intent(&self) -> u64 {
        let intent = self
            .play_intent
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        *self
            .failed_tracks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = FailedTracks::default();
        *self
            .resume_transport
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        let mut retry = self
            .auto_advance_retry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *retry = None;
        intent
    }
}

fn is_zero_offset(offset: &i64) -> bool {
    *offset == 0
}

fn map_local_music_error(error: LocalMusicError) -> PlaybackSessionError {
    let playback = match error {
        LocalMusicError::CodecUnavailable => PlaybackError::LocalCodecUnavailable,
        LocalMusicError::StorageUnavailable
        | LocalMusicError::InvalidTrackId
        | LocalMusicError::InvalidFile
        | LocalMusicError::UnsupportedFormat
        | LocalMusicError::FileTooLarge
        | LocalMusicError::MetadataUnreadable
        | LocalMusicError::CopyFailed
        | LocalMusicError::StorageConflict
        | LocalMusicError::FileMissing
        | LocalMusicError::DeleteFailed
        | LocalMusicError::OutcomeUnknown => PlaybackError::LocalFileMissing,
    };
    PlaybackSessionError::Playback(playback)
}

fn auto_advance_loop(session: Weak<PlaybackSession>, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Acquire) {
        thread::sleep(AUTO_ADVANCE_POLL_INTERVAL);
        if stop.load(Ordering::Acquire) {
            return;
        }
        let Some(session) = session.upgrade() else {
            return;
        };
        session.handle_native_events();
        session.advance_after_failure();
        session.observe_shuffle_listening();
        let _ = session.advance_if_ended();
    }
}

impl Drop for PlaybackSession {
    fn drop(&mut self) {
        self.listening_stats
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .flush(&self.queue.persistence);
        self.auto_worker_stop.store(true, Ordering::Release);
        let worker = self
            .auto_worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(worker) = worker {
            if worker.thread().id() != thread::current().id() {
                let _ = worker.join();
            }
        }
    }
}

impl PlaybackSession {
    fn handle_native_events(&self) {
        while let Some(event) = self.playback.try_native_event() {
            match event {
                NativePlayerEvent::TransportPlay => {
                    let _ = self.play();
                }
                NativePlayerEvent::TransportPause => {
                    let _ = self.pause();
                }
                NativePlayerEvent::TransportStop => {
                    let _ = self.stop();
                }
                NativePlayerEvent::TransportNext => {
                    let _ = self.next();
                }
                NativePlayerEvent::TransportPrevious => {
                    let _ = self.previous();
                }
                NativePlayerEvent::Failed {
                    generation,
                    failure,
                } if failure.code == PlayerFailureCode::Network => {
                    let snapshot = self.playback.snapshot();
                    if snapshot.generation != generation {
                        continue;
                    }
                    let mut handled = self
                        .handled_failed_generation
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if *handled == Some(generation) {
                        continue;
                    }
                    *handled = Some(generation);
                    drop(handled);
                    let Some(failed_track_id) = snapshot
                        .current_track
                        .as_ref()
                        .map(|track| track.id.as_str())
                    else {
                        continue;
                    };
                    let Some(active) = *self
                        .active_source
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                    else {
                        continue;
                    };
                    if active.generation != generation
                        || self.play_intent.load(Ordering::SeqCst) != active.intent
                    {
                        continue;
                    }
                    let queue = self.queue.snapshot();
                    let Some(track) = queue
                        .items
                        .into_iter()
                        .find(|track| track.id == failed_track_id)
                    else {
                        continue;
                    };
                    let _ = self.play_selected_with_resume(
                        active.intent,
                        track,
                        PlaybackQuality::Auto,
                        Some(snapshot.position_ms),
                        false,
                        true,
                    );
                }
                NativePlayerEvent::Failed {
                    generation,
                    failure,
                } if matches!(
                    failure.code,
                    PlayerFailureCode::Decoding
                        | PlayerFailureCode::Unsupported
                        | PlayerFailureCode::Unavailable
                ) =>
                {
                    let _operation = self
                        .operation
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let snapshot = self.playback.snapshot();
                    let active = *self
                        .active_source
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if snapshot.generation != generation {
                        continue;
                    }
                    let Some(active) = active.filter(|active| {
                        active.generation == generation
                            && active.intent == self.play_intent.load(Ordering::SeqCst)
                    }) else {
                        continue;
                    };
                    let Some(track) = snapshot.current_track.as_ref().and_then(|current| {
                        self.queue
                            .snapshot()
                            .items
                            .into_iter()
                            .find(|track| track.id == current.id)
                    }) else {
                        continue;
                    };
                    self.schedule_failed_track(active.intent, &track);
                }
                NativePlayerEvent::Opened { generation } => {
                    let _operation = self
                        .operation
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if self.playback.snapshot().generation != generation {
                        continue;
                    }
                    let pending = {
                        let mut pending = self
                            .pending_resume
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        match *pending {
                            Some(value)
                                if value.generation == generation
                                    && self.play_intent.load(Ordering::SeqCst) == value.intent =>
                            {
                                pending.take()
                            }
                            Some(value) if value.generation <= generation => {
                                pending.take();
                                None
                            }
                            _ => None,
                        }
                    };
                    if let Some(pending) = pending {
                        let snapshot = self.playback.snapshot();
                        let position = pending
                            .position_ms
                            .min(snapshot.duration_ms.unwrap_or(pending.position_ms));
                        let _ = self.playback.seek(position);
                        if pending.resume_play {
                            let _ = self.playback.play();
                        } else {
                            let _ = self.playback.pause();
                        }
                    }
                }
                NativePlayerEvent::Ended { .. } | NativePlayerEvent::Failed { .. } => {}
            }
        }
    }
}

fn current_index(snapshot: &PlaybackSessionSnapshot) -> Option<usize> {
    snapshot
        .player
        .current_track
        .as_ref()
        .and_then(|track| {
            snapshot
                .queue
                .items
                .iter()
                .position(|item| item.id == track.id)
        })
        .or(snapshot.queue.selected_index)
}

fn failed_track_next_index(
    queue: &QueueSnapshot,
    mode: PlaybackMode,
    id: &str,
    failed: &HashSet<String>,
) -> Option<usize> {
    let current = queue.items.iter().position(|track| track.id == id)?;
    let candidates: Vec<_> = (1..queue.items.len())
        .filter_map(|offset| {
            let index = current + offset;
            if mode == PlaybackMode::Sequence && index >= queue.items.len() {
                return None;
            }
            let index = index % queue.items.len();
            (!failed.contains(&queue.items[index].id)).then_some(index)
        })
        .collect();
    if candidates.is_empty() {
        return None;
    }
    // A failure overrides single-track repeat. Shuffle only chooses untried tracks.
    let pick = if mode == PlaybackMode::Shuffle {
        queue.generation as usize % candidates.len()
    } else {
        0
    };
    Some(candidates[pick])
}

fn song_cannot_play(error: &PlaybackSessionError) -> bool {
    matches!(
        error,
        PlaybackSessionError::Playback(
            PlaybackError::EntitlementDenied
                | PlaybackError::Unavailable
                | PlaybackError::LocalFileMissing
                | PlaybackError::LocalCodecUnavailable
                | PlaybackError::NativePlayerUnavailable
        )
    )
}

fn normalize_quality(quality: PlaybackQuality) -> PlaybackQuality {
    match quality {
        PlaybackQuality::Auto => PlaybackQuality::Kbps320,
        quality => quality,
    }
}

fn quality_wire(quality: PlaybackQuality) -> &'static str {
    match normalize_quality(quality) {
        PlaybackQuality::Flac => "flac",
        PlaybackQuality::Kbps320 => "320k",
        PlaybackQuality::Kbps128 => "128k",
        PlaybackQuality::Auto => unreachable!("auto is normalized before serialization"),
    }
}

fn manual_skip_index(snapshot: &PlaybackSessionSnapshot, direction: i8) -> Option<usize> {
    let length = snapshot.queue.items.len();
    if length == 0 {
        return None;
    }
    let current = current_index(snapshot).unwrap_or(0);
    if snapshot.mode == PlaybackMode::Shuffle {
        return Some(shuffled_index(current, length, snapshot.player.generation));
    }
    if direction < 0 {
        Some((current + length - 1) % length)
    } else {
        Some((current + 1) % length)
    }
}

fn automatic_index(snapshot: &PlaybackSessionSnapshot) -> Option<usize> {
    let length = snapshot.queue.items.len();
    let current = current_index(snapshot)?;
    match snapshot.mode {
        PlaybackMode::Sequence if current + 1 >= length => None,
        PlaybackMode::Sequence => Some(current + 1),
        PlaybackMode::RepeatAll => Some((current + 1) % length),
        PlaybackMode::RepeatOne => Some(current),
        PlaybackMode::Shuffle => Some(shuffled_index(current, length, snapshot.player.generation)),
    }
}

const fn playback_session_error_is_transient(error: &PlaybackSessionError) -> bool {
    matches!(
        error,
        PlaybackSessionError::Playback(
            crate::playback::PlaybackError::ProviderUnavailable
                | crate::playback::PlaybackError::NetworkUnavailable
                | crate::playback::PlaybackError::Unavailable
        )
    )
}

fn shuffled_index(current: usize, length: usize, generation: u64) -> usize {
    if length <= 1 {
        return current;
    }
    let mixed = generation
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    let offset = 1 + (mixed as usize % (length - 1));
    (current + offset) % length
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        fs,
        net::{IpAddr, Ipv4Addr},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Barrier,
        },
    };

    use uuid::Uuid;

    use super::*;
    use crate::{
        network_policy::{DnsResolver, RemoteUrlError},
        player::{PlayerCommand, PlayerEngine, PlayerError},
        provider::{ProviderError, ProviderReply, ProviderRequest, ProviderRequestPort},
    };

    struct CountingProvider {
        requests: Arc<AtomicUsize>,
    }

    struct SelectiveProvider {
        denied: HashSet<String>,
        requests: Arc<AtomicUsize>,
        queue: Arc<QueueService>,
    }

    impl ProviderRequestPort for SelectiveProvider {
        fn request(&self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            let queue = self.queue.snapshot();
            let id = queue.items[queue.selected_index.unwrap()].id.as_str();
            let global_failure = match id {
                "network" => Some("network_unavailable"),
                "authentication" => Some("authentication_required"),
                "device" => Some("playback_device_limit"),
                _ => None,
            };
            if let Some(code) = global_failure {
                return Ok(ProviderReply::Failure {
                    code: code.into(),
                    retryable: false,
                });
            }
            if self.denied.contains(id) {
                return Ok(ProviderReply::Failure {
                    code: "entitlement_denied".into(),
                    retryable: false,
                });
            }
            Ok(ProviderReply::Success {
                result: serde_json::json!({"trackId":id,"quality":"320k","url":"https://isure.stream.qqmusic.qq.com/M800fixture.mp3?vkey=v","expiresInSeconds":7200}).as_object().unwrap().clone(),
                warnings: vec![],
            })
        }
    }

    fn failure_session(denied: &[&str]) -> (TestSession, Arc<Mutex<VecDeque<NativePlayerEvent>>>) {
        let root = std::env::temp_dir().join(format!("qqmusic-skip-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).unwrap());
        queue
            .replace(vec![
                queue_track("one"),
                queue_track("two"),
                queue_track("three"),
            ])
            .unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let events = Arc::new(Mutex::new(VecDeque::new()));
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(SelectiveProvider {
                denied: denied.iter().map(|id| (*id).to_owned()).collect(),
                requests: requests.clone(),
                queue: queue.clone(),
            }),
            Box::new(RecoveryPlayer {
                snapshot: Mutex::new(PlayerSnapshot::idle()),
                events: events.clone(),
                seeks: Arc::new(Mutex::new(vec![])),
            }),
            Arc::new(FakeResolver),
        ));
        (
            TestSession {
                root,
                session: PlaybackSession::new(queue, playback),
                requests,
            },
            events,
        )
    }

    fn run_pending_skip(session: &PlaybackSession) {
        if let Some((_, _, due)) = session.failed_tracks.lock().unwrap().pending.as_mut() {
            *due = Instant::now();
        }
        session.advance_after_failure();
    }

    #[test]
    fn failed_selection_shows_notice_before_advancing_from_failed_id_not_old_source() {
        let (test, _) = failure_session(&["two"]);
        test.session.play_index(0, PlaybackQuality::Auto).unwrap();
        assert!(test.session.play_index(1, PlaybackQuality::Auto).is_err());
        assert_eq!(
            test.session
                .snapshot_update(None)
                .skip_notice
                .unwrap()
                .title,
            "Track two"
        );
        test.session.advance_after_failure();
        assert_eq!(test.requests.load(Ordering::SeqCst), 2);
        run_pending_skip(&test.session);
        assert_eq!(
            test.session.snapshot().player.current_track.unwrap().id,
            "three"
        );
        assert_eq!(test.requests.load(Ordering::SeqCst), 3);
        assert!(!test.session.skip_notice().unwrap().exhausted);
    }

    #[test]
    fn consecutive_failures_try_each_recording_once_in_every_playback_mode() {
        for mode in [
            PlaybackMode::Sequence,
            PlaybackMode::RepeatAll,
            PlaybackMode::RepeatOne,
            PlaybackMode::Shuffle,
        ] {
            let (test, _) = failure_session(&["one", "two", "three"]);
            test.session.set_mode(mode).unwrap();
            assert!(test.session.play_index(0, PlaybackQuality::Auto).is_err());
            for _ in 0..6 {
                run_pending_skip(&test.session);
            }
            assert_eq!(test.requests.load(Ordering::SeqCst), 3, "{mode:?}");
            assert!(test.session.skip_notice().unwrap().exhausted);
            assert_eq!(test.session.snapshot().player.state, PlayerState::Idle);
        }
    }

    #[test]
    fn repeat_one_skips_failed_track_and_successful_next_track_keeps_notice() {
        let (test, _) = failure_session(&["one"]);
        test.session.set_mode(PlaybackMode::RepeatOne).unwrap();
        assert!(test.session.play_index(0, PlaybackQuality::Auto).is_err());
        run_pending_skip(&test.session);
        assert_eq!(
            test.session.snapshot().player.current_track.unwrap().id,
            "two"
        );
        assert_eq!(test.requests.load(Ordering::SeqCst), 2);
        assert_eq!(test.session.skip_notice().unwrap().title, "Track one");
    }

    #[test]
    fn explicit_actions_cancel_scheduled_failure_advancement() {
        for action in ["pause", "stop", "replace", "play"] {
            let (test, _) = failure_session(&["one"]);
            assert!(test.session.play_index(0, PlaybackQuality::Auto).is_err());
            match action {
                "pause" => {
                    let _ = test.session.pause();
                }
                "stop" => {
                    let _ = test.session.stop();
                }
                "replace" => {
                    test.session
                        .replace_queue(vec![queue_track("three")])
                        .unwrap();
                }
                _ => {
                    test.session.play_index(2, PlaybackQuality::Auto).unwrap();
                }
            }
            run_pending_skip(&test.session);
            assert_eq!(
                test.requests.load(Ordering::SeqCst),
                if action == "play" { 2 } else { 1 }
            );
            assert!(test.session.skip_notice().is_none());
        }
    }

    #[test]
    fn superseded_failure_cannot_stop_or_skip_the_new_manual_selection() {
        let (test, _) = failure_session(&[]);
        test.session.play_index(0, PlaybackQuality::Auto).unwrap();
        let previous_intent = test.session.play_intent.load(Ordering::SeqCst);
        test.session.play_index(2, PlaybackQuality::Auto).unwrap();
        {
            let _operation = test.session.operation.lock().unwrap();
            test.session
                .schedule_failed_track(previous_intent, &queue_track("one"));
        }
        run_pending_skip(&test.session);
        assert!(test.session.skip_notice().is_none());
        assert_eq!(
            test.session.snapshot().player.current_track.unwrap().id,
            "three"
        );
        assert_eq!(test.requests.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn stale_native_failure_does_not_skip_current_track_but_decoding_failure_does() {
        let (test, events) = failure_session(&[]);
        test.session.play_index(0, PlaybackQuality::Auto).unwrap();
        let generation = test.session.snapshot().player.generation;
        for event_generation in [generation.wrapping_sub(1), generation] {
            events.lock().unwrap().push_back(NativePlayerEvent::Failed {
                generation: event_generation,
                failure: crate::player::PlayerFailure::new(
                    PlayerFailureCode::Decoding,
                    event_generation,
                ),
            });
            test.session.handle_native_events();
            if event_generation != generation {
                assert!(test.session.skip_notice().is_none());
            }
        }
        assert_eq!(test.session.skip_notice().unwrap().title, "Track one");
        run_pending_skip(&test.session);
        assert_eq!(
            test.session.snapshot().player.current_track.unwrap().id,
            "two"
        );
    }

    #[test]
    fn global_network_authentication_and_device_failures_do_not_scan_the_queue() {
        for id in ["network", "authentication", "device"] {
            let (test, _) = failure_session(&[]);
            test.session
                .replace_queue(vec![queue_track(id), queue_track("two")])
                .unwrap();
            assert!(test.session.play_index(0, PlaybackQuality::Auto).is_err());
            run_pending_skip(&test.session);
            assert_eq!(test.requests.load(Ordering::SeqCst), 1);
            assert!(test.session.skip_notice().is_none());
        }
    }

    struct SuccessfulProvider {
        track_id: &'static str,
        requests: Arc<AtomicUsize>,
    }

    #[derive(Default)]
    struct RecordingArtworkPort {
        requests: Mutex<Vec<(u64, Option<String>)>>,
        clears: AtomicUsize,
    }

    impl SmtcArtworkPort for RecordingArtworkPort {
        fn request(&self, generation: u64, cover_cache_key: Option<String>) {
            self.requests
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push((generation, cover_cache_key));
        }

        fn clear(&self) {
            self.clears.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[derive(Default)]
    struct RecordingDynamicLyricsPort {
        requests: Mutex<Vec<(String, u64)>>,
        clears: AtomicUsize,
    }

    impl SmtcDynamicLyricsPort for RecordingDynamicLyricsPort {
        fn request(&self, track_id: String, player_generation: u64) {
            self.requests
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push((track_id, player_generation));
        }

        fn clear(&self) {
            self.clears.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl ProviderRequestPort for SuccessfulProvider {
        fn request(&self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            Ok(ProviderReply::Success {
                result: serde_json::json!({
                    "trackId": self.track_id,
                    "quality": "320k",
                    "url": "https://isure.stream.qqmusic.qq.com/M800fixture.mp3?vkey=v",
                    "expiresInSeconds": 7200
                })
                .as_object()
                .expect("object")
                .clone(),
                warnings: Vec::new(),
            })
        }
    }

    struct OutOfOrderProvider {
        barrier: Barrier,
        requests: AtomicUsize,
    }

    struct BurstProvider {
        barrier: Barrier,
    }

    impl ProviderRequestPort for BurstProvider {
        fn request(&self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            self.barrier.wait();
            Ok(ProviderReply::Success {
                result: serde_json::json!({
                    "trackId": "one",
                    "quality": "320k",
                    "url": "https://isure.stream.qqmusic.qq.com/M800fixture.mp3?vkey=v",
                    "expiresInSeconds": 7200
                })
                .as_object()
                .expect("object")
                .clone(),
                warnings: Vec::new(),
            })
        }
    }

    impl ProviderRequestPort for OutOfOrderProvider {
        fn request(&self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            let sequence = self.requests.fetch_add(1, Ordering::SeqCst);
            if sequence == 0 {
                self.barrier.wait();
                thread::sleep(Duration::from_millis(30));
            } else {
                self.barrier.wait();
            }
            Ok(ProviderReply::Success {
                result: serde_json::json!({
                    "trackId": if sequence == 0 { "one" } else { "two" },
                    "quality": "320k",
                    "url": "https://isure.stream.qqmusic.qq.com/M800fixture.mp3?vkey=v",
                    "expiresInSeconds": 7200
                })
                .as_object()
                .expect("object")
                .clone(),
                warnings: Vec::new(),
            })
        }
    }

    impl ProviderRequestPort for CountingProvider {
        fn request(&self, _request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            Ok(ProviderReply::Failure {
                code: "playback_unavailable".to_owned(),
                retryable: false,
            })
        }
    }

    struct FakeResolver;

    impl DnsResolver for FakeResolver {
        fn resolve(&self, _host: &str, _port: u16) -> Result<Vec<IpAddr>, RemoteUrlError> {
            Ok(vec![IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))])
        }
    }

    struct EndedPlayer {
        snapshot: PlayerSnapshot,
    }

    struct CountingPlayer {
        snapshot: PlayerSnapshot,
        snapshots: Arc<AtomicUsize>,
        cached_snapshots: Arc<AtomicUsize>,
    }

    struct EventPlayer {
        snapshot: PlayerSnapshot,
        events: Mutex<VecDeque<NativePlayerEvent>>,
    }

    struct RecoveryPlayer {
        snapshot: Mutex<PlayerSnapshot>,
        events: Arc<Mutex<VecDeque<NativePlayerEvent>>>,
        seeks: Arc<Mutex<Vec<u64>>>,
    }

    impl PlayerEngine for RecoveryPlayer {
        fn snapshot(&self) -> PlayerSnapshot {
            self.snapshot
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }

        fn handle(&mut self, command: PlayerCommand) -> Result<(), PlayerError> {
            let mut snapshot = self
                .snapshot
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match command {
                PlayerCommand::LoadRemote { track, .. }
                | PlayerCommand::LoadLocal { track, .. } => {
                    snapshot.generation = snapshot.generation.saturating_add(1);
                    snapshot.state = PlayerState::Loading;
                    snapshot.current_track = Some(track);
                    snapshot.failure = None;
                }
                PlayerCommand::Play => snapshot.state = PlayerState::Playing,
                PlayerCommand::Pause => snapshot.state = PlayerState::Paused,
                PlayerCommand::Stop => {
                    let generation = snapshot.generation;
                    *snapshot = PlayerSnapshot::idle();
                    snapshot.generation = generation;
                }
                PlayerCommand::Seek { .. }
                    if snapshot.current_track.is_none()
                        || snapshot.state == PlayerState::Loading =>
                {
                    return Err(PlayerError::NotReady);
                }
                PlayerCommand::Seek { position } => {
                    self.seeks
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(position.get());
                    snapshot.position_ms = position.get();
                }
                _ => {}
            }
            Ok(())
        }

        fn try_event(&self) -> Option<NativePlayerEvent> {
            let event = self
                .events
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .pop_front();
            if let Some(NativePlayerEvent::Opened { generation }) = event {
                let mut snapshot = self
                    .snapshot
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if snapshot.generation == generation {
                    snapshot.state = PlayerState::Paused;
                }
            }
            event
        }
    }

    impl PlayerEngine for EventPlayer {
        fn snapshot(&self) -> PlayerSnapshot {
            self.snapshot.clone()
        }

        fn handle(&mut self, command: PlayerCommand) -> Result<(), PlayerError> {
            match command {
                PlayerCommand::Play => self.snapshot.state = PlayerState::Playing,
                PlayerCommand::Pause => self.snapshot.state = PlayerState::Paused,
                PlayerCommand::SetVolume { volume } => self.snapshot.volume = volume.get(),
                PlayerCommand::Stop => self.snapshot = PlayerSnapshot::idle(),
                _ => {}
            }
            Ok(())
        }

        fn try_event(&self) -> Option<NativePlayerEvent> {
            self.events
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .pop_front()
        }
    }

    impl PlayerEngine for EndedPlayer {
        fn snapshot(&self) -> PlayerSnapshot {
            self.snapshot.clone()
        }

        fn handle(&mut self, command: PlayerCommand) -> Result<(), PlayerError> {
            match command {
                PlayerCommand::LoadRemote { track, .. }
                | PlayerCommand::LoadLocal { track, .. } => {
                    self.snapshot.current_track = Some(track);
                    self.snapshot.generation = self.snapshot.generation.saturating_add(1);
                    self.snapshot.state = PlayerState::Paused;
                    Ok(())
                }
                PlayerCommand::Play => {
                    self.snapshot.state = PlayerState::Playing;
                    Ok(())
                }
                _ => Ok(()),
            }
        }
    }

    impl PlayerEngine for CountingPlayer {
        fn snapshot(&self) -> PlayerSnapshot {
            self.snapshots.fetch_add(1, Ordering::SeqCst);
            self.snapshot.clone()
        }

        fn cached_snapshot(&self) -> PlayerSnapshot {
            self.cached_snapshots.fetch_add(1, Ordering::SeqCst);
            self.snapshot.clone()
        }

        fn handle(&mut self, _command: PlayerCommand) -> Result<(), PlayerError> {
            Ok(())
        }
    }

    struct TestSession {
        root: std::path::PathBuf,
        session: PlaybackSession,
        requests: Arc<AtomicUsize>,
    }

    #[test]
    fn saved_queue_switch_and_restore_keep_selection_without_resolving_media() {
        use crate::personal::PersonalRequest;
        let test = TestSession::ended();
        test.session.queue.select(1).unwrap();
        test.session
            .personal_library(PersonalRequest::SaveQueue {
                name: "work".into(),
            })
            .unwrap();
        test.session
            .replace_queue(vec![queue_track("other")])
            .unwrap();
        let loaded = test
            .session
            .personal_library(PersonalRequest::LoadQueue {
                name: "work".into(),
            })
            .unwrap();
        assert_eq!(loaded["queue"]["selectedIndex"], 1);
        assert_eq!(loaded["queue"]["items"][1]["id"], "two");
        let restored = test
            .session
            .personal_library(PersonalRequest::RestoreQueue)
            .unwrap();
        assert_eq!(restored["queue"]["items"][0]["id"], "other");
        assert_eq!(test.requests.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn memory_tape_enqueue_rechecks_files_deduplicates_and_never_rewrites_history() {
        use crate::personal::PersonalRequest;
        let mut test = TestSession::ended();
        let media = test.root.join("local");
        fs::create_dir_all(&media).unwrap();
        let local_id = format!("local_{}_mp3", "a".repeat(64));
        let path = media.join(format!("{}.mp3", "a".repeat(64)));
        fs::write(&path, b"fixture").unwrap();
        test.session.local_music = Some(Arc::new(LocalMusicService::new(media)));
        let db = &test.session.queue.persistence;
        let now = crate::personal::now_ms();
        for id in ["tape-song", local_id.as_str()] {
            db.record_listening(id, "Tape song", "Artist", 1000, true, now)
                .unwrap();
        }
        let tapes = test
            .session
            .personal_library(PersonalRequest::MemoryTapes { before: None })
            .unwrap();
        let month = tapes["items"][0]["month"].as_str().unwrap().to_owned();
        let detail = test
            .session
            .personal_library(PersonalRequest::MemoryTape {
                month: month.clone(),
                offset: 0,
            })
            .unwrap();
        assert_eq!(
            detail["songs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["id"] == local_id)
                .unwrap()["availability"],
            "local"
        );
        fs::remove_file(path).unwrap();
        let history = db.listening_report().unwrap();
        let collections = db.personal_collections().unwrap();
        let player = test.session.snapshot().player;
        let enqueue = || {
            test.session
                .personal_library(PersonalRequest::MemoryTapeEnqueue {
                    month: month.clone(),
                    ids: vec!["tape-song".into(), local_id.clone()],
                })
                .unwrap()
        };
        let result = enqueue();
        assert_eq!(result["acceptedIds"], serde_json::json!(["tape-song"]));
        assert_eq!(result["skippedIds"], serde_json::json!([local_id]));
        let repeated = enqueue();
        assert_eq!(result["queue"], repeated["queue"]);
        assert_eq!(test.session.snapshot().player, player);
        assert_eq!(test.requests.load(Ordering::SeqCst), 0);
        assert_eq!(db.listening_report().unwrap(), history);
        assert_eq!(db.personal_collections().unwrap(), collections);
        assert!(test
            .session
            .personal_library(PersonalRequest::MemoryTapeEnqueue {
                month,
                ids: vec!["unseen-song".into()]
            })
            .is_err());
        assert_eq!(test.session.queue.snapshot().items.len(), 3);
    }

    impl TestSession {
        fn ended() -> Self {
            let root = std::env::temp_dir().join(format!("qqmusic-session-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).expect("create session root");
            let queue = Arc::new(
                QueueService::open(&root.join("state.sqlite3")).expect("open session queue"),
            );
            queue
                .replace(vec![queue_track("one"), queue_track("two")])
                .expect("seed queue");
            queue.select(0).expect("select first");
            let requests = Arc::new(AtomicUsize::new(0));
            let player = EndedPlayer {
                snapshot: PlayerSnapshot {
                    state: PlayerState::Ended,
                    generation: 9,
                    position_ms: 1_000,
                    duration_ms: Some(1_000),
                    volume: 1.0,
                    muted: false,
                    current_track: Some(TrackSummary {
                        source: None,
                        id: "one".to_owned(),
                        title: "Track one".to_owned(),
                        artist: "Artist".to_owned(),
                    }),
                    failure: None,
                },
            };
            let playback = Arc::new(PlaybackController::with_resolver(
                Arc::new(CountingProvider {
                    requests: requests.clone(),
                }),
                Box::new(player),
                Arc::new(FakeResolver),
            ));
            Self {
                root,
                session: PlaybackSession::new(queue, playback),
                requests,
            }
        }
    }

    impl Drop for TestSession {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn explicit_next_overrides_repeat_one_and_shuffle_without_starting_playback() {
        let test = TestSession::ended();
        for mode in [
            PlaybackMode::RepeatOne,
            PlaybackMode::Shuffle,
            PlaybackMode::Sequence,
        ] {
            test.session.set_mode(mode).unwrap();
            let before = test.session.snapshot().player;
            test.session.enqueue_next(queue_track("three")).unwrap();
            assert_eq!(test.session.preview_next_track().as_deref(), Some("three"));
            assert_eq!(test.session.snapshot().player, before);
            assert_eq!(test.requests.load(Ordering::SeqCst), 0);
            assert_eq!(
                test.session.next_index(&test.session.snapshot(), Some(1)),
                Some(1)
            );
        }
    }

    #[test]
    fn pause_updates_both_resolving_and_loaded_resume_intentions() {
        let test = TestSession::ended();
        *test.session.resume_transport.lock().unwrap() = Some((0, true));
        *test.session.pending_resume.lock().unwrap() = Some(PendingResume {
            generation: 9,
            intent: 0,
            position_ms: 500,
            resume_play: true,
        });
        test.session.pause().unwrap();
        assert_eq!(
            *test.session.resume_transport.lock().unwrap(),
            Some((0, false))
        );
        assert!(
            !test
                .session
                .pending_resume
                .lock()
                .unwrap()
                .unwrap()
                .resume_play
        );
        test.session.play().unwrap();
        assert!(
            test.session
                .pending_resume
                .lock()
                .unwrap()
                .unwrap()
                .resume_play
        );
    }

    #[test]
    fn replacing_a_playlist_clears_previous_next_request_even_when_track_is_reused() {
        let test = TestSession::ended();
        test.session.enqueue_next(queue_track("three")).unwrap();
        test.session
            .replace_queue(vec![
                queue_track("one"),
                queue_track("two"),
                queue_track("three"),
            ])
            .unwrap();
        assert_eq!(test.session.preview_next_track().as_deref(), Some("two"));
    }

    #[test]
    fn smart_shuffle_uses_same_selection_for_preview_manual_and_automatic_play() {
        for automatic in [false, true] {
            let test = TestSession::ended();
            test.session
                .queue
                .replace((0..12).map(|i| queue_track(&format!("song{i}"))).collect())
                .unwrap();
            test.session.set_mode(PlaybackMode::Shuffle).unwrap();
            test.session
                .set_smart_shuffle(true, Some(std::collections::HashSet::new()), 0)
                .unwrap();
            let before = test.session.snapshot();
            let expected = test.session.preview_next_track().unwrap();
            assert_eq!(test.session.preview_next_track(), Some(expected.clone()));
            assert_eq!(test.session.snapshot(), before);
            assert_eq!(test.requests.load(Ordering::SeqCst), 0);
            // This fixture deliberately rejects source resolution; selection must already match the preview.
            let result = if automatic {
                test.session.advance_if_ended()
            } else {
                test.session.next()
            };
            assert_eq!(
                result,
                Err(PlaybackSessionError::Playback(PlaybackError::Unavailable))
            );
            assert_eq!(test.requests.load(Ordering::SeqCst), 1);
            let selected = test.session.queue.snapshot();
            assert_eq!(
                selected.items[selected.selected_index.unwrap()].id,
                expected
            );
            test.session.set_smart_shuffle(false, None, 0).unwrap();
            let snapshot = test.session.snapshot();
            assert_eq!(
                test.session.next_index(&snapshot, Some(1)),
                manual_skip_index(&snapshot, 1)
            );
        }
    }

    #[test]
    fn remote_stale_actions_do_not_change_selection_or_resolve_sources() {
        let test = TestSession::ended();
        let before = test.session.snapshot();
        assert_eq!(
            test.session
                .seek_generation(500, before.player.generation + 1),
            Err(PlaybackSessionError::Superseded)
        );
        assert_eq!(
            test.session
                .play_remote_track("two", before.queue.generation + 1),
            Err(PlaybackSessionError::Superseded)
        );
        assert_eq!(test.session.snapshot(), before);
        assert_eq!(test.requests.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn smart_shuffle_never_changes_other_modes_and_discards_stale_account_likes() {
        let test = TestSession::ended();
        test.session.clear_shuffle_likes();
        let status = test
            .session
            .set_smart_shuffle(
                true,
                Some(std::collections::HashSet::from(["one".into()])),
                0,
            )
            .unwrap();
        assert!(!status.likes_loaded);
        for mode in [
            PlaybackMode::Sequence,
            PlaybackMode::RepeatAll,
            PlaybackMode::RepeatOne,
        ] {
            test.session.set_mode(mode).unwrap();
            let snapshot = test.session.snapshot();
            assert_eq!(
                test.session.next_index(&snapshot, None),
                automatic_index(&snapshot)
            );
            assert_eq!(
                test.session.next_index(&snapshot, Some(-1)),
                manual_skip_index(&snapshot, -1)
            );
        }
    }

    #[test]
    fn next_preview_is_read_only_and_matches_automatic_rule() {
        let test = TestSession::ended();
        for mode in [
            PlaybackMode::Sequence,
            PlaybackMode::RepeatAll,
            PlaybackMode::RepeatOne,
            PlaybackMode::Shuffle,
        ] {
            test.session.set_mode(mode).expect("mode");
            let before = test.session.snapshot();
            let expected = automatic_index(&before).map(|i| before.queue.items[i].id.clone());
            assert_eq!(test.session.preview_next_track(), expected);
            assert_eq!(test.session.snapshot(), before);
            assert_eq!(test.requests.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn incremental_snapshot_preserves_player_and_sends_queue_on_selection_or_content_change() {
        let test = TestSession::ended();
        let full = test.session.snapshot();
        assert_eq!(
            test.session.snapshot_update(None).queue,
            Some(full.queue.clone())
        );
        let update = test.session.snapshot_update(Some(full.queue.generation));
        assert_eq!(update.queue, None);
        assert_eq!(update.player, full.player);
        assert_eq!(update.mode, full.mode);
        assert_eq!(update.requested_quality, full.requested_quality);
        test.session.queue.select(1).expect("select");
        let selected = test
            .session
            .snapshot_update(Some(full.queue.generation))
            .queue
            .expect("changed selection");
        assert_eq!(selected.selected_index, Some(1));
        test.session
            .queue
            .replace(vec![queue_track("new")])
            .expect("replace");
        let replaced = test
            .session
            .snapshot_update(Some(selected.generation))
            .queue
            .expect("changed items");
        assert_eq!(replaced.items[0].id, "new");
        assert_eq!(test.requests.load(Ordering::SeqCst), 0);
    }

    fn queue_track(id: &str) -> QueueTrack {
        QueueTrack {
            id: id.to_owned(),
            media_mid: None,
            title: format!("Track {id}"),
            artist: "Artist".to_owned(),
            album: "Album".to_owned(),
            duration_ms: 1_000,
            cover_cache_key: None,
        }
    }

    fn snapshot(mode: PlaybackMode, current: usize, length: usize) -> PlaybackSessionSnapshot {
        let items = (0..length)
            .map(|index| QueueTrack {
                id: format!("track{index}"),
                media_mid: None,
                title: format!("Track {index}"),
                artist: "Artist".to_owned(),
                album: "Album".to_owned(),
                duration_ms: 1_000,
                cover_cache_key: None,
            })
            .collect::<Vec<_>>();
        PlaybackSessionSnapshot {
            skip_notice: None,
            actual_quality: None,
            lyric_offset_ms: 0,
            mode,
            queue: QueueSnapshot {
                generation: 1,
                selected_index: (!items.is_empty()).then_some(current),
                items,
            },
            player: PlayerSnapshot {
                state: PlayerState::Ended,
                generation: 7,
                position_ms: 1_000,
                duration_ms: Some(1_000),
                volume: 1.0,
                muted: false,
                current_track: (length > 0).then(|| TrackSummary {
                    source: None,
                    id: format!("track{current}"),
                    title: format!("Track {current}"),
                    artist: "Artist".to_owned(),
                }),
                failure: None,
            },
            requested_quality: "320k".to_owned(),
        }
    }

    #[test]
    fn automatic_modes_choose_stable_indices() {
        assert_eq!(
            automatic_index(&snapshot(PlaybackMode::Sequence, 0, 3)),
            Some(1)
        );
        assert_eq!(
            automatic_index(&snapshot(PlaybackMode::Sequence, 2, 3)),
            None
        );
        assert_eq!(
            automatic_index(&snapshot(PlaybackMode::RepeatAll, 2, 3)),
            Some(0)
        );
        assert_eq!(
            automatic_index(&snapshot(PlaybackMode::RepeatOne, 1, 3)),
            Some(1)
        );
        let shuffled = automatic_index(&snapshot(PlaybackMode::Shuffle, 1, 3))
            .expect("shuffle has a next item");
        assert!(shuffled < 3);
        assert_ne!(shuffled, 1);
    }

    #[test]
    fn manual_skip_wraps_but_shuffle_avoids_current_item() {
        assert_eq!(
            manual_skip_index(&snapshot(PlaybackMode::Sequence, 2, 3), 1),
            Some(0)
        );
        assert_eq!(
            manual_skip_index(&snapshot(PlaybackMode::RepeatOne, 0, 3), -1),
            Some(2)
        );
        let shuffled = manual_skip_index(&snapshot(PlaybackMode::Shuffle, 0, 3), 1)
            .expect("shuffle has a next item");
        assert_ne!(shuffled, 0);
    }

    #[test]
    fn mode_parser_rejects_unknown_wire_values() {
        assert_eq!(
            PlaybackMode::parse("repeat-all"),
            Ok(PlaybackMode::RepeatAll)
        );
        assert_eq!(
            PlaybackMode::parse("sentinel"),
            Err(PlaybackSessionError::InvalidMode)
        );
    }

    #[test]
    fn deleting_current_local_track_stops_and_removes_it() {
        let root = std::env::temp_dir().join(format!("qqmusic-delete-session-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("root");
        let local_root = root.join("local-music");
        fs::create_dir_all(&local_root).expect("local root");
        let local_id = "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_mp3";
        fs::write(
            local_root.join(format!("{}.mp3", &local_id[6..70])),
            b"audio",
        )
        .expect("audio");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("queue"));
        queue
            .replace(vec![queue_track(local_id)])
            .expect("queue seed");
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(CountingProvider {
                requests: Arc::new(AtomicUsize::new(0)),
            }),
            Box::new(EventPlayer {
                snapshot: PlayerSnapshot {
                    state: PlayerState::Playing,
                    generation: 1,
                    position_ms: 12,
                    duration_ms: Some(100),
                    volume: 1.0,
                    muted: false,
                    current_track: Some(TrackSummary {
                        source: None,
                        id: local_id.to_owned(),
                        title: "Local".to_owned(),
                        artist: "Artist".to_owned(),
                    }),
                    failure: None,
                },
                events: Mutex::new(VecDeque::new()),
            }),
            Arc::new(FakeResolver),
        ));
        let session = PlaybackSession::with_ports_and_local_music(
            queue,
            playback,
            None,
            None,
            Some(Arc::new(LocalMusicService::new(local_root.clone()))),
        );

        let result = session.delete_local_track(local_id).expect("delete");
        assert_eq!(result.deleted_id, local_id);
        assert!(!result.auto_play_started);
        assert!(result.session.queue.items.is_empty());
        assert_eq!(result.session.player.state, PlayerState::Idle);
        assert!(!local_root
            .join(format!("{}.mp3", &local_id[6..70]))
            .exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deleting_current_local_track_starts_adjusted_next_local_track() {
        let root = std::env::temp_dir().join(format!("qqmusic-delete-session-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("root");
        let local_root = root.join("local-music");
        fs::create_dir_all(&local_root).expect("local root");
        let current_id =
            "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_mp3";
        let next_id = "local_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789_mp3";
        fs::write(
            local_root.join(format!("{}.mp3", &current_id[6..70])),
            b"current audio",
        )
        .expect("current audio");
        fs::write(
            local_root.join(format!("{}.mp3", &next_id[6..70])),
            b"next audio",
        )
        .expect("next audio");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("queue"));
        queue
            .replace(vec![queue_track(current_id), queue_track(next_id)])
            .expect("queue seed");
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(CountingProvider {
                requests: Arc::new(AtomicUsize::new(0)),
            }),
            Box::new(EndedPlayer {
                snapshot: PlayerSnapshot {
                    state: PlayerState::Playing,
                    generation: 1,
                    position_ms: 12,
                    duration_ms: Some(100),
                    volume: 1.0,
                    muted: false,
                    current_track: Some(TrackSummary {
                        source: None,
                        id: current_id.to_owned(),
                        title: "Current local".to_owned(),
                        artist: "Artist".to_owned(),
                    }),
                    failure: None,
                },
            }),
            Arc::new(FakeResolver),
        ));
        let session = PlaybackSession::with_ports_and_local_music(
            queue,
            playback,
            None,
            None,
            Some(Arc::new(LocalMusicService::new(local_root.clone()))),
        );

        let result = session.delete_local_track(current_id).expect("delete");
        assert!(result.auto_play_started);
        assert_eq!(result.session.queue.selected_index, Some(0));
        assert_eq!(result.session.queue.items[0].id, next_id);
        assert_eq!(result.session.player.state, PlayerState::Playing);
        assert_eq!(
            result
                .session
                .player
                .current_track
                .as_ref()
                .map(|track| track.id.as_str()),
            Some(next_id)
        );
        assert!(!local_root
            .join(format!("{}.mp3", &current_id[6..70]))
            .exists());
        assert!(local_root.join(format!("{}.mp3", &next_id[6..70])).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deleting_current_queue_tail_starts_adjusted_previous_local_track() {
        let root = std::env::temp_dir().join(format!("qqmusic-delete-session-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("root");
        let local_root = root.join("local-music");
        fs::create_dir_all(&local_root).expect("local root");
        let previous_id =
            "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_mp3";
        let current_id =
            "local_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789_mp3";
        fs::write(
            local_root.join(format!("{}.mp3", &previous_id[6..70])),
            b"previous audio",
        )
        .expect("previous audio");
        fs::write(
            local_root.join(format!("{}.mp3", &current_id[6..70])),
            b"current audio",
        )
        .expect("current audio");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("queue"));
        queue
            .replace(vec![queue_track(previous_id), queue_track(current_id)])
            .expect("queue seed");
        queue.select(1).expect("select current tail");
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(CountingProvider {
                requests: Arc::new(AtomicUsize::new(0)),
            }),
            Box::new(EndedPlayer {
                snapshot: PlayerSnapshot {
                    state: PlayerState::Playing,
                    generation: 1,
                    position_ms: 12,
                    duration_ms: Some(100),
                    volume: 1.0,
                    muted: false,
                    current_track: Some(TrackSummary {
                        source: None,
                        id: current_id.to_owned(),
                        title: "Current local".to_owned(),
                        artist: "Artist".to_owned(),
                    }),
                    failure: None,
                },
            }),
            Arc::new(FakeResolver),
        ));
        let session = PlaybackSession::with_ports_and_local_music(
            queue,
            playback,
            None,
            None,
            Some(Arc::new(LocalMusicService::new(local_root.clone()))),
        );

        let result = session.delete_local_track(current_id).expect("delete");
        assert!(result.auto_play_started);
        assert_eq!(result.session.queue.selected_index, Some(0));
        assert_eq!(result.session.queue.items[0].id, previous_id);
        assert_eq!(result.session.player.state, PlayerState::Playing);
        assert_eq!(
            result
                .session
                .player
                .current_track
                .as_ref()
                .map(|track| track.id.as_str()),
            Some(previous_id)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn queue_persistence_failure_rolls_back_prepared_local_file() {
        let root = std::env::temp_dir().join(format!("qqmusic-delete-session-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("root");
        let local_root = root.join("local-music");
        fs::create_dir_all(&local_root).expect("local root");
        let local_id = "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_mp3";
        let local_path = local_root.join(format!("{}.mp3", &local_id[6..70]));
        fs::write(&local_path, b"audio").expect("audio");
        let database_path = root.join("state.sqlite3");
        let queue = Arc::new(QueueService::open(&database_path).expect("queue"));
        queue
            .replace(vec![queue_track(local_id), queue_track("remote")])
            .expect("queue seed");
        queue.select(1).expect("select remote");
        let blocker = rusqlite::Connection::open(&database_path).expect("open blocker");
        blocker
            .execute_batch("BEGIN IMMEDIATE")
            .expect("hold persistence writer lock");
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(CountingProvider {
                requests: Arc::new(AtomicUsize::new(0)),
            }),
            Box::new(EventPlayer {
                snapshot: PlayerSnapshot {
                    state: PlayerState::Playing,
                    generation: 1,
                    position_ms: 12,
                    duration_ms: Some(100),
                    volume: 1.0,
                    muted: false,
                    current_track: Some(TrackSummary {
                        source: None,
                        id: "remote".to_owned(),
                        title: "Remote".to_owned(),
                        artist: "Artist".to_owned(),
                    }),
                    failure: None,
                },
                events: Mutex::new(VecDeque::new()),
            }),
            Arc::new(FakeResolver),
        ));
        let session = PlaybackSession::with_ports_and_local_music(
            queue,
            playback,
            None,
            None,
            Some(Arc::new(LocalMusicService::new(local_root.clone()))),
        );

        assert_eq!(
            session.delete_local_track(local_id),
            Err(PlaybackSessionError::LocalMusic(
                LocalMusicError::DeleteFailed
            ))
        );
        assert!(local_path.exists());
        assert_eq!(session.snapshot().queue.items.len(), 2);
        blocker.execute_batch("ROLLBACK").expect("release lock");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deleting_non_current_local_track_does_not_stop_current_player() {
        let root = std::env::temp_dir().join(format!("qqmusic-delete-session-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("root");
        let local_root = root.join("local-music");
        fs::create_dir_all(&local_root).expect("local root");
        let local_id = "local_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789_mp3";
        fs::write(
            local_root.join(format!("{}.mp3", &local_id[6..70])),
            b"audio",
        )
        .expect("audio");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("queue"));
        queue
            .replace(vec![queue_track(local_id), queue_track("remote")])
            .expect("queue seed");
        queue.select(1).expect("select remote");
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(CountingProvider {
                requests: Arc::new(AtomicUsize::new(0)),
            }),
            Box::new(EventPlayer {
                snapshot: PlayerSnapshot {
                    state: PlayerState::Playing,
                    generation: 1,
                    position_ms: 12,
                    duration_ms: Some(100),
                    volume: 1.0,
                    muted: false,
                    current_track: Some(TrackSummary {
                        source: None,
                        id: "remote".to_owned(),
                        title: "Remote".to_owned(),
                        artist: "Artist".to_owned(),
                    }),
                    failure: None,
                },
                events: Mutex::new(VecDeque::new()),
            }),
            Arc::new(FakeResolver),
        ));
        let session = PlaybackSession::with_ports_and_local_music(
            queue,
            playback,
            None,
            None,
            Some(Arc::new(LocalMusicService::new(local_root.clone()))),
        );

        let result = session.delete_local_track(local_id).expect("delete");
        assert!(!result.auto_play_started);
        assert_eq!(result.session.player.state, PlayerState::Playing);
        assert_eq!(
            result
                .session
                .player
                .current_track
                .as_ref()
                .map(|track| track.id.as_str()),
            Some("remote")
        );
        assert_eq!(result.session.queue.items.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_success_is_not_rolled_back_when_adjusted_autoplay_fails() {
        let root = std::env::temp_dir().join(format!("qqmusic-delete-session-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("root");
        let local_root = root.join("local-music");
        fs::create_dir_all(&local_root).expect("local root");
        let local_id = "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_mp3";
        let local_path = local_root.join(format!("{}.mp3", &local_id[6..70]));
        fs::write(&local_path, b"audio").expect("audio");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("queue"));
        queue
            .replace(vec![queue_track(local_id), queue_track("remote")])
            .expect("queue seed");
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(CountingProvider {
                requests: Arc::new(AtomicUsize::new(0)),
            }),
            Box::new(EventPlayer {
                snapshot: PlayerSnapshot {
                    state: PlayerState::Playing,
                    generation: 1,
                    position_ms: 12,
                    duration_ms: Some(100),
                    volume: 1.0,
                    muted: false,
                    current_track: Some(TrackSummary {
                        source: None,
                        id: local_id.to_owned(),
                        title: "Local".to_owned(),
                        artist: "Artist".to_owned(),
                    }),
                    failure: None,
                },
                events: Mutex::new(VecDeque::new()),
            }),
            Arc::new(FakeResolver),
        ));
        let session = PlaybackSession::with_ports_and_local_music(
            queue,
            playback,
            None,
            None,
            Some(Arc::new(LocalMusicService::new(local_root))),
        );

        let result = session
            .delete_local_track(local_id)
            .expect("delete succeeds");
        assert!(!result.auto_play_started);
        assert!(!local_path.exists());
        assert_eq!(result.session.queue.items.len(), 1);
        assert_eq!(result.session.queue.items[0].id, "remote");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn auto_uses_session_default_and_explicit_quality_does_not_replace_it() {
        let root = std::env::temp_dir().join(format!("qqmusic-quality-default-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create quality root");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("open queue"));
        queue.replace(vec![queue_track("one")]).expect("seed queue");
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(SuccessfulProvider {
                track_id: "one",
                requests: Arc::new(AtomicUsize::new(0)),
            }),
            Box::new(EndedPlayer {
                snapshot: PlayerSnapshot::idle(),
            }),
            Arc::new(FakeResolver),
        ));
        let session = PlaybackSession::with_default_quality(queue, playback, PlaybackQuality::Flac);

        let automatic = session
            .play_index(0, PlaybackQuality::Auto)
            .expect("auto play");
        assert_eq!(automatic.requested_quality, "flac");
        assert_eq!(session.default_quality(), PlaybackQuality::Flac);

        let explicit = session
            .play_index(0, PlaybackQuality::Kbps128)
            .expect("explicit play");
        assert_eq!(explicit.requested_quality, "128k");
        assert_eq!(session.default_quality(), PlaybackQuality::Flac);
        assert_eq!(session.snapshot().requested_quality, "128k");

        drop(session);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn quality_change_restores_position_and_paused_transport_state() {
        let root = std::env::temp_dir().join(format!("qqmusic-quality-reload-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create quality reload root");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("open queue"));
        queue.replace(vec![queue_track("one")]).expect("seed queue");
        queue.select(0).expect("select queue item");
        let seeks = Arc::new(Mutex::new(Vec::new()));
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(SuccessfulProvider {
                track_id: "one",
                requests: Arc::new(AtomicUsize::new(0)),
            }),
            Box::new(RecoveryPlayer {
                snapshot: Mutex::new(PlayerSnapshot {
                    state: PlayerState::Paused,
                    generation: 1,
                    position_ms: 1_234,
                    duration_ms: Some(10_000),
                    volume: 1.0,
                    muted: false,
                    current_track: Some(TrackSummary {
                        source: None,
                        id: "one".to_owned(),
                        title: "Track one".to_owned(),
                        artist: "Artist".to_owned(),
                    }),
                    failure: None,
                }),
                events: Arc::new(Mutex::new(VecDeque::from([
                    NativePlayerEvent::Opened { generation: 2 },
                    NativePlayerEvent::Opened { generation: 3 },
                ]))),
                seeks: seeks.clone(),
            }),
            Arc::new(FakeResolver),
        ));
        let session = PlaybackSession::new(queue, playback);

        let result = session
            .change_quality(PlaybackQuality::Kbps128)
            .expect("change quality");
        assert_eq!(result.requested_quality, "128k");
        assert_ne!(result.playback.player.state, PlayerState::Playing);
        let repeated = session
            .change_quality(PlaybackQuality::Kbps320)
            .expect("repeat while loading");
        assert_ne!(repeated.playback.player.state, PlayerState::Playing);
        assert!(!session.pending_resume.lock().unwrap().unwrap().resume_play);
        session.handle_native_events();
        assert_eq!(
            *seeks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            vec![1_234]
        );
        assert_eq!(session.snapshot().player.state, PlayerState::Paused);

        drop(session);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unavailable_auto_advance_stops_at_end_without_retrying_the_same_song() {
        let test = TestSession::ended();
        assert_eq!(
            test.session.advance_if_ended(),
            Err(PlaybackSessionError::Playback(PlaybackError::Unavailable))
        );
        assert_eq!(test.session.advance_if_ended(), Ok(None));
        assert_eq!(test.requests.load(Ordering::SeqCst), 1);
        assert!(test.session.skip_notice().unwrap().exhausted);
        assert!(test.session.auto_advance_retry.lock().unwrap().is_none());
    }

    #[test]
    fn shortcut_toggle_starts_restored_selection_and_handles_empty_queue() {
        for local in [false, true] {
            let test = SeekSession::restored(local);
            assert!(test.session.snapshot().player.current_track.is_none());
            let player = test.session.toggle_playback().unwrap();
            // This fake engine starts transport synchronously, unlike the seek resume path.
            assert_eq!(player.state, PlayerState::Playing);
            assert_eq!(
                player.current_track.unwrap().id,
                test.session.snapshot().queue.items[1].id
            );
            assert_eq!(test.session.snapshot().queue.selected_index, Some(1));
            assert_eq!(test.requests.load(Ordering::SeqCst), usize::from(!local));
            assert_eq!(
                test.session.toggle_playback().unwrap().state,
                PlayerState::Paused
            );
            assert_eq!(
                test.session.toggle_playback().unwrap().state,
                PlayerState::Playing
            );
        }
        let test = SeekSession::restored(false);
        test.session.replace_queue(vec![]).unwrap();
        assert_eq!(
            test.session.toggle_playback().unwrap().state,
            PlayerState::Idle
        );
        assert_eq!(test.requests.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn shortcut_toggle_uses_serial_transport_and_pauses_loading() {
        for state in [
            PlayerState::Paused,
            PlayerState::Playing,
            PlayerState::Loading,
            PlayerState::Ended,
        ] {
            let root = std::env::temp_dir().join(format!("qqmusic-toggle-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).unwrap());
            let requests = Arc::new(AtomicUsize::new(0));
            let playback = Arc::new(PlaybackController::with_resolver(
                Arc::new(CountingProvider {
                    requests: requests.clone(),
                }),
                Box::new(EventPlayer {
                    snapshot: PlayerSnapshot {
                        state,
                        current_track: Some(TrackSummary {
                            source: None,
                            id: "one".into(),
                            title: "Track one".into(),
                            artist: "Artist".into(),
                        }),
                        ..PlayerSnapshot::idle()
                    },
                    events: Mutex::new(VecDeque::new()),
                }),
                Arc::new(FakeResolver),
            ));
            let session = PlaybackSession::new(queue, playback);
            let expected = if matches!(state, PlayerState::Playing | PlayerState::Loading) {
                PlayerState::Paused
            } else {
                PlayerState::Playing
            };
            assert_eq!(session.toggle_playback().unwrap().state, expected);
            thread::scope(|scope| {
                for _ in 0..10 {
                    scope.spawn(|| {
                        session.toggle_playback().unwrap();
                    });
                }
            });
            assert_eq!(session.snapshot().player.state, expected);
            assert_eq!(requests.load(Ordering::SeqCst), 0);
            drop(session);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn shortcut_volume_steps_clamp_preserve_mute_and_persist() {
        let root = std::env::temp_dir().join(format!("qqmusic-volume-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).unwrap());
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(CountingProvider {
                requests: Arc::new(AtomicUsize::new(0)),
            }),
            Box::new(EventPlayer {
                snapshot: PlayerSnapshot {
                    muted: true,
                    ..PlayerSnapshot::idle()
                },
                events: Mutex::new(VecDeque::new()),
            }),
            Arc::new(FakeResolver),
        ));
        let session = PlaybackSession::new(queue.clone(), playback);
        session.set_volume(0.37).unwrap();
        assert!((session.adjust_volume(0.1).unwrap().volume - 0.47).abs() < 0.00001);
        assert!((session.adjust_volume(-0.1).unwrap().volume - 0.37).abs() < 0.00001);
        session.set_volume(0.96).unwrap();
        assert_eq!(session.adjust_volume(0.1).unwrap().volume, 1.0);
        session.set_volume(0.04).unwrap();
        assert_eq!(session.adjust_volume(-0.1).unwrap().volume, 0.0);
        assert_eq!(session.adjust_volume(-0.1).unwrap().volume, 0.0);

        // Parallel button presses must not read the same stale volume and lose steps.
        thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    session.adjust_volume(0.1).unwrap();
                });
            }
        });
        assert!((session.snapshot().player.volume - 0.8).abs() < 0.00001);
        assert!(session.snapshot().player.muted);
        let saved = queue.load_playback_preferences().unwrap().1;
        assert!((saved - 0.8).abs() < 0.00001);
        drop(session);
        drop(queue);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_restores_selection_mode_and_volume_without_autoplay() {
        let root = std::env::temp_dir().join(format!("qqmusic-resume-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let make_session = || {
            let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).unwrap());
            let playback = Arc::new(PlaybackController::with_resolver(
                Arc::new(CountingProvider {
                    requests: requests.clone(),
                }),
                Box::new(EventPlayer {
                    snapshot: PlayerSnapshot::idle(),
                    events: Mutex::new(VecDeque::new()),
                }),
                Arc::new(FakeResolver),
            ));
            PlaybackSession::new(queue, playback)
        };
        let session = make_session();
        session
            .queue
            .replace(vec![queue_track("one"), queue_track("two")])
            .unwrap();
        session.queue.select(1).unwrap();
        session.set_mode(PlaybackMode::Shuffle).unwrap();
        session.set_volume(0.37).unwrap();
        drop(session);
        let restored = make_session();
        let snapshot = restored.snapshot();
        assert_eq!(snapshot.queue.selected_index, Some(1));
        assert_eq!(snapshot.mode, PlaybackMode::Shuffle);
        assert_eq!(snapshot.player.volume, 0.37);
        assert_eq!(snapshot.player.state, PlayerState::Idle);
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        drop(restored);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn non_ended_auto_advance_uses_cached_snapshot_only() {
        let root = std::env::temp_dir().join(format!("qqmusic-cached-snapshot-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create cached snapshot root");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("open queue"));
        let snapshots = Arc::new(AtomicUsize::new(0));
        let cached_snapshots = Arc::new(AtomicUsize::new(0));
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(CountingProvider {
                requests: Arc::new(AtomicUsize::new(0)),
            }),
            Box::new(CountingPlayer {
                snapshot: PlayerSnapshot {
                    state: PlayerState::Playing,
                    ..PlayerSnapshot::idle()
                },
                snapshots: snapshots.clone(),
                cached_snapshots: cached_snapshots.clone(),
            }),
            Arc::new(FakeResolver),
        ));
        let session = PlaybackSession::new(queue, playback);

        // Initialization restores volume before the polling measurement.
        snapshots.store(0, Ordering::SeqCst);
        cached_snapshots.store(0, Ordering::SeqCst);
        assert_eq!(session.advance_if_ended(), Ok(None));
        assert_eq!(cached_snapshots.load(Ordering::SeqCst), 1);
        assert_eq!(snapshots.load(Ordering::SeqCst), 0);

        drop(session);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manual_stop_clears_failure_notice_and_pending_skip() {
        let test = TestSession::ended();
        assert_eq!(
            test.session.advance_if_ended(),
            Err(PlaybackSessionError::Playback(PlaybackError::Unavailable))
        );
        assert!(test.session.skip_notice().is_some());
        let _ = test.session.stop();
        assert!(test.session.auto_advance_retry.lock().unwrap().is_none());
        assert!(test.session.skip_notice().is_none());
    }

    #[test]
    fn successful_play_submits_smtc_assets_for_real_generation_and_stop_clears_them() {
        let root = std::env::temp_dir().join(format!("qqmusic-artwork-port-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create artwork root");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("open queue"));
        let mut track = queue_track("one");
        track.cover_cache_key = Some("cover-one".to_owned());
        queue.replace(vec![track]).expect("seed queue");
        let requests = Arc::new(AtomicUsize::new(0));
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(SuccessfulProvider {
                track_id: "one",
                requests,
            }),
            Box::new(EndedPlayer {
                snapshot: PlayerSnapshot::idle(),
            }),
            Arc::new(FakeResolver),
        ));
        let artwork = Arc::new(RecordingArtworkPort::default());
        let dynamic_lyrics = Arc::new(RecordingDynamicLyricsPort::default());
        let session = PlaybackSession::with_ports(
            queue,
            playback,
            Some(artwork.clone() as Arc<dyn SmtcArtworkPort>),
            Some(dynamic_lyrics.clone() as Arc<dyn SmtcDynamicLyricsPort>),
        );

        let result = session
            .play_index(0, PlaybackQuality::Auto)
            .expect("play with artwork");
        assert_eq!(result.playback.player.generation, 1);
        assert_eq!(
            *artwork.requests.lock().expect("artwork requests"),
            vec![(1, Some("cover-one".to_owned()))]
        );
        assert_eq!(
            *dynamic_lyrics.requests.lock().expect("lyrics requests"),
            vec![("one".to_owned(), 1)]
        );
        assert_eq!(session.requested_quality(), Some(PlaybackQuality::Kbps320));

        session.stop().expect("stop");
        assert_eq!(session.requested_quality(), None);
        assert_eq!(session.snapshot().requested_quality, "320k");
        assert_eq!(artwork.clears.load(Ordering::SeqCst), 1);
        assert_eq!(dynamic_lyrics.clears.load(Ordering::SeqCst), 1);
        drop(session);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_track_uses_the_same_session_without_calling_provider_or_online_assets() {
        const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let root = std::env::temp_dir().join(format!("qqmusic-local-session-{}", Uuid::new_v4()));
        let local_root = root.join("local-music");
        fs::create_dir_all(&local_root).expect("create local session root");
        fs::write(local_root.join(format!("{HASH}.mp3")), b"local fixture")
            .expect("write local session fixture");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("open queue"));
        let local_id = format!("local_{HASH}_mp3");
        queue
            .replace(vec![QueueTrack {
                id: local_id.clone(),
                media_mid: None,
                title: "Local track".to_owned(),
                artist: "Local artist".to_owned(),
                album: "Local album".to_owned(),
                duration_ms: 1_000,
                cover_cache_key: None,
            }])
            .expect("seed local queue");
        let requests = Arc::new(AtomicUsize::new(0));
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(CountingProvider {
                requests: requests.clone(),
            }),
            Box::new(EndedPlayer {
                snapshot: PlayerSnapshot::idle(),
            }),
            Arc::new(FakeResolver),
        ));
        let artwork = Arc::new(RecordingArtworkPort::default());
        let dynamic_lyrics = Arc::new(RecordingDynamicLyricsPort::default());
        let local_music = Arc::new(LocalMusicService::new(local_root));
        let session = PlaybackSession::with_ports_and_local_music(
            queue,
            playback,
            Some(artwork.clone() as Arc<dyn SmtcArtworkPort>),
            Some(dynamic_lyrics.clone() as Arc<dyn SmtcDynamicLyricsPort>),
            Some(local_music),
        );

        let result = session
            .play_index(0, PlaybackQuality::Auto)
            .expect("play local track");

        assert_eq!(result.playback.quality, "local");
        assert_eq!(result.playback.expires_in_seconds, 0);
        assert_eq!(result.playback.player.current_track.unwrap().id, local_id);
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        assert_eq!(artwork.requests.lock().unwrap().as_slice(), &[]);
        assert_eq!(dynamic_lyrics.requests.lock().unwrap().as_slice(), &[]);
        assert_eq!(artwork.clears.load(Ordering::SeqCst), 1);
        assert_eq!(dynamic_lyrics.clears.load(Ordering::SeqCst), 1);
        assert_eq!(session.requested_quality(), None);

        drop(session);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn transport_pause_is_consumed_by_the_same_serial_session_boundary() {
        let root = std::env::temp_dir().join(format!("qqmusic-smtc-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create smtc root");
        let queue =
            Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("open smtc queue"));
        let requests = Arc::new(AtomicUsize::new(0));
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(CountingProvider {
                requests: requests.clone(),
            }),
            Box::new(EventPlayer {
                snapshot: PlayerSnapshot {
                    state: PlayerState::Playing,
                    generation: 1,
                    position_ms: 123,
                    duration_ms: Some(1_000),
                    volume: 1.0,
                    muted: false,
                    current_track: Some(TrackSummary {
                        source: None,
                        id: "one".to_owned(),
                        title: "Track one".to_owned(),
                        artist: "Artist".to_owned(),
                    }),
                    failure: None,
                },
                events: Mutex::new(VecDeque::from([NativePlayerEvent::TransportPause])),
            }),
            Arc::new(FakeResolver),
        ));
        let session = PlaybackSession::new(queue, playback);

        session.handle_native_events();

        assert_eq!(session.snapshot().player.state, PlayerState::Paused);
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        drop(session);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn late_resolution_is_superseded_and_only_the_latest_intent_loads() {
        let root = std::env::temp_dir().join(format!("qqmusic-intent-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create intent root");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("open queue"));
        queue
            .replace(vec![queue_track("one"), queue_track("two")])
            .expect("seed queue");
        let provider = Arc::new(OutOfOrderProvider {
            barrier: Barrier::new(2),
            requests: AtomicUsize::new(0),
        });
        let playback = Arc::new(PlaybackController::with_resolver(
            provider.clone(),
            Box::new(EndedPlayer {
                snapshot: PlayerSnapshot::idle(),
            }),
            Arc::new(FakeResolver),
        ));
        let session = Arc::new(PlaybackSession::new(queue, playback));
        let first = {
            let session = session.clone();
            thread::spawn(move || session.play_index(0, PlaybackQuality::Auto))
        };
        while provider.requests.load(Ordering::SeqCst) == 0 {
            thread::yield_now();
        }
        let second = {
            let session = session.clone();
            thread::spawn(move || session.play_index(1, PlaybackQuality::Auto))
        };

        assert!(second.join().expect("second thread").is_ok());
        assert_eq!(
            first.join().expect("first thread"),
            Err(PlaybackSessionError::Superseded)
        );
        assert_eq!(
            session.snapshot().player.current_track.expect("current").id,
            "two"
        );
        drop(session);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn twenty_rapid_intents_allow_only_one_latest_submission() {
        const INTENTS: usize = 20;
        let root = std::env::temp_dir().join(format!("qqmusic-burst-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create burst root");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("open queue"));
        queue.replace(vec![queue_track("one")]).expect("seed queue");
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(BurstProvider {
                barrier: Barrier::new(INTENTS),
            }),
            Box::new(EndedPlayer {
                snapshot: PlayerSnapshot::idle(),
            }),
            Arc::new(FakeResolver),
        ));
        let session = Arc::new(PlaybackSession::new(queue, playback));
        let workers = (0..INTENTS)
            .map(|_| {
                let session = session.clone();
                thread::spawn(move || session.play_index(0, PlaybackQuality::Auto))
            })
            .collect::<Vec<_>>();

        let results = workers
            .into_iter()
            .map(|worker| worker.join().expect("intent worker"))
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == Err(PlaybackSessionError::Superseded))
                .count(),
            INTENTS - 1
        );
        assert_eq!(session.snapshot().player.generation, 1);
        drop(session);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn network_failure_for_a_track_removed_from_queue_does_not_use_selected_index() {
        let root =
            std::env::temp_dir().join(format!("qqmusic-recovery-missing-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create recovery root");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("open queue"));
        queue.replace(vec![queue_track("new")]).expect("seed queue");
        let requests = Arc::new(AtomicUsize::new(0));
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(SuccessfulProvider {
                track_id: "new",
                requests: requests.clone(),
            }),
            Box::new(EventPlayer {
                snapshot: PlayerSnapshot {
                    state: PlayerState::Failed,
                    generation: 4,
                    position_ms: 12_345,
                    duration_ms: Some(60_000),
                    volume: 1.0,
                    muted: false,
                    current_track: Some(TrackSummary {
                        source: None,
                        id: "removed".to_owned(),
                        title: "Removed".to_owned(),
                        artist: "Artist".to_owned(),
                    }),
                    failure: None,
                },
                events: Mutex::new(VecDeque::from([NativePlayerEvent::Failed {
                    generation: 4,
                    failure: crate::player::PlayerFailure::new(PlayerFailureCode::Network, 4),
                }])),
            }),
            Arc::new(FakeResolver),
        ));
        let session = PlaybackSession::new(queue, playback);
        *session
            .active_source
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ActiveSource {
            generation: 4,
            intent: 0,
        });

        session.handle_native_events();

        assert_eq!(requests.load(Ordering::SeqCst), 0);
        drop(session);
        let _ = fs::remove_dir_all(root);
    }

    struct SeekSession {
        root: std::path::PathBuf,
        session: PlaybackSession,
        events: Arc<Mutex<VecDeque<NativePlayerEvent>>>,
        seeks: Arc<Mutex<Vec<u64>>>,
        requests: Arc<AtomicUsize>,
    }

    impl SeekSession {
        fn restored(local: bool) -> Self {
            let root = std::env::temp_dir().join(format!("qqmusic-cold-seek-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let database = root.join("state.sqlite3");
            let queue = QueueService::open(&database).unwrap();
            let local_id =
                "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_mp3";
            let id = if local { local_id } else { "one" };
            let mut track = queue_track(id);
            track.duration_ms = 60_000;
            queue.replace(vec![queue_track("other"), track]).unwrap();
            queue.select(1).unwrap();
            drop(queue);
            let queue = Arc::new(QueueService::open(&database).unwrap());
            let events = Arc::new(Mutex::new(VecDeque::new()));
            let seeks = Arc::new(Mutex::new(Vec::new()));
            let requests = Arc::new(AtomicUsize::new(0));
            let playback = Arc::new(PlaybackController::with_resolver(
                Arc::new(SuccessfulProvider {
                    track_id: "one",
                    requests: requests.clone(),
                }),
                Box::new(RecoveryPlayer {
                    snapshot: Mutex::new(PlayerSnapshot::idle()),
                    events: events.clone(),
                    seeks: seeks.clone(),
                }),
                Arc::new(FakeResolver),
            ));
            let local_root = root.join("local-music");
            fs::create_dir_all(&local_root).unwrap();
            if local {
                fs::write(
                    local_root.join(format!("{}.mp3", &local_id[6..70])),
                    b"audio",
                )
                .unwrap();
            }
            let session = PlaybackSession::with_ports_and_local_music(
                queue,
                playback,
                None,
                None,
                Some(Arc::new(LocalMusicService::new(local_root))),
            );
            Self {
                root,
                session,
                events,
                seeks,
                requests,
            }
        }

        fn opened(&self, generation: u64) {
            self.events
                .lock()
                .unwrap()
                .push_back(NativePlayerEvent::Opened { generation });
            self.session.handle_native_events();
        }
    }

    impl Drop for SeekSession {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn cold_seek_loads_restored_selection_then_plays_only_after_opened() {
        for local in [false, true] {
            let test = SeekSession::restored(local);
            assert_eq!(test.session.snapshot().player.current_track, None);
            assert_eq!(test.requests.load(Ordering::SeqCst), 0);
            let player = test.session.seek_generation(20_000, 0).unwrap();
            assert_eq!(player.state, PlayerState::Loading);
            assert_eq!(player.position_ms, 20_000);
            assert_eq!(test.session.snapshot().queue.selected_index, Some(1));
            assert!(test.seeks.lock().unwrap().is_empty());
            assert_eq!(test.requests.load(Ordering::SeqCst), usize::from(!local));
            test.opened(player.generation);
            assert_eq!(*test.seeks.lock().unwrap(), vec![20_000]);
            assert_eq!(test.session.snapshot().player.state, PlayerState::Playing);
            assert!(test.session.snapshot().player.failure.is_none());
        }
    }

    #[test]
    fn loading_seek_uses_latest_position_and_polling_preserves_it() {
        let test = SeekSession::restored(false);
        let player = test.session.seek(90_000).unwrap();
        assert_eq!(player.position_ms, 60_000);
        assert_eq!(test.session.seek(10_000).unwrap().position_ms, 10_000);
        assert_eq!(test.session.seek(35_000).unwrap().position_ms, 35_000);
        assert_eq!(
            test.session.snapshot_update(None).player.position_ms,
            35_000
        );
        assert!(test.seeks.lock().unwrap().is_empty());
        assert_eq!(test.requests.load(Ordering::SeqCst), 1);
        test.opened(player.generation);
        assert_eq!(*test.seeks.lock().unwrap(), vec![35_000]);
    }

    #[test]
    fn pause_during_pending_seek_is_preserved_when_opened_and_seeking_again() {
        let test = SeekSession::restored(false);
        let player = test.session.seek(20_000).unwrap();
        test.session.pause().unwrap();
        test.session.seek(30_000).unwrap();
        test.opened(player.generation);
        assert_eq!(*test.seeks.lock().unwrap(), vec![30_000]);
        assert_eq!(test.session.snapshot().player.state, PlayerState::Paused);
        test.session.seek(12_000).unwrap();
        assert_eq!(test.session.snapshot().player.state, PlayerState::Paused);
        test.session.play().unwrap();
        assert_eq!(test.session.snapshot().player.state, PlayerState::Playing);
        assert_eq!(test.session.snapshot().player.position_ms, 12_000);
    }

    #[test]
    fn superseded_seek_and_opened_event_do_not_seek_the_new_source() {
        let test = SeekSession::restored(false);
        let first = test.session.seek(20_000).unwrap();
        let new = test
            .session
            .play_index(1, PlaybackQuality::Auto)
            .unwrap()
            .playback
            .player;
        assert_ne!(new.generation, first.generation);
        assert_eq!(
            test.session.seek_generation(30_000, first.generation),
            Err(PlaybackSessionError::Superseded)
        );
        test.opened(first.generation);
        assert!(test.seeks.lock().unwrap().is_empty());
        test.opened(new.generation);
        assert!(test.seeks.lock().unwrap().is_empty());
    }

    #[test]
    fn network_resume_waits_for_matching_opened_event_before_seeking() {
        let root = std::env::temp_dir().join(format!("qqmusic-recovery-opened-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create recovery root");
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).expect("open queue"));
        queue.replace(vec![queue_track("one")]).expect("seed queue");
        let requests = Arc::new(AtomicUsize::new(0));
        let seeks = Arc::new(Mutex::new(Vec::new()));
        let playback = Arc::new(PlaybackController::with_resolver(
            Arc::new(SuccessfulProvider {
                track_id: "one",
                requests: requests.clone(),
            }),
            Box::new(RecoveryPlayer {
                snapshot: Mutex::new(PlayerSnapshot {
                    state: PlayerState::Failed,
                    generation: 4,
                    position_ms: 12_345,
                    duration_ms: Some(60_000),
                    volume: 1.0,
                    muted: false,
                    current_track: Some(TrackSummary {
                        source: None,
                        id: "one".to_owned(),
                        title: "Track one".to_owned(),
                        artist: "Artist".to_owned(),
                    }),
                    failure: None,
                }),
                events: Arc::new(Mutex::new(VecDeque::from([
                    NativePlayerEvent::Failed {
                        generation: 4,
                        failure: crate::player::PlayerFailure::new(PlayerFailureCode::Network, 4),
                    },
                    NativePlayerEvent::Opened { generation: 5 },
                ]))),
                seeks: seeks.clone(),
            }),
            Arc::new(FakeResolver),
        ));
        let session = PlaybackSession::new(queue, playback);
        *session
            .active_source
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ActiveSource {
            generation: 4,
            intent: 0,
        });

        session.handle_native_events();

        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert_eq!(
            *seeks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            vec![12_345]
        );
        assert_eq!(session.snapshot().player.state, PlayerState::Playing);
        drop(session);
        let _ = fs::remove_dir_all(root);
    }
}
