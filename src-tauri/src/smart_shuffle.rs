//! Opt-in experiment. Its sidecar leaves the main database readable by older builds.
use crate::{
    player::{PlayerSnapshot, PlayerState},
    queue::QueueTrack,
};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const DAY_MS: u64 = 86_400_000;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartShuffleStatus {
    pub enabled: bool,
    pub likes_loaded: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SmartShufflePersistenceError;

pub struct SmartShuffle {
    path: PathBuf,
    connection: Option<Connection>,
    enabled: bool,
    likes: HashSet<String>,
    likes_loaded: bool,
    last_played: HashMap<String, u64>,
    recent: VecDeque<String>,
    listening: Option<Listening>,
    last_sample: Option<Instant>,
    seed: u64,
}

struct Listening {
    id: String,
    generation: u64,
    at: Instant,
    position: u64,
    playing: bool,
    elapsed_ms: u64,
    recorded: bool,
}

impl SmartShuffle {
    pub fn new(path: PathBuf) -> Self {
        let mut smart = Self {
            path,
            connection: None,
            enabled: false,
            likes: HashSet::new(),
            likes_loaded: false,
            last_played: HashMap::new(),
            recent: VecDeque::new(),
            listening: None,
            last_sample: None,
            seed: uuid::Uuid::new_v4().as_u128() as u64,
        };
        // Older experimental databases have no saved preference and remain opt-in.
        let enabled =
            Connection::open_with_flags(&smart.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .and_then(|connection| {
                    connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM metadata WHERE key = 'smart_shuffle_enabled')",
                        [],
                        |row| row.get::<_, bool>(0),
                    )
                })
                .unwrap_or(false);
        if enabled {
            let _ = smart.set_enabled(true, &[], None);
        }
        smart
    }

    pub fn status(&self) -> SmartShuffleStatus {
        SmartShuffleStatus {
            enabled: self.enabled,
            likes_loaded: self.likes_loaded,
        }
    }

    pub fn set_enabled(
        &mut self,
        enabled: bool,
        history: &[(String, u64)],
        likes: Option<HashSet<String>>,
    ) -> Result<SmartShuffleStatus, SmartShufflePersistenceError> {
        if self.connection.is_none() && (enabled || self.path.exists()) {
            let mut connection =
                Connection::open(&self.path).map_err(|_| SmartShufflePersistenceError)?;
            connection
                .busy_timeout(Duration::from_secs(2))
                .map_err(|_| SmartShufflePersistenceError)?;
            // Only this experiment owns this file. Completed migration is marked atomically.
            let tx = connection
                .transaction()
                .map_err(|_| SmartShufflePersistenceError)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS listening_stats (
                track_id TEXT PRIMARY KEY, last_played_ms INTEGER NOT NULL CHECK(last_played_ms >= 0)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY) STRICT;").map_err(|_| SmartShufflePersistenceError)?;
            let seeded: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM metadata WHERE key = 'history_seeded')",
                    [],
                    |r| r.get(0),
                )
                .map_err(|_| SmartShufflePersistenceError)?;
            if !seeded {
                for (id, time) in history {
                    let time = i64::try_from(*time).map_err(|_| SmartShufflePersistenceError)?;
                    tx.execute(
                        "INSERT OR IGNORE INTO listening_stats VALUES (?1, ?2)",
                        params![id, time],
                    )
                    .map_err(|_| SmartShufflePersistenceError)?;
                }
                tx.execute("INSERT INTO metadata VALUES ('history_seeded')", [])
                    .map_err(|_| SmartShufflePersistenceError)?;
            }
            tx.commit().map_err(|_| SmartShufflePersistenceError)?;
            let values = {
                let mut query = connection
                    .prepare("SELECT track_id, last_played_ms FROM listening_stats")
                    .map_err(|_| SmartShufflePersistenceError)?;
                let rows = query
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?.max(0) as u64,
                        ))
                    })
                    .map_err(|_| SmartShufflePersistenceError)?;
                rows.collect::<Result<HashMap<_, _>, _>>()
                    .map_err(|_| SmartShufflePersistenceError)?
            };
            self.last_played = values;
            self.connection = Some(connection);
        }
        // Persist first: never report a changed switch if saving failed.
        if let Some(connection) = &self.connection {
            connection
                .execute(
                    if enabled {
                        "INSERT OR IGNORE INTO metadata VALUES ('smart_shuffle_enabled')"
                    } else {
                        "DELETE FROM metadata WHERE key = 'smart_shuffle_enabled'"
                    },
                    [],
                )
                .map_err(|_| SmartShufflePersistenceError)?;
        }
        self.enabled = enabled;
        self.listening = None;
        self.last_sample = None;
        self.replace_likes(likes);
        Ok(self.status())
    }

    pub fn replace_likes(&mut self, likes: Option<HashSet<String>>) {
        self.likes_loaded = likes.is_some();
        self.likes = likes.unwrap_or_default();
    }

    pub fn update_likes(&mut self, ids: &[String], liked: bool) {
        for id in ids {
            if liked {
                self.likes.insert(id.clone());
            } else {
                self.likes.remove(id);
            }
        }
    }

    pub fn index(
        &self,
        items: &[QueueTrack],
        current: usize,
        generation: u64,
        queue_generation: u64,
    ) -> Option<usize> {
        if !self.enabled || items.is_empty() {
            return None;
        }
        if items.len() == 1 {
            return Some(0);
        }
        let now = unix_ms();
        let weights: Vec<f64> = items
            .iter()
            .enumerate()
            .map(|(i, track)| {
                if i == current {
                    return 0.0;
                }
                weight(
                    self.last_played.get(&track.id).copied(),
                    now,
                    self.likes.contains(&track.id),
                    self.recent.contains(&track.id),
                )
            })
            .collect();
        // Stable within a playback/queue generation: previews never consume randomness.
        let bits = mix(self
            .seed
            .wrapping_add(mix(generation))
            .wrapping_add(mix(queue_generation).rotate_left(17)));
        pick(&weights, (bits >> 11) as f64 / ((1_u64 << 53) as f64))
    }

    pub fn explanation(
        &self,
        items: &[QueueTrack],
        current: Option<usize>,
        shuffle_mode: bool,
    ) -> serde_json::Value {
        let now = unix_ms();
        let weights: Vec<f64> = items
            .iter()
            .enumerate()
            .map(|(index, track)| {
                if Some(index) == current && items.len() > 1 {
                    0.0
                } else {
                    weight(
                        self.last_played.get(&track.id).copied(),
                        now,
                        self.likes.contains(&track.id),
                        self.recent.contains(&track.id),
                    )
                }
            })
            .collect();
        let total = weights.iter().sum::<f64>();
        let rows: Vec<_>=items.iter().zip(weights).map(|(track,weight)| serde_json::json!({
            "id":track.id,"title":track.title,"artist":track.artist,"lastPlayedMs":self.last_played.get(&track.id),
            "liked":self.likes.contains(&track.id),"recent":self.recent.contains(&track.id),"weight":weight,
            "probability":if total>0.0 {weight/total} else {0.0}
        })).collect();
        serde_json::json!({"enabled":self.enabled,"active":self.enabled && shuffle_mode,"likesLoaded":self.likes_loaded,"items":rows})
    }

    /// Fresh position samples are needed even when the renderer is hidden. Stop sampling after qualification.
    pub fn needs_position_sample(&mut self, snapshot: &PlayerSnapshot, now: Instant) -> bool {
        if !self.enabled || snapshot.state != PlayerState::Playing {
            return false;
        }
        if self
            .listening
            .as_ref()
            .is_some_and(|value| value.generation == snapshot.generation && value.recorded)
        {
            return false;
        }
        if self
            .last_sample
            .is_some_and(|at| now.saturating_duration_since(at) < Duration::from_secs(1))
        {
            return false;
        }
        self.last_sample = Some(now);
        true
    }

    pub fn observe(&mut self, snapshot: &PlayerSnapshot, now: Instant) {
        if !self.enabled {
            return;
        }
        let Some(track) = &snapshot.current_track else {
            self.listening = None;
            return;
        };
        if self
            .listening
            .as_ref()
            .is_none_or(|value| value.id != track.id || value.generation != snapshot.generation)
        {
            // Count starts for repetition suppression even if the user skips quickly.
            self.recent.retain(|id| id != &track.id);
            self.recent.push_front(track.id.clone());
            self.recent.truncate(5);
            self.listening = Some(Listening {
                id: track.id.clone(),
                generation: snapshot.generation,
                at: now,
                position: snapshot.position_ms,
                playing: snapshot.state == PlayerState::Playing,
                elapsed_ms: 0,
                recorded: false,
            });
            return;
        }
        let value = self.listening.as_mut().expect("listening initialized");
        let elapsed = now.saturating_duration_since(value.at).as_millis() as u64;
        let advanced = snapshot.position_ms.saturating_sub(value.position);
        // Do not count pauses, buffering, seeks, or long scheduling/suspend gaps.
        if value.playing
            && snapshot.state == PlayerState::Playing
            && elapsed <= 2_000
            && advanced <= elapsed.saturating_add(1_000)
        {
            value.elapsed_ms = value.elapsed_ms.saturating_add(advanced.min(elapsed));
        }
        // Native snapshots may update position less often than the observation loop.
        if advanced > 0
            || snapshot.position_ms < value.position
            || snapshot.state != PlayerState::Playing
            || !value.playing
            || elapsed > 2_000
        {
            value.at = now;
        }
        value.position = snapshot.position_ms;
        value.playing = snapshot.state == PlayerState::Playing;
        let threshold = snapshot
            .duration_ms
            .filter(|d| *d > 0)
            .map_or(30_000, |d| (d / 2).clamp(1_000, 30_000));
        if !value.recorded && value.elapsed_ms >= threshold {
            let time = unix_ms();
            // Best effort, once per play: a storage error must not stall playback or retry every tick.
            value.recorded = true;
            self.last_played.insert(value.id.clone(), time);
            if let Some(connection) = &self.connection {
                let _ = connection.execute(
                    "INSERT INTO listening_stats VALUES (?1, ?2)
                    ON CONFLICT(track_id) DO UPDATE SET last_played_ms = excluded.last_played_ms",
                    params![value.id, time.min(i64::MAX as u64) as i64],
                );
            }
        }
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn weight(last: Option<u64>, now: u64, liked: bool, recent: bool) -> f64 {
    let age_weight = last.map_or(2.0, |last| {
        let days = now.saturating_sub(last) as f64 / DAY_MS as f64;
        if days < 1.0 {
            0.25 + 0.75 * days
        } else {
            1.0 + (days / 30.0).min(4.0)
        }
    });
    age_weight * if liked { 1.5 } else { 1.0 } * if recent { 0.08 } else { 1.0 }
}

fn mix(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e3779b97f4a7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d049bb133111eb);
    value ^ (value >> 31)
}

