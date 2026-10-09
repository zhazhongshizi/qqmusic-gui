//! Desktop-only directory catalog. Paths never enter queue or remote DTOs.
use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::{HashMap, HashSet},
    sync::atomic::Ordering,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    Reference,
    Copy,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub running: bool,
    pub cancelled: bool,
    pub directory_id: String,
    pub processed: usize,
    pub added: usize,
    pub existing: usize,
    pub errors: usize,
    pub failures: Vec<LocalMusicImportFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Directory {
    id: String,
    path: String,
    mode: ImportMode,
    available: bool,
    track_count: usize,
    missing_count: usize,
    last_scan_ms: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogStatus {
    directories: Vec<Directory>,
    pub scan: ScanProgress,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum CatalogRequest {
    Status,
    Add { mode: ImportMode },
    Scan { id: String },
    Relocate { id: String },
    Remove { id: String },
    Cancel,
}

fn storage<T>(result: rusqlite::Result<T>) -> Result<T, LocalMusicError> {
    result.map_err(|_| LocalMusicError::StorageUnavailable)
}

pub(super) fn open(root: &Path) -> Result<Connection, LocalMusicError> {
    let path = root.join("library.sqlite3");
    if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || is_reparse_point(&m)) {
        return Err(LocalMusicError::StorageUnavailable);
    }
    let db = storage(Connection::open(path))?;
    storage(db.busy_timeout(Duration::from_secs(5)))?;
    storage(db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;"))?;
    let version: i64 = storage(db.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
    if version > 1 {
        return Err(LocalMusicError::StorageUnavailable);
    }
    if version == 0 {
        storage(db.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS directories(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,mode TEXT NOT NULL,last_scan_ms INTEGER);
            CREATE TABLE IF NOT EXISTS files(directory_id TEXT NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
                path TEXT NOT NULL,track_id TEXT NOT NULL,payload TEXT NOT NULL,size INTEGER NOT NULL,modified TEXT NOT NULL,available INTEGER NOT NULL,
                PRIMARY KEY(directory_id,path));
            CREATE INDEX IF NOT EXISTS files_track ON files(track_id);
            CREATE TABLE IF NOT EXISTS managed_cache(id TEXT PRIMARY KEY,size INTEGER NOT NULL,modified TEXT NOT NULL,payload TEXT NOT NULL);
            PRAGMA user_version=1; COMMIT;"))?;
    }
    Ok(db)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn fingerprint(metadata: &fs::Metadata) -> (i64, String) {
    (
        metadata.len() as i64,
        format!("{:?}", metadata.modified().ok()),
    )
}
fn mode_text(mode: ImportMode) -> &'static str {
    if mode == ImportMode::Copy {
        "copy"
    } else {
        "reference"
    }
}
fn checked_directory(path: &Path) -> Result<PathBuf, LocalMusicError> {
    let m = fs::symlink_metadata(path).map_err(|_| LocalMusicError::InvalidFile)?;
    if !m.is_dir() || is_reparse_point(&m) {
        return Err(LocalMusicError::InvalidFile);
    }
    fs::canonicalize(path).map_err(|_| LocalMusicError::InvalidFile)
}

#[derive(Clone)]
struct IndexedFile {
    path: PathBuf,
    track: LocalMusicTrack,
    size: i64,
    modified: String,
    available: bool,
}
fn files(db: &Connection, id: &str) -> Result<Vec<IndexedFile>, LocalMusicError> {
    let mut q = storage(
        db.prepare("SELECT path,payload,size,modified,available FROM files WHERE directory_id=?1"),
    )?;
    let raw = storage(q.query_map([id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, bool>(4)?,
        ))
    }))?;
    raw.map(|row| {
        let (path, payload, size, modified, available) = storage(row)?;
        Ok(IndexedFile {
            path: path.into(),
            track: serde_json::from_str(&payload)
                .map_err(|_| LocalMusicError::StorageUnavailable)?,
            size,
            modified,
            available,
        })
    })
    .collect()
}

impl LocalMusicService {
    pub fn catalog(&self, request: CatalogRequest) -> Result<CatalogStatus, LocalMusicError> {
        match request {
            CatalogRequest::Status => {}
            CatalogRequest::Cancel => {
                self.cancel_scan.store(true, Ordering::Release);
            }
            CatalogRequest::Scan { id } => {
                self.scan_directory(&id)?;
            }
            CatalogRequest::Add { mode } => {
                if let Some(path) = FileDialog::new().set_title("选择音乐目录").pick_folder()
                {
                    let id = self.add_directory(&path, mode)?;
                    self.scan_directory(&id)?;
                }
            }
            CatalogRequest::Relocate { id } => {
                if let Some(path) = FileDialog::new()
                    .set_title("重新定位音乐目录（保留歌曲 ID）")
                    .pick_folder()
                {
                    self.relocate_directory(&id, &path)?;
                    self.scan_directory(&id)?;
                }
            }
            CatalogRequest::Remove { id } => {
                self.remove_directory(&id)?;
            }
        }
        self.catalog_status()
    }

    pub fn catalog_status(&self) -> Result<CatalogStatus, LocalMusicError> {
        let root = self.ensure_writable()?;
        let db = open(&root)?;
        let mut q = storage(db.prepare("SELECT d.id,d.path,d.mode,d.last_scan_ms,COUNT(DISTINCT f.track_id),COALESCE(SUM(CASE WHEN f.available=0 THEN 1 ELSE 0 END),0)
            FROM directories d LEFT JOIN files f ON d.id=f.directory_id GROUP BY d.id ORDER BY d.path"))?;
        let directories = storage(q.query_map([], |r| {
            let path: String = r.get(1)?;
            Ok(Directory {
                id: r.get(0)?,
                available: Path::new(&path).is_dir(),
                path,
                mode: if r.get::<_, String>(2)? == "copy" {
                    ImportMode::Copy
                } else {
                    ImportMode::Reference
                },
                last_scan_ms: r.get(3)?,
                track_count: r.get::<_, i64>(4)? as usize,
                missing_count: r.get::<_, i64>(5)? as usize,
            })
        }))?
        .collect::<rusqlite::Result<Vec<_>>>();
        Ok(CatalogStatus {
            directories: storage(directories)?,
            scan: self
                .scan
                .lock()
                .map_err(|_| LocalMusicError::StorageUnavailable)?
                .clone(),
        })
    }

    fn mutation_guard(&self) -> Result<std::sync::MutexGuard<'_, ()>, LocalMusicError> {
        self.import_lock
            .try_lock()
            .map_err(|_| LocalMusicError::StorageConflict)
    }

    fn validate_directory_overlap(
        &self,
        db: &Connection,
        path: &Path,
        except: &str,
    ) -> Result<(), LocalMusicError> {
        let root =
            fs::canonicalize(self.root()?).map_err(|_| LocalMusicError::StorageUnavailable)?;
        if path.starts_with(&root) || root.starts_with(path) {
            return Err(LocalMusicError::StorageConflict);
        }
        let mut q = storage(db.prepare("SELECT path FROM directories WHERE id<>?1"))?;
        for row in storage(q.query_map([except], |r| r.get::<_, String>(0)))? {
            let other = PathBuf::from(storage(row)?);
            if path.starts_with(&other) || other.starts_with(path) {
                return Err(LocalMusicError::StorageConflict);
            }
        }
        Ok(())
    }

    pub fn add_directory(&self, path: &Path, mode: ImportMode) -> Result<String, LocalMusicError> {
        let _guard = self.mutation_guard()?;
        let root = self.ensure_writable()?;
        let path = checked_directory(path)?;
        let db = open(&root)?;
        self.validate_directory_overlap(&db, &path, "")?;
        let id = Uuid::new_v4().to_string();
        storage(db.execute(
            "INSERT INTO directories(id,path,mode) VALUES(?1,?2,?3)",
            params![id, path.to_string_lossy(), mode_text(mode)],
        ))?;
        Ok(id)
    }

    pub fn relocate_directory(&self, id: &str, path: &Path) -> Result<(), LocalMusicError> {
        let _guard = self.mutation_guard()?;
        let mut db = open(&self.ensure_writable()?)?;
        let path = checked_directory(path)?;
        self.validate_directory_overlap(&db, &path, id)?;
        let tx = storage(db.transaction())?;
        if storage(tx.execute(
            "UPDATE directories SET path=?2,last_scan_ms=NULL WHERE id=?1",
            params![id, path.to_string_lossy()],
        ))? == 0
        {
            return Err(LocalMusicError::InvalidFile);
        }
        // Old entries remain visible as unavailable until the new scan commits.
        storage(tx.execute("UPDATE files SET available=0 WHERE directory_id=?1", [id]))?;
        storage(tx.commit())
    }

    pub fn remove_directory(&self, id: &str) -> Result<(), LocalMusicError> {
        let _guard = self.mutation_guard()?;
        let db = open(&self.ensure_writable()?)?;
        storage(db.execute("DELETE FROM directories WHERE id=?1", [id]))?;
        Ok(()) // Never touch source files or managed copies.
    }

    pub fn scan_directory(&self, id: &str) -> Result<(), LocalMusicError> {
        let _guard = self.mutation_guard()?;
        self.cancel_scan.store(false, Ordering::Release);
        *self
            .scan
            .lock()
            .map_err(|_| LocalMusicError::StorageUnavailable)? = ScanProgress {
            running: true,
            directory_id: id.into(),
            ..Default::default()
        };
        let result = self.scan_directory_inner(id);
        if let Ok(mut progress) = self.scan.lock() {
            progress.running = false;
            progress.cancelled = result.as_ref().is_ok_and(|completed| !*completed);
            if let Err(error) = &result {
                progress.errors += 1;
                progress.failures.push(LocalMusicImportFailure {
                    file_name: "目录扫描".into(),
                    code: error.code(),
                });
            }
        }
        result.map(|_| ())
    }

    fn scan_directory_inner(&self, id: &str) -> Result<bool, LocalMusicError> {
        let root = self.ensure_writable()?;
        let mut db = open(&root)?;
        let (path, mode): (String, String) = storage(db.query_row(
            "SELECT path,mode FROM directories WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        let source_root = match checked_directory(Path::new(&path)) {
            Ok(path) => path,
            Err(error) => {
                storage(db.execute("UPDATE files SET available=0 WHERE directory_id=?1", [id]))?;
                return Err(error);
            }
        };
        let mut previous: HashMap<PathBuf, IndexedFile> = files(&db, id)?
            .into_iter()
            .map(|v| (v.path.clone(), v))
            .collect();
        let mut next = Vec::new();
        let mut stack = vec![source_root.clone()];
        let mut seen: HashSet<String> = {
            let mut q = storage(
                db.prepare("SELECT track_id FROM files UNION SELECT id FROM managed_cache"),
            )?;
            let rows = storage(q.query_map([], |r| r.get(0)))?;
            storage(rows.collect())?
        };
        while let Some(dir) = stack.pop() {
            if self.cancel_scan.load(Ordering::Acquire) {
                return Ok(false);
            }
            if checked_directory(&dir)
                .map_or(true, |canonical| !canonical.starts_with(&source_root))
            {
                self.scan_failure(&dir, LocalMusicError::InvalidFile);
                continue;
            }
            let entries = match fs::read_dir(&dir) {
                Ok(v) => v,
                Err(_) => {
                    self.scan_failure(&dir, LocalMusicError::InvalidFile);
                    continue;
                }
            };
            for entry in entries {
                if self.cancel_scan.load(Ordering::Acquire) {
                    return Ok(false);
                }
                let entry = match entry {
                    Ok(v) => v,
                    Err(_) => {
                        self.scan_failure(&dir, LocalMusicError::InvalidFile);
                        continue;
                    }
                };
                let path = entry.path();
                let m = match fs::symlink_metadata(&path) {
                    Ok(v) => v,
                    Err(_) => {
                        self.scan_failure(&path, LocalMusicError::InvalidFile);
                        continue;
                    }
                };
                if is_reparse_point(&m) || m.file_type().is_symlink() {
                    continue;
                }
                if m.is_dir() {
                    stack.push(path);
                    continue;
                }
                let Some(format) = path
                    .extension()
                    .and_then(OsStr::to_str)
                    .and_then(LocalMusicFormat::from_extension)
                else {
                    continue;
                };
                if !m.is_file() {
                    continue;
                }
                let (size, modified) = fingerprint(&m);
                let result = (|| {
                    if size == 0 {
                        return Err(LocalMusicError::InvalidFile);
                    }
                    if size > MAX_AUDIO_BYTES as i64 {
                        return Err(LocalMusicError::FileTooLarge);
                    }
                    if let Some(old) = previous
                        .get(&path)
                        .filter(|v| v.size == size && v.modified == modified && v.available)
                    {
                        if mode != "copy"
                            || root
                                .join(LocalTrackId::parse(&old.track.id)?.filename())
                                .is_file()
                        {
                            return Ok(old.track.clone());
                        }
                    }
                    let digest = self.hash_cancellable(&path)?;
                    let track_id = LocalTrackId { digest, format };
                    let track = if mode == "copy" {
                        if self.cancel_scan.load(Ordering::Acquire) {
                            return Err(LocalMusicError::InvalidFile);
                        }
                        match self.import_one_with_cancel(&root, &path, Some(&self.cancel_scan))? {
                            ImportOutcome::Imported(v) => v,
                            ImportOutcome::Existing => self.read_track(
                                &root,
                                &root.join(track_id.filename()),
                                &track_id,
                                None,
                            )?,
                        }
                    } else {
                        let inspected = inspect_audio(&path, format)?;
                        if inspected.ogg_codec.is_some_and(|c| !ogg_codec_available(c)) {
                            return Err(LocalMusicError::CodecUnavailable);
                        }
                        self.read_track(
                            &root,
                            &path,
                            &track_id,
                            path.file_stem().and_then(OsStr::to_str),
                        )?
                    };
                    if fingerprint(&fs::metadata(&path).map_err(|_| LocalMusicError::InvalidFile)?)
                        != (size, modified.clone())
                    {
                        return Err(LocalMusicError::InvalidFile);
                    }
                    Ok(track)
                })();
                if self.cancel_scan.load(Ordering::Acquire) {
                    return Ok(false);
                }
                match result {
                    Ok(track) => {
                        let existed = !seen.insert(track.id.clone());
                        previous.remove(&path);
                        next.push(IndexedFile {
                            path,
                            track,
                            size,
                            modified,
                            available: true,
                        });
                        if let Ok(mut p) = self.scan.lock() {
                            p.processed += 1;
                            if existed {
                                p.existing += 1;
                            } else {
                                p.added += 1;
                            }
                        }
                    }
                    Err(error) => self.scan_failure(&path, error),
                }
            }
        }
        // Keep missing entries for repair, but not obsolete locations of moved content.
        let present: HashSet<_> = next.iter().map(|v| v.track.id.clone()).collect();
        for mut old in previous.into_values() {
            if !present.contains(&old.track.id) {
                old.available = false;
                next.push(old);
            }
        }
        if self.cancel_scan.load(Ordering::Acquire) {
            return Ok(false);
        }
        let tx = storage(db.transaction())?;
        storage(tx.execute("DELETE FROM files WHERE directory_id=?1", [id]))?;
        {
            let mut insert=storage(tx.prepare("INSERT INTO files(directory_id,path,track_id,payload,size,modified,available) VALUES(?1,?2,?3,?4,?5,?6,?7)"))?;
            for item in next {
                let payload = serde_json::to_string(&item.track)
                    .map_err(|_| LocalMusicError::StorageUnavailable)?;
                storage(insert.execute(params![
                    id,
                    item.path.to_string_lossy(),
                    item.track.id,
                    payload,
                    item.size,
                    item.modified,
                    item.available
                ]))?;
            }
        }
        storage(tx.execute(
            "UPDATE directories SET last_scan_ms=?2 WHERE id=?1",
            params![id, now_ms()],
        ))?;
        if self.cancel_scan.load(Ordering::Acquire) {
            return Ok(false);
        }
        storage(tx.commit())?;
        Ok(true)
    }

    fn scan_failure(&self, path: &Path, error: LocalMusicError) {
        if let Ok(mut p) = self.scan.lock() {
            p.processed += 1;
            p.errors += 1;
            if p.failures.len() < 100 {
                p.failures.push(LocalMusicImportFailure {
                    file_name: safe_file_name(path),
                    code: error.code(),
                });
            }
        }
    }

    fn hash_cancellable(&self, path: &Path) -> Result<[u8; 32], LocalMusicError> {
        let mut file = File::open(path).map_err(|_| LocalMusicError::InvalidFile)?;
        let mut digest = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        loop {
            if self.cancel_scan.load(Ordering::Acquire) {
                return Err(LocalMusicError::InvalidFile);
            }
            let count = file
                .read(&mut buffer)
                .map_err(|_| LocalMusicError::InvalidFile)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        Ok(digest.finalize().into())
    }

    pub(super) fn merge_indexed_tracks(
        &self,
        root: &Path,
        tracks: &mut Vec<LocalMusicTrack>,
        warnings: &mut usize,
    ) -> Result<(), LocalMusicError> {
        if !root.join("library.sqlite3").exists() {
            return Ok(());
        }
        let db = open(root)?;
        let mut q=storage(db.prepare("SELECT f.payload,MAX(f.available) FROM files f JOIN directories d ON d.id=f.directory_id WHERE d.mode='reference' GROUP BY f.track_id"))?;
        let ids: HashSet<_> = tracks.iter().map(|v| v.id.clone()).collect();
        for row in storage(q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))))?
        {
            let (payload, available) = storage(row)?;
            let mut track: LocalMusicTrack =
                serde_json::from_str(&payload).map_err(|_| LocalMusicError::StorageUnavailable)?;
            if ids.contains(&track.id) {
                continue;
            }
            track.available = Some(available);
            track.referenced = Some(true);
            if !available {
                *warnings += 1;
            }
            tracks.push(track);
        }
        Ok(())
    }

    pub(super) fn resolve_reference(
        &self,
        root: &Path,
        id: &str,
    ) -> Result<PathBuf, LocalMusicError> {
        if !root.join("library.sqlite3").exists() {
            return Err(LocalMusicError::FileMissing);
        }
        let db = open(root)?;
        let mut q=storage(db.prepare("SELECT f.path,d.path,f.size,f.modified FROM files f JOIN directories d ON d.id=f.directory_id WHERE f.track_id=?1 AND f.available=1 AND d.mode='reference'"))?;
        for row in storage(q.query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        }))? {
            let (file, dir, size, modified) = storage(row)?;
            let path = PathBuf::from(file);
            let base = PathBuf::from(dir);
            if !path.starts_with(&base) {
                continue;
            }
            // Reject a replaced parent junction as well as a linked file.
            let mut current = Some(path.as_path());
            let mut safe = true;
            while let Some(p) = current {
                if fs::symlink_metadata(p)
                    .map_or(true, |m| is_reparse_point(&m) || m.file_type().is_symlink())
                {
                    safe = false;
                    break;
                }
                if p == base {
                    break;
                }
                current = p.parent();
            }
            if safe
                && fs::canonicalize(&path).is_ok_and(|canonical| canonical.starts_with(&base))
                && fs::metadata(&path)
                    .is_ok_and(|m| m.is_file() && fingerprint(&m) == (size, modified.clone()))
            {
                return Ok(path);
            }
        }
        Err(LocalMusicError::FileMissing)
    }

    pub(super) fn cached_managed_track(
        &self,
        db: &Connection,
        root: &Path,
        path: &Path,
        id: &LocalTrackId,
        metadata: &fs::Metadata,
    ) -> Result<LocalMusicTrack, LocalMusicError> {
        let (size, modified) = fingerprint(metadata);
        let cached: Option<String> = storage(
            db.query_row(
                "SELECT payload FROM managed_cache WHERE id=?1 AND size=?2 AND modified=?3",
                params![id.as_string(), size, modified],
                |r| r.get(0),
            )
            .optional(),
        )?;
        if let Some(payload) = cached {
            if let Ok(track) = serde_json::from_str(&payload) {
                return Ok(track);
            }
        }
        let track = self.read_track(root, path, id, None)?;
        let payload =
            serde_json::to_string(&track).map_err(|_| LocalMusicError::StorageUnavailable)?;
        storage(db.execute(
            "INSERT OR REPLACE INTO managed_cache(id,size,modified,payload) VALUES(?1,?2,?3,?4)",
            params![id.as_string(), size, modified, payload],
        ))?;
        Ok(track)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        home: PathBuf,
        source: PathBuf,
        service: LocalMusicService,
    }
    impl Fixture {
        fn new() -> Self {
            let home = std::env::temp_dir().join(format!("qmg-f03-{}", Uuid::new_v4()));
            let source = home.join("音乐 原文件");
            fs::create_dir_all(&source).unwrap();
            let service = LocalMusicService::new(home.join("local-music"));
            Self {
                home,
                source,
                service,
            }
        }
        fn audio(&self, name: &str, samples: u64) -> PathBuf {
            let path = self.source.join(name);
            let mut bytes = b"fLaC\x80\x00\x00\x22".to_vec();
            let mut stream = [0u8; 34];
            stream[0..4].copy_from_slice(&[0x10, 0, 0x10, 0]);
            let packed = (44100u64 << 44) | (1u64 << 41) | (15u64 << 36) | samples;
            stream[10..18].copy_from_slice(&packed.to_be_bytes());
            bytes.extend(stream);
            fs::write(&path, bytes).unwrap();
            path
        }
        fn add(&self, mode: ImportMode) -> String {
            self.service.add_directory(&self.source, mode).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.home);
        }
    }

    #[test]
    fn reference_scan_deduplicates_and_preserves_unicode_source() {
        let f = Fixture::new();
        let original = f.audio("夜航.flac", 44100);
        fs::copy(&original, f.source.join("重复.flac")).unwrap();
        let id = f.add(ImportMode::Reference);
        f.service.scan_directory(&id).unwrap();
        let tracks = f.service.list().unwrap().tracks;
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].referenced, Some(true));
        assert_eq!(tracks[0].duration_ms, 1000);
        assert!(f
            .service
            .resolve_media_file(&tracks[0].id)
            .unwrap()
            .exists());
        assert_eq!(f.service.scan.lock().unwrap().existing, 1);
        f.service.scan_directory(&id).unwrap();
        assert_eq!(f.service.list().unwrap().tracks.len(), 1);
        assert_eq!(f.service.scan.lock().unwrap().added, 0);
        assert!(f.service.prepare_delete(&tracks[0].id).is_err());
        f.service.remove_directory(&id).unwrap();
        assert!(original.exists());
        assert!(f.service.list().unwrap().tracks.is_empty());
    }

    #[test]
    fn copy_mode_retains_original_and_managed_copy_after_removing_directory() {
        let f = Fixture::new();
        let original = f.audio("复制.flac", 88200);
        let id = f.add(ImportMode::Copy);
        f.service.scan_directory(&id).unwrap();
        let tracks = f.service.list().unwrap().tracks;
        assert_eq!(tracks.len(), 1);
        let managed = f.service.resolve_media_file(&tracks[0].id).unwrap();
        assert_ne!(managed, original);
        assert_eq!(fs::read(&managed).unwrap(), fs::read(&original).unwrap());
        f.service.remove_directory(&id).unwrap();
        assert!(original.exists());
        assert!(managed.exists());
        assert_eq!(f.service.list().unwrap().tracks.len(), 1);
    }

    #[test]
    fn moved_deleted_and_relocated_files_keep_content_identity() {
        let f = Fixture::new();
        let original = f.audio("原名.flac", 44100);
        let directory = f.add(ImportMode::Reference);
        f.service.scan_directory(&directory).unwrap();
        let id = f.service.list().unwrap().tracks[0].id.clone();
        let moved = f.source.join("新名.flac");
        fs::rename(&original, &moved).unwrap();
        f.service.scan_directory(&directory).unwrap();
        assert_eq!(f.service.list().unwrap().tracks.len(), 1);
        assert_eq!(
            f.service.resolve_media_file(&id).unwrap(),
            fs::canonicalize(&moved).unwrap()
        );
        let new_root = f.home.join("新目录");
        fs::rename(&f.source, &new_root).unwrap();
        assert!(f.service.scan_directory(&directory).is_err());
        assert_eq!(f.service.list().unwrap().tracks[0].available, Some(false));
        f.service.relocate_directory(&directory, &new_root).unwrap();
        f.service.scan_directory(&directory).unwrap();
        assert!(f.service.resolve_media_file(&id).unwrap().exists());
        assert_eq!(f.service.list().unwrap().tracks[0].id, id);
        fs::remove_file(new_root.join("新名.flac")).unwrap();
        f.service.scan_directory(&directory).unwrap();
        assert_eq!(f.service.list().unwrap().tracks[0].available, Some(false));
        assert!(f.service.resolve_media_file(&id).is_err());
    }

    #[test]
    fn multiple_directories_overlap_rejected_and_duplicate_content_survives_one_removal() {
        let f = Fixture::new();
        let original = f.audio("同曲.flac", 44100);
        let one = f.add(ImportMode::Reference);
        f.service.scan_directory(&one).unwrap();
        assert!(f
            .service
            .add_directory(&f.source, ImportMode::Reference)
            .is_err());
        let nested = f.source.join("子目录");
        fs::create_dir(&nested).unwrap();
        assert!(f
            .service
            .add_directory(&nested, ImportMode::Reference)
            .is_err());
        let other = f.home.join("另一目录");
        fs::create_dir(&other).unwrap();
        fs::copy(&original, other.join("同曲.flac")).unwrap();
        let two = f
            .service
            .add_directory(&other, ImportMode::Reference)
            .unwrap();
        f.service.scan_directory(&two).unwrap();
        assert_eq!(f.service.list().unwrap().tracks.len(), 1);
        assert_eq!(f.service.catalog_status().unwrap().directories.len(), 2);
        f.service.remove_directory(&one).unwrap();
        assert_eq!(f.service.list().unwrap().tracks.len(), 1);
    }

    #[test]
    fn cancelled_scan_does_not_replace_snapshot_and_copy_temp_is_cleaned() {
        let f = Fixture::new();
        let source = f.audio("保留.flac", 44100);
        let id = f.add(ImportMode::Reference);
        f.service.scan_directory(&id).unwrap();
        f.audio("新增.flac", 88200);
        f.service.cancel_scan.store(true, Ordering::Release);
        assert!(!f.service.scan_directory_inner(&id).unwrap());
        assert_eq!(f.service.list().unwrap().tracks.len(), 1);
        let root = f.service.ensure_writable().unwrap();
        assert!(copy_and_hash(&source, &root, Some(&f.service.cancel_scan)).is_err());
        assert!(!fs::read_dir(&root)
            .unwrap()
            .flatten()
            .any(|v| v.file_name().to_string_lossy().ends_with(".part")));
        f.service.scan_directory(&id).unwrap();
        assert_eq!(f.service.list().unwrap().tracks.len(), 2);
    }

    #[test]
    fn malformed_file_is_reported_and_list_playback_do_not_take_scan_lock() {
        let f = Fixture::new();
        f.audio("有效.flac", 44100);
        fs::write(f.source.join("损坏.flac"), b"broken").unwrap();
        let dir = f.add(ImportMode::Reference);
        f.service.scan_directory(&dir).unwrap();
        assert_eq!(f.service.scan.lock().unwrap().errors, 1);
        let _scan_guard = f.service.mutation_guard().unwrap();
        let tracks = f.service.list().unwrap().tracks;
        assert_eq!(tracks.len(), 1);
        assert!(f.service.resolve_media_file(&tracks[0].id).is_ok());
        assert!(matches!(
            f.service.prepare_delete(&tracks[0].id),
            Err(LocalMusicError::StorageConflict)
        ));
        assert!(f.service.remove_directory(&dir).is_err());
        let serialized = serde_json::to_string(&f.service.list().unwrap()).unwrap();
        assert!(!serialized.contains("音乐 原文件"));
        assert!(!serialized.contains("path"));
    }

    #[test]
    fn thousand_track_catalog_survives_restart_and_only_scans_on_request() {
        let f = Fixture::new();
        for i in 0..1200 {
            f.audio(&format!("歌曲{i:04}.flac"), 44100 + i);
        }
        let id = f.add(ImportMode::Reference);
        let started = std::time::Instant::now();
        f.service.scan_directory(&id).unwrap();
        eprintln!("F03 1200 metadata fixtures scan: {:?}", started.elapsed());
        assert_eq!(f.service.list().unwrap().tracks.len(), 1200);
        f.service.scan_directory(&id).unwrap();
        assert_eq!(f.service.scan.lock().unwrap().existing, 1200);
        f.audio("未扫描新歌.flac", 100000);
        let restarted = LocalMusicService::new(f.home.join("local-music"));
        assert_eq!(restarted.list().unwrap().tracks.len(), 1200);
        assert!(!restarted.catalog_status().unwrap().scan.running);
        restarted.scan_directory(&id).unwrap();
        assert_eq!(restarted.list().unwrap().tracks.len(), 1201);
    }

    #[test]
    fn changed_file_is_not_played_using_stale_identity() {
        let f = Fixture::new();
        let path = f.audio("变更.flac", 44100);
        let dir = f.add(ImportMode::Reference);
        f.service.scan_directory(&dir).unwrap();
        let id = f.service.list().unwrap().tracks[0].id.clone();
        fs::write(&path, b"changed data").unwrap();
        assert!(f.service.resolve_media_file(&id).is_err());
        f.service.scan_directory(&dir).unwrap();
        assert_eq!(f.service.list().unwrap().tracks[0].available, Some(false));
    }

    #[test]
    fn embedded_cover_prefers_front_and_rejects_unsupported_bytes() {
        use lofty::picture::{MimeType, Picture, PictureType};
        use lofty::{
            config::WriteOptions,
            tag::{Tag, TagType},
        };
        let f = Fixture::new();
        let path = f.audio("带封面.flac", 44100);
        let mut tag = Tag::new(TagType::VorbisComments);
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        png.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
        let mut back = png.clone();
        back.extend_from_slice(b"back");
        let mut front = png;
        front.extend_from_slice(b"front");
        tag.push_picture(
            Picture::unchecked(back)
                .pic_type(PictureType::CoverBack)
                .mime_type(MimeType::Png)
                .build(),
        );
        tag.push_picture(
            Picture::unchecked(front.clone())
                .pic_type(PictureType::CoverFront)
                .mime_type(MimeType::Png)
                .build(),
        );
        tag.save_to_path(&path, WriteOptions::default()).unwrap();
        let dir = f.add(ImportMode::Reference);
        f.service.scan_directory(&dir).unwrap();
        let track = &f.service.list().unwrap().tracks[0];
        assert_eq!(track.cover_cache_key.as_ref(), Some(&track.id));
        assert_eq!(f.service.embedded_cover(&track.id).unwrap().bytes, front);
        assert!(supported_picture(b"<svg/>").is_none());
        assert!(supported_picture(&vec![0; crate::cover::MAX_COVER_BYTES + 1]).is_none());
    }
}
