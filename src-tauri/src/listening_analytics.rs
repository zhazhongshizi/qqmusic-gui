//! Long-lived aggregates; no player state or qualification policy lives here.
use crate::persistence::{PersistenceError, PersistenceService};
use rusqlite::{params, Connection, OpenFlags, Transaction};
use serde_json::{json, Value};
use std::collections::HashSet;

fn unavailable(_: rusqlite::Error) -> PersistenceError {
    PersistenceError::Unavailable
}

// A flush contains at most 60 seconds. Split its elapsed time at the local hour
// boundary; a qualification belongs to its actual timestamp, including midnight.
fn aggregate_sql(source: &str) -> String {
    format!(
        r#"
WITH input AS ({source}), boundaries AS (
 SELECT *, ended_ms - CAST(strftime('%M',ended_ms/1000,'unixepoch','localtime') AS INTEGER)*60000
 - CAST(strftime('%S',ended_ms/1000,'unixepoch','localtime') AS INTEGER)*1000 - ended_ms%1000 AS boundary FROM input
), parts AS (
 SELECT track_id,ended_ms AS stamp,min(listened_ms,ended_ms-boundary) AS ms,qualified_plays AS plays FROM boundaries
 UNION ALL
 SELECT track_id,boundary-1,max(0,listened_ms-(ended_ms-boundary)),0 FROM boundaries
)
INSERT INTO listening_hourly(track_id,day,hour,listened_ms,qualified_plays)
SELECT track_id,date(stamp/1000,'unixepoch','localtime'),CAST(strftime('%H',stamp/1000,'unixepoch','localtime') AS INTEGER),sum(ms),sum(plays)
FROM parts WHERE ms>0 OR plays>0 GROUP BY 1,2,3
ON CONFLICT(track_id,day,hour) DO UPDATE SET
 listened_ms=listened_ms+excluded.listened_ms,qualified_plays=qualified_plays+excluded.qualified_plays;
"#
    )
}

pub(crate) fn migrate(tx: &Transaction<'_>) -> Result<(), PersistenceError> {
    // IF NOT EXISTS also supports existing migration test fixtures that rewind
    // user_version; a populated aggregate must never be imported twice.
    tx.execute_batch(r#"
CREATE TABLE IF NOT EXISTS listening_hourly (
 track_id TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
 listened_ms INTEGER NOT NULL CHECK(listened_ms>=0), qualified_plays INTEGER NOT NULL CHECK(qualified_plays>=0),
 PRIMARY KEY(track_id,day,hour)
) STRICT;
CREATE INDEX IF NOT EXISTS listening_hourly_day ON listening_hourly(day,hour);
CREATE TABLE IF NOT EXISTS listening_analytics_metadata (
 singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), upgraded_ms INTEGER NOT NULL, retained_from_ms INTEGER NOT NULL
) STRICT;
"#).map_err(unavailable)?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM listening_analytics_metadata)",
            [],
            |r| r.get(0),
        )
        .map_err(unavailable)?;
    if !exists {
        tx.execute_batch(&aggregate_sql(
            "SELECT track_id,ended_ms,listened_ms,qualified_plays FROM listening_intervals",
        ))
        .map_err(unavailable)?;
        let now = crate::personal::now_ms() as i64;
        tx.execute("INSERT INTO listening_analytics_metadata SELECT 1,?1,coalesce(min(ended_ms-listened_ms),?1) FROM listening_intervals", [now]).map_err(unavailable)?;
    }
    Ok(())
}

pub(crate) fn record(
    tx: &Transaction<'_>,
    id: &str,
    now: i64,
    elapsed: i64,
    qualified: bool,
) -> Result<(), PersistenceError> {
    tx.execute(
        &aggregate_sql(
            "SELECT ?1 AS track_id,?2 AS ended_ms,?3 AS listened_ms,?4 AS qualified_plays",
        ),
        params![id, now, elapsed, i64::from(qualified)],
    )
    .map_err(unavailable)?;
    Ok(())
}

fn valid_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
        && date >= "1970-01-01"
        && date <= "9999-12-31"
}

