//! Local collections contain only display metadata and stable IDs.
use crate::{
    persistence::{PersistenceError, PersistenceService},
    queue::QueueTrack,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

pub(crate) const MIGRATION: &str = "
CREATE TABLE IF NOT EXISTS personal_items (
    kind TEXT NOT NULL CHECK(kind IN ('queue','previous','album','artist')),
    id TEXT NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(kind,id)
) STRICT;
CREATE TABLE IF NOT EXISTS listening_totals (
    track_id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL,
    listened_ms INTEGER NOT NULL CHECK(listened_ms >= 0),
    qualified_plays INTEGER NOT NULL CHECK(qualified_plays >= 0),
    last_played_ms INTEGER NOT NULL CHECK(last_played_ms >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS listening_metadata (singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), started_ms INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS listening_daily (track_id TEXT NOT NULL, day INTEGER NOT NULL, listened_ms INTEGER NOT NULL, qualified_plays INTEGER NOT NULL, PRIMARY KEY(track_id,day)) STRICT;
CREATE TABLE IF NOT EXISTS listening_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL, played_at_ms INTEGER NOT NULL) STRICT;
";

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum PersonalRequest {
    Collections,
    SaveQueue {
        name: String,
    },
    DeleteQueue {
        name: String,
    },
    LoadQueue {
        name: String,
    },
    RestoreQueue,
    #[serde(rename_all = "camelCase")]
    Bookmark {
        kind: String,
        id: String,
        title: String,
        saved: bool,
        #[serde(default)]
        cover_cache_key: Option<String>,
    },
    PreviewQueue {
        name: Option<String>,
    },
    RenameQueue {
        name: String,
        target: String,
    },
    UndoDeleteQueue,
    PinBookmark {
        kind: String,
        id: String,
        pinned: bool,
    },
    #[serde(rename_all = "camelCase")]
    Statistics {
        #[serde(default)]
        since_ms: Option<u64>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredQueue {
    pub items: Vec<QueueTrack>,
    pub selected_index: Option<usize>,
    #[serde(default)]
    pub saved_at_ms: u64,
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) const MIGRATION_V8: &str = "
CREATE TABLE IF NOT EXISTS personal_deleted_queue (singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), name TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS listening_intervals (track_id TEXT NOT NULL, ended_ms INTEGER NOT NULL, listened_ms INTEGER NOT NULL, qualified_plays INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS listening_intervals_time ON listening_intervals(ended_ms);
";
#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct BookmarkMetadata {
    added_ms: u64,
    pinned: bool,
    cover_cache_key: Option<String>,
}
fn bookmark_metadata(payload: &str) -> Result<BookmarkMetadata, PersistenceError> {
    if payload.is_empty() {
        Ok(BookmarkMetadata::default())
    } else {
        serde_json::from_str(payload).map_err(unavailable)
    }
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn unavailable(_: impl std::fmt::Debug) -> PersistenceError {
    PersistenceError::Unavailable
}

impl PersistenceService {
    pub(crate) fn personal_collections(&self) -> Result<serde_json::Value, PersistenceError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT kind,id,title,payload FROM personal_items ORDER BY title,id")
            .map_err(unavailable)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(unavailable)?;
        let mut queues = Vec::new();
        let mut bookmarks = Vec::new();
        let mut previous = None;
        for row in rows {
            let (kind, id, title, payload) = row.map_err(unavailable)?;
            match kind.as_str() {
                "previous" => {
                    let queue: StoredQueue = serde_json::from_str(&payload).map_err(unavailable)?;
                    previous = Some(
                        serde_json::json!({"count":queue.items.len(),"savedAtMs":queue.saved_at_ms}),
                    );
                }
                "queue" => {
                    let queue: StoredQueue = serde_json::from_str(&payload).map_err(unavailable)?;
                    queues.push(serde_json::json!({"name":id,"count":queue.items.len(),"savedAtMs":queue.saved_at_ms}));
                }
                "album" | "artist" => {
                    let metadata = bookmark_metadata(&payload)?;
                    bookmarks.push(serde_json::json!({"kind":kind,"id":id,"title":title,"addedMs":metadata.added_ms,"pinned":metadata.pinned,"coverCacheKey":metadata.cover_cache_key}))
                }
                _ => return Err(PersistenceError::InvalidData),
            }
        }
        let deleted: Option<String> = connection
            .query_row(
                "SELECT name FROM personal_deleted_queue WHERE singleton_id=1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(unavailable)?;
        Ok(
            serde_json::json!({"queues":queues,"bookmarks":bookmarks,"hasPrevious":previous.is_some(),"previous":previous,"deletedQueue":deleted}),
        )
    }

    pub(crate) fn save_named_queue(
        &self,
        name: &str,
        queue: &StoredQueue,
    ) -> Result<(), PersistenceError> {
        if !valid_text(name, 128) {
            return Err(PersistenceError::InvalidData);
        }
        crate::queue::validate_items(&queue.items).map_err(|_| PersistenceError::InvalidData)?;
        let payload = serde_json::to_string(queue).map_err(unavailable)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction().map_err(unavailable)?;
        tx.execute("INSERT INTO personal_items(kind,id,title,payload) SELECT 'queue',?1,?1,?2 WHERE (SELECT count(*) FROM personal_items WHERE kind='queue') < 100 OR EXISTS(SELECT 1 FROM personal_items WHERE kind='queue' AND id=?1) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload", params![name,payload]).map_err(unavailable).and_then(|n| if n == 0 {Err(PersistenceError::LimitExceeded)} else {Ok(())})?;
        tx.commit().map_err(unavailable)
    }

    pub(crate) fn load_named_queue(
        &self,
        name: Option<&str>,
    ) -> Result<StoredQueue, PersistenceError> {
        let (kind, id) = name.map_or(("previous", "previous"), |name| ("queue", name));
        if !valid_text(id, 128) {
            return Err(PersistenceError::InvalidData);
        }
        let payload: String = self
            .connection()?
            .query_row(
                "SELECT payload FROM personal_items WHERE kind=?1 AND id=?2",
                params![kind, id],
                |r| r.get(0),
            )
            .map_err(unavailable)?;
        let queue: StoredQueue = serde_json::from_str(&payload).map_err(unavailable)?;
        crate::queue::validate_items(&queue.items).map_err(|_| PersistenceError::InvalidData)?;
        if queue
            .selected_index
            .is_some_and(|index| index >= queue.items.len())
        {
            return Err(PersistenceError::InvalidData);
        }
        Ok(queue)
    }

    pub(crate) fn delete_named_queue(&self, name: &str) -> Result<(), PersistenceError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction().map_err(unavailable)?;
        let payload: String = tx
            .query_row(
                "SELECT payload FROM personal_items WHERE kind='queue' AND id=?1",
                [name],
                |r| r.get(0),
            )
            .map_err(unavailable)?;
        tx.execute("INSERT INTO personal_deleted_queue VALUES(1,?1,?2) ON CONFLICT(singleton_id) DO UPDATE SET name=excluded.name,payload=excluded.payload",params![name,payload]).map_err(unavailable)?;
        tx.execute(
            "DELETE FROM personal_items WHERE kind='queue' AND id=?1",
            [name],
        )
        .map_err(unavailable)?;
        tx.commit().map_err(unavailable)
    }
    pub(crate) fn undo_delete_queue(&self) -> Result<(), PersistenceError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction().map_err(unavailable)?;
        let count: i64 = tx
            .query_row(
                "SELECT count(*) FROM personal_items WHERE kind='queue'",
                [],
                |r| r.get(0),
            )
            .map_err(unavailable)?;
        if count >= 100 {
            return Err(PersistenceError::LimitExceeded);
        }
        // A newly-created same-name queue is never overwritten by undo.
        let n=tx.execute("INSERT INTO personal_items(kind,id,title,payload) SELECT 'queue',name,name,payload FROM personal_deleted_queue",[]).map_err(unavailable)?;
        if n == 0 {
            return Err(PersistenceError::InvalidData);
        }
        tx.execute("DELETE FROM personal_deleted_queue", [])
            .map_err(unavailable)?;
        tx.commit().map_err(unavailable)
    }
    pub(crate) fn rename_named_queue(
        &self,
        name: &str,
        target: &str,
    ) -> Result<(), PersistenceError> {
        if !valid_text(target, 128) {
            return Err(PersistenceError::InvalidData);
        }
        let n = self
            .connection()?
            .execute(
                "UPDATE personal_items SET id=?2,title=?2 WHERE kind='queue' AND id=?1",
                params![name, target],
            )
            .map_err(unavailable)?;
        if n == 0 {
            Err(PersistenceError::InvalidData)
        } else {
            Ok(())
        }
    }
    pub(crate) fn pin_bookmark(
        &self,
        kind: &str,
        id: &str,
        pinned: bool,
    ) -> Result<(), PersistenceError> {
        if !matches!(kind, "album" | "artist") {
            return Err(PersistenceError::InvalidData);
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction().map_err(unavailable)?;
        let payload: String = tx
            .query_row(
                "SELECT payload FROM personal_items WHERE kind=?1 AND id=?2",
                params![kind, id],
                |r| r.get(0),
            )
            .map_err(unavailable)?;
        let mut metadata = bookmark_metadata(&payload)?;
        metadata.pinned = pinned;
        tx.execute(
            "UPDATE personal_items SET payload=?3 WHERE kind=?1 AND id=?2",
            params![
                kind,
                id,
                serde_json::to_string(&metadata).map_err(unavailable)?
            ],
        )
        .map_err(unavailable)?;
        tx.commit().map_err(unavailable)
    }

    #[cfg(test)]
    pub(crate) fn bookmark(
        &self,
        kind: &str,
        id: &str,
        title: &str,
        saved: bool,
    ) -> Result<(), PersistenceError> {
        self.bookmark_with_cover(kind, id, title, saved, None)
    }
    pub(crate) fn bookmark_with_cover(
        &self,
        kind: &str,
        id: &str,
        title: &str,
        saved: bool,
        cover: Option<&str>,
    ) -> Result<(), PersistenceError> {
        if cover.is_some_and(|key| {
            !valid_text(key, 128)
                || !key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }) {
            return Err(PersistenceError::InvalidData);
        }
        if !matches!(kind, "album" | "artist")
            || !valid_text(id, 128)
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !valid_text(title, 512)
        {
            return Err(PersistenceError::InvalidData);
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction().map_err(unavailable)?;
        if saved {
            let old: Option<String> = tx
                .query_row(
                    "SELECT payload FROM personal_items WHERE kind=?1 AND id=?2",
                    params![kind, id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(unavailable)?;
            let mut metadata = bookmark_metadata(old.as_deref().unwrap_or(""))?;
            if metadata.added_ms == 0 {
                metadata.added_ms = now_ms();
            }
            if let Some(key) = cover {
                metadata.cover_cache_key = Some(key.to_owned());
            }
            let payload = serde_json::to_string(&metadata).map_err(unavailable)?;
            let count = tx.execute("INSERT INTO personal_items(kind,id,title,payload) SELECT ?1,?2,?3,?4 WHERE (SELECT count(*) FROM personal_items WHERE kind IN ('album','artist')) < 500 OR EXISTS(SELECT 1 FROM personal_items WHERE kind=?1 AND id=?2) ON CONFLICT(kind,id) DO UPDATE SET title=excluded.title,payload=excluded.payload", params![kind,id,title,payload]).map_err(unavailable)?;
            if count == 0 {
                return Err(PersistenceError::LimitExceeded);
            }
        } else {
            tx.execute(
                "DELETE FROM personal_items WHERE kind=?1 AND id=?2",
                params![kind, id],
            )
            .map_err(unavailable)?;
        }
        tx.commit().map_err(unavailable)
    }

    pub(crate) fn record_listening(
        &self,
        id: &str,
        title: &str,
        artist: &str,
        elapsed: u64,
        qualified: bool,
        now: u64,
    ) -> Result<(), PersistenceError> {
        if !valid_text(id, 128)
            || !valid_text(title, 512)
            || !valid_text(artist, 512)
            || elapsed > 60_000
        {
            return Err(PersistenceError::InvalidData);
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction().map_err(unavailable)?;
        let now = i64::try_from(now).map_err(|_| PersistenceError::InvalidData)?;
        let elapsed = i64::try_from(elapsed).map_err(|_| PersistenceError::InvalidData)?;
        tx.execute(
            "INSERT OR IGNORE INTO listening_metadata VALUES(1,?1)",
            [now],
        )
        .map_err(unavailable)?;
        tx.execute("INSERT INTO listening_totals VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(track_id) DO UPDATE SET title=excluded.title,artist=excluded.artist,listened_ms=listened_ms+excluded.listened_ms,qualified_plays=qualified_plays+excluded.qualified_plays,last_played_ms=excluded.last_played_ms", params![id,title,artist,elapsed,i64::from(qualified),now]).map_err(unavailable)?;
        tx.execute("INSERT INTO listening_daily VALUES(?1,?2,?3,?4) ON CONFLICT(track_id,day) DO UPDATE SET listened_ms=listened_ms+excluded.listened_ms,qualified_plays=qualified_plays+excluded.qualified_plays",params![id,now/86_400_000,elapsed,i64::from(qualified)]).map_err(unavailable)?;
        tx.execute(
            "DELETE FROM listening_daily WHERE day < ?1",
            [now / 86_400_000 - 30],
        )
        .map_err(unavailable)?;
        tx.execute(
            "INSERT INTO listening_intervals VALUES(?1,?2,?3,?4)",
            params![id, now, elapsed, i64::from(qualified)],
        )
        .map_err(unavailable)?;
        tx.execute(
            "DELETE FROM listening_intervals WHERE ended_ms < ?1",
            [now - 31 * 86_400_000],
        )
        .map_err(unavailable)?;
        if qualified {
            tx.execute("INSERT INTO listening_events(track_id,title,artist,played_at_ms) VALUES(?1,?2,?3,?4)",params![id,title,artist,now]).map_err(unavailable)?;
            tx.execute("DELETE FROM listening_events WHERE event_id IN (SELECT event_id FROM listening_events ORDER BY event_id DESC LIMIT -1 OFFSET 5000)",[]).map_err(unavailable)?;
        }
        tx.commit().map_err(unavailable)
    }

    #[cfg(test)]
    pub(crate) fn listening_report(&self) -> Result<serde_json::Value, PersistenceError> {
        self.listening_report_since(None)
    }
    pub(crate) fn listening_report_since(
        &self,
        since: Option<u64>,
    ) -> Result<serde_json::Value, PersistenceError> {
        if since
            .is_some_and(|time| time > now_ms() || time < now_ms().saturating_sub(32 * 86_400_000))
        {
            return Err(PersistenceError::InvalidData);
        }
        let connection = self.connection()?;
        let started: Option<i64> = connection
            .query_row(
                "SELECT started_ms FROM listening_metadata WHERE singleton_id=1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(unavailable)?;
        let (total,plays): (i64,i64) = connection.query_row("SELECT coalesce(sum(listened_ms),0),coalesce(sum(qualified_plays),0) FROM listening_totals", [], |r| Ok((r.get(0)?,r.get(1)?))).map_err(unavailable)?;
        let day = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
            / 86_400_000;
        let mut statement = connection.prepare("SELECT t.track_id,t.title,t.artist,t.listened_ms,t.qualified_plays,t.last_played_ms,coalesce(d.listened_ms,0),coalesce(d.qualified_plays,0) FROM listening_totals t LEFT JOIN (SELECT track_id,sum(listened_ms) AS listened_ms,sum(qualified_plays) AS qualified_plays FROM listening_daily WHERE day >= ?1 GROUP BY track_id) d ON d.track_id=t.track_id ORDER BY t.last_played_ms DESC LIMIT 5000").map_err(unavailable)?;
        let rows = statement.query_map([day-29], |r| Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"artist":r.get::<_,String>(2)?,"listenedMs":r.get::<_,i64>(3)?,"qualifiedPlays":r.get::<_,i64>(4)?,"lastPlayedMs":r.get::<_,i64>(5)?,"recentMs":r.get::<_,i64>(6)?,"recentPlays":r.get::<_,i64>(7)?}))).map_err(unavailable)?;
        let mut items = rows.collect::<Result<Vec<_>, _>>().map_err(unavailable)?;
        if let Some(since) = since {
            let mut range=connection.prepare("SELECT track_id,sum(min(listened_ms,max(0,ended_ms-?1))),sum(qualified_plays) FROM listening_intervals WHERE ended_ms>=?1 GROUP BY track_id").map_err(unavailable)?;
            let rows = range
                .query_map([since as i64], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?),
                    ))
                })
                .map_err(unavailable)?
                .collect::<Result<std::collections::HashMap<_, _>, _>>()
                .map_err(unavailable)?;
            for item in &mut items {
                let (ms, plays) = rows
                    .get(item["id"].as_str().unwrap_or_default())
                    .copied()
                    .unwrap_or_default();
                item["recentMs"] = ms.into();
                item["recentPlays"] = plays.into();
            }
        }
        let mut events_statement=connection.prepare("SELECT track_id,title,artist,played_at_ms FROM listening_events WHERE played_at_ms>=?1 ORDER BY event_id DESC LIMIT 5000").map_err(unavailable)?;
        let events=events_statement.query_map([since.unwrap_or(0) as i64],|r| Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"artist":r.get::<_,String>(2)?,"playedAtMs":r.get::<_,i64>(3)?}))).map_err(unavailable)?.collect::<Result<Vec<_>,_>>().map_err(unavailable)?;
        Ok(
            serde_json::json!({"startedMs":started,"totalMs":total,"qualifiedPlays":plays,"items":items,"events":events}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::QueueService;
    fn track(id: &str) -> QueueTrack {
        QueueTrack {
            id: id.into(),
            title: id.into(),
            artist: "Artist".into(),
            album: "".into(),
            duration_ms: 10_000,
            media_mid: None,
            cover_cache_key: None,
        }
    }
    #[test]
    fn batch_append_is_atomic_preserves_selection_and_rolls_back_on_write_failure() {
        let root = std::env::temp_dir().join(format!("batch-{}", uuid::Uuid::new_v4()));
        let queue = QueueService::open(&root.join("state.sqlite3")).unwrap();
        queue.replace(vec![track("a"), track("b")]).unwrap();
        queue.select(1).unwrap();
        let before = queue.snapshot();
        let after = queue
            .enqueue_many(vec![track("a"), track("c"), track("d")])
            .unwrap();
        assert_eq!(
            after
                .items
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "c", "d"]
        );
        assert_eq!(after.selected_index, Some(1));
        assert_eq!(after.generation, before.generation + 1);
        assert!(queue
            .enqueue_many((0..1000).map(|i| track(&format!("x{i}"))).collect())
            .is_err());
        assert_eq!(queue.snapshot(), after);
        queue.persistence.connection().unwrap().execute_batch("CREATE TRIGGER reject_batch BEFORE INSERT ON queue_items BEGIN SELECT RAISE(ABORT, 'test'); END;").unwrap();
        assert!(queue.enqueue_many(vec![track("e")]).is_err());
        assert_eq!(queue.snapshot(), after);
        drop(queue);
        let reopened = QueueService::open(&root.join("state.sqlite3")).unwrap();
        assert_eq!(reopened.snapshot().items, after.items);
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rename_delete_undo_and_bookmark_metadata_survive_restart_without_overwriting() {
        let root = std::env::temp_dir().join(format!("personal-edit-{}", uuid::Uuid::new_v4()));
        let path = root.join("state.sqlite3");
        let queue = QueueService::open(&path).unwrap();
        let db = &queue.persistence;
        let saved = StoredQueue {
            items: vec![track("a")],
            selected_index: Some(0),
            saved_at_ms: 100,
        };
        db.save_named_queue("work", &saved).unwrap();
        db.save_named_queue("other", &saved).unwrap();
        assert!(db.rename_named_queue("work", "other").is_err());
        db.rename_named_queue("work", "commute").unwrap();
        db.delete_named_queue("commute").unwrap();
        db.bookmark_with_cover("album", "a", "Album", true, Some("cover_a"))
            .unwrap();
        db.pin_bookmark("album", "a", true).unwrap();
        db.bookmark_with_cover("album", "a", "Album new", true, None)
            .unwrap();
        drop(queue);
        let queue = QueueService::open(&path).unwrap();
        let db = &queue.persistence;
        let rows = db.personal_collections().unwrap();
        assert_eq!(rows["deletedQueue"], "commute");
        assert_eq!(rows["bookmarks"][0]["coverCacheKey"], "cover_a");
        assert_eq!(rows["bookmarks"][0]["pinned"], true);
        db.save_named_queue("commute", &saved).unwrap();
        assert!(db.undo_delete_queue().is_err());
        db.rename_named_queue("commute", "new").unwrap();
        db.undo_delete_queue().unwrap();
        assert_eq!(
            db.load_named_queue(Some("commute")).unwrap().saved_at_ms,
            100
        );
        assert!(db.personal_collections().unwrap()["deletedQueue"].is_null());
        drop(queue);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn version_seven_migration_preserves_old_payloads_and_range_statistics() {
        let root = std::env::temp_dir().join(format!("personal-v8-{}", uuid::Uuid::new_v4()));
        let path = root.join("state.sqlite3");
        let queue = QueueService::open(&path).unwrap();
        queue
            .persistence
            .connection()
            .unwrap()
            .execute_batch(crate::persistence::REMOVE_HISTORY_V9_COLUMNS)
            .unwrap();
        queue.persistence.connection().unwrap().execute_batch("INSERT INTO personal_items VALUES('queue','old','old','{\"items\":[],\"selectedIndex\":null}');INSERT INTO personal_items VALUES('album','a','A','');DROP TABLE personal_deleted_queue;DROP TABLE listening_intervals;PRAGMA user_version=7;").unwrap();
        drop(queue);
        let queue = QueueService::open(&path).unwrap();
        let db = &queue.persistence;
        assert_eq!(db.load_named_queue(Some("old")).unwrap().saved_at_ms, 0);
        assert_eq!(
            db.personal_collections().unwrap()["bookmarks"][0]["pinned"],
            false
        );
        let now = now_ms();
        db.record_listening("a", "A", "Artist", 1000, true, now - 2 * 86_400_000)
            .unwrap();
        db.record_listening("a", "A", "Artist", 2000, true, now - 1000)
            .unwrap();
        let report = db.listening_report_since(Some(now - 86_400_000)).unwrap();
        assert_eq!(report["totalMs"], 3000);
        assert_eq!(report["items"][0]["recentMs"], 2000);
        assert_eq!(report["items"][0]["recentPlays"], 1);
        assert_eq!(report["events"].as_array().unwrap().len(), 1);
        let clipped = db.listening_report_since(Some(now - 2000)).unwrap();
        assert_eq!(clipped["items"][0]["recentMs"], 1000);
        drop(queue);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn named_queues_bookmarks_checkpoint_and_selection_survive_restart() {
        let root = std::env::temp_dir().join(format!("personal-{}", uuid::Uuid::new_v4()));
        let path = root.join("state.sqlite3");
        let queue = QueueService::open(&path).unwrap();
        queue.replace(vec![track("a"), track("b")]).unwrap();
        queue.select(1).unwrap();
        queue
            .persistence
            .save_named_queue(
                "工作",
                &StoredQueue {
                    saved_at_ms: crate::personal::now_ms(),
                    items: queue.snapshot().items,
                    selected_index: Some(1),
                },
            )
            .unwrap();
        queue
            .persistence
            .bookmark("artist", "artist1", "Artist", true)
            .unwrap();
        queue
            .persistence
            .bookmark("album", "album1", "Album", true)
            .unwrap();
        queue.replace(vec![]).unwrap();
        drop(queue);
        let queue = QueueService::open(&path).unwrap();
        let previous = queue.persistence.load_named_queue(None).unwrap();
        assert_eq!(previous.items.len(), 2);
        assert_eq!(previous.selected_index, Some(1));
        let saved = queue.persistence.load_named_queue(Some("工作")).unwrap();
        queue
            .replace_selected(saved.items, saved.selected_index)
            .unwrap();
        assert_eq!(queue.snapshot().selected_index, Some(1));
        let collections = queue.persistence.personal_collections().unwrap();
        assert_eq!(collections["queues"][0]["count"], 2);
        assert_eq!(collections["bookmarks"].as_array().unwrap().len(), 2);
        queue.persistence.delete_named_queue("工作").unwrap();
        queue
            .persistence
            .bookmark("album", "album1", "Album", false)
            .unwrap();
        assert_eq!(queue.snapshot().items.len(), 2);
        assert!(queue
            .persistence
            .bookmark("artist", "https://bad", "Bad", true)
            .is_err());
        drop(queue);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_replacement_rolls_back_both_queue_and_checkpoint() {
        let root = std::env::temp_dir().join(format!("personal-{}", uuid::Uuid::new_v4()));
        let path = root.join("state.sqlite3");
        let queue = QueueService::open(&path).unwrap();
        queue.replace(vec![track("a")]).unwrap();
        queue.replace(vec![track("b")]).unwrap();
        queue.persistence.connection().unwrap().execute_batch("CREATE TRIGGER reject_queue BEFORE INSERT ON queue_items BEGIN SELECT RAISE(ABORT, 'test'); END;").unwrap();
        assert!(queue.replace(vec![track("c")]).is_err());
        assert_eq!(queue.snapshot().items[0].id, "b");
        assert_eq!(
            queue.persistence.load_named_queue(None).unwrap().items[0].id,
            "a"
        );
        drop(queue);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn version_six_migrates_without_changing_existing_queue() {
        let root = std::env::temp_dir().join(format!("personal-{}", uuid::Uuid::new_v4()));
        let path = root.join("state.sqlite3");
        let queue = QueueService::open(&path).unwrap();
        queue.replace(vec![track("old")]).unwrap();
        queue
            .persistence
            .connection()
            .unwrap()
            .execute_batch(crate::persistence::REMOVE_HISTORY_V9_COLUMNS)
            .unwrap();
        queue.persistence.connection().unwrap().execute_batch("DROP TABLE personal_items;DROP TABLE listening_totals;DROP TABLE listening_metadata;PRAGMA user_version=6;").unwrap();
        drop(queue);
        let queue = QueueService::open(&path).unwrap();
        assert_eq!(queue.snapshot().items[0].id, "old");
        assert_eq!(
            queue.persistence.schema_version().unwrap(),
            crate::persistence::LOCAL_SCHEMA_VERSION
        );
        assert_eq!(
            queue.persistence.personal_collections().unwrap()["queues"],
            serde_json::json!([])
        );
        drop(queue);
        std::fs::remove_dir_all(root).unwrap();
    }
}