fn pick(weights: &[f64], fraction: f64) -> Option<usize> {
    let mut target = weights.iter().sum::<f64>() * fraction;
    for (i, weight) in weights.iter().enumerate() {
        if *weight > 0.0 && target < *weight {
            return Some(i);
        }
        target -= weight;
    }
    weights.iter().rposition(|weight| *weight > 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preference_survives_restart_and_old_databases_remain_opt_in() {
        let (root, mut smart) = fixture();
        let path = smart.path.clone();
        smart
            .set_enabled(true, &[("old".into(), 123)], None)
            .unwrap();
        drop(smart);
        let mut restored = SmartShuffle::new(path.clone());
        assert!(restored.status().enabled);
        assert_eq!(restored.last_played["old"], 123);
        restored.set_enabled(false, &[], None).unwrap();
        drop(restored);
        let mut disabled = SmartShuffle::new(path.clone());
        assert!(!disabled.status().enabled);
        disabled.set_enabled(true, &[], None).unwrap();
        disabled
            .connection
            .as_ref()
            .unwrap()
            .execute(
                "DELETE FROM metadata WHERE key = 'smart_shuffle_enabled'",
                [],
            )
            .unwrap();
        drop(disabled);
        let mut legacy = SmartShuffle::new(path);
        assert!(!legacy.status().enabled);
        legacy.set_enabled(true, &[], None).unwrap();
        assert_eq!(legacy.last_played["old"], 123);
        drop(legacy);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_preference_write_keeps_runtime_and_saved_switch_enabled() {
        let (root, mut smart) = fixture();
        smart.set_enabled(true, &[], None).unwrap();
        smart.connection.as_ref().unwrap().execute_batch(
            "CREATE TRIGGER reject_disable BEFORE DELETE ON metadata BEGIN SELECT RAISE(ABORT, 'test failure'); END;"
        ).unwrap();
        assert!(smart.set_enabled(false, &[], None).is_err());
        assert!(smart.status().enabled);
        let path = smart.path.clone();
        drop(smart);
        let restored = SmartShuffle::new(path);
        assert!(restored.status().enabled);
        drop(restored);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn forgotten_favorites_gain_weight_without_starving_unheard_tracks() {
        let now = 200 * DAY_MS;
        assert!(
            weight(Some(now - 120 * DAY_MS), now, true, false)
                > weight(Some(now - 2 * DAY_MS), now, true, false)
        );
        assert_eq!(weight(Some(now - 120 * DAY_MS), now, true, false), 7.5);
        assert!(weight(None, now, false, false) > 0.0);
        assert!(weight(Some(now), now, true, true) < weight(None, now, false, false));
        assert_eq!(weight(Some(now + DAY_MS), now, false, false), 0.25);
    }

    #[test]
    fn sampling_respects_weights_and_never_selects_zero_weight() {
        let mut counts = [0; 4];
        for i in 0..10_000 {
            counts[pick(&[0.0, 1.0, 2.0, 7.0], i as f64 / 10_000.0).unwrap()] += 1;
        }
        assert_eq!(counts, [0, 1_000, 2_000, 7_000]);
        assert_eq!(pick(&[], 0.5), None);
    }

    fn fixture() -> (PathBuf, SmartShuffle) {
        let root = std::env::temp_dir().join(format!("smart-shuffle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let smart = SmartShuffle::new(root.join("smart-shuffle.sqlite3"));
        (root, smart)
    }

    #[test]
    fn explanation_uses_selection_weights_without_consuming_randomness() {
        let (root, mut smart) = fixture();
        smart
            .set_enabled(true, &[], Some(HashSet::from(["liked".to_owned()])))
            .unwrap();
        let items: Vec<_> = ["current", "liked", "other"]
            .into_iter()
            .map(|id| QueueTrack {
                id: id.into(),
                title: id.into(),
                artist: "Artist".into(),
                album: "".into(),
                duration_ms: 10_000,
                media_mid: None,
                cover_cache_key: None,
            })
            .collect();
        let preview = smart.index(&items, 0, 1, 1);
        let report = smart.explanation(&items, Some(0), true);
        assert_eq!(report["active"], true);
        assert_eq!(report["items"][0]["weight"], 0.0);
        assert_eq!(report["items"][1]["weight"], 3.0);
        assert_eq!(report["items"][2]["weight"], 2.0);
        assert_eq!(report["items"][1]["probability"], 0.6);
        assert_eq!(smart.index(&items, 0, 1, 1), preview);
        assert_eq!(smart.explanation(&items, Some(0), false)["active"], false);
        drop(smart);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn player(id: &str) -> PlayerSnapshot {
        PlayerSnapshot {
            state: PlayerState::Playing,
            generation: 1,
            position_ms: 0,
            duration_ms: Some(180_000),
            volume: 0.8,
            muted: false,
            failure: None,
            current_track: Some(crate::player::TrackSummary {
                source: None,
                id: id.into(),
                title: id.into(),
                artist: "Artist".into(),
            }),
        }
    }

    #[test]
    fn qualified_listen_survives_restart_without_reimporting_old_starts() {
        let (root, mut smart) = fixture();
        assert!(!smart.status().enabled);
        assert!(!smart.path.exists());
        smart
            .set_enabled(
                true,
                &[("old".into(), 100)],
                Some(HashSet::from(["new".into()])),
            )
            .unwrap();
        let mut snapshot = player("new");
        let start = Instant::now();
        smart.observe(&snapshot, start);
        // A one-second native position update observed by a 250-ms worker.
        for tick in 1..=120 {
            snapshot.position_ms = (tick / 4) * 1_000;
            smart.observe(&snapshot, start + Duration::from_millis(tick * 250));
        }
        assert!(smart.last_played.contains_key("new"));
        let recorded = smart.last_played["new"];
        drop(smart);
        let mut reopened = SmartShuffle::new(root.join("smart-shuffle.sqlite3"));
        assert!(reopened.status().enabled);
        reopened
            .set_enabled(true, &[("new".into(), 1), ("later-start".into(), 2)], None)
            .unwrap();
        assert_eq!(reopened.last_played["new"], recorded);
        assert_eq!(reopened.last_played["old"], 100);
        assert!(!reopened.last_played.contains_key("later-start"));
        assert!(!reopened.status().likes_loaded);
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skips_seeks_pauses_and_disabled_playback_do_not_count_as_listens() {
        let (root, mut smart) = fixture();
        smart.set_enabled(true, &[], None).unwrap();
        let start = Instant::now();
        let mut snapshot = player("skip");
        smart.observe(&snapshot, start);
        snapshot.position_ms = 120_000;
        smart.observe(&snapshot, start + Duration::from_millis(250));
        snapshot.state = PlayerState::Paused;
        smart.observe(&snapshot, start + Duration::from_secs(60));
        assert!(smart.last_played.is_empty());
        snapshot = player("next");
        snapshot.generation = 2;
        smart.observe(&snapshot, start + Duration::from_secs(61));
        assert!(smart.recent.contains(&"skip".into()));
        smart.set_enabled(false, &[], None).unwrap();
        snapshot.position_ms = 40_000;
        smart.observe(&snapshot, start + Duration::from_secs(101));
        assert!(smart.last_played.is_empty());
        drop(smart);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn short_tracks_use_half_duration_and_record_only_once() {
        let (root, mut smart) = fixture();
        smart.set_enabled(true, &[], None).unwrap();
        let mut snapshot = player("short");
        snapshot.duration_ms = Some(10_000);
        let start = Instant::now();
        smart.observe(&snapshot, start);
        for second in 1..=4 {
            snapshot.position_ms = second * 1_000;
            smart.observe(&snapshot, start + Duration::from_secs(second));
        }
        assert!(smart.last_played.is_empty());
        snapshot.position_ms = 5_000;
        smart.observe(&snapshot, start + Duration::from_secs(5));
        assert!(smart.last_played.contains_key("short"));
        smart.last_played.insert("short".into(), 123);
        snapshot.position_ms = 6_000;
        smart.observe(&snapshot, start + Duration::from_secs(6));
        assert_eq!(smart.last_played["short"], 123);
        drop(smart);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_is_repeatable_and_queue_edges_remain_playable() {
        let (root, mut smart) = fixture();
        let items: Vec<_> = (0..10)
            .map(|i| QueueTrack {
                id: i.to_string(),
                media_mid: None,
                title: i.to_string(),
                artist: "Artist".into(),
                album: "".into(),
                duration_ms: 100_000,
                cover_cache_key: None,
            })
            .collect();
        assert_eq!(smart.index(&items, 0, 1, 1), None);
        smart.set_enabled(true, &[], None).unwrap();
        assert_eq!(smart.index(&[], 0, 1, 1), None);
        assert_eq!(smart.index(&items[..1], 0, 1, 1), Some(0));
        for generation in 0..100 {
            let first = smart.index(&items, 0, generation, 1);
            assert_ne!(first, Some(0));
            assert_eq!(first, smart.index(&items, 0, generation, 1));
        }
        let distinct: HashSet<_> = (0..100)
            .map(|generation| smart.index(&items, 0, generation, generation))
            .collect();
        assert!(distinct.len() > 5);
        drop(smart);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unwritable_target_does_not_enable_or_create_a_fallback_database() {
        let (root, mut smart) = fixture();
        smart.path = root.clone(); // Opening a directory as SQLite must fail.
        assert!(smart.set_enabled(true, &[], None).is_err());
        assert!(!smart.status().enabled);
        drop(smart);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn background_sampling_is_opt_in_throttled_and_stops_after_qualification() {
        let (root, mut smart) = fixture();
        let mut snapshot = player("short");
        snapshot.duration_ms = Some(2_000);
        let now = Instant::now();
        assert!(!smart.needs_position_sample(&snapshot, now));
        smart.set_enabled(true, &[], None).unwrap();
        assert!(smart.needs_position_sample(&snapshot, now));
        smart.observe(&snapshot, now);
        assert!(!smart.needs_position_sample(&snapshot, now + Duration::from_millis(250)));
        assert!(smart.needs_position_sample(&snapshot, now + Duration::from_secs(1)));
        snapshot.position_ms = 1_000;
        smart.observe(&snapshot, now + Duration::from_secs(1));
        assert!(!smart.needs_position_sample(&snapshot, now + Duration::from_secs(2)));
        snapshot.generation += 1;
        assert!(smart.needs_position_sample(&snapshot, now + Duration::from_secs(2)));
        snapshot.state = PlayerState::Paused;
        assert!(!smart.needs_position_sample(&snapshot, now + Duration::from_secs(3)));
        drop(smart);
        std::fs::remove_dir_all(root).unwrap();
    }
}
