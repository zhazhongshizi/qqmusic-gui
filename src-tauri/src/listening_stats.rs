use crate::{
    persistence::PersistenceService,
    player::{PlayerSnapshot, PlayerState},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Default)]
pub struct ListeningStats {
    current: Option<Listen>,
    sampled: Option<Instant>,
    pub storage_available: bool,
}
struct Listen {
    id: String,
    title: String,
    artist: String,
    generation: u64,
    at: Instant,
    position: u64,
    playing: bool,
    elapsed: u64,
    pending: u64,
    qualified: bool,
    pending_qualified: bool,
}
impl ListeningStats {
    pub fn new() -> Self {
        Self {
            storage_available: true,
            ..Self::default()
        }
    }
    pub fn needs_sample(&mut self, snapshot: &PlayerSnapshot, now: Instant) -> bool {
        if snapshot.state != PlayerState::Playing {
            return false;
        }
        if self
            .sampled
            .is_some_and(|at| now.saturating_duration_since(at) < Duration::from_secs(1))
        {
            return false;
        }
        self.sampled = Some(now);
        true
    }
    pub fn reposition(&mut self, snapshot: &PlayerSnapshot, now: Instant) {
        if let Some(value) = self.current.as_mut().filter(|value| {
            value.generation == snapshot.generation
                && snapshot
                    .current_track
                    .as_ref()
                    .is_some_and(|track| track.id == value.id)
        }) {
            value.position = snapshot.position_ms;
            value.at = now;
            value.playing = snapshot.state == PlayerState::Playing;
        }
    }
    pub fn observe(
        &mut self,
        snapshot: &PlayerSnapshot,
        now: Instant,
        persistence: &PersistenceService,
    ) {
        let changed = match (&self.current, &snapshot.current_track) {
            (Some(current), Some(track)) => {
                current.id != track.id || current.generation != snapshot.generation
            }
            (None, None) => false,
            _ => true,
        };
        if changed {
            self.flush(persistence);
            self.current = snapshot.current_track.as_ref().map(|track| Listen {
                id: track.id.clone(),
                title: track.title.clone(),
                artist: track.artist.clone(),
                generation: snapshot.generation,
                at: now,
                position: snapshot.position_ms,
                playing: snapshot.state == PlayerState::Playing,
                elapsed: 0,
                pending: 0,
                qualified: false,
                pending_qualified: false,
            });
            return;
        }
        let Some(value) = &mut self.current else {
            return;
        };
        let elapsed = now.saturating_duration_since(value.at).as_millis() as u64;
        let advanced = snapshot.position_ms.saturating_sub(value.position);
        if value.playing
            && snapshot.state == PlayerState::Playing
            && elapsed <= 2000
            && advanced <= elapsed.saturating_add(1000)
        {
            let counted = advanced.min(elapsed);
            value.elapsed += counted;
            value.pending += counted;
        }
        if advanced > 0
            || snapshot.position_ms < value.position
            || snapshot.state != PlayerState::Playing
            || !value.playing
            || elapsed > 2000
        {
            value.at = now;
        }
        value.position = snapshot.position_ms;
        value.playing = snapshot.state == PlayerState::Playing;
        let threshold = snapshot
            .duration_ms
            .filter(|d| *d > 0)
            .map_or(30_000, |d| (d / 2).clamp(1000, 30_000));
        if !value.qualified && value.elapsed >= threshold {
            value.qualified = true;
            value.pending_qualified = true;
        }
        if value.pending >= 15_000 || !value.playing || value.pending_qualified {
            self.flush(persistence);
        }
    }
    pub fn flush(&mut self, persistence: &PersistenceService) {
        let Some(value) = &mut self.current else {
            return;
        };
        if value.pending == 0 && !value.pending_qualified {
            return;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        self.storage_available = persistence
            .record_listening(
                &value.id,
                &value.title,
                &value.artist,
                value.pending,
                value.pending_qualified,
                now,
            )
            .is_ok();
        value.pending = 0;
        value.pending_qualified = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_small_seek_rebases_position_without_adding_seek_distance() {
        let root = std::env::temp_dir().join(format!("listen-{}", uuid::Uuid::new_v4()));
        let db = PersistenceService::open(&root.join("state.sqlite3")).unwrap();
        let mut tracker = ListeningStats::new();
        let mut player = PlayerSnapshot {
            state: PlayerState::Playing,
            generation: 1,
            position_ms: 0,
            duration_ms: Some(180_000),
            volume: 0.8,
            muted: false,
            failure: None,
            current_track: Some(crate::player::TrackSummary {
                id: "small".into(),
                title: "Small".into(),
                artist: "Artist".into(),
                source: None,
            }),
        };
        let start = Instant::now();
        tracker.observe(&player, start, &db);
        player.position_ms = 1000;
        tracker.observe(&player, start + Duration::from_secs(1), &db);
        player.position_ms = 1500;
        tracker.reposition(&player, start + Duration::from_millis(1500));
        player.position_ms = 2000;
        tracker.observe(&player, start + Duration::from_secs(2), &db);
        tracker.flush(&db);
        assert_eq!(db.listening_report().unwrap()["totalMs"], 1500);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn actual_progress_counts_once_and_survives_restart_without_seek_pause_or_suspend_time() {
        let root = std::env::temp_dir().join(format!("listen-{}", uuid::Uuid::new_v4()));
        let path = root.join("state.sqlite3");
        let db = PersistenceService::open(&path).unwrap();
        let mut tracker = ListeningStats::new();
        let mut player = PlayerSnapshot {
            state: PlayerState::Playing,
            generation: 1,
            position_ms: 0,
            duration_ms: Some(10_000),
            volume: 0.8,
            muted: false,
            failure: None,
            current_track: Some(crate::player::TrackSummary {
                id: "song".into(),
                title: "Song".into(),
                artist: "Artist".into(),
                source: None,
            }),
        };
        let start = Instant::now();
        tracker.observe(&player, start, &db);
        for second in 1..=6 {
            player.position_ms = second * 1000;
            tracker.observe(&player, start + Duration::from_secs(second), &db);
        }
        player.position_ms = 100_000;
        tracker.observe(&player, start + Duration::from_secs(7), &db);
        player.state = PlayerState::Paused;
        tracker.observe(&player, start + Duration::from_secs(8), &db);
        player.state = PlayerState::Playing;
        player.position_ms = 101_000;
        tracker.observe(&player, start + Duration::from_secs(80), &db);
        tracker.flush(&db);
        drop(db);
        let db = PersistenceService::open(&path).unwrap();
        let report = db.listening_report().unwrap();
        assert_eq!(report["totalMs"], 6000);
        assert_eq!(report["qualifiedPlays"], 1);
        assert_eq!(report["events"].as_array().unwrap().len(), 1);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
