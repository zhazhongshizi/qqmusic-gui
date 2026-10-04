use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender},
        Arc, Mutex, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use windows::{
    core::{IInspectable, IUnknown, Interface, HSTRING},
    Foundation::{TimeSpan, TypedEventHandler, Uri},
    Media::{
        Core::MediaSource,
        MediaPlaybackStatus, MediaPlaybackType,
        Playback::{
            IMediaPlaybackSource, MediaPlaybackSession, MediaPlaybackState, MediaPlayer,
            MediaPlayerError, MediaPlayerFailedEventArgs,
        },
        SystemMediaTransportControls, SystemMediaTransportControlsButton,
        SystemMediaTransportControlsButtonPressedEventArgs,
        SystemMediaTransportControlsTimelineProperties,
    },
    Storage::{StorageFile, Streams::RandomAccessStreamReference},
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};

use super::{
    LocalMediaFile, NativePlayerEvent, PlayerCommand, PlayerEngine, PlayerError, PlayerFailure,
    PlayerFailureCode, PlayerSnapshot, PlayerState, SmtcArtworkFile, SmtcLyricLine,
    SmtcLyricTimeline, SmtcMetadata, TrackSummary,
};

const WINDOWS_TICKS_PER_MILLISECOND: i64 = 10_000;
const POSITION_SAMPLE_TIMEOUT: Duration = Duration::from_millis(50);
const DYNAMIC_LYRICS_WATCHDOG_INTERVAL: Duration = Duration::from_secs(30);
const DYNAMIC_LYRICS_EARLY_WAKE_BACKOFFS: [Duration; 3] = [
    Duration::from_millis(10),
    Duration::from_millis(50),
    Duration::from_millis(250),
];

pub struct WindowsMediaPlayerEngine {
    commands: Sender<EngineMessage>,
    snapshot: Arc<RwLock<PlayerSnapshot>>,
    position_sample_in_flight: Arc<AtomicBool>,
    events: Receiver<NativePlayerEvent>,
    worker: Option<JoinHandle<()>>,
}

impl WindowsMediaPlayerEngine {
    pub fn new() -> Result<Self, PlayerError> {
        let (commands, command_receiver) = mpsc::channel();
        let (events, event_receiver) = mpsc::channel();
        let (startup, startup_receiver) = mpsc::sync_channel(1);
        let snapshot = Arc::new(RwLock::new(PlayerSnapshot::idle()));
        let position_sample_in_flight = Arc::new(AtomicBool::new(false));
        let worker_snapshot = Arc::clone(&snapshot);
        let worker_commands = commands.clone();
        let worker = thread::Builder::new()
            .name("qqmusic-native-player".to_owned())
            .spawn(move || {
                NativeWorker::run(
                    command_receiver,
                    worker_commands,
                    events,
                    startup,
                    worker_snapshot,
                );
            })
            .map_err(|_| PlayerError::NativeUnavailable)?;
        startup_receiver
            .recv()
            .unwrap_or(Err(PlayerError::NativeUnavailable))?;
        Ok(Self {
            commands,
            snapshot,
            position_sample_in_flight,
            events: event_receiver,
            worker: Some(worker),
        })
    }

    pub fn try_event(&self) -> Option<NativePlayerEvent> {
        self.events.try_recv().ok()
    }
}

