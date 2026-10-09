//! Monthly archives reference real hourly aggregates; enqueueing never writes them.
use crate::persistence::{PersistenceError, PersistenceService};
use crate::queue::QueueTrack;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde_json::{json, Value};

fn unavailable(_: rusqlite::Error) -> PersistenceError {
    PersistenceError::Unavailable
}

pub(crate) fn migrate(tx: &Transaction<'_>) -> Result<(), PersistenceError> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS memory_tapes (month TEXT PRIMARY KEY, generated_ms INTEGER NOT NULL) STRICT;").map_err(unavailable)?;
    tx.execute("INSERT OR IGNORE INTO memory_tapes SELECT DISTINCT substr(day,1,7),?1 FROM listening_hourly", [crate::personal::now_ms() as i64]).map_err(unavailable)?;
    Ok(())
}

pub(crate) fn register(
    tx: &Transaction<'_>,
    now: i64,
    elapsed: i64,
) -> Result<(), PersistenceError> {
    // Query at most two days. A flush crossing midnight can affect two months;
    // only register months with actual aggregates, including zero-ms qualifications.
    tx.execute("INSERT OR IGNORE INTO memory_tapes SELECT DISTINCT substr(day,1,7),?1 FROM listening_hourly WHERE day BETWEEN date((?1-?2)/1000,'unixepoch','localtime') AND date(?1/1000,'unixepoch','localtime')",params![now,elapsed]).map_err(unavailable)?;
    Ok(())
}

pub(crate) fn valid_month(month: &str) -> bool {
    let b = month.as_bytes();
    b.len() == 7
        && b[4] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || c.is_ascii_digit())
        && &month[..4] >= "1970"
        && &month[5..] >= "01"
        && &month[5..] <= "12"
}

fn bounds(month: &str) -> Result<(String, String), PersistenceError> {
    if !valid_month(month) {
        return Err(PersistenceError::InvalidData);
    }
    Ok((format!("{month}-01"), format!("{month}-31")))
}

