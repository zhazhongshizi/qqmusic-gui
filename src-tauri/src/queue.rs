use std::{path::Path, sync::RwLock};

use serde::{Deserialize, Serialize};

use crate::persistence::{PersistedTrack, PersistenceError, PersistenceService};

const MAX_QUEUE_ITEMS: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueError {
    InvalidItem,
    InvalidIndex,
    LimitExceeded,
    PersistenceUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueTrack {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_mid: Option<String>,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_cache_key: Option<String>,
}

impl QueueTrack {
    fn persisted(&self) -> PersistedTrack {
        PersistedTrack {
            track_id: self.id.clone(),
            media_mid: self.media_mid.clone(),
            title: self.title.clone(),
            artist: self.artist.clone(),
            album: self.album.clone(),
            duration_ms: self.duration_ms,
            cover_cache_key: self.cover_cache_key.clone(),
        }
    }
}

impl From<PersistedTrack> for QueueTrack {
    fn from(track: PersistedTrack) -> Self {
        Self {
            id: track.track_id,
            media_mid: track.media_mid,
            title: track.title,
            artist: track.artist,
            album: track.album,
            duration_ms: track.duration_ms,
            cover_cache_key: track.cover_cache_key,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub generation: u64,
    pub selected_index: Option<usize>,
    pub items: Vec<QueueTrack>,
}

struct QueueState {
    generation: u64,
    selected_index: Option<usize>,
    items: Vec<QueueTrack>,
}

pub struct QueueService {
    pub(crate) shuffle_path: std::path::PathBuf,
    pub(crate) persistence: PersistenceService,
    state: RwLock<QueueState>,
}

impl QueueService {
    pub fn open(path: &Path) -> Result<Self, QueueError> {
        let persistence = PersistenceService::open(path).map_err(map_persistence_error)?;
        let items = persistence
            .load_queue()
            .map_err(map_persistence_error)?
            .into_iter()
            .map(QueueTrack::from)
            .collect::<Vec<_>>();
        validate_items(&items)?;
        let saved = persistence
            .load_playback_resume()
            .map_err(map_persistence_error)?
            .0;
        let selected_index = items
            .iter()
            .position(|track| Some(&track.id) == saved.as_ref())
            .or_else(|| (!items.is_empty()).then_some(0));
        Ok(Self {
            shuffle_path: path.with_extension("shuffle.sqlite3"),
            persistence,
            state: RwLock::new(QueueState {
                generation: 0,
                selected_index,
                items,
            }),
        })
    }

    pub(crate) fn last_history_plays(&self) -> Result<Vec<(String, u64)>, QueueError> {
        self.persistence
            .last_history_plays()
            .map_err(map_persistence_error)
    }

    pub fn load_playback_preferences(&self) -> Result<(String, f32), QueueError> {
        self.persistence
            .load_playback_resume()
            .map(|(_, mode, volume)| (mode, volume))
            .map_err(map_persistence_error)
    }
    pub(crate) fn mv_fallback_enabled(&self) -> Result<bool, QueueError> {
        self.persistence
            .load_settings()
            .map(|settings| settings.mv_fallback_enabled)
            .map_err(map_persistence_error)
    }
    pub(crate) fn mv_lyric_offset(&self, id: &str) -> Result<i64, QueueError> {
        self.persistence
            .mv_lyric_offset(id)
            .map_err(map_persistence_error)
    }
    pub(crate) fn save_mv_lyric_offset(&self, id: &str, offset: i64) -> Result<(), QueueError> {
        self.persistence
            .save_mv_lyric_offset(id, offset)
            .map_err(map_persistence_error)
    }
    pub fn save_playback_mode(&self, mode: &str) -> Result<(), QueueError> {
        self.persistence
            .save_playback_mode(mode)
            .map_err(map_persistence_error)
    }
    pub fn save_playback_volume(&self, volume: f32) -> Result<(), QueueError> {
        self.persistence
            .save_playback_volume(volume)
            .map_err(map_persistence_error)
    }
    pub fn snapshot(&self) -> QueueSnapshot {
        let state = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        QueueSnapshot {
            generation: state.generation,
            selected_index: state.selected_index,
            items: state.items.clone(),
        }
    }

    /// Check and clone under the same lock so a matching generation costs no item copies.
    pub fn snapshot_if_changed(&self, known_generation: Option<u64>) -> Option<QueueSnapshot> {
        let state = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (known_generation != Some(state.generation)).then(|| snapshot_from(&state))
    }

    pub fn replace(&self, items: Vec<QueueTrack>) -> Result<QueueSnapshot, QueueError> {
        self.replace_selected(items, None)
    }

    pub(crate) fn replace_selected(
        &self,
        items: Vec<QueueTrack>,
        selected: Option<usize>,
    ) -> Result<QueueSnapshot, QueueError> {
        validate_items(&items)?;
        let selected = selected
            .filter(|index| *index < items.len())
            .or_else(|| (!items.is_empty()).then_some(0));
        let persisted = items.iter().map(QueueTrack::persisted).collect::<Vec<_>>();
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = serde_json::to_string(&crate::personal::StoredQueue {
            saved_at_ms: crate::personal::now_ms(),
            items: state.items.clone(),
            selected_index: state.selected_index,
        })
        .map_err(|_| QueueError::InvalidItem)?;
        self.persistence
            .replace_queue_checkpoint(
                &persisted,
                selected
                    .and_then(|index| items.get(index))
                    .map(|track| track.id.as_str()),
                (state.items != items || state.selected_index != selected)
                    .then_some(previous.as_str()),
            )
            .map_err(map_persistence_error)?;
        state.items = items;
        state.selected_index = selected;
        state.generation = state.generation.saturating_add(1);
        Ok(snapshot_from(&state))
    }

    pub fn enqueue_many(&self, items: Vec<QueueTrack>) -> Result<QueueSnapshot, QueueError> {
        validate_items(&items)?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut next = state.items.clone();
        for item in items {
            if !next.iter().any(|existing| existing.id == item.id) {
                next.push(item);
            }
        }
        validate_items(&next)?;
        if next.len() == state.items.len() {
            return Ok(snapshot_from(&state));
        }
        let selected = state
            .selected_index
            .or_else(|| (!next.is_empty()).then_some(0));
        persist_items(
            &self.persistence,
            &next,
            selected.map(|i| next[i].id.as_str()),
        )?;
        state.items = next;
        state.selected_index = selected;
        state.generation = state.generation.saturating_add(1);
        Ok(snapshot_from(&state))
    }

    pub fn enqueue(&self, item: QueueTrack) -> Result<QueueSnapshot, QueueError> {
        validate_items(std::slice::from_ref(&item))?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(index) = state.items.iter().position(|current| current.id == item.id) {
            self.persistence
                .save_queue_selection(&item.id)
                .map_err(map_persistence_error)?;
            if state.selected_index != Some(index) {
                state.selected_index = Some(index);
                state.generation = state.generation.saturating_add(1);
            }
            return Ok(snapshot_from(&state));
        }
        if state.items.len() >= MAX_QUEUE_ITEMS {
            return Err(QueueError::LimitExceeded);
        }
        let mut next = state.items.clone();
        next.push(item);
        persist_items(
            &self.persistence,
            &next,
            state
                .selected_index
                .and_then(|i| state.items.get(i))
                .or_else(|| next.first())
                .map(|t| t.id.as_str()),
        )?;
        state.items = next;
        state.selected_index.get_or_insert(0);
        state.generation = state.generation.saturating_add(1);
        Ok(snapshot_from(&state))
    }

    pub fn enqueue_next(
        &self,
        item: QueueTrack,
        current_id: Option<&str>,
    ) -> Result<QueueSnapshot, QueueError> {
        validate_items(std::slice::from_ref(&item))?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = current_id
            .or_else(|| {
                state
                    .selected_index
                    .and_then(|i| state.items.get(i))
                    .map(|t| t.id.as_str())
            })
            .map(str::to_owned);
        if current.as_deref() == Some(item.id.as_str()) {
            return Ok(snapshot_from(&state));
        }
        let mut next = state.items.clone();
        next.retain(|track| track.id != item.id);
        if next.len() >= MAX_QUEUE_ITEMS {
            return Err(QueueError::LimitExceeded);
        }
        let index = current
            .as_ref()
            .and_then(|id| next.iter().position(|t| &t.id == id))
            .map_or(0, |i| i + 1);
        next.insert(index, item);
        let selected = current
            .as_ref()
            .and_then(|id| next.iter().position(|t| &t.id == id))
            .unwrap_or(0);
        persist_items(&self.persistence, &next, Some(&next[selected].id))?;
        state.items = next;
        state.selected_index = Some(selected);
        state.generation = state.generation.saturating_add(1);
        Ok(snapshot_from(&state))
    }

    pub fn remove(&self, index: usize) -> Result<QueueSnapshot, QueueError> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if index >= state.items.len() {
            return Err(QueueError::InvalidIndex);
        }
        let mut next = state.items.clone();
        next.remove(index);
        persist_items(
            &self.persistence,
            &next,
            adjust_selection_after_remove(state.selected_index, index, next.len())
                .and_then(|i| next.get(i))
                .map(|t| t.id.as_str()),
        )?;
        state.items = next;
        state.selected_index =
            adjust_selection_after_remove(state.selected_index, index, state.items.len());
        state.generation = state.generation.saturating_add(1);
        Ok(snapshot_from(&state))
    }

    pub fn move_item(&self, from: usize, to: usize) -> Result<QueueSnapshot, QueueError> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if from >= state.items.len() || to >= state.items.len() {
            return Err(QueueError::InvalidIndex);
        }
        if from == to {
            return Ok(snapshot_from(&state));
        }
        let mut next = state.items.clone();
        let item = next.remove(from);
        next.insert(to, item);
        persist_items(
            &self.persistence,
            &next,
            state
                .selected_index
                .and_then(|i| state.items.get(i))
                .map(|t| t.id.as_str()),
        )?;
        state.items = next;
        state.selected_index = state.selected_index.map(|selected| {
            if selected == from {
                to
            } else if from < selected && selected <= to {
                selected - 1
            } else if to <= selected && selected < from {
                selected + 1
            } else {
                selected
            }
        });
        state.generation = state.generation.saturating_add(1);
        Ok(snapshot_from(&state))
    }

    pub fn select(&self, index: usize) -> Result<QueueTrack, QueueError> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let track = state
            .items
            .get(index)
            .cloned()
            .ok_or(QueueError::InvalidIndex)?;
        self.persistence
            .save_queue_selection(&track.id)
            .map_err(map_persistence_error)?;
        if state.selected_index != Some(index) {
            state.selected_index = Some(index);
            state.generation = state.generation.saturating_add(1);
        }
        Ok(track)
    }

    pub fn append_history(&self, track: &QueueTrack) -> Result<(), QueueError> {
        self.persistence
            .append_history(&track.persisted(), false)
            .map_err(map_persistence_error)
    }

    /// Resolve a remote selection under the same lock as queue edits.
    pub(crate) fn select_remote(
        &self,
        id: &str,
        generation: u64,
    ) -> Result<Option<QueueTrack>, QueueError> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.generation != generation {
            return Ok(None);
        }
        let Some(index) = state.items.iter().position(|track| track.id == id) else {
            return Ok(None);
        };
        let track = state.items[index].clone();
        self.persistence
            .save_queue_selection(&track.id)
            .map_err(map_persistence_error)?;
        if state.selected_index != Some(index) {
            state.selected_index = Some(index);
            state.generation = state.generation.saturating_add(1);
        }
        Ok(Some(track))
    }
}

