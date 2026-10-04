use std::{
    sync::{Arc, Condvar, Mutex, Weak},
    thread::{self, JoinHandle},
};

use crate::{
    lyrics::LyricService,
    playback::PlaybackController,
    player::{SmtcLyricLine, SmtcLyricTimeline},
};

pub(crate) trait SmtcDynamicLyricsPort: Send + Sync {
    fn request(&self, track_id: String, player_generation: u64);
    fn clear(&self);
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LyricsRequest {
    track_id: String,
    player_generation: u64,
    lyrics_epoch: u64,
}

#[derive(Default)]
struct CoordinatorState {
    enabled: bool,
    pending: Option<LyricsRequest>,
    lyrics_epoch: u64,
    stopped: bool,
}

impl CoordinatorState {
    fn queue(&mut self, track_id: String, player_generation: u64) -> Option<u64> {
        if !self.enabled || self.stopped {
            return None;
        }
        self.lyrics_epoch = self.lyrics_epoch.wrapping_add(1);
        self.pending = Some(LyricsRequest {
            track_id,
            player_generation,
            lyrics_epoch: self.lyrics_epoch,
        });
        Some(self.lyrics_epoch)
    }

    fn cancel(&mut self) -> u64 {
        self.lyrics_epoch = self.lyrics_epoch.wrapping_add(1);
        self.pending = None;
        self.lyrics_epoch
    }

    fn request_is_current(&self, request: &LyricsRequest) -> bool {
        self.enabled
            && !self.stopped
            && self.lyrics_epoch == request.lyrics_epoch
            && self.pending.is_none()
    }
}

struct SharedState {
    state: Mutex<CoordinatorState>,
    wake: Condvar,
}

pub(crate) struct SmtcDynamicLyricsCoordinator {
    shared: Arc<SharedState>,
    playback: Weak<PlaybackController>,
    worker: Option<JoinHandle<()>>,
}

impl SmtcDynamicLyricsCoordinator {
    pub(crate) fn new(lyrics: Arc<LyricService>, playback: Weak<PlaybackController>) -> Arc<Self> {
        let shared = Arc::new(SharedState {
            state: Mutex::new(CoordinatorState::default()),
            wake: Condvar::new(),
        });
        let worker_shared = Arc::clone(&shared);
        let worker_playback = playback.clone();
        let worker = thread::Builder::new()
            .name("qqmusic-smtc-dynamic-lyrics".to_owned())
            .spawn(move || lyrics_loop(worker_shared, lyrics, worker_playback))
            .ok();
        if worker.is_none() {
            shared
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .stopped = true;
        }
        Arc::new(Self {
            shared,
            playback,
            worker,
        })
    }

    pub(crate) fn set_enabled(&self, enabled: bool) -> bool {
        let lyrics_epoch = {
            let mut state = self
                .shared
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.stopped {
                return false;
            }
            state.enabled = enabled;
            if enabled {
                None
            } else {
                Some(state.cancel())
            }
        };
        self.shared.wake.notify_one();

        if let Some(lyrics_epoch) = lyrics_epoch {
            self.clear_native(lyrics_epoch);
            return false;
        }

        self.request_current_track();
        true
    }

    pub(crate) fn clear_for_logout(&self) {
        self.clear();
    }

    fn clear_native(&self, lyrics_epoch: u64) {
        if let Some(playback) = self.playback.upgrade() {
            let generation = playback.snapshot().generation;
            let _ = playback.clear_smtc_dynamic_lyrics(generation, lyrics_epoch);
        }
    }

    fn request_current_track(&self) {
        let Some(playback) = self.playback.upgrade() else {
            return;
        };
        let before = playback.snapshot();
        let before_identity = before
            .current_track
            .as_ref()
            .map(|track| (track.id.clone(), before.generation));
        if let Some((track_id, generation)) = &before_identity {
            self.request(track_id.clone(), *generation);
        }

        // Enabling races with queue changes outside the session operation lock. Re-read after
        // enqueueing so an older track can never remain the coordinator's latest request.
        let after = playback.snapshot();
        let after_identity = after
            .current_track
            .map(|track| (track.id, after.generation));
        if after_identity != before_identity {
            if let Some((track_id, generation)) = after_identity {
                self.request(track_id, generation);
            } else {
                self.clear();
            }
        }
    }
}

impl SmtcDynamicLyricsPort for SmtcDynamicLyricsCoordinator {
    fn request(&self, track_id: String, player_generation: u64) {
        let queued_epoch = {
            let mut state = self
                .shared
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.queue(track_id, player_generation)
        };
        if let Some(_lyrics_epoch) = queued_epoch {
            #[cfg(debug_assertions)]
            eprintln!(
                "[smtc-dynamic-lyrics] queued generation={player_generation} epoch={_lyrics_epoch}"
            );
            self.shared.wake.notify_one();
        }
    }