impl PersistenceService {
    pub(crate) fn listening_analytics(
        &self,
        start: &str,
        end: &str,
        likes: Option<&HashSet<String>>,
        storage_available: bool,
    ) -> Result<Value, PersistenceError> {
        if !valid_date(start) || !valid_date(end) || start > end {
            return Err(PersistenceError::InvalidData);
        }
        // Release the writer mutex before doing any aggregation. A WAL read
        // transaction gives every chart the same snapshot without blocking writes.
        let path = self
            .connection()?
            .path()
            .ok_or(PersistenceError::Unavailable)?
            .to_owned();
        let mut reader = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(unavailable)?;
        reader
            .busy_timeout(std::time::Duration::from_secs(2))
            .map_err(unavailable)?;
        let valid: bool = reader.query_row("SELECT date(?1,'+0 days')=?1 AND date(?2,'+0 days')=?2 AND julianday(?2)-julianday(?1) BETWEEN 0 AND 365", params![start,end], |r| r.get::<_,Option<bool>>(0).map(|v| v.unwrap_or(false))).map_err(unavailable)?;
        if !valid {
            return Err(PersistenceError::InvalidData);
        }
        // TEMP tables are private to this read connection, never persisted.
        reader
            .execute_batch("CREATE TEMP TABLE analytics_likes(id TEXT PRIMARY KEY) WITHOUT ROWID;")
            .map_err(unavailable)?;
        let tx = reader.transaction().map_err(unavailable)?;
        if let Some(likes) = likes {
            let mut insert = tx
                .prepare("INSERT INTO analytics_likes VALUES(?1)")
                .map_err(unavailable)?;
            for id in likes {
                insert.execute([id]).map_err(unavailable)?;
            }
        }
        tx.execute("CREATE TEMP TABLE selected AS SELECT h.track_id,sum(h.listened_ms) AS ms,sum(h.qualified_plays) AS plays FROM listening_hourly h WHERE day BETWEEN ?1 AND ?2 GROUP BY track_id", params![start,end]).map_err(unavailable)?;
        let (total, plays, tracks): (i64, i64, i64) = tx
            .query_row(
                "SELECT coalesce(sum(ms),0),coalesce(sum(plays),0),count(*) FROM selected",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(unavailable)?;
        let (lifetime_ms,lifetime_plays): (i64,i64) = tx.query_row("SELECT coalesce(sum(listened_ms),0),coalesce(sum(qualified_plays),0) FROM listening_totals", [], |r| Ok((r.get(0)?,r.get(1)?))).map_err(unavailable)?;
        let (upgraded, retained): (i64,i64) = tx.query_row("SELECT upgraded_ms,retained_from_ms FROM listening_analytics_metadata WHERE singleton_id=1", [], |r| Ok((r.get(0)?,r.get(1)?))).map_err(unavailable)?;
        let mut stmt = tx.prepare("SELECT day,sum(listened_ms),sum(qualified_plays) FROM listening_hourly WHERE day BETWEEN ?1 AND ?2 GROUP BY day ORDER BY day").map_err(unavailable)?;
        let days = stmt.query_map(params![start,end], |r| Ok(json!({"date":r.get::<_,String>(0)?,"listenedMs":r.get::<_,i64>(1)?,"qualifiedPlays":r.get::<_,i64>(2)?}))).map_err(unavailable)?.collect::<Result<Vec<_>,_>>().map_err(unavailable)?;
        let mut stmt = tx.prepare("SELECT hour,sum(listened_ms),sum(qualified_plays) FROM listening_hourly WHERE day BETWEEN ?1 AND ?2 GROUP BY hour ORDER BY hour").map_err(unavailable)?;
        let hours = stmt.query_map(params![start,end], |r| Ok(json!({"hour":r.get::<_,i64>(0)?,"listenedMs":r.get::<_,i64>(1)?,"qualifiedPlays":r.get::<_,i64>(2)?}))).map_err(unavailable)?.collect::<Result<Vec<_>,_>>().map_err(unavailable)?;
        let mut stmt = tx.prepare("SELECT s.track_id,t.title,t.artist,s.ms,s.plays FROM selected s JOIN listening_totals t ON t.track_id=s.track_id ORDER BY s.plays DESC,s.ms DESC,s.track_id LIMIT 30").map_err(unavailable)?;
        let songs = stmt.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"artist":r.get::<_,String>(2)?,"listenedMs":r.get::<_,i64>(3)?,"qualifiedPlays":r.get::<_,i64>(4)?}))).map_err(unavailable)?.collect::<Result<Vec<_>,_>>().map_err(unavailable)?;
        let mut stmt = tx.prepare("SELECT t.artist,sum(s.ms),sum(s.plays),count(*) FROM selected s JOIN listening_totals t ON t.track_id=s.track_id GROUP BY t.artist ORDER BY sum(s.plays) DESC,sum(s.ms) DESC,t.artist LIMIT 30").map_err(unavailable)?;
        let artists = stmt.query_map([], |r| Ok(json!({"artist":r.get::<_,String>(0)?,"listenedMs":r.get::<_,i64>(1)?,"qualifiedPlays":r.get::<_,i64>(2)?,"tracks":r.get::<_,i64>(3)?}))).map_err(unavailable)?.collect::<Result<Vec<_>,_>>().map_err(unavailable)?;
        let (liked_ms,liked_plays,liked_tracks): (i64,i64,i64) = tx.query_row("SELECT coalesce(sum(s.ms),0),coalesce(sum(s.plays),0),count(*) FROM selected s JOIN analytics_likes l ON l.id=s.track_id", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(unavailable)?;
        Ok(
            json!({"startDate":start,"endDate":end,"totalMs":total,"qualifiedPlays":plays,"tracks":tracks,
            "lifetimeMs":lifetime_ms,"lifetimePlays":lifetime_plays,"upgradedMs":upgraded,"retainedFromMs":retained,
            "storageAvailable":storage_available,"days":days,"hours":hours,"songs":songs,"artists":artists,
            "likes":likes.map(|_| json!({"listenedMs":liked_ms,"qualifiedPlays":liked_plays,"tracks":liked_tracks}))}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (std::path::PathBuf, PersistenceService) {
        let root = std::env::temp_dir().join(format!("analytics-{}", uuid::Uuid::new_v4()));
        let db = PersistenceService::open(&root.join("state.sqlite3")).unwrap();
        (root, db)
    }
    fn timestamp(db: &PersistenceService, local: &str) -> u64 {
        db.connection()
            .unwrap()
            .query_row(
                "SELECT CAST(strftime('%s',?1,'utc') AS INTEGER)*1000",
                [local],
                |r| r.get::<_, i64>(0),
            )
            .unwrap() as u64
    }
    #[test]
    fn splits_midnight_and_keeps_qualification_at_boundary() {
        let (root, db) = fixture();
        let midnight = timestamp(&db, "2026-10-08 00:00:00");
        db.record_listening("a", "A", "Artist", 30_000, true, midnight)
            .unwrap();
        let yesterday = db
            .listening_analytics("2026-10-07", "2026-10-07", None, true)
            .unwrap();
        assert_eq!(yesterday["totalMs"], 30_000);
        assert_eq!(yesterday["qualifiedPlays"], 0);
        let today = db
            .listening_analytics(
                "2026-10-08",
                "2026-10-08",
                Some(&HashSet::from(["a".into()])),
                true,
            )
            .unwrap();
        assert_eq!(today["totalMs"], 0);
        assert_eq!(today["qualifiedPlays"], 1);
        assert_eq!(today["likes"]["qualifiedPlays"], 1);
        db.record_listening("b", "B", "Artist", 20_000, true, midnight + 10_000)
            .unwrap();
        let range = db
            .listening_analytics("2026-10-07", "2026-10-08", None, true)
            .unwrap();
        assert_eq!(range["totalMs"], 50_000);
        assert_eq!(range["artists"][0]["tracks"], 2);
        assert!(range["likes"].is_null());
        assert_eq!(
            range["days"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| d["listenedMs"].as_i64().unwrap())
                .sum::<i64>(),
            50_000
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn migration_is_repeatable_preserves_totals_and_retains_year_history() {
        let (root, db) = fixture();
        let time = timestamp(&db, "2025-02-02 12:00:00");
        db.record_listening("a", "A", "Artist", 5000, true, time)
            .unwrap();
        // Simulate an actual v9 database with intervals but no v10 tables.
        db.connection().unwrap().execute_batch("DROP TABLE listening_hourly; DROP TABLE listening_analytics_metadata; PRAGMA user_version=9;").unwrap();
        drop(db);
        let db = PersistenceService::open(&root.join("state.sqlite3")).unwrap();
        let report = db
            .listening_analytics("2025-01-01", "2025-12-31", None, true)
            .unwrap();
        assert_eq!(report["totalMs"], 5000);
        assert_eq!(report["lifetimeMs"], 5000);
        db.record_listening("a", "A", "Artist", 3000, false, time + 400 * 86_400_000)
            .unwrap();
        drop(db);
        let db = PersistenceService::open(&root.join("state.sqlite3")).unwrap();
        assert_eq!(
            db.listening_analytics("2025-01-01", "2025-12-31", None, true)
                .unwrap()["totalMs"],
            5000
        );
        assert_eq!(
            db.listening_analytics("2024-01-01", "2024-12-31", None, true)
                .unwrap()["totalMs"],
            0
        );
        for (start, end) in [
            ("2026-02-30", "2026-03-01"),
            ("2025-01-01", "2026-12-31"),
            ("2026-10-09", "2026-10-08"),
            ("bad", "bad"),
        ] {
            assert!(db.listening_analytics(start, end, None, true).is_err());
        }
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn large_history_returns_bounded_rankings_and_exact_totals() {
        let (root, db) = fixture();
        db.connection().unwrap().execute_batch("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO listening_totals SELECT 't'||x,'Song '||x,'Artist '||(x%50),60000,1,1 FROM n; INSERT INTO listening_hourly SELECT track_id,'2026-10-08',12,listened_ms,qualified_plays FROM listening_totals;").unwrap();
        let start = std::time::Instant::now();
        let report = db
            .listening_analytics(
                "2026-01-01",
                "2026-12-31",
                Some(&HashSet::from(["t1".into()])),
                true,
            )
            .unwrap();
        eprintln!("10k-track analytics: {:?}", start.elapsed());
        assert_eq!(report["totalMs"], 600_000_000);
        assert_eq!(report["tracks"], 10000);
        assert_eq!(report["songs"].as_array().unwrap().len(), 30);
        assert_eq!(report["artists"].as_array().unwrap().len(), 30);
        assert_eq!(report["likes"]["listenedMs"], 60000);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
