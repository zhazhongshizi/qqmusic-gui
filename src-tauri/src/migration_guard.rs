use crate::persistence::LOCAL_SCHEMA_VERSION;
use rusqlite::{Connection, OpenFlags};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, PartialEq, Eq)]
pub enum MigrationError {
    Unavailable,
    Declined,
    Incompatible,
}

pub fn existing_version(path: &Path) -> Result<Option<u32>, MigrationError> {
    if !path.exists() {
        return Ok(None);
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| MigrationError::Unavailable)?;
    db.pragma_query_value(None, "user_version", |r| r.get(0))
        .map(Some)
        .map_err(|_| MigrationError::Unavailable)
}

pub fn prepare(path: &Path, approved: bool) -> Result<Option<PathBuf>, MigrationError> {
    let Some(version) = existing_version(path)? else {
        return Ok(None);
    };
    if version > LOCAL_SCHEMA_VERSION {
        return Err(MigrationError::Incompatible);
    }
    if version == LOCAL_SCHEMA_VERSION {
        return Ok(None);
    }
    if !approved {
        return Err(MigrationError::Declined);
    }
    let folder = path
        .parent()
        .ok_or(MigrationError::Unavailable)?
        .join("migration-backups");
    fs::create_dir_all(&folder).map_err(|_| MigrationError::Unavailable)?;
    let backup = folder.join(format!(
        "state-schema-{version}-before-{}-{}.sqlite3",
        LOCAL_SCHEMA_VERSION,
        uuid::Uuid::new_v4()
    ));
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| MigrationError::Unavailable)?;
    db.backup("main", &backup, None)
        .map_err(|_| MigrationError::Unavailable)?;
    let saved = Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| MigrationError::Unavailable)?;
    let integrity: String = saved
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|_| MigrationError::Unavailable)?;
    if integrity != "ok" {
        return Err(MigrationError::Unavailable);
    }
    Ok(Some(backup))
}

#[cfg(windows)]
pub fn approve_application(path: &Path) -> bool {
    use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
    match existing_version(path) {
        Ok(Some(version)) if version < LOCAL_SCHEMA_VERSION => {
            let approved=MessageDialog::new().set_title("升级音乐数据")
                .set_description("当前版本需要升级已有音乐数据。升级前会保留安全快照；升级后的数据库不能直接交给旧版本使用。是否升级？选择“否”将保留原数据，本次音乐数据功能暂不可用。")
                .set_level(MessageLevel::Warning).set_buttons(MessageButtons::YesNo).show()==MessageDialogResult::Yes;
            match prepare(path, approved) {
                Ok(_) => true,
                Err(MigrationError::Declined) => false,
                Err(_) => {
                    MessageDialog::new().set_title("音乐数据暂不可用").set_description("无法创建升级前的安全快照，原数据库未执行升级。请检查数据目录权限和磁盘空间后重新启动。").set_level(MessageLevel::Error).show();
                    false
                }
            }
        }
        Ok(Some(version)) if version > LOCAL_SCHEMA_VERSION => {
            MessageDialog::new().set_title("数据版本不兼容").set_description("数据库来自更新的应用版本。本次不会打开它供写入；请使用对应的新版本，或使用旧版本的数据副本。").set_level(MessageLevel::Error).show();
            false
        }
        Ok(_) => true,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approved_upgrade_preserves_settings_and_keeps_an_old_schema_snapshot() {
        use crate::persistence::{PersistenceService, PreferredQuality};
        let folder = std::env::temp_dir().join(format!("qmg-migration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join("state.sqlite3");
        let service = PersistenceService::open(&path).unwrap();
        let mut settings = service.load_settings().unwrap();
        settings.preferred_quality = PreferredQuality::Flac;
        service.save_settings(&settings).unwrap();
        drop(service);
        let db = Connection::open(&path).unwrap();
        db.execute_batch("DROP TABLE memory_tapes; PRAGMA user_version=10;")
            .unwrap();
        drop(db);
        let backup = prepare(&path, true).unwrap().unwrap();
        let upgraded = PersistenceService::open(&path).unwrap();
        assert_eq!(
            upgraded.load_settings().unwrap().preferred_quality,
            PreferredQuality::Flac
        );
        assert_eq!(existing_version(&path), Ok(Some(LOCAL_SCHEMA_VERSION)));
        assert_eq!(existing_version(&backup), Ok(Some(10)));
        drop(upgraded);
        fs::remove_dir_all(folder).unwrap();
    }
    #[test]
    fn declined_upgrade_does_not_create_or_modify_data() {
        let folder = std::env::temp_dir().join(format!("qmg-migration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join("state.sqlite3");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('original'); PRAGMA user_version=1;").unwrap();
        drop(db);
        let before = fs::read(&path).unwrap();
        assert_eq!(prepare(&path, false), Err(MigrationError::Declined));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(!folder.join("migration-backups").exists());
        fs::remove_dir_all(folder).unwrap();
    }
    #[test]
    fn snapshot_includes_live_wal_and_survives_failed_migration() {
        let folder = std::env::temp_dir().join(format!("qmg-migration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join("state.sqlite3");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('wal-record'); PRAGMA user_version=1;").unwrap();
        let backup = prepare(&path, true).unwrap().unwrap();
        let saved = Connection::open(&backup).unwrap();
        assert_eq!(
            saved
                .query_row("SELECT value FROM sentinel", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "wal-record"
        );
        assert!(crate::persistence::PersistenceService::open(&path).is_err());
        assert_eq!(existing_version(&path), Ok(Some(1)));
        assert_eq!(
            db.query_row("SELECT value FROM sentinel", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "wal-record"
        );
        drop(saved);
        drop(db);
        fs::remove_dir_all(folder).unwrap();
    }
    #[test]
    fn fresh_current_and_newer_schemas_have_clear_boundaries() {
        let folder = std::env::temp_dir().join(format!("qmg-migration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join("state.sqlite3");
        assert_eq!(prepare(&path, false), Ok(None));
        assert!(!path.exists());
        let db = Connection::open(&path).unwrap();
        db.pragma_update(None, "user_version", LOCAL_SCHEMA_VERSION)
            .unwrap();
        assert_eq!(prepare(&path, false), Ok(None));
        db.pragma_update(None, "user_version", LOCAL_SCHEMA_VERSION + 1)
            .unwrap();
        assert_eq!(prepare(&path, true), Err(MigrationError::Incompatible));
        drop(db);
        fs::remove_dir_all(folder).unwrap();
    }
}