pub(crate) fn validate_items(items: &[QueueTrack]) -> Result<(), QueueError> {
    if items.len() > MAX_QUEUE_ITEMS {
        return Err(QueueError::LimitExceeded);
    }
    let mut ids = std::collections::HashSet::with_capacity(items.len());
    for item in items {
        item.persisted().validate().map_err(map_persistence_error)?;
        if !ids.insert(&item.id) {
            return Err(QueueError::InvalidItem);
        }
    }
    Ok(())
}

fn persist_items(
    persistence: &PersistenceService,
    items: &[QueueTrack],
    selected: Option<&str>,
) -> Result<(), QueueError> {
    let persisted = items.iter().map(QueueTrack::persisted).collect::<Vec<_>>();
    persistence
        .replace_queue_selected(&persisted, selected)
        .map_err(map_persistence_error)
}

fn snapshot_from(state: &QueueState) -> QueueSnapshot {
    QueueSnapshot {
        generation: state.generation,
        selected_index: state.selected_index,
        items: state.items.clone(),
    }
}

fn adjust_selection_after_remove(
    selected: Option<usize>,
    removed: usize,
    new_length: usize,
) -> Option<usize> {
    if new_length == 0 {
        return None;
    }
    selected.map(|index| {
        if index > removed {
            index - 1
        } else if index == removed {
            index.min(new_length - 1)
        } else {
            index
        }
    })
}