fn summary(conn: &Connection, month: &str, now: u64) -> Result<Value, PersistenceError> {
    let (start, end) = bounds(month)?;
    let generated: i64 = conn
        .query_row(
            "SELECT generated_ms FROM memory_tapes WHERE month=?1",
            [month],
            |r| r.get(0),
        )
        .optional()
        .map_err(unavailable)?
        .ok_or(PersistenceError::InvalidData)?;
    let (today,cutoff,complete_from):(String,i64,String)=conn.query_row("SELECT strftime('%Y-%m',?1/1000,'unixepoch','localtime'), min(?1,CAST(strftime('%s',date(?2,'+1 month'),'utc') AS INTEGER)*1000-1),date(upgraded_ms/1000,'unixepoch','localtime','+1 day') FROM listening_analytics_metadata WHERE singleton_id=1",params![now as i64,start],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(unavailable)?;
    if month > today.as_str() {
        return Err(PersistenceError::InvalidData);
    }
    let (ms,plays,count,first,last):(i64,i64,i64,Option<String>,Option<String>)=conn.query_row("SELECT coalesce(sum(listened_ms),0),coalesce(sum(qualified_plays),0),count(DISTINCT track_id),min(day),max(day) FROM listening_hourly WHERE day BETWEEN ?1 AND ?2",params![start,end],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(unavailable)?;
    let top_song:Option<String>=conn.query_row("SELECT t.title FROM listening_hourly h JOIN listening_totals t ON t.track_id=h.track_id WHERE h.day BETWEEN ?1 AND ?2 GROUP BY h.track_id ORDER BY sum(h.qualified_plays) DESC,sum(h.listened_ms) DESC,h.track_id LIMIT 1",params![start,end],|r|r.get(0)).optional().map_err(unavailable)?;
    let top_artist:Option<String>=conn.query_row("SELECT t.artist FROM listening_hourly h JOIN listening_totals t ON t.track_id=h.track_id WHERE h.day BETWEEN ?1 AND ?2 GROUP BY t.artist ORDER BY sum(h.qualified_plays) DESC,sum(h.listened_ms) DESC,t.artist LIMIT 1",params![start,end],|r|r.get(0)).optional().map_err(unavailable)?;
    let status = if month == today {
        "recording"
    } else if start >= complete_from {
        "complete"
    } else {
        "partial"
    };
    Ok(
        json!({"month":month,"generatedMs":generated,"cutoffMs":cutoff,"totalMs":ms,"qualifiedPlays":plays,"trackCount":count,
        "topSong":top_song,"topArtist":top_artist,"dataStartDate":first,"dataEndDate":last,"status":status}),
    )
}

impl PersistenceService {
    fn tape_reader(&self) -> Result<Connection, PersistenceError> {
        let path = self
            .connection()?
            .path()
            .ok_or(PersistenceError::Unavailable)?
            .to_owned();
        let reader = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(unavailable)?;
        reader
            .busy_timeout(std::time::Duration::from_secs(2))
            .map_err(unavailable)?;
        Ok(reader)
    }

    pub(crate) fn memory_tapes(
        &self,
        before: Option<&str>,
        now: u64,
    ) -> Result<Value, PersistenceError> {
        if before.is_some_and(|m| !valid_month(m)) {
            return Err(PersistenceError::InvalidData);
        }
        let mut reader = self.tape_reader()?;
        let tx = reader.transaction().map_err(unavailable)?;
        let mut stmt=tx.prepare("SELECT month FROM memory_tapes WHERE (?1 IS NULL OR month<?1) AND month<=strftime('%Y-%m',?2/1000,'unixepoch','localtime') ORDER BY month DESC LIMIT 13").map_err(unavailable)?;
        let months = stmt
            .query_map(params![before, now as i64], |r| r.get::<_, String>(0))
            .map_err(unavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(unavailable)?;
        let items = months
            .iter()
            .take(12)
            .map(|month| summary(&tx, month, now))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({"items":items,"hasMore":months.len()>12}))
    }

    pub(crate) fn memory_tape(
        &self,
        month: &str,
        offset: u32,
        now: u64,
    ) -> Result<Value, PersistenceError> {
        let (start, end) = bounds(month)?;
        if offset > 1_000_000 || offset % 50 != 0 {
            return Err(PersistenceError::InvalidData);
        }
        let mut reader = self.tape_reader()?;
        let tx = reader.transaction().map_err(unavailable)?;
        let tape = summary(&tx, month, now)?;
        let mut stmt=tx.prepare("SELECT h.track_id,t.title,t.artist,sum(h.listened_ms),sum(h.qualified_plays) FROM listening_hourly h JOIN listening_totals t ON t.track_id=h.track_id WHERE h.day BETWEEN ?1 AND ?2 GROUP BY h.track_id ORDER BY sum(h.qualified_plays) DESC,sum(h.listened_ms) DESC,h.track_id LIMIT 51 OFFSET ?3").map_err(unavailable)?;
        let mut songs=stmt.query_map(params![start,end,offset],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"artist":r.get::<_,String>(2)?,"listenedMs":r.get::<_,i64>(3)?,"qualifiedPlays":r.get::<_,i64>(4)?}))).map_err(unavailable)?.collect::<Result<Vec<_>,_>>().map_err(unavailable)?;
        let more = songs.len() > 50;
        songs.truncate(50);
        Ok(json!({"tape":tape,"songs":songs,"offset":offset,"hasMore":more}))
    }

    pub(crate) fn memory_tape_tracks(
        &self,
        month: &str,
        ids: &[String],
    ) -> Result<Vec<QueueTrack>, PersistenceError> {
        let (start, end) = bounds(month)?;
        if ids.is_empty()
            || ids.len() > 50
            || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
        {
            return Err(PersistenceError::InvalidData);
        }
        let mut reader = self.tape_reader()?;
        let tx = reader.transaction().map_err(unavailable)?;
        let mut stmt=tx.prepare("SELECT t.track_id,t.title,t.artist FROM listening_totals t WHERE t.track_id=?1 AND EXISTS(SELECT 1 FROM listening_hourly h WHERE h.track_id=t.track_id AND h.day BETWEEN ?2 AND ?3)").map_err(unavailable)?;
        ids.iter()
            .map(|id| {
                stmt.query_row(params![id, start, end], |r| {
                    Ok(QueueTrack {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        artist: r.get(2)?,
                        album: String::new(),
                        duration_ms: 0,
                        media_mid: None,
                        cover_cache_key: None,
                    })
                })
                .optional()
                .map_err(unavailable)?
                .ok_or(PersistenceError::InvalidData)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (std::path::PathBuf, PersistenceService) {
        let root = std::env::temp_dir().join(format!("memory-tapes-{}", uuid::Uuid::new_v4()));
        let db = PersistenceService::open(&root.join("state.sqlite3")).unwrap();
        (root, db)
    }
    fn time(db: &PersistenceService, s: &str) -> u64 {
        db.connection()
            .unwrap()
            .query_row(
                "SELECT CAST(strftime('%s',?1,'utc') AS INTEGER)*1000",
                [s],
                |r| r.get::<_, i64>(0),
            )
            .unwrap() as u64
    }
    #[test]
    fn stable_months_boundary_coverage_and_read_side_effects() {
        let (root, db) = fixture();
        let now = time(&db, "2026-10-09 12:00:00");
        let upgraded = time(&db, "2026-08-15 12:00:00");
        db.connection()
            .unwrap()
            .execute(
                "UPDATE listening_analytics_metadata SET upgraded_ms=?1",
                [upgraded as i64],
            )
            .unwrap();
        db.record_listening(
            "a",
            "Song A",
            "Artist A",
            10000,
            true,
            time(&db, "2026-09-01 00:00:05"),
        )
        .unwrap();
        db.record_listening(
            "a",
            "Song A",
            "Artist A",
            20000,
            true,
            time(&db, "2026-10-09 12:00:00"),
        )
        .unwrap();
        let list = db.memory_tapes(None, now).unwrap();
        let items = list["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["status"], "recording");
        assert_eq!(items[1]["status"], "complete");
        assert_eq!(items[2]["status"], "partial");
        assert_eq!(items[1]["totalMs"], 5000);
        assert_eq!(items[2]["totalMs"], 5000);
        let generated = items[0]["generatedMs"].clone();
        let before = db.listening_report().unwrap();
        let details = db.memory_tape("2026-09", 0, now).unwrap();
        assert_eq!(details["songs"][0]["qualifiedPlays"], 1);
        assert_eq!(
            db.memory_tape_tracks("2026-09", &["a".into()]).unwrap()[0].id,
            "a"
        );
        assert!(db
            .memory_tape_tracks("2026-09", &["not-in-tape".into()])
            .is_err());
        assert!(db
            .memory_tape_tracks("2026-09", &["a".into(), "a".into()])
            .is_err());
        assert_eq!(db.listening_report().unwrap(), before);
        drop(db);
        let db = PersistenceService::open(&root.join("state.sqlite3")).unwrap();
        assert_eq!(
            db.memory_tapes(None, now).unwrap()["items"][0]["generatedMs"],
            generated
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn migration_no_empty_fabrication_pagination_and_validation() {
        let (root, db) = fixture();
        let now = time(&db, "2026-10-09 12:00:00");
        assert!(db.memory_tapes(None, now).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        db.connection().unwrap().execute_batch("INSERT INTO listening_totals VALUES('a','Song','Artist',1000,1,1); WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<14) INSERT INTO listening_hourly SELECT 'a',date('2025-01-01','+'||x||' months'),12,1000,1 FROM n; DROP TABLE memory_tapes; PRAGMA user_version=10;").unwrap();
        drop(db);
        let db = PersistenceService::open(&root.join("state.sqlite3")).unwrap();
        let first = db.memory_tapes(None, now).unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 12);
        assert_eq!(first["hasMore"], true);
        let last = first["items"][11]["month"].as_str().unwrap();
        assert_eq!(
            db.memory_tapes(Some(last), now).unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        for month in ["2026-13", "2026-00", "../data", "2026-1", "2026-01x"] {
            assert!(db.memory_tape(month, 0, now).is_err());
        }
        assert!(db.memory_tape("2025-01", 1, now).is_err());
        assert!(db.memory_tape_tracks("2025-01", &[]).is_err());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