    fn clear(&self) {
        let lyrics_epoch = {
            let mut state = self
                .shared
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.cancel()
        };
        self.shared.wake.notify_one();
        self.clear_native(lyrics_epoch);
    }
}

impl Drop for SmtcDynamicLyricsCoordinator {
    fn drop(&mut self) {
        {
            let mut state = self
                .shared
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.stopped = true;
            state.cancel();
        }
        self.shared.wake.notify_one();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn lyrics_loop(
    shared: Arc<SharedState>,
    lyrics: Arc<LyricService>,
    playback: Weak<PlaybackController>,
) {
    loop {
        let request = {
            let mut state = shared
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            while state.pending.is_none() && !state.stopped {
                state = shared
                    .wake
                    .wait(state)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            if state.stopped {
                return;
            }
            state.pending.take()
        };
        let Some(request) = request else {
            continue;
        };

        let timeline = lyrics
            .timeline(&request.track_id, request.player_generation)
            .and_then(|timeline| {
                let lines = timeline.lines;
                #[cfg(debug_assertions)]
                eprintln!(
                    "[smtc-dynamic-lyrics] fetched generation={} epoch={} lines={}",
                    request.player_generation,
                    request.lyrics_epoch,
                    lines.len()
                );
                let lines = lines
                    .iter()
                    .map(|line| SmtcLyricLine::new(line.at_ms, line.original.clone()))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| crate::lyrics::LyricError::UpstreamSchemaChanged)?;
                SmtcLyricTimeline::new(lines)
                    .map_err(|_| crate::lyrics::LyricError::UpstreamSchemaChanged)
            });

        let still_current = {
            let state = shared
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.request_is_current(&request)
        };

        #[cfg(debug_assertions)]
        if let Err(error) = &timeline {
            eprintln!(
                "[smtc-dynamic-lyrics] timeline failed generation={} epoch={} error={error:?}",
                request.player_generation, request.lyrics_epoch
            );
        }
        if !still_current {
            #[cfg(debug_assertions)]
            eprintln!(
                "[smtc-dynamic-lyrics] stale coordinator request generation={} epoch={}",
                request.player_generation, request.lyrics_epoch
            );
            continue;
        }
        let Some(playback) = playback.upgrade() else {
            return;
        };
        if playback.snapshot().generation != request.player_generation {
            #[cfg(debug_assertions)]
            eprintln!(
                "[smtc-dynamic-lyrics] stale player generation={} epoch={}",
                request.player_generation, request.lyrics_epoch
            );
            continue;
        }
        match timeline {
            Ok(timeline) => {
                let _result = playback.set_smtc_dynamic_lyrics(
                    request.player_generation,
                    request.lyrics_epoch,
                    timeline,
                );
                #[cfg(debug_assertions)]
                eprintln!(
                    "[smtc-dynamic-lyrics] submitted generation={} epoch={} applied={}",
                    request.player_generation,
                    request.lyrics_epoch,
                    _result.is_ok()
                );
            }
            Err(_) => {
                let _result = playback
                    .clear_smtc_dynamic_lyrics(request.player_generation, request.lyrics_epoch);
                #[cfg(debug_assertions)]
                eprintln!(
                    "[smtc-dynamic-lyrics] cleared after failure generation={} epoch={} applied={}",
                    request.player_generation,
                    request.lyrics_epoch,
                    _result.is_ok()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinator_state_is_disabled_by_default_and_latest_wins() {
        let mut state = CoordinatorState::default();
        assert_eq!(state.queue("track-a".to_owned(), 1), None);
        state.enabled = true;
        let first_epoch = state.queue("track-a".to_owned(), 1).expect("first");
        let second_epoch = state.queue("track-b".to_owned(), 2).expect("second");
        assert!(second_epoch > first_epoch);
        assert_eq!(
            state
                .pending
                .as_ref()
                .map(|request| request.track_id.as_str()),
            Some("track-b")
        );
    }

    #[test]
    fn cancel_invalidates_an_in_flight_request() {
        let mut state = CoordinatorState {
            enabled: true,
            ..CoordinatorState::default()
        };
        state.queue("track".to_owned(), 7).expect("queue");
        let request = state.pending.take().expect("request");
        assert!(state.request_is_current(&request));
        state.cancel();
        assert!(!state.request_is_current(&request));
    }
}