impl PlayerEngine for WindowsMediaPlayerEngine {
    fn snapshot(&self) -> PlayerSnapshot {
        if try_start_position_sample(&self.position_sample_in_flight) {
            let (reply, receiver) = mpsc::sync_channel(1);
            let in_flight = Arc::clone(&self.position_sample_in_flight);
            if self
                .commands
                .send(EngineMessage::SamplePosition { reply, in_flight })
                .is_err()
            {
                self.position_sample_in_flight
                    .store(false, Ordering::Release);
            } else {
                let _ = receiver.recv_timeout(POSITION_SAMPLE_TIMEOUT);
            }
        }
        self.snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn cached_snapshot(&self) -> PlayerSnapshot {
        self.snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn handle(&mut self, command: PlayerCommand) -> Result<(), PlayerError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.commands
            .send(EngineMessage::Command { command, reply })
            .map_err(|_| PlayerError::EngineStopped)?;
        receiver.recv().unwrap_or(Err(PlayerError::EngineStopped))
    }

    fn try_event(&self) -> Option<NativePlayerEvent> {
        WindowsMediaPlayerEngine::try_event(self)
    }
}

impl Drop for WindowsMediaPlayerEngine {
    fn drop(&mut self) {
        let _ = self.commands.send(EngineMessage::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

enum EngineMessage {
    Command {
        command: PlayerCommand,
        reply: SyncSender<Result<(), PlayerError>>,
    },
    SamplePosition {
        reply: SyncSender<Result<(), PlayerError>>,
        in_flight: Arc<AtomicBool>,
    },
    RecalibrateDynamicLyrics {
        generation: u64,
    },
    Shutdown,
}

struct EventTokens {
    source: Option<SourceEventTokens>,
    smtc_button_pressed: i64,
}

#[derive(Default)]
struct SourceEventTokens {
    identity: Option<SourceIdentity>,
    opened: Option<i64>,
    ended: Option<i64>,
    failed: Option<i64>,
    state_changed: Option<i64>,
    position_changed: Option<i64>,
    duration_changed: Option<i64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct SourceIdentity(usize);

impl SourceIdentity {
    fn new(source: &MediaSource) -> Result<Self, PlayerError> {
        source
            .cast::<IUnknown>()
            .map(|identity| Self(identity.as_raw() as usize))
            .map_err(|_| PlayerError::NativeFailure)
    }

    fn is_current(&self, player: &MediaPlayer) -> bool {
        player
            .Source()
            .ok()
            .and_then(|source: IMediaPlaybackSource| source.cast::<IUnknown>().ok())
            .is_some_and(|current| current.as_raw() as usize == self.0)
    }
}

struct NativeWorker {
    player: MediaPlayer,
    commands: Sender<EngineMessage>,
    snapshot: Arc<RwLock<PlayerSnapshot>>,
    events: Sender<NativePlayerEvent>,
    tokens: EventTokens,
    smtc: SystemMediaTransportControls,
    initial_timeline_duration_ms: Option<u64>,
    _current_media_source: Option<MediaSource>,
    _current_local_file: Option<StorageFile>,
    artwork_file: Option<StorageFile>,
    artwork_reference: Option<RandomAccessStreamReference>,
    artwork_epoch: u64,
    dynamic_lyrics: DynamicLyricsDisplayState,
    dynamic_lyrics_schedule: DynamicLyricsSchedule,
    timeline_gate: Arc<Mutex<TimelinePublishGate>>,
}

#[derive(Debug, Default)]
struct TimelinePublishGate {
    generation: Option<u64>,
    duration_ms: Option<u64>,
    position_ms: Option<u64>,
    last_success_at: Option<Instant>,
}

impl TimelinePublishGate {
    fn begin_generation(&mut self, generation: u64) {
        self.generation = Some(generation);
        self.duration_ms = None;
        self.position_ms = None;
        self.last_success_at = None;
    }

    fn should_publish(
        &self,
        generation: u64,
        duration_ms: Option<u64>,
        position_ms: u64,
        now: Instant,
        force: bool,
    ) -> bool {
        if self.generation != Some(generation) {
            return false;
        }
        if force || self.duration_ms != duration_ms || self.position_ms.is_none() {
            return true;
        }
        if self.position_ms == Some(position_ms) {
            return false;
        }
        self.last_success_at
            .is_none_or(|last| now.saturating_duration_since(last) >= TIMELINE_PUBLISH_INTERVAL)
    }

    fn record_success(
        &mut self,
        generation: u64,
        duration_ms: Option<u64>,
        position_ms: u64,
        published_at: Instant,
    ) {
        if self.generation == Some(generation) {
            self.duration_ms = duration_ms;
            self.position_ms = Some(position_ms);
            self.last_success_at = Some(published_at);
        }
    }
}

const TIMELINE_PUBLISH_INTERVAL: Duration = Duration::from_millis(1_000);

#[derive(Debug, Clone, PartialEq, Eq)]
struct NormalSmtcText {
    title: String,
    artist: String,
    album: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PublishedSmtcText {
    Normal,
    Lyric(usize),
}

#[derive(Debug, Default)]
struct DynamicLyricsDisplayState {
    generation: u64,
    lyrics_epoch: u64,
    normal: Option<NormalSmtcText>,
    timeline: Option<SmtcLyricTimeline>,
    published: Option<PublishedSmtcText>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct DynamicLyricsSchedule {
    generation: u64,
    lyrics_epoch: u64,
    lyric_deadline: Option<Instant>,
    watchdog_deadline: Option<Instant>,
    boundary_ms: Option<u64>,
    early_wake_attempts: u8,
    last_position_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DynamicLyricsWakeReason {
    LyricBoundary,
    Watchdog,
    Command,
    PlaybackState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DynamicLyricsDeadlineKind {
    Lyric,
    Watchdog,
}

impl DynamicLyricsDisplayState {
    fn reset_for_track(
        &mut self,
        generation: u64,
        track: &crate::player::TrackSummary,
        metadata: &SmtcMetadata,
    ) {
        self.generation = generation;
        self.lyrics_epoch = 0;
        self.normal = Some(NormalSmtcText {
            title: track.title.clone(),
            artist: track.artist.clone(),
            album: metadata.album().unwrap_or_default().to_owned(),
        });
        self.timeline = None;
        self.published = None;
    }

    fn clear(&mut self) {
        *self = Self::default();
    }

    fn set_timeline(&mut self, lyrics_epoch: u64, timeline: SmtcLyricTimeline) {
        self.lyrics_epoch = lyrics_epoch;
        self.timeline = Some(timeline);
        if matches!(self.published, Some(PublishedSmtcText::Lyric(_))) {
            self.published = None;
        }
    }
}

impl NativeWorker {
    fn run(
        commands: Receiver<EngineMessage>,
        command_sender: Sender<EngineMessage>,
        events: Sender<NativePlayerEvent>,
        startup: SyncSender<Result<(), PlayerError>>,
        snapshot: Arc<RwLock<PlayerSnapshot>>,
    ) {
        // SAFETY: this dedicated worker balances a successful WinRT initialization with
        // RoUninitialize on the same thread and owns every MediaPlayer call.
        if unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_err() {
            let _ = startup.send(Err(PlayerError::NativeUnavailable));
            return;
        }
        let worker = Self::create(Arc::clone(&snapshot), events, command_sender);
        let mut worker = match worker {
            Ok(worker) => {
                let _ = startup.send(Ok(()));
                worker
            }
            Err(error) => {
                let _ = startup.send(Err(error));
                // SAFETY: balances the successful RoInitialize above.
                unsafe { RoUninitialize() };
                return;
            }
        };

        loop {
            let deadline = worker.next_dynamic_lyrics_deadline();
            match deadline {
                None => match commands.recv() {
                    Ok(message) => {
                        if worker.handle_message(message) {
                            break;
                        }
                    }
                    Err(_) => break,
                },
                Some((deadline, _)) => {
                    let timeout = deadline.saturating_duration_since(Instant::now());
                    match commands.recv_timeout(timeout) {
                        Ok(message) => {
                            if worker.handle_message(message) {
                                break;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            // Commands already queued at the same deadline have priority over
                            // a lyric/watchdog wake-up.
                            match commands.try_recv() {
                                Ok(message) => {
                                    if worker.handle_message(message) {
                                        break;
                                    }
                                }
                                Err(mpsc::TryRecvError::Empty) => {
                                    worker.handle_dynamic_lyrics_deadline(Instant::now());
                                }
                                Err(mpsc::TryRecvError::Disconnected) => break,
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            }
        }
        worker.close();
        // Release the MediaPlayer and handler references while the apartment is alive.
        drop(worker);
        // SAFETY: balances the successful RoInitialize above after WinRT objects drop.
        unsafe { RoUninitialize() };
    }

    fn create(
        snapshot: Arc<RwLock<PlayerSnapshot>>,
        events: Sender<NativePlayerEvent>,
        commands: Sender<EngineMessage>,
    ) -> Result<Self, PlayerError> {
        let player = MediaPlayer::new().map_err(|_| PlayerError::NativeUnavailable)?;
        player
            .CommandManager()
            .and_then(|manager| manager.SetIsEnabled(false))
            .map_err(|_| PlayerError::NativeFailure)?;
        player
            .SetAutoPlay(false)
            .map_err(|_| PlayerError::NativeFailure)?;
        player
            .SetVolume(1.0)
            .map_err(|_| PlayerError::NativeFailure)?;
        let smtc = player
            .SystemMediaTransportControls()
            .map_err(|_| PlayerError::NativeFailure)?;
        configure_smtc(&smtc)?;
        let timeline_gate = Arc::new(Mutex::new(TimelinePublishGate::default()));

        let smtc_events = events.clone();
        let smtc_button_pressed = smtc
            .ButtonPressed(&TypedEventHandler::<
                SystemMediaTransportControls,
                SystemMediaTransportControlsButtonPressedEventArgs,
            >::new(move |_, args| {
                if let Some(event) = args
                    .as_ref()
                    .and_then(|args| args.Button().ok())
                    .and_then(transport_event)
                {
                    let _ = smtc_events.send(event);
                }
                Ok(())
            }))
            .map_err(|_| PlayerError::NativeFailure)?;

        Ok(Self {
            player,
            commands,
            snapshot,
            events,
            tokens: EventTokens {
                source: None,
                smtc_button_pressed,
            },
            smtc,
            initial_timeline_duration_ms: None,
            _current_media_source: None,
            _current_local_file: None,
            artwork_file: None,
            artwork_reference: None,
            artwork_epoch: 0,
            dynamic_lyrics: DynamicLyricsDisplayState::default(),
            dynamic_lyrics_schedule: DynamicLyricsSchedule::default(),
            timeline_gate,
        })
    }

    fn handle_message(&mut self, message: EngineMessage) -> bool {
        match message {
            EngineMessage::Command { command, reply } => {
                let _ = reply.send(self.handle(command));
                false
            }
            EngineMessage::SamplePosition { reply, in_flight } => {
                let _ = reply.send(self.sample_position());
                in_flight.store(false, Ordering::Release);
                false
            }
            EngineMessage::RecalibrateDynamicLyrics { generation } => {
                if self.current_generation_matches(generation) {
                    self.recalibrate_dynamic_lyrics(
                        Instant::now(),
                        DynamicLyricsWakeReason::PlaybackState,
                    );
                }
                false
            }
            EngineMessage::Shutdown => true,
        }
    }

    fn next_dynamic_lyrics_deadline(&self) -> Option<(Instant, DynamicLyricsDeadlineKind)> {
        next_dynamic_lyrics_deadline(&self.dynamic_lyrics_schedule)
    }

    fn clear_dynamic_lyrics_schedule(&mut self) {
        self.dynamic_lyrics_schedule = DynamicLyricsSchedule::default();
    }

    fn ensure_dynamic_lyrics_schedule(&mut self, now: Instant, reset_lyric: bool) {
        let snapshot = self
            .snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let Some(timeline) = self.dynamic_lyrics.timeline.as_ref() else {
            self.clear_dynamic_lyrics_schedule();
            return;
        };
        if snapshot.state != PlayerState::Playing
            || snapshot.generation != self.dynamic_lyrics.generation
        {
            self.clear_dynamic_lyrics_schedule();
            return;
        }
        let next_boundary_ms = dynamic_lyrics_target(snapshot.position_ms, timeline).1;
        let same_context = self.dynamic_lyrics_schedule.generation == snapshot.generation
            && self.dynamic_lyrics_schedule.lyrics_epoch == self.dynamic_lyrics.lyrics_epoch;
        let position_advanced = self
            .dynamic_lyrics_schedule
            .last_position_ms
            .is_some_and(|last| snapshot.position_ms > last);
        let boundary_changed = self.dynamic_lyrics_schedule.boundary_ms != next_boundary_ms;
        if !same_context || self.dynamic_lyrics_schedule.watchdog_deadline.is_none() {
            self.dynamic_lyrics_schedule.generation = snapshot.generation;
            self.dynamic_lyrics_schedule.lyrics_epoch = self.dynamic_lyrics.lyrics_epoch;
            self.dynamic_lyrics_schedule.watchdog_deadline =
                Some(now + DYNAMIC_LYRICS_WATCHDOG_INTERVAL);
            self.dynamic_lyrics_schedule.early_wake_attempts = 0;
        } else if position_advanced || boundary_changed {
            self.dynamic_lyrics_schedule.early_wake_attempts = 0;
        }
        self.dynamic_lyrics_schedule.boundary_ms = next_boundary_ms;
        self.dynamic_lyrics_schedule.last_position_ms = Some(snapshot.position_ms);
        self.dynamic_lyrics_schedule.lyric_deadline = next_boundary_ms.map(|boundary| {
            now + Duration::from_millis(boundary.saturating_sub(snapshot.position_ms))
        });
        if reset_lyric {
            self.dynamic_lyrics_schedule.early_wake_attempts = 0;
        }
    }

    fn read_native_playback_sample(&self) -> Result<(MediaPlaybackState, u64), PlayerError> {
        let session = self
            .player
            .PlaybackSession()
            .map_err(|_| PlayerError::NativeFailure)?;
        let playback_state = session
            .PlaybackState()
            .map_err(|_| PlayerError::NativeFailure)?;
        let position_ms = session
            .Position()
            .map(|position| ticks_to_milliseconds(position.Duration))
            .map_err(|_| PlayerError::NativeFailure)?;
        Ok((playback_state, position_ms))
    }

    fn defer_dynamic_lyrics_to_watchdog(&mut self, now: Instant, snapshot: &PlayerSnapshot) {
        if snapshot.state != PlayerState::Playing
            || snapshot.generation != self.dynamic_lyrics.generation
            || self.dynamic_lyrics.timeline.is_none()
        {
            self.clear_dynamic_lyrics_schedule();
            return;
        }
        self.dynamic_lyrics_schedule = dynamic_lyrics_watchdog_fallback(
            &self.dynamic_lyrics_schedule,
            snapshot.generation,
            self.dynamic_lyrics.lyrics_epoch,
            now,
        );
    }

    fn recalibrate_dynamic_lyrics(&mut self, now: Instant, reason: DynamicLyricsWakeReason) {
        let snapshot = self
            .snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if snapshot.generation != self.dynamic_lyrics.generation {
            self.clear_dynamic_lyrics_schedule();
            return;
        }
        match snapshot.state {
            PlayerState::Idle | PlayerState::Ended | PlayerState::Failed => {
                let _ = restore_normal_smtc_text_with(
                    &mut self.dynamic_lyrics,
                    snapshot.generation,
                    |title, artist, album| {
                        update_smtc_music_properties(&self.smtc, title, artist, album)
                    },
                );
                self.clear_dynamic_lyrics_schedule();
            }
            PlayerState::Loading => {
                self.clear_dynamic_lyrics_schedule();
            }
            PlayerState::Paused | PlayerState::Playing => {
                let (native_state, position_ms) = match self.read_native_playback_sample() {
                    Ok(sample) => {
                        let position_ms = sample.1;
                        update_if_current(&self.snapshot, snapshot.generation, |state| {
                            state.position_ms = position_ms;
                        });
                        sample
                    }
                    Err(_) => {
                        self.defer_dynamic_lyrics_to_watchdog(now, &snapshot);
                        return;
                    }
                };
                if !matches!(
                    native_state,
                    MediaPlaybackState::Playing | MediaPlaybackState::Paused
                ) {
                    self.clear_dynamic_lyrics_schedule();
                    return;
                }
                let _ = update_dynamic_smtc_text_with(
                    &mut self.dynamic_lyrics,
                    snapshot.generation,
                    position_ms,
                    |title, artist, album| {
                        update_smtc_music_properties(&self.smtc, title, artist, album)
                    },
                );
                if snapshot.state == PlayerState::Playing
                    && native_state == MediaPlaybackState::Playing
                {
                    self.ensure_dynamic_lyrics_schedule(
                        now,
                        matches!(reason, DynamicLyricsWakeReason::Command),
                    );
                } else {
                    self.clear_dynamic_lyrics_schedule();
                }
                #[cfg(debug_assertions)]
                eprintln!(
                    "[smtc-dynamic-lyrics] recalibrate generation={} epoch={} reason={reason:?} position_ms={} schedule={}",
                    snapshot.generation,
                    self.dynamic_lyrics.lyrics_epoch,
                    position_ms,
                    self.next_dynamic_lyrics_deadline().is_some()
                );
            }
        }
    }

    fn handle_dynamic_lyrics_deadline(&mut self, now: Instant) {
        let Some((deadline, kind)) = self.next_dynamic_lyrics_deadline() else {
            return;
        };
        if deadline > now {
            return;
        }
        let snapshot = self
            .snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if snapshot.generation != self.dynamic_lyrics_schedule.generation
            || self.dynamic_lyrics.lyrics_epoch != self.dynamic_lyrics_schedule.lyrics_epoch
        {
            self.clear_dynamic_lyrics_schedule();
            return;
        }
        match kind {
            DynamicLyricsDeadlineKind::Watchdog => {
                self.dynamic_lyrics_schedule.watchdog_deadline =
                    Some(now + DYNAMIC_LYRICS_WATCHDOG_INTERVAL);
                self.recalibrate_dynamic_lyrics(now, DynamicLyricsWakeReason::Watchdog);
            }
            DynamicLyricsDeadlineKind::Lyric => {
                let Some(boundary_ms) = self.dynamic_lyrics_schedule.boundary_ms else {
                    self.dynamic_lyrics_schedule.lyric_deadline = None;
                    return;
                };
                let Ok((native_state, position_ms)) = self.read_native_playback_sample() else {
                    self.defer_dynamic_lyrics_to_watchdog(now, &snapshot);
                    return;
                };
                if native_state != MediaPlaybackState::Playing {
                    update_if_current(&self.snapshot, snapshot.generation, |state| {
                        state.position_ms = position_ms;
                    });
                    if native_state == MediaPlaybackState::Paused {
                        let _ = update_dynamic_smtc_text_with(
                            &mut self.dynamic_lyrics,
                            snapshot.generation,
                            position_ms,
                            |title, artist, album| {
                                update_smtc_music_properties(&self.smtc, title, artist, album)
                            },
                        );
                    }
                    self.clear_dynamic_lyrics_schedule();
                    return;
                }
                let previous_position = self.dynamic_lyrics_schedule.last_position_ms;
                if position_ms < boundary_ms {
                    match early_wake_decision(
                        self.dynamic_lyrics_schedule.early_wake_attempts,
                        previous_position,
                        position_ms,
                        boundary_ms,
                    ) {
                        EarlyWakeDecision::Retry(backoff) => {
                            self.dynamic_lyrics_schedule.early_wake_attempts += 1;
                            self.dynamic_lyrics_schedule.lyric_deadline = Some(now + backoff);
                        }
                        EarlyWakeDecision::Cancel | EarlyWakeDecision::Ready => {
                            if previous_position.is_some_and(|previous| position_ms > previous) {
                                self.dynamic_lyrics_schedule.early_wake_attempts = 0;
                                self.dynamic_lyrics_schedule.last_position_ms = Some(position_ms);
                                self.dynamic_lyrics_schedule.lyric_deadline = Some(
                                    now + Duration::from_millis(
                                        boundary_ms.saturating_sub(position_ms),
                                    ),
                                );
                            } else {
                                self.dynamic_lyrics_schedule.lyric_deadline = None;
                            }
                        }
                    }
                    return;
                }
                update_if_current(&self.snapshot, snapshot.generation, |state| {
                    state.position_ms = position_ms;
                });
                self.dynamic_lyrics_schedule.last_position_ms = Some(position_ms);
                self.dynamic_lyrics_schedule.early_wake_attempts = 0;
                let _ = update_dynamic_smtc_text_with(
                    &mut self.dynamic_lyrics,
                    snapshot.generation,
                    position_ms,
                    |title, artist, album| {
                        update_smtc_music_properties(&self.smtc, title, artist, album)
                    },
                );
                self.ensure_dynamic_lyrics_schedule(now, false);
                #[cfg(debug_assertions)]
                eprintln!(
                    "[smtc-dynamic-lyrics] recalibrate generation={} epoch={} reason={:?} position_ms={} schedule={}",
                    snapshot.generation,
                    self.dynamic_lyrics.lyrics_epoch,
                    DynamicLyricsWakeReason::LyricBoundary,
                    position_ms,
                    self.next_dynamic_lyrics_deadline().is_some()
                );
            }
        }
    }

    fn load_media_source(
        &mut self,
        source: MediaSource,
        local_file: Option<StorageFile>,
        track: TrackSummary,
        smtc_metadata: SmtcMetadata,
    ) -> Result<(), PlayerError> {
        let local = local_file.is_some();
        self.initial_timeline_duration_ms = smtc_metadata.duration_ms();
        self.clear_smtc_artwork();
        self.smtc
            .SetPlaybackStatus(MediaPlaybackStatus::Changing)
            .map_err(|_| PlayerError::NativeFailure)?;
        self.remove_source_events();
        let generation = update_snapshot(&self.snapshot, |state| {
            state.generation = state.generation.saturating_add(1);
            state.state = PlayerState::Loading;
            state.position_ms = 0;
            state.duration_ms = None;
            state.current_track = Some(track.clone());
            state.failure = None;
            state.generation
        });
        self.timeline_gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .begin_generation(generation);
        self.dynamic_lyrics
            .reset_for_track(generation, &track, &smtc_metadata);
        self.clear_dynamic_lyrics_schedule();
        self.player
            .SetSource(None)
            .map_err(|_| PlayerError::NativeFailure)?;
        self._current_media_source = None;
        self._current_local_file = None;
        self.bind_source_events(generation, &source, smtc_metadata.duration_ms())?;
        self.player.SetSource(&source).map_err(|_| {
            update_if_current(&self.snapshot, generation, |state| {
                state.state = PlayerState::Failed;
                state.failure = Some(PlayerFailure::new(
                    PlayerFailureCode::Unavailable,
                    generation,
                ));
            });
            PlayerError::NativeFailure
        })?;
        // Opening a StorageFile-backed MediaSource is asynchronous. Retain the
        // projected source and file until the next load so the backing objects
        // cannot be released before MediaOpened/MediaFailed completes.
        self._current_media_source = Some(source);
        self._current_local_file = local_file;
        #[cfg(debug_assertions)]
        eprintln!("[native-player] source-submitted generation={generation} local={local}");
        crate::file_logging::native_event("native_source_submitted", generation);
        // The media source can overwrite the updater, so publish metadata only
        // after SetSource has succeeded. SMTC is best effort here; playback itself
        // must remain usable if the shell rejects an update.
        let _ = update_dynamic_smtc_text_with(
            &mut self.dynamic_lyrics,
            generation,
            0,
            |title, artist, album| update_smtc_music_properties(&self.smtc, title, artist, album),
        );
        let _ = publish_smtc_timeline(
            &self.smtc,
            &self.timeline_gate,
            generation,
            0,
            smtc_metadata.duration_ms(),
            true,
        );
        Ok(())
    }

    fn load_local_media_source(
        &mut self,
        file: LocalMediaFile,
        track: TrackSummary,
        smtc_metadata: SmtcMetadata,
    ) -> Result<(), PlayerError> {
        #[cfg(debug_assertions)]
        eprintln!("[native-player] local-load stage=begin");
        let path = winrt_storage_path(file.path())?;
        let storage_file = StorageFile::GetFileFromPathAsync(&path)
            .map_err(|_| PlayerError::InvalidMediaFile)?
            .get()
            .map_err(|_| PlayerError::InvalidMediaFile)?;
        #[cfg(debug_assertions)]
        eprintln!("[native-player] local-load stage=storage-file");
        let source = MediaSource::CreateFromStorageFile(&storage_file)
            .map_err(|_| PlayerError::NativeFailure)?;
        #[cfg(debug_assertions)]
        eprintln!("[native-player] local-load stage=media-source");
        self.load_media_source(source, Some(storage_file), track, smtc_metadata)
    }

    fn handle(&mut self, command: PlayerCommand) -> Result<(), PlayerError> {
        match command {
            PlayerCommand::LoadRemote {
                url,
                track,
                smtc_metadata,
            } => {
                let uri = Uri::CreateUri(&HSTRING::from(url.expose_to_native_player()))
                    .map_err(|_| PlayerError::InvalidMediaUrl)?;
                let source =
                    MediaSource::CreateFromUri(&uri).map_err(|_| PlayerError::NativeFailure)?;
                self.load_media_source(source, None, track, smtc_metadata)
            }
            PlayerCommand::LoadLocal {
                file,
                track,
                smtc_metadata,
            } => self.load_local_media_source(file, track, smtc_metadata),
            PlayerCommand::SetArtwork {
                generation,
                epoch,
                artwork,
            } => {
                // SetSource is synchronous for our command ordering, but WinRT can expose the
                // new source identity later. Generation + epoch are the authoritative guards;
                // requiring Source() identity here can silently discard a fast cache hit.
                if artwork_epoch_is_current(epoch, self.artwork_epoch)
                    && self.current_generation_matches(generation)
                {
                    self.artwork_epoch = epoch;
                    let result = self
                        .set_smtc_artwork(artwork)
                        .map_err(|_| PlayerError::NativeFailure);
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[smtc-artwork] native update generation={generation} epoch={epoch} applied={}",
                        result.is_ok()
                    );
                    result
                } else {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[smtc-artwork] stale update ignored generation={generation} epoch={epoch}"
                    );
                    Ok(())
                }
            }
            PlayerCommand::ClearArtwork { generation, epoch } => {
                if artwork_epoch_is_current(epoch, self.artwork_epoch)
                    && self.current_generation_matches(generation)
                {
                    self.artwork_epoch = epoch;
                    self.clear_smtc_artwork();
                }
                Ok(())
            }
            PlayerCommand::SetDynamicLyrics {
                generation,
                lyrics_epoch,
                timeline,
            } => {
                if self.current_generation_matches(generation) {
                    let accepted = if self.dynamic_lyrics.generation == generation
                        && lyrics_epoch_is_current(lyrics_epoch, self.dynamic_lyrics.lyrics_epoch)
                    {
                        self.dynamic_lyrics.set_timeline(lyrics_epoch, timeline);
                        self.clear_dynamic_lyrics_schedule();
                        true
                    } else {
                        false
                    };
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[smtc-dynamic-lyrics] native timeline generation={generation} epoch={lyrics_epoch} accepted={accepted}"
                    );
                    if accepted {
                        let snapshot = self
                            .snapshot
                            .read()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .clone();
                        let _result = if matches!(
                            snapshot.state,
                            PlayerState::Idle | PlayerState::Ended | PlayerState::Failed
                        ) {
                            self.clear_dynamic_lyrics_schedule();
                            restore_normal_smtc_text_with(
                                &mut self.dynamic_lyrics,
                                generation,
                                |title, artist, album| {
                                    update_smtc_music_properties(&self.smtc, title, artist, album)
                                },
                            )
                        } else {
                            let now = Instant::now();
                            match self.read_native_playback_sample() {
                                Ok((native_state, position_ms)) => {
                                    update_if_current(&self.snapshot, generation, |state| {
                                        state.position_ms = position_ms;
                                    });
                                    let result = update_dynamic_smtc_text_with(
                                        &mut self.dynamic_lyrics,
                                        generation,
                                        position_ms,
                                        |title, artist, album| {
                                            update_smtc_music_properties(
                                                &self.smtc, title, artist, album,
                                            )
                                        },
                                    );
                                    if snapshot.state == PlayerState::Playing
                                        && native_state == MediaPlaybackState::Playing
                                    {
                                        self.ensure_dynamic_lyrics_schedule(now, true);
                                    } else {
                                        self.clear_dynamic_lyrics_schedule();
                                    }
                                    result
                                }
                                Err(error) => {
                                    self.defer_dynamic_lyrics_to_watchdog(now, &snapshot);
                                    Err(error)
                                }
                            }
                        };
                        #[cfg(debug_assertions)]
                        eprintln!(
                            "[smtc-dynamic-lyrics] native publish generation={generation} epoch={lyrics_epoch} result={_result:?}"
                        );
                    }
                }
                Ok(())
            }
            PlayerCommand::ClearDynamicLyrics {
                generation,
                lyrics_epoch,
            } => {
                if self.current_generation_matches(generation) {
                    let accepted = if self.dynamic_lyrics.generation == generation
                        && lyrics_epoch_is_current(lyrics_epoch, self.dynamic_lyrics.lyrics_epoch)
                    {
                        self.dynamic_lyrics.lyrics_epoch = lyrics_epoch;
                        self.dynamic_lyrics.timeline = None;
                        true
                    } else {
                        false
                    };
                    if accepted {
                        self.clear_dynamic_lyrics_schedule();
                        let position_ms = self
                            .snapshot
                            .read()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .position_ms;
                        let _ = update_dynamic_smtc_text_with(
                            &mut self.dynamic_lyrics,
                            generation,
                            position_ms,
                            |title, artist, album| {
                                update_smtc_music_properties(&self.smtc, title, artist, album)
                            },
                        );
                    }
                }
                Ok(())
            }
            PlayerCommand::Play => {
                self.ensure_track_loaded()?;
                self.player.Play().map_err(|_| PlayerError::NativeFailure)?;
                #[cfg(debug_assertions)]
                eprintln!("[native-player] play-submitted");
                self.smtc
                    .SetPlaybackStatus(MediaPlaybackStatus::Playing)
                    .map_err(|_| PlayerError::NativeFailure)?;
                // PlaybackStateChanged remains the public playback-state authority and
                // will arm the lyric schedule after the native session reaches Playing.
                Ok(())
            }
            PlayerCommand::Pause => {
                self.ensure_track_loaded()?;
                self.player
                    .Pause()
                    .map_err(|_| PlayerError::NativeFailure)?;
                self.smtc
                    .SetPlaybackStatus(MediaPlaybackStatus::Paused)
                    .map_err(|_| PlayerError::NativeFailure)?;
                self.recalibrate_dynamic_lyrics(Instant::now(), DynamicLyricsWakeReason::Command);
                // Freeze immediately without changing the public snapshot before the
                // native PlaybackStateChanged callback confirms Paused.
                self.clear_dynamic_lyrics_schedule();
                Ok(())
            }
            PlayerCommand::Stop => {
                self.initial_timeline_duration_ms = None;
                self.clear_smtc_artwork();
                self.remove_source_events();
                self.dynamic_lyrics.clear();
                self.clear_dynamic_lyrics_schedule();
                let generation = update_snapshot(&self.snapshot, |state| {
                    state.generation = state.generation.saturating_add(1);
                    state.generation
                });
                self.timeline_gate
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .begin_generation(generation);
                let _ = self.player.Pause();
                self.player
                    .SetSource(None)
                    .map_err(|_| PlayerError::NativeFailure)?;
                // Release the projected source and StorageFile only after the
                // player has accepted SetSource(None); deleting a local file
                // immediately after Stop must not race a live WinRT reference.
                self._current_media_source = None;
                self._current_local_file = None;
                update_snapshot(&self.snapshot, |state| {
                    if state.generation != generation {
                        return;
                    }
                    let volume = state.volume;
                    let muted = state.muted;
                    *state = PlayerSnapshot::idle();
                    state.generation = generation;
                    state.volume = volume;
                    state.muted = muted;
                });
                let _ = self.smtc.DisplayUpdater().and_then(|updater| {
                    updater.ClearAll()?;
                    updater.Update()
                });
                let _ = publish_smtc_timeline(
                    &self.smtc,
                    &self.timeline_gate,
                    generation,
                    0,
                    None,
                    true,
                );
                self.smtc
                    .SetPlaybackStatus(MediaPlaybackStatus::Stopped)
                    .map_err(|_| PlayerError::NativeFailure)?;
                Ok(())
            }
            PlayerCommand::Seek { position } => {
                self.ensure_track_loaded()?;
                self.player
                    .PlaybackSession()
                    .and_then(|session| {
                        session.SetPosition(TimeSpan {
                            Duration: milliseconds_to_ticks(position.get()),
                        })
                    })
                    .map_err(|_| PlayerError::NativeFailure)?;
                let source_matches = self
                    .tokens
                    .source
                    .as_ref()
                    .and_then(|source| source.identity)
                    .is_some_and(|source| source.is_current(&self.player));
                let generation = self
                    .snapshot
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .generation;
                if update_source_if_current(&self.snapshot, generation, source_matches, |state| {
                    state.position_ms = position.get()
                }) {
                    let duration_ms = self
                        .snapshot
                        .read()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .duration_ms
                        .or(self.initial_timeline_duration_ms);
                    let _ = publish_smtc_timeline(
                        &self.smtc,
                        &self.timeline_gate,
                        generation,
                        position.get(),
                        duration_ms,
                        true,
                    );
                    let _ = update_dynamic_smtc_text_with(
                        &mut self.dynamic_lyrics,
                        generation,
                        position.get(),
                        |title, artist, album| {
                            update_smtc_music_properties(&self.smtc, title, artist, album)
                        },
                    );
                    let is_playing = self
                        .snapshot
                        .read()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .state
                        == PlayerState::Playing;
                    if is_playing {
                        self.ensure_dynamic_lyrics_schedule(Instant::now(), true);
                    } else {
                        self.clear_dynamic_lyrics_schedule();
                    }
                }
                Ok(())
            }
            PlayerCommand::SetVolume { volume } => {
                self.player
                    .SetVolume(f64::from(volume.get()))
                    .map_err(|_| PlayerError::NativeFailure)?;
                update_snapshot(&self.snapshot, |state| state.volume = volume.get());
                Ok(())
            }
            PlayerCommand::SetMuted { muted } => {
                self.player
                    .SetIsMuted(muted)
                    .map_err(|_| PlayerError::NativeFailure)?;
                update_snapshot(&self.snapshot, |state| state.muted = muted);
                Ok(())
            }
        }
    }

    fn ensure_track_loaded(&self) -> Result<(), PlayerError> {
        let loaded = self
            .snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .current_track
            .is_some();
        loaded.then_some(()).ok_or(PlayerError::NotReady)
    }

    fn current_generation_matches(&self, generation: u64) -> bool {
        self.snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .generation
            == generation
    }

    fn set_smtc_artwork(&mut self, artwork: SmtcArtworkFile) -> windows::core::Result<()> {
        let path = HSTRING::from(artwork.path().to_string_lossy().as_ref());
        let file = StorageFile::GetFileFromPathAsync(&path)?.get()?;
        let reference = RandomAccessStreamReference::CreateFromFile(&file)?;
        let updater = self.smtc.DisplayUpdater()?;
        updater.SetThumbnail(&reference)?;
        updater.Update()?;
        self.artwork_file = Some(file);
        self.artwork_reference = Some(reference);
        Ok(())
    }

    fn clear_smtc_artwork(&mut self) {
        let _ = self.smtc.DisplayUpdater().and_then(|updater| {
            updater.SetThumbnail(Option::<&RandomAccessStreamReference>::None)?;
            updater.Update()
        });
        self.artwork_file = None;
        self.artwork_reference = None;
    }

    fn sample_position(&mut self) -> Result<(), PlayerError> {
        let source_identity = self
            .tokens
            .source
            .as_ref()
            .and_then(|source| source.identity)
            .ok_or(PlayerError::NotReady)?;
        let generation = self
            .snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .generation;
        let source_matches = source_identity.is_current(&self.player);
        if !source_matches {
            return Err(PlayerError::NotReady);
        }
        let position = self
            .player
            .PlaybackSession()
            .map_err(|_| PlayerError::NativeFailure)?
            .Position()
            .map_err(|_| PlayerError::NativeFailure)?;
        sample_position_if_current(
            &self.snapshot,
            generation,
            source_matches,
            ticks_to_milliseconds(position.Duration),
        )
        .then_some(())
        .ok_or(PlayerError::NotReady)?;
        let state = self
            .snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _ = publish_smtc_timeline(
            &self.smtc,
            &self.timeline_gate,
            generation,
            state.position_ms,
            state.duration_ms.or(self.initial_timeline_duration_ms),
            false,
        );
        drop(state);
        Ok(())
    }

    fn bind_source_events(
        &mut self,
        generation: u64,
        source: &MediaSource,
        initial_duration_ms: Option<u64>,
    ) -> Result<(), PlayerError> {
        self.remove_source_events();
        self.tokens.source = Some(SourceEventTokens::default());
        let result = self.register_source_events(generation, source, initial_duration_ms);
        if result.is_err() {
            self.remove_source_events();
        }
        result
    }

    fn register_source_events(
        &mut self,
        generation: u64,
        source: &MediaSource,
        initial_duration_ms: Option<u64>,
    ) -> Result<(), PlayerError> {
        let source_identity = SourceIdentity::new(source)?;
        self.source_tokens_mut()?.identity = Some(source_identity);

        let opened_snapshot = Arc::clone(&self.snapshot);
        let opened_events = self.events.clone();
        let opened_smtc = self.smtc.clone();
        let opened_player = self.player.clone();
        let opened_source = source_identity;
        let opened = self
            .player
            .MediaOpened(&TypedEventHandler::<MediaPlayer, IInspectable>::new(
                move |_, _| {
                    if update_source_if_current(
                        &opened_snapshot,
                        generation,
                        opened_source.is_current(&opened_player),
                        |state| {
                            state.state = PlayerState::Paused;
                            state.failure = None;
                        },
                    ) {
                        let _ = opened_smtc.SetPlaybackStatus(MediaPlaybackStatus::Paused);
                        let _ = opened_events.send(NativePlayerEvent::Opened { generation });
                        crate::file_logging::native_event("native_media_opened", generation);
                    }
                    Ok(())
                },
            ))
            .map_err(|_| PlayerError::NativeFailure)?;
        self.source_tokens_mut()?.opened = Some(opened);

        let ended_snapshot = Arc::clone(&self.snapshot);
        let ended_events = self.events.clone();
        let ended_smtc = self.smtc.clone();
        let ended_commands = self.commands.clone();
        let ended_player = self.player.clone();
        let ended_source = source_identity;
        let ended = self
            .player
            .MediaEnded(&TypedEventHandler::<MediaPlayer, IInspectable>::new(
                move |_, _| {
                    let source_matches = ended_source.is_current(&ended_player);
                    let ended = update_snapshot(&ended_snapshot, |state| {
                        mark_ended_if_current(state, generation, source_matches)
                    });
                    if ended {
                        let _ = ended_smtc.SetPlaybackStatus(MediaPlaybackStatus::Stopped);
                        let _ = ended_commands
                            .send(EngineMessage::RecalibrateDynamicLyrics { generation });
                        let _ = ended_events.send(NativePlayerEvent::Ended { generation });
                    }
                    Ok(())
                },
            ))
            .map_err(|_| PlayerError::NativeFailure)?;
        self.source_tokens_mut()?.ended = Some(ended);

        let failed_snapshot = Arc::clone(&self.snapshot);
        let failed_events = self.events.clone();
        let failed_smtc = self.smtc.clone();
        let failed_commands = self.commands.clone();
        let failed_player = self.player.clone();
        let failed_source = source_identity;
        let failed = self
            .player
            .MediaFailed(
                &TypedEventHandler::<MediaPlayer, MediaPlayerFailedEventArgs>::new(
                    move |_, args| {
                        let native_error = args.as_ref().and_then(|args| args.Error().ok());
                        crate::file_logging::native_failure(generation, args.as_ref().and_then(|args| args.ExtendedErrorCode().ok()).map(|code| code.0));
                        #[cfg(debug_assertions)]
                        {
                            // Log only the numeric HRESULT; native error messages may contain media URLs.
                            let extended_error = args
                                .as_ref()
                                .and_then(|args| args.ExtendedErrorCode().ok())
                                .map(|code| format!("0x{:08X}", code.0 as u32))
                                .unwrap_or_else(|| "unavailable".to_owned());
                            eprintln!(
                                "[native-player] media-failed generation={generation} category={native_error:?} hresult={extended_error}"
                            );
                        }
                        let failure = match native_error {
                            Some(error) => media_player_failure(error, generation),
                            None => Some(PlayerFailure::new(
                                PlayerFailureCode::Unavailable,
                                generation,
                            )),
                        };
                        let Some(failure) = failure else {
                            return Ok(());
                        };
                        if update_source_if_current(
                            &failed_snapshot,
                            generation,
                            failed_source.is_current(&failed_player),
                            |state| {
                                state.state = PlayerState::Failed;
                                state.failure = Some(failure);
                            },
                        ) {
                            let _ = failed_smtc.SetPlaybackStatus(MediaPlaybackStatus::Closed);
                            let _ = failed_commands
                                .send(EngineMessage::RecalibrateDynamicLyrics { generation });
                            let _ = failed_events.send(NativePlayerEvent::Failed {
                                generation,
                                failure,
                            });
                        }
                        Ok(())
                    },
                ),
            )
            .map_err(|_| PlayerError::NativeFailure)?;
        self.source_tokens_mut()?.failed = Some(failed);

        let session = self
            .player
            .PlaybackSession()
            .map_err(|_| PlayerError::NativeFailure)?;
        let state_snapshot = Arc::clone(&self.snapshot);
        let state_smtc = self.smtc.clone();
        let state_player = self.player.clone();
        let state_commands = self.commands.clone();
        let state_source = source_identity;
        let state_changed = session
            .PlaybackStateChanged(
                &TypedEventHandler::<MediaPlaybackSession, IInspectable>::new(move |sender, _| {
                    if let Some(sender) = sender.as_ref() {
                        if let Ok(playback_state) = sender.PlaybackState() {
                            let source_matches = state_source.is_current(&state_player);
                            let public_state = update_snapshot(&state_snapshot, |state| {
                                if !event_belongs_to_current_source(
                                    generation,
                                    state.generation,
                                    source_matches,
                                ) {
                                    return None;
                                }
                                state.state = match playback_state {
                                    MediaPlaybackState::Opening | MediaPlaybackState::Buffering => {
                                        PlayerState::Loading
                                    }
                                    MediaPlaybackState::Playing => PlayerState::Playing,
                                    MediaPlaybackState::Paused => PlayerState::Paused,
                                    _ if state.current_track.is_none() => PlayerState::Idle,
                                    _ => state.state,
                                };
                                Some(state.state)
                            });
                            if let Some(public_state) = public_state {
                                let _ = state_smtc.SetPlaybackStatus(smtc_status(public_state));
                                let _ = state_commands
                                    .send(EngineMessage::RecalibrateDynamicLyrics { generation });
                            }
                        }
                    }
                    Ok(())
                }),
            )
            .map_err(|_| PlayerError::NativeFailure)?;
        self.source_tokens_mut()?.state_changed = Some(state_changed);

        let position_snapshot = Arc::clone(&self.snapshot);
        let position_player = self.player.clone();
        let position_smtc = self.smtc.clone();
        let position_timeline_gate = Arc::clone(&self.timeline_gate);
        let position_source = source_identity;
        let position_changed = session
            .PositionChanged(
                &TypedEventHandler::<MediaPlaybackSession, IInspectable>::new(move |sender, _| {
                    if let Some(sender) = sender.as_ref() {
                        if let Ok(position) = sender.Position() {
                            let accepted = update_source_if_current(
                                &position_snapshot,
                                generation,
                                position_source.is_current(&position_player),
                                |state| {
                                    state.position_ms = ticks_to_milliseconds(position.Duration);
                                },
                            );
                            if accepted {
                                let state = position_snapshot
                                    .read()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                                let _ = publish_smtc_timeline(
                                    &position_smtc,
                                    &position_timeline_gate,
                                    generation,
                                    state.position_ms,
                                    state.duration_ms.or(initial_duration_ms),
                                    false,
                                );
                            }
                        }
                    }
                    Ok(())
                }),
            )
            .map_err(|_| PlayerError::NativeFailure)?;
        self.source_tokens_mut()?.position_changed = Some(position_changed);

        let duration_snapshot = Arc::clone(&self.snapshot);
        let duration_player = self.player.clone();
        let duration_smtc = self.smtc.clone();
        let duration_timeline_gate = Arc::clone(&self.timeline_gate);
        let duration_source = source_identity;
        let duration_changed = session
            .NaturalDurationChanged(
                &TypedEventHandler::<MediaPlaybackSession, IInspectable>::new(move |sender, _| {
                    if let Some(sender) = sender.as_ref() {
                        if let Ok(duration) = sender.NaturalDuration() {
                            let duration_ms = ticks_to_milliseconds(duration.Duration);
                            let accepted = update_source_if_current(
                                &duration_snapshot,
                                generation,
                                duration_source.is_current(&duration_player),
                                |state| {
                                    state.duration_ms = Some(duration_ms);
                                },
                            );
                            if accepted {
                                let position_ms = sender
                                    .Position()
                                    .map(|position| ticks_to_milliseconds(position.Duration))
                                    .unwrap_or(0);
                                let _ = publish_smtc_timeline(
                                    &duration_smtc,
                                    &duration_timeline_gate,
                                    generation,
                                    position_ms,
                                    Some(duration_ms),
                                    false,
                                );
                            }
                        }
                    }
                    Ok(())
                }),
            )
            .map_err(|_| PlayerError::NativeFailure)?;
        self.source_tokens_mut()?.duration_changed = Some(duration_changed);
        Ok(())
    }

    fn source_tokens_mut(&mut self) -> Result<&mut SourceEventTokens, PlayerError> {
        self.tokens
            .source
            .as_mut()
            .ok_or(PlayerError::NativeFailure)
    }

    fn remove_source_events(&mut self) {
        let Some(tokens) = self.tokens.source.take() else {
            return;
        };
        if let Ok(session) = self.player.PlaybackSession() {
            if let Some(token) = tokens.state_changed {
                let _ = session.RemovePlaybackStateChanged(token);
            }
            if let Some(token) = tokens.position_changed {
                let _ = session.RemovePositionChanged(token);
            }
            if let Some(token) = tokens.duration_changed {
                let _ = session.RemoveNaturalDurationChanged(token);
            }
        }
        if let Some(token) = tokens.opened {
            let _ = self.player.RemoveMediaOpened(token);
        }
        if let Some(token) = tokens.ended {
            let _ = self.player.RemoveMediaEnded(token);
        }
        if let Some(token) = tokens.failed {
            let _ = self.player.RemoveMediaFailed(token);
        }
    }

    fn close(&mut self) {
        self.remove_source_events();
        self.dynamic_lyrics.clear();
        self.clear_dynamic_lyrics_schedule();
        let _ = self
            .smtc
            .RemoveButtonPressed(self.tokens.smtc_button_pressed);
        let _ = self.smtc.SetIsEnabled(false);
        let _ = self.player.Close();
        self._current_media_source = None;
        self._current_local_file = None;
    }
}

fn update_snapshot<R>(
    snapshot: &Arc<RwLock<PlayerSnapshot>>,
    update: impl FnOnce(&mut PlayerSnapshot) -> R,
) -> R {
    update(
        &mut snapshot
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    )
}

fn update_if_current(
    snapshot: &Arc<RwLock<PlayerSnapshot>>,
    generation: u64,
    update: impl FnOnce(&mut PlayerSnapshot),
) -> bool {
    update_snapshot(snapshot, |state| {
        if state.generation != generation {
            return false;
        }
        update(state);
        true
    })
}

fn event_belongs_to_current_source(
    event_generation: u64,
    current_generation: u64,
    source_matches: bool,
) -> bool {
    event_generation == current_generation && source_matches
}

fn artwork_epoch_is_current(event_epoch: u64, current_epoch: u64) -> bool {
    event_epoch >= current_epoch
}

fn lyrics_epoch_is_current(event_epoch: u64, current_epoch: u64) -> bool {
    event_epoch >= current_epoch
}

fn update_source_if_current(
    snapshot: &Arc<RwLock<PlayerSnapshot>>,
    generation: u64,
    source_matches: bool,
    update: impl FnOnce(&mut PlayerSnapshot),
) -> bool {
    update_snapshot(snapshot, |state| {
        if !event_belongs_to_current_source(generation, state.generation, source_matches) {
            return false;
        }
        update(state);
        true
    })
}

fn mark_ended_if_current(
    state: &mut PlayerSnapshot,
    generation: u64,
    source_matches: bool,
) -> bool {
    if !event_belongs_to_current_source(generation, state.generation, source_matches)
        || state.current_track.is_none()
        || state.state == PlayerState::Loading
    {
        return false;
    }
    let belongs_to_current_source = state.duration_ms.map_or(state.position_ms > 0, |duration| {
        state.position_ms >= duration.saturating_sub(2_000)
    });
    if !belongs_to_current_source {
        return false;
    }
    state.state = PlayerState::Ended;
    true
}

fn sample_position_if_current(
    snapshot: &Arc<RwLock<PlayerSnapshot>>,
    generation: u64,
    source_matches: bool,
    position_ms: u64,
) -> bool {
    update_source_if_current(snapshot, generation, source_matches, |state| {
        state.position_ms = position_ms;
    })
}

fn try_start_position_sample(in_flight: &AtomicBool) -> bool {
    in_flight
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

fn configure_smtc(smtc: &SystemMediaTransportControls) -> Result<(), PlayerError> {
    smtc.SetIsEnabled(true)
        .and_then(|_| smtc.SetIsPlayEnabled(true))
        .and_then(|_| smtc.SetIsPauseEnabled(true))
        .and_then(|_| smtc.SetIsStopEnabled(true))
        .and_then(|_| smtc.SetIsNextEnabled(true))
        .and_then(|_| smtc.SetIsPreviousEnabled(true))
        .map_err(|_| PlayerError::NativeFailure)
}

fn update_smtc_music_properties(
    smtc: &SystemMediaTransportControls,
    title: &str,
    artist: &str,
    album: &str,
) -> Result<(), PlayerError> {
    let updater = smtc
        .DisplayUpdater()
        .map_err(|_| PlayerError::NativeFailure)?;
    updater
        .SetType(MediaPlaybackType::Music)
        .map_err(|_| PlayerError::NativeFailure)?;
    let properties = updater
        .MusicProperties()
        .map_err(|_| PlayerError::NativeFailure)?;
    properties
        .SetTitle(&HSTRING::from(title))
        .and_then(|_| properties.SetArtist(&HSTRING::from(artist)))
        .and_then(|_| properties.SetAlbumTitle(&HSTRING::from(album)))
        .map_err(|_| PlayerError::NativeFailure)?;
    updater.Update().map_err(|_| PlayerError::NativeFailure)
}

fn lyric_index_at(position_ms: u64, lines: &[SmtcLyricLine]) -> Option<usize> {
    lines
        .partition_point(|line| line.at_ms() <= position_ms)
        .checked_sub(1)
}

fn dynamic_lyrics_target(
    position_ms: u64,
    timeline: &SmtcLyricTimeline,
) -> (Option<usize>, Option<u64>) {
    let lyric_index = lyric_index_at(position_ms, timeline.lines());
    let next_boundary_ms = match lyric_index {
        Some(index) => timeline.lines().get(index + 1),
        None => timeline.lines().first(),
    }
    .map(SmtcLyricLine::at_ms);
    (lyric_index, next_boundary_ms)
}

fn next_dynamic_lyrics_deadline(
    schedule: &DynamicLyricsSchedule,
) -> Option<(Instant, DynamicLyricsDeadlineKind)> {
    match (schedule.lyric_deadline, schedule.watchdog_deadline) {
        (Some(lyric), Some(watchdog)) if lyric < watchdog => {
            Some((lyric, DynamicLyricsDeadlineKind::Lyric))
        }
        (Some(_lyric), Some(watchdog)) => Some((watchdog, DynamicLyricsDeadlineKind::Watchdog)),
        (Some(lyric), None) => Some((lyric, DynamicLyricsDeadlineKind::Lyric)),
        (None, Some(watchdog)) => Some((watchdog, DynamicLyricsDeadlineKind::Watchdog)),
        (None, None) => None,
    }
}

fn dynamic_lyrics_watchdog_fallback(
    current: &DynamicLyricsSchedule,
    generation: u64,
    lyrics_epoch: u64,
    now: Instant,
) -> DynamicLyricsSchedule {
    let watchdog_deadline =
        if current.generation == generation && current.lyrics_epoch == lyrics_epoch {
            current.watchdog_deadline
        } else {
            None
        }
        .unwrap_or(now + DYNAMIC_LYRICS_WATCHDOG_INTERVAL);
    DynamicLyricsSchedule {
        generation,
        lyrics_epoch,
        watchdog_deadline: Some(watchdog_deadline),
        ..DynamicLyricsSchedule::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EarlyWakeDecision {
    Retry(Duration),
    Cancel,
    Ready,
}

fn early_wake_decision(
    attempts: u8,
    previous_position_ms: Option<u64>,
    position_ms: u64,
    boundary_ms: u64,
) -> EarlyWakeDecision {
    if position_ms >= boundary_ms {
        return EarlyWakeDecision::Ready;
    }
    if previous_position_ms != Some(position_ms) {
        return EarlyWakeDecision::Cancel;
    }
    DYNAMIC_LYRICS_EARLY_WAKE_BACKOFFS
        .get(attempts as usize)
        .copied()
        .map_or(EarlyWakeDecision::Cancel, EarlyWakeDecision::Retry)
}

fn update_dynamic_smtc_text_with(
    state: &mut DynamicLyricsDisplayState,
    generation: u64,
    position_ms: u64,
    mut writer: impl FnMut(&str, &str, &str) -> Result<(), PlayerError>,
) -> Result<bool, PlayerError> {
    if state.generation != generation {
        return Ok(false);
    }
    let Some(normal) = state.normal.as_ref() else {
        return Ok(false);
    };
    let lyric_index = state
        .timeline
        .as_ref()
        .and_then(|timeline| dynamic_lyrics_target(position_ms, timeline).0);
    let target = lyric_index
        .map(PublishedSmtcText::Lyric)
        .unwrap_or(PublishedSmtcText::Normal);
    if state.published == Some(target) {
        return Ok(false);
    }

    let (title, artist) = match lyric_index {
        Some(index) => {
            let line = state
                .timeline
                .as_ref()
                .and_then(|timeline| timeline.lines().get(index))
                .ok_or(PlayerError::InvalidLyrics)?;
            (
                line.text().to_owned(),
                format!("{} · {}", normal.title, normal.artist),
            )
        }
        None => (normal.title.clone(), normal.artist.clone()),
    };
    let album = normal.album.clone();
    writer(&title, &artist, &album)?;
    state.published = Some(target);
    Ok(true)
}

fn restore_normal_smtc_text_with(
    state: &mut DynamicLyricsDisplayState,
    generation: u64,
    mut writer: impl FnMut(&str, &str, &str) -> Result<(), PlayerError>,
) -> Result<bool, PlayerError> {
    if state.generation != generation || state.published == Some(PublishedSmtcText::Normal) {
        return Ok(false);
    }
    let Some(normal) = state.normal.as_ref() else {
        return Ok(false);
    };
    let title = normal.title.clone();
    let artist = normal.artist.clone();
    let album = normal.album.clone();
    writer(&title, &artist, &album)?;
    state.published = Some(PublishedSmtcText::Normal);
    Ok(true)
}

fn timeline_bounds_ms(position_ms: u64, duration_ms: Option<u64>) -> Option<(u64, u64)> {
    let duration_ms = duration_ms
        .filter(|duration| *duration > 0)
        .map(|duration| duration.min(MAX_TIMELINE_MILLISECONDS))?;
    Some((position_ms.min(duration_ms), duration_ms))
}

fn update_smtc_timeline(
    smtc: &SystemMediaTransportControls,
    position_ms: u64,
    duration_ms: Option<u64>,
) -> windows::core::Result<()> {
    let Some((position_ms, duration_ms)) = timeline_bounds_ms(position_ms, duration_ms) else {
        return clear_smtc_timeline(smtc);
    };
    let properties = SystemMediaTransportControlsTimelineProperties::new()?;
    let start = TimeSpan { Duration: 0 };
    let end = TimeSpan {
        Duration: milliseconds_to_ticks(duration_ms),
    };
    let position = TimeSpan {
        Duration: milliseconds_to_ticks(position_ms),
    };
    properties.SetStartTime(start)?;
    properties.SetEndTime(end)?;
    properties.SetMinSeekTime(start)?;
    properties.SetMaxSeekTime(end)?;
    properties.SetPosition(position)?;
    smtc.UpdateTimelineProperties(&properties)
}

fn publish_smtc_timeline(
    smtc: &SystemMediaTransportControls,
    gate: &Arc<Mutex<TimelinePublishGate>>,
    generation: u64,
    position_ms: u64,
    duration_ms: Option<u64>,
    force: bool,
) -> windows::core::Result<()> {
    let (position_ms, duration_ms) = timeline_bounds_ms(position_ms, duration_ms)
        .map_or((0, None), |(position_ms, duration_ms)| {
            (position_ms, Some(duration_ms))
        });
    let now = Instant::now();
    let mut gate = gate
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !gate.should_publish(generation, duration_ms, position_ms, now, force) {
        return Ok(());
    }
    let result = duration_ms.map_or_else(
        || clear_smtc_timeline(smtc),
        |duration_ms| update_smtc_timeline(smtc, position_ms, Some(duration_ms)),
    );
    if result.is_ok() {
        gate.record_success(generation, duration_ms, position_ms, Instant::now());
    }
    result
}

fn clear_smtc_timeline(smtc: &SystemMediaTransportControls) -> windows::core::Result<()> {
    let properties = SystemMediaTransportControlsTimelineProperties::new()?;
    let zero = TimeSpan { Duration: 0 };
    properties.SetStartTime(zero)?;
    properties.SetEndTime(zero)?;
    properties.SetMinSeekTime(zero)?;
    properties.SetMaxSeekTime(zero)?;
    properties.SetPosition(zero)?;
    smtc.UpdateTimelineProperties(&properties)
}

fn smtc_status(state: PlayerState) -> MediaPlaybackStatus {
    match state {
        PlayerState::Loading => MediaPlaybackStatus::Changing,
        PlayerState::Playing => MediaPlaybackStatus::Playing,
        PlayerState::Paused => MediaPlaybackStatus::Paused,
        PlayerState::Idle | PlayerState::Ended => MediaPlaybackStatus::Stopped,
        PlayerState::Failed => MediaPlaybackStatus::Closed,
    }
}

fn transport_event(button: SystemMediaTransportControlsButton) -> Option<NativePlayerEvent> {
    match button {
        SystemMediaTransportControlsButton::Play => Some(NativePlayerEvent::TransportPlay),
        SystemMediaTransportControlsButton::Pause => Some(NativePlayerEvent::TransportPause),
        SystemMediaTransportControlsButton::Stop => Some(NativePlayerEvent::TransportStop),
        SystemMediaTransportControlsButton::Next => Some(NativePlayerEvent::TransportNext),
        SystemMediaTransportControlsButton::Previous => Some(NativePlayerEvent::TransportPrevious),
        _ => None,
    }
}

fn ticks_to_milliseconds(ticks: i64) -> u64 {
    u64::try_from(ticks.max(0) / WINDOWS_TICKS_PER_MILLISECOND).unwrap_or(u64::MAX)
}

fn milliseconds_to_ticks(milliseconds: u64) -> i64 {
    i64::try_from(milliseconds)
        .unwrap_or(i64::MAX / WINDOWS_TICKS_PER_MILLISECOND)
        .saturating_mul(WINDOWS_TICKS_PER_MILLISECOND)
}

fn winrt_storage_path(path: &std::path::Path) -> Result<HSTRING, PlayerError> {
    let path = path.to_str().ok_or(PlayerError::InvalidMediaFile)?;
    let normalized = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(drive_path) = path.strip_prefix(r"\\?\") {
        drive_path.to_owned()
    } else {
        path.to_owned()
    };
    if normalized.starts_with(r"\\.\") || normalized.starts_with(r"\\?\") {
        return Err(PlayerError::InvalidMediaFile);
    }
    Ok(HSTRING::from(normalized))
}

const MAX_TIMELINE_MILLISECONDS: u64 = i64::MAX as u64 / WINDOWS_TICKS_PER_MILLISECOND as u64;

fn media_player_failure(error: MediaPlayerError, generation: u64) -> Option<PlayerFailure> {
    let code = match error {
        MediaPlayerError::Aborted => return None,
        MediaPlayerError::NetworkError => PlayerFailureCode::Network,
        MediaPlayerError::DecodingError => PlayerFailureCode::Decoding,
        MediaPlayerError::SourceNotSupported => PlayerFailureCode::Unsupported,
        _ => PlayerFailureCode::Unavailable,
    };
    Some(PlayerFailure::new(code, generation))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_timespan_conversion_is_bounded() {
        assert_eq!(ticks_to_milliseconds(-1), 0);
        assert_eq!(ticks_to_milliseconds(10_000), 1);
        assert_eq!(milliseconds_to_ticks(1), 10_000);
        assert_eq!(
            milliseconds_to_ticks(u64::MAX),
            (i64::MAX / WINDOWS_TICKS_PER_MILLISECOND) * WINDOWS_TICKS_PER_MILLISECOND
        );
    }

    #[test]
    fn winrt_storage_path_removes_only_supported_extended_prefixes() {
        assert_eq!(
            winrt_storage_path(std::path::Path::new(r"\\?\D:\Apps\QQ Music\track.flac"))
                .expect("drive path")
                .to_string(),
            r"D:\Apps\QQ Music\track.flac"
        );
        assert_eq!(
            winrt_storage_path(std::path::Path::new(r"\\?\UNC\server\share\track.ogg"))
                .expect("UNC path")
                .to_string(),
            r"\\server\share\track.ogg"
        );
        assert!(winrt_storage_path(std::path::Path::new(r"\\.\PhysicalDrive0")).is_err());
    }

    #[test]
    fn smtc_timeline_bounds_clamp_position_and_reject_unknown_duration() {
        assert_eq!(timeline_bounds_ms(1_234, None), None);
        assert_eq!(timeline_bounds_ms(9_999, Some(5_000)), Some((5_000, 5_000)));
        assert_eq!(timeline_bounds_ms(1_234, Some(5_000)), Some((1_234, 5_000)));
        assert_eq!(timeline_bounds_ms(1_234, Some(0)), None);
        assert_eq!(
            timeline_bounds_ms(u64::MAX, Some(u64::MAX)),
            Some((MAX_TIMELINE_MILLISECONDS, MAX_TIMELINE_MILLISECONDS))
        );
    }

    #[test]
    fn smtc_timeline_gate_is_generation_scoped_and_throttles_only_regular_progress() {
        let now = Instant::now();
        let mut gate = TimelinePublishGate::default();
        gate.begin_generation(7);

        assert!(gate.should_publish(7, Some(60_000), 0, now, false));
        gate.record_success(7, Some(60_000), 0, now);
        assert!(!gate.should_publish(7, Some(60_000), 0, now, false));
        assert!(!gate.should_publish(
            7,
            Some(60_000),
            500,
            now + Duration::from_millis(999),
            false
        ));
        assert!(gate.should_publish(
            7,
            Some(60_000),
            500,
            now + Duration::from_millis(1_000),
            false
        ));
        assert!(gate.should_publish(7, Some(60_001), 500, now, false));
        assert!(gate.should_publish(7, Some(60_000), 500, now, true));
        assert!(!gate.should_publish(6, Some(60_000), 500, now + Duration::from_secs(10), true));
    }

    #[test]
    fn smtc_timeline_gate_allows_failed_publish_to_retry() {
        let now = Instant::now();
        let mut gate = TimelinePublishGate::default();
        gate.begin_generation(3);
        gate.record_success(3, Some(1_000), 0, now);

        assert!(gate.should_publish(3, Some(1_001), 100, now, false));
        assert!(gate.should_publish(3, Some(1_001), 100, now, false));
        gate.record_success(3, Some(1_001), 100, now);
        assert!(!gate.should_publish(3, Some(1_001), 100, now, false));
    }

    #[test]
    fn native_failure_categories_are_stable_and_non_sensitive() {
        assert_eq!(
            media_player_failure(MediaPlayerError::NetworkError, 7),
            Some(PlayerFailure::new(PlayerFailureCode::Network, 7))
        );
        assert_eq!(
            media_player_failure(MediaPlayerError::SourceNotSupported, 8),
            Some(PlayerFailure::new(PlayerFailureCode::Unsupported, 8))
        );
        assert_eq!(media_player_failure(MediaPlayerError::Aborted, 9), None);
    }

    #[test]
    fn smtc_buttons_map_only_to_bounded_player_intents() {
        assert_eq!(
            transport_event(SystemMediaTransportControlsButton::Play),
            Some(NativePlayerEvent::TransportPlay)
        );
        assert_eq!(
            transport_event(SystemMediaTransportControlsButton::Next),
            Some(NativePlayerEvent::TransportNext)
        );
        assert_eq!(
            transport_event(SystemMediaTransportControlsButton::ChannelUp),
            None
        );
        assert_eq!(
            smtc_status(PlayerState::Loading),
            MediaPlaybackStatus::Changing
        );
        assert_eq!(
            smtc_status(PlayerState::Playing),
            MediaPlaybackStatus::Playing
        );
    }

    #[test]
    fn media_player_can_be_created_and_closed_on_its_worker_thread() {
        let engine = WindowsMediaPlayerEngine::new().expect("Windows MediaPlayer is available");
        assert_eq!(engine.snapshot(), PlayerSnapshot::idle());
        drop(engine);
    }

    #[test]
    fn manual_smtc_mode_disables_command_manager_and_round_trips_metadata() {
        thread::spawn(|| {
            // SAFETY: this test owns the WinRT apartment and balances it below.
            assert!(unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok());
            let snapshot = Arc::new(RwLock::new(PlayerSnapshot::idle()));
            let (events, _event_receiver) = mpsc::channel();
            let (commands, _command_receiver) = mpsc::channel();
            let mut worker =
                NativeWorker::create(snapshot, events, commands).expect("create native worker");

            assert!(!worker
                .player
                .CommandManager()
                .and_then(|manager| manager.IsEnabled())
                .expect("read command manager state"));

            update_snapshot(&worker.snapshot, |state| state.generation = 7);
            assert!(worker.current_generation_matches(7));
            assert!(!worker.current_generation_matches(6));

            let track = crate::player::TrackSummary {
                source: None,
                id: "fixture-track".to_owned(),
                title: "Fixture title".to_owned(),
                artist: "Fixture artist".to_owned(),
            };
            let metadata = SmtcMetadata::from_queue_track("Fixture album".to_owned(), 123_000);
            worker.dynamic_lyrics.reset_for_track(7, &track, &metadata);
            update_smtc_music_properties(
                &worker.smtc,
                &track.title,
                &track.artist,
                metadata.album().unwrap_or_default(),
            )
            .expect("publish SMTC metadata");
            let properties = worker
                .smtc
                .DisplayUpdater()
                .and_then(|updater| updater.MusicProperties())
                .expect("read SMTC music properties");
            assert_eq!(properties.Title().expect("title").to_string(), track.title);
            assert_eq!(
                properties.Artist().expect("artist").to_string(),
                track.artist
            );
            assert_eq!(
                properties.AlbumTitle().expect("album").to_string(),
                "Fixture album"
            );

            let timeline = SmtcLyricTimeline::new(vec![
                SmtcLyricLine::new(1_000, "First lyric".to_owned()).expect("first lyric"),
                SmtcLyricLine::new(2_000, "Second lyric".to_owned()).expect("second lyric"),
            ])
            .expect("lyric timeline");
            worker
                .handle(PlayerCommand::SetDynamicLyrics {
                    generation: 7,
                    lyrics_epoch: 1,
                    timeline,
                })
                .expect("set dynamic lyrics");
            update_dynamic_smtc_text_with(
                &mut worker.dynamic_lyrics,
                7,
                1_500,
                |title, artist, album| {
                    update_smtc_music_properties(&worker.smtc, title, artist, album)
                },
            )
            .expect("publish dynamic lyric");
            assert_eq!(
                properties.Title().expect("dynamic title").to_string(),
                "First lyric"
            );
            assert_eq!(
                properties.Artist().expect("dynamic artist").to_string(),
                "Fixture title · Fixture artist"
            );
            assert_eq!(
                properties.AlbumTitle().expect("dynamic album").to_string(),
                "Fixture album"
            );
            restore_normal_smtc_text_with(&mut worker.dynamic_lyrics, 7, |title, artist, album| {
                update_smtc_music_properties(&worker.smtc, title, artist, album)
            })
            .expect("restore at end");
            assert_eq!(
                properties.Title().expect("ended title").to_string(),
                "Fixture title"
            );
            update_dynamic_smtc_text_with(
                &mut worker.dynamic_lyrics,
                7,
                1_500,
                |title, artist, album| {
                    update_smtc_music_properties(&worker.smtc, title, artist, album)
                },
            )
            .expect("resume dynamic lyric");
            worker
                .handle(PlayerCommand::ClearDynamicLyrics {
                    generation: 7,
                    lyrics_epoch: 2,
                })
                .expect("clear dynamic lyrics");
            assert_eq!(
                properties.Title().expect("restored title").to_string(),
                "Fixture title"
            );
            assert_eq!(
                properties.Artist().expect("restored artist").to_string(),
                "Fixture artist"
            );

            let artwork_path = std::env::temp_dir()
                .join(format!("qqmusic-smtc-native-{}.png", uuid::Uuid::new_v4()));
            let artwork_bytes = vec![
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
                0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00,
                0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78,
                0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00, 0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66,
                0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
            ];
            std::fs::write(&artwork_path, artwork_bytes).expect("png artwork");
            let artwork = SmtcArtworkFile::new("image/png".to_owned(), artwork_path.clone())
                .expect("png artwork file");
            worker
                .set_smtc_artwork(artwork)
                .expect("publish SMTC artwork");
            let thumbnail = worker
                .smtc
                .DisplayUpdater()
                .and_then(|updater| updater.Thumbnail())
                .expect("thumbnail reference");
            let thumbnail_stream = thumbnail.OpenReadAsync().expect("thumbnail stream");
            assert!(
                thumbnail_stream
                    .get()
                    .expect("thumbnail bytes")
                    .Size()
                    .unwrap_or(0)
                    > 0
            );
            worker.clear_smtc_artwork();
            let _ = std::fs::remove_file(artwork_path);

            worker.close();
            drop(worker);
            // SAFETY: balances the successful RoInitialize above on this thread.
            unsafe { RoUninitialize() };
        })
        .join()
        .expect("SMTC test thread");
    }

    #[test]
    fn stale_media_ended_cannot_overwrite_a_new_generation() {
        let mut loading = PlayerSnapshot {
            state: PlayerState::Loading,
            generation: 8,
            position_ms: 0,
            duration_ms: Some(200_000),
            volume: 1.0,
            muted: false,
            current_track: Some(crate::player::TrackSummary {
                source: None,
                id: "new-track".to_owned(),
                title: "New".to_owned(),
                artist: "Artist".to_owned(),
            }),
            failure: None,
        };
        assert!(!mark_ended_if_current(&mut loading, 8, true));
        assert_eq!(loading.state, PlayerState::Loading);

        loading.state = PlayerState::Playing;
        assert!(!mark_ended_if_current(&mut loading, 7, true));
        assert!(!mark_ended_if_current(&mut loading, 8, false));
        assert!(!mark_ended_if_current(&mut loading, 8, true));
        assert_eq!(loading.state, PlayerState::Playing);

        loading.position_ms = 199_000;
        assert!(mark_ended_if_current(&mut loading, 8, true));
        assert_eq!(loading.state, PlayerState::Ended);
    }

    #[test]
    fn sampled_position_requires_current_generation_and_source() {
        let snapshot = Arc::new(RwLock::new(PlayerSnapshot {
            state: PlayerState::Playing,
            generation: 8,
            position_ms: 123,
            duration_ms: Some(200_000),
            volume: 1.0,
            muted: false,
            current_track: Some(crate::player::TrackSummary {
                source: None,
                id: "current-track".to_owned(),
                title: "Current".to_owned(),
                artist: "Artist".to_owned(),
            }),
            failure: None,
        }));

        assert!(sample_position_if_current(&snapshot, 8, true, 456));
        assert_eq!(snapshot.read().expect("snapshot lock").position_ms, 456);
        assert!(!sample_position_if_current(&snapshot, 7, true, 789));
        assert!(!sample_position_if_current(&snapshot, 8, false, 789));
        assert_eq!(snapshot.read().expect("snapshot lock").position_ms, 456);
    }

    #[test]
    fn position_sample_gate_returns_cached_path_while_request_is_in_flight() {
        let in_flight = AtomicBool::new(false);
        assert!(try_start_position_sample(&in_flight));
        assert!(!try_start_position_sample(&in_flight));
        in_flight.store(false, Ordering::Release);
        assert!(try_start_position_sample(&in_flight));
    }

    #[test]
    fn queued_event_requires_both_generation_and_source_identity() {
        assert!(event_belongs_to_current_source(12, 12, true));
        assert!(!event_belongs_to_current_source(11, 12, true));
        assert!(!event_belongs_to_current_source(12, 12, false));
    }

    #[test]
    fn stale_artwork_epoch_cannot_restore_a_cleared_thumbnail() {
        assert!(artwork_epoch_is_current(7, 6));
        assert!(artwork_epoch_is_current(7, 7));
        assert!(!artwork_epoch_is_current(6, 7));
    }

    #[test]
    fn dynamic_lyric_index_uses_current_or_previous_line() {
        let lines = vec![
            SmtcLyricLine::new(1_000, "one".to_owned()).expect("one"),
            SmtcLyricLine::new(2_000, "two".to_owned()).expect("two"),
            SmtcLyricLine::new(4_000, "three".to_owned()).expect("three"),
        ];
        assert_eq!(lyric_index_at(999, &lines), None);
        assert_eq!(lyric_index_at(1_000, &lines), Some(0));
        assert_eq!(lyric_index_at(1_999, &lines), Some(0));
        assert_eq!(lyric_index_at(2_000, &lines), Some(1));
        assert_eq!(lyric_index_at(u64::MAX, &lines), Some(2));
        assert_eq!(lyric_index_at(0, &[]), None);
    }

    #[test]
    fn dynamic_lyrics_target_uses_strictly_later_boundary_and_skips_missed_lines() {
        let timeline = SmtcLyricTimeline::new(vec![
            SmtcLyricLine::new(1_000, "one".to_owned()).expect("one"),
            SmtcLyricLine::new(2_000, "two".to_owned()).expect("two"),
            SmtcLyricLine::new(4_000, "three".to_owned()).expect("three"),
        ])
        .expect("timeline");

        assert_eq!(dynamic_lyrics_target(0, &timeline), (None, Some(1_000)));
        assert_eq!(
            dynamic_lyrics_target(1_000, &timeline),
            (Some(0), Some(2_000))
        );
        assert_eq!(
            dynamic_lyrics_target(2_500, &timeline),
            (Some(1), Some(4_000))
        );
        assert_eq!(dynamic_lyrics_target(9_000, &timeline), (Some(2), None));
    }

    #[test]
    fn dynamic_lyrics_deadline_prefers_lyric_and_combines_equal_watchdog_wake() {
        let now = Instant::now();
        let mut schedule = DynamicLyricsSchedule {
            generation: 7,
            lyrics_epoch: 3,
            lyric_deadline: Some(now + Duration::from_secs(1)),
            watchdog_deadline: Some(now + Duration::from_secs(30)),
            boundary_ms: Some(1_000),
            early_wake_attempts: 0,
            last_position_ms: Some(0),
        };
        assert_eq!(
            next_dynamic_lyrics_deadline(&schedule),
            Some((
                now + Duration::from_secs(1),
                DynamicLyricsDeadlineKind::Lyric
            ))
        );
        schedule.lyric_deadline = None;
        assert_eq!(
            next_dynamic_lyrics_deadline(&schedule),
            Some((
                now + Duration::from_secs(30),
                DynamicLyricsDeadlineKind::Watchdog
            ))
        );
        schedule.lyric_deadline = schedule.watchdog_deadline;
        assert_eq!(
            next_dynamic_lyrics_deadline(&schedule),
            Some((
                now + Duration::from_secs(30),
                DynamicLyricsDeadlineKind::Watchdog
            ))
        );
    }

    #[test]
    fn early_wake_backoff_is_bounded_and_deterministic() {
        assert_eq!(
            early_wake_decision(0, Some(900), 900, 1_000),
            EarlyWakeDecision::Retry(Duration::from_millis(10))
        );
        assert_eq!(
            early_wake_decision(1, Some(900), 900, 1_000),
            EarlyWakeDecision::Retry(Duration::from_millis(50))
        );
        assert_eq!(
            early_wake_decision(2, Some(900), 900, 1_000),
            EarlyWakeDecision::Retry(Duration::from_millis(250))
        );
        assert_eq!(
            early_wake_decision(3, Some(900), 900, 1_000),
            EarlyWakeDecision::Cancel
        );
        assert_eq!(
            early_wake_decision(0, Some(900), 1_000, 1_000),
            EarlyWakeDecision::Ready
        );
        assert_eq!(
            early_wake_decision(0, Some(900), 950, 1_000),
            EarlyWakeDecision::Cancel
        );
    }

    #[test]
    fn watchdog_fallback_keeps_current_deadline_and_rebinds_stale_context() {
        let now = Instant::now();
        let existing_deadline = now + Duration::from_secs(12);
        let current = DynamicLyricsSchedule {
            generation: 7,
            lyrics_epoch: 3,
            lyric_deadline: Some(now + Duration::from_secs(1)),
            watchdog_deadline: Some(existing_deadline),
            boundary_ms: Some(1_000),
            early_wake_attempts: 2,
            last_position_ms: Some(900),
        };
        let same = dynamic_lyrics_watchdog_fallback(&current, 7, 3, now);
        assert_eq!(same.watchdog_deadline, Some(existing_deadline));
        assert_eq!(same.lyric_deadline, None);
        assert_eq!(same.generation, 7);
        assert_eq!(same.lyrics_epoch, 3);

        let rebound = dynamic_lyrics_watchdog_fallback(&current, 8, 4, now);
        assert_eq!(
            rebound.watchdog_deadline,
            Some(now + DYNAMIC_LYRICS_WATCHDOG_INTERVAL)
        );
        assert_eq!(rebound.generation, 8);
        assert_eq!(rebound.lyrics_epoch, 4);
    }

    #[test]
    fn setting_timeline_preserves_normal_but_invalidates_a_published_lyric_index() {
        let mut state = DynamicLyricsDisplayState {
            published: Some(PublishedSmtcText::Normal),
            ..DynamicLyricsDisplayState::default()
        };
        state.set_timeline(
            1,
            SmtcLyricTimeline::new(vec![
                SmtcLyricLine::new(1_000, "one".to_owned()).expect("one")
            ])
            .expect("first timeline"),
        );
        assert_eq!(state.published, Some(PublishedSmtcText::Normal));

        state.published = Some(PublishedSmtcText::Lyric(0));
        state.set_timeline(
            2,
            SmtcLyricTimeline::new(vec![
                SmtcLyricLine::new(2_000, "two".to_owned()).expect("two")
            ])
            .expect("second timeline"),
        );
        assert_eq!(state.published, None);
        assert_eq!(state.lyrics_epoch, 2);
    }

    #[test]
    fn dynamic_lyrics_writer_commits_published_state_only_after_success() {
        let track = crate::player::TrackSummary {
            source: None,
            id: "fixture".to_owned(),
            title: "Title".to_owned(),
            artist: "Artist".to_owned(),
        };
        let metadata = SmtcMetadata::from_queue_track("Album".to_owned(), 60_000);
        let mut state = DynamicLyricsDisplayState::default();
        state.reset_for_track(7, &track, &metadata);
        state.timeline = Some(
            SmtcLyricTimeline::new(vec![
                SmtcLyricLine::new(1_000, "lyric".to_owned()).expect("lyric")
            ])
            .expect("timeline"),
        );

        let failed =
            update_dynamic_smtc_text_with(&mut state, 7, 1_000, |_title, _artist, _album| {
                Err(PlayerError::NativeFailure)
            });
        assert_eq!(failed, Err(PlayerError::NativeFailure));
        assert_eq!(state.published, None);

        let mut writes = 0;
        assert_eq!(
            update_dynamic_smtc_text_with(&mut state, 7, 1_000, |_title, _artist, _album| {
                writes += 1;
                Ok(())
            }),
            Ok(true)
        );
        assert_eq!(writes, 1);
        assert_eq!(state.published, Some(PublishedSmtcText::Lyric(0)));
        assert_eq!(
            update_dynamic_smtc_text_with(&mut state, 7, 1_000, |_title, _artist, _album| {
                writes += 1;
                Ok(())
            }),
            Ok(false)
        );
        assert_eq!(writes, 1);

        assert_eq!(
            restore_normal_smtc_text_with(&mut state, 7, |_title, _artist, _album| {
                Err(PlayerError::NativeFailure)
            }),
            Err(PlayerError::NativeFailure)
        );
        assert_eq!(state.published, Some(PublishedSmtcText::Lyric(0)));
        assert_eq!(
            restore_normal_smtc_text_with(&mut state, 7, |_title, _artist, _album| Ok(())),
            Ok(true)
        );
        assert_eq!(state.published, Some(PublishedSmtcText::Normal));
    }

    #[test]
    fn lyric_timeline_still_rejects_duplicate_and_reversed_timestamps() {
        assert!(SmtcLyricTimeline::new(vec![
            SmtcLyricLine::new(1_000, "one".to_owned()).expect("one"),
            SmtcLyricLine::new(1_000, "two".to_owned()).expect("two"),
        ])
        .is_err());
        assert!(SmtcLyricTimeline::new(vec![
            SmtcLyricLine::new(2_000, "two".to_owned()).expect("two"),
            SmtcLyricLine::new(1_000, "one".to_owned()).expect("one"),
        ])
        .is_err());
    }

    #[test]
    fn lyrics_epoch_is_independent_and_monotonic() {
        assert!(lyrics_epoch_is_current(7, 6));
        assert!(lyrics_epoch_is_current(7, 7));
        assert!(!lyrics_epoch_is_current(6, 7));
    }
}