fn map_persistence_error(error: PersistenceError) -> QueueError {
    match error {
        PersistenceError::InvalidData => QueueError::InvalidItem,
        PersistenceError::LimitExceeded => QueueError::LimitExceeded,
        PersistenceError::Unavailable | PersistenceError::IncompatibleSchema => {
            QueueError::PersistenceUnavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::*;

    struct TestQueue {
        root: std::path::PathBuf,
        service: QueueService,
    }

    impl TestQueue {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("qqmusic-queue-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).expect("create queue root");
            let service = QueueService::open(&root.join("state.sqlite3")).expect("open queue");
            Self { root, service }
        }
    }

    impl Drop for TestQueue {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn track(id: &str) -> QueueTrack {
        QueueTrack {
            id: id.to_owned(),
            media_mid: None,
            title: format!("Track {id}"),
            artist: "Artist".to_owned(),
            album: "Album".to_owned(),
            duration_ms: 123_000,
            cover_cache_key: None,
        }
    }

    #[test]
    fn selected_track_and_preferences_survive_restart_and_queue_edits() {
        let queue = TestQueue::new();
        let path = queue.root.join("state.sqlite3");
        queue
            .service
            .replace(vec![track("one"), track("two"), track("three")])
            .unwrap();
        queue.service.select(2).unwrap();
        queue.service.save_playback_mode("shuffle").unwrap();
        queue.service.save_playback_volume(0.37).unwrap();
        let reopened = QueueService::open(&path).unwrap();
        assert_eq!(reopened.snapshot().selected_index, Some(2));
        assert_eq!(
            reopened.load_playback_preferences().unwrap(),
            ("shuffle".to_owned(), 0.37)
        );
        drop(reopened);
        queue.service.move_item(2, 1).unwrap();
        assert_eq!(
            QueueService::open(&path).unwrap().snapshot().selected_index,
            Some(1)
        );
        queue.service.remove(1).unwrap();
        let restored = QueueService::open(&path).unwrap().snapshot();
        assert_eq!(restored.items[restored.selected_index.unwrap()].id, "two");
        queue.service.replace(vec![]).unwrap();
        assert_eq!(
            QueueService::open(&path).unwrap().snapshot().selected_index,
            None
        );
        queue.service.save_playback_mode("repeat-all").unwrap();
        queue.service.save_playback_volume(0.0).unwrap();
        assert_eq!(
            QueueService::open(&path)
                .unwrap()
                .load_playback_preferences()
                .unwrap(),
            ("repeat-all".to_owned(), 0.0)
        );
    }

    #[test]
    fn remote_selection_rejects_a_reordered_or_removed_queue() {
        let test = TestQueue::new();
        let before = test
            .service
            .replace(vec![track("one"), track("two")])
            .unwrap();
        test.service.move_item(0, 1).unwrap();
        assert_eq!(
            test.service
                .select_remote("two", before.generation)
                .unwrap(),
            None
        );
        let current = test.service.snapshot();
        assert_eq!(
            test.service
                .select_remote("two", current.generation)
                .unwrap()
                .unwrap()
                .id,
            "two"
        );
        let current = test.service.snapshot();
        assert_eq!(current.selected_index, Some(0));
        assert_eq!(
            test.service
                .select_remote("missing", current.generation)
                .unwrap(),
            None
        );
        assert_eq!(test.service.snapshot(), current);
    }

    #[test]
    fn mutations_are_transactional_and_survive_restart() {
        let queue = TestQueue::new();
        queue
            .service
            .replace(vec![track("one"), track("two"), track("three")])
            .expect("replace");
        queue.service.select(1).expect("select two");
        let moved = queue.service.move_item(1, 0).expect("move two");
        assert_eq!(moved.selected_index, Some(0));
        assert_eq!(moved.items[0].id, "two");
        assert_eq!(
            moved.items[moved.selected_index.expect("selected")].id,
            "two"
        );
        let removed = queue.service.remove(0).expect("remove selected");
        assert_eq!(removed.selected_index, Some(0));
        assert_eq!(removed.items[0].id, "one");

        let reopened = QueueService::open(&queue.root.join("state.sqlite3")).expect("reopen");
        assert_eq!(
            reopened
                .snapshot()
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "three"]
        );
    }

    #[test]
    fn moving_non_selected_items_across_selection_preserves_selected_track() {
        let queue = TestQueue::new();
        queue
            .service
            .replace(vec![
                track("one"),
                track("two"),
                track("three"),
                track("four"),
            ])
            .expect("replace");
        queue.service.select(1).expect("select two");

        let moved_up = queue.service.move_item(3, 0).expect("move four above two");
        assert_eq!(
            moved_up
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["four", "one", "two", "three"]
        );
        assert_eq!(moved_up.selected_index, Some(2));
        assert_eq!(moved_up.items[2].id, "two");

        let moved_down = queue.service.move_item(0, 3).expect("move four below two");
        assert_eq!(
            moved_down
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two", "three", "four"]
        );
        assert_eq!(moved_down.selected_index, Some(1));
        assert_eq!(moved_down.items[1].id, "two");
    }

    #[test]
    fn invalid_move_index_preserves_snapshot() {
        let queue = TestQueue::new();
        queue
            .service
            .replace(vec![track("one"), track("two"), track("three")])
            .expect("replace");
        queue.service.select(1).expect("select two");
        let before = queue.service.snapshot();

        for (from, to) in [(before.items.len(), 0), (0, before.items.len())] {
            assert_eq!(
                queue.service.move_item(from, to),
                Err(QueueError::InvalidIndex)
            );
            assert_eq!(queue.service.snapshot(), before);
        }
    }

    #[test]
    fn enqueue_next_moves_existing_item_without_changing_current_and_persists() {
        let queue = TestQueue::new();
        queue
            .service
            .replace(vec![track("three"), track("one"), track("two")])
            .unwrap();
        queue.service.select(1).unwrap();
        let result = queue
            .service
            .enqueue_next(track("three"), Some("one"))
            .unwrap();
        assert_eq!(
            result
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "three", "two"]
        );
        assert_eq!(result.selected_index, Some(0));
        let reopened = QueueService::open(&queue.root.join("state.sqlite3")).unwrap();
        assert_eq!(reopened.snapshot().items, result.items);
        assert_eq!(reopened.snapshot().selected_index, Some(0));
        assert_eq!(
            queue
                .service
                .enqueue_next(track("one"), Some("one"))
                .unwrap(),
            result
        );
    }

    #[test]
    fn enqueue_next_full_queue_allows_relocation_but_rejects_new_item() {
        let queue = TestQueue::new();
        queue
            .service
            .replace((0..1000).map(|i| track(&format!("song{i}"))).collect())
            .unwrap();
        let result = queue
            .service
            .enqueue_next(track("song999"), Some("song0"))
            .unwrap();
        assert_eq!(result.items[1].id, "song999");
        assert!(queue
            .service
            .enqueue_next(track("extra"), Some("song0"))
            .is_err());
        assert_eq!(queue.service.snapshot(), result);
    }

    #[test]
    fn enqueue_deduplicates_and_selects_existing_track() {
        let queue = TestQueue::new();
        queue.service.enqueue(track("one")).expect("one");
        queue.service.enqueue(track("two")).expect("two");
        let snapshot = queue.service.enqueue(track("two")).expect("deduplicate");
        assert_eq!(snapshot.items.len(), 2);
        assert_eq!(snapshot.selected_index, Some(1));
        assert_eq!(snapshot.generation, 3);
    }

    #[test]
    fn invalid_or_duplicate_replacement_preserves_existing_queue() {
        let queue = TestQueue::new();
        queue.service.enqueue(track("stable")).expect("stable");
        assert_eq!(
            queue.service.replace(vec![track("same"), track("same")]),
            Err(QueueError::InvalidItem)
        );
        assert_eq!(queue.service.snapshot().items[0].id, "stable");
        let reopened = QueueService::open(&queue.root.join("state.sqlite3")).expect("reopen");
        assert_eq!(reopened.snapshot().items[0].id, "stable");
    }

    #[test]
    fn selection_and_index_bounds_are_stable() {
        let queue = TestQueue::new();
        assert_eq!(queue.service.select(0), Err(QueueError::InvalidIndex));
        queue.service.enqueue(track("one")).expect("one");
        assert_eq!(queue.service.move_item(0, 1), Err(QueueError::InvalidIndex));
        assert_eq!(queue.service.remove(1), Err(QueueError::InvalidIndex));
    }
}
