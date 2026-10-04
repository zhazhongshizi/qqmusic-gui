use std::{
    ffi::OsStr,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Write},
    path::{Path, PathBuf},
    str::FromStr,
    sync::Mutex,
    time::{Duration, SystemTime},
};

use lofty::{file::FileType, prelude::*, probe::Probe};
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[cfg(windows)]
use windows::{
    core::HSTRING,
    Media::Core::{CodecCategory, CodecKind, CodecQuery, CodecSubtypes},
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_SINGLETHREADED},
};

const MAX_AUDIO_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 512;
const MAX_SIDECAR_BYTES: usize = 4 * 1024;
const SIDECAR_SCHEMA_VERSION: u16 = 1;
const TEMPORARY_FILE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalMusicFormat {
    Mp3,
    Flac,
    Ogg,
}

impl LocalMusicFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::Flac => "flac",
            Self::Ogg => "ogg",
        }
    }

    fn from_extension(extension: &str) -> Option<Self> {
        match extension.to_ascii_lowercase().as_str() {
            "mp3" => Some(Self::Mp3),
            "flac" => Some(Self::Flac),
            "ogg" => Some(Self::Ogg),
            _ => None,
        }
    }

    fn matches_file_type(self, file_type: FileType) -> bool {
        match self {
            Self::Mp3 => matches!(file_type, FileType::Mpeg),
            Self::Flac => matches!(file_type, FileType::Flac),
            Self::Ogg => matches!(file_type, FileType::Vorbis | FileType::Opus),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct LocalTrackId {
    digest: [u8; 32],
    format: LocalMusicFormat,
}

impl LocalTrackId {
    pub fn parse(value: &str) -> Result<Self, LocalMusicError> {
        value.parse()
    }

    pub fn format(&self) -> LocalMusicFormat {
        self.format
    }

    pub fn as_string(&self) -> String {
        format!(
            "local_{}_{}",
            hex_digest(&self.digest),
            self.format.extension()
        )
    }

    fn filename(&self) -> String {
        format!("{}.{}", hex_digest(&self.digest), self.format.extension())
    }

    fn sidecar_filename(&self) -> String {
        format!("{}.metadata.json", hex_digest(&self.digest))
    }
}

impl fmt::Debug for LocalTrackId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LocalTrackId([REDACTED])")
    }
}

impl FromStr for LocalTrackId {
    type Err = LocalMusicError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let mut parts = value.split('_');
        if parts.next() != Some("local") {
            return Err(LocalMusicError::InvalidTrackId);
        }
        let digest = parts.next().ok_or(LocalMusicError::InvalidTrackId)?;
        let format = parts.next().ok_or(LocalMusicError::InvalidTrackId)?;
        if parts.next().is_some()
            || digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(LocalMusicError::InvalidTrackId);
        }
        let format = match format {
            "mp3" => LocalMusicFormat::Mp3,
            "flac" => LocalMusicFormat::Flac,
            "ogg" => LocalMusicFormat::Ogg,
            _ => return Err(LocalMusicError::InvalidTrackId),
        };
        let mut bytes = [0u8; 32];
        for (index, pair) in digest.as_bytes().chunks_exact(2).enumerate() {
            bytes[index] = (hex_value(pair[0]) << 4) | hex_value(pair[1]);
        }
        Ok(Self {
            digest: bytes,
            format,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMusicTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    pub format: LocalMusicFormat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMusicImportFailure {
    pub file_name: String,
    pub code: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMusicImportResult {
    pub imported: Vec<LocalMusicTrack>,
    pub existing_count: usize,
    pub failures: Vec<LocalMusicImportFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMusicListResult {
    pub tracks: Vec<LocalMusicTrack>,
    pub warning_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalMusicError {
    StorageUnavailable,
    InvalidTrackId,
    InvalidFile,
    UnsupportedFormat,
    FileTooLarge,
    MetadataUnreadable,
    CodecUnavailable,
    CopyFailed,
    StorageConflict,
    FileMissing,
    DeleteFailed,
    OutcomeUnknown,
}

impl LocalMusicError {
    pub fn code(self) -> &'static str {
        match self {
            Self::StorageUnavailable => "local_music_storage_unavailable",
            Self::InvalidTrackId => "local_music_invalid_file",
            Self::InvalidFile => "local_music_invalid_file",
            Self::UnsupportedFormat => "local_music_unsupported_format",
            Self::FileTooLarge => "local_music_file_too_large",
            Self::MetadataUnreadable => "local_music_metadata_unreadable",
            Self::CodecUnavailable => "local_music_codec_unavailable",
            Self::CopyFailed => "local_music_copy_failed",
            Self::StorageConflict => "local_music_storage_conflict",
            Self::FileMissing => "local_music_file_missing",
            Self::DeleteFailed => "local_music_delete_failed",
            Self::OutcomeUnknown => "local_music_delete_outcome_unknown",
        }
    }
}

impl fmt::Display for LocalMusicError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for LocalMusicError {}

pub struct LocalMusicService {
    root_override: Option<PathBuf>,
    import_lock: Mutex<()>,
}

/// A prepared, ID-scoped local track deletion.
///
/// The audio file (and, when safe to do so, its sidecar) is renamed to a
/// service-owned tombstone before queue persistence.  Callers must commit or
/// roll back the guard after the queue mutation; dropping it attempts a best
/// effort rollback so an early return does not strand the user's file.
pub struct LocalMusicDeleteGuard<'a> {
    _service_lock: std::sync::MutexGuard<'a, ()>,
    original: PathBuf,
    tombstone: PathBuf,
    sidecar_original: Option<PathBuf>,
    sidecar_tombstone: Option<PathBuf>,
    active: bool,
}

impl fmt::Debug for LocalMusicDeleteGuard<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalMusicDeleteGuard")
            .field("active", &self.active)
            .finish()
    }
}

impl LocalMusicDeleteGuard<'_> {
    /// Permanently removes the prepared audio tombstone. Sidecar cleanup is
    /// best-effort because it is non-essential metadata.
    pub fn commit(mut self) -> Result<(), LocalMusicError> {
        self.active = false;
        remove_if_present(&self.tombstone).map_err(|_| LocalMusicError::OutcomeUnknown)?;
        if let Some(sidecar) = &self.sidecar_tombstone {
            let _ = remove_if_present(sidecar);
        }
        Ok(())
    }

    /// Restores the original audio and sidecar names after queue persistence
    /// fails. Any inability to restore is explicitly surfaced as unknown.
    pub fn rollback(mut self) -> Result<(), LocalMusicError> {
        let result = self.rollback_in_place();
        self.active = false;
        result
    }

    fn rollback_in_place(&mut self) -> Result<(), LocalMusicError> {
        if !self.active {
            return Ok(());
        }
        if self.original.exists() {
            return Err(LocalMusicError::OutcomeUnknown);
        }
        fs::rename(&self.tombstone, &self.original).map_err(|_| LocalMusicError::OutcomeUnknown)?;
        if let (Some(sidecar_original), Some(sidecar_tombstone)) =
            (&self.sidecar_original, &self.sidecar_tombstone)
        {
            if sidecar_original.exists() {
                return Err(LocalMusicError::OutcomeUnknown);
            }
            fs::rename(sidecar_tombstone, sidecar_original)
                .map_err(|_| LocalMusicError::OutcomeUnknown)?;
        }
        Ok(())
    }
}

impl Drop for LocalMusicDeleteGuard<'_> {
    fn drop(&mut self) {
        let _ = self.rollback_in_place();
    }
}

impl LocalMusicService {
    pub fn from_current_exe() -> Result<Self, LocalMusicError> {
        current_exe_local_music_root()?;
        Ok(Self {
            root_override: None,
            import_lock: Mutex::new(()),
        })
    }

    pub fn new(root: PathBuf) -> Self {
        Self {
            root_override: Some(root),
            import_lock: Mutex::new(()),
        }
    }

    pub fn pick_files(&self) -> Option<Vec<PathBuf>> {
        FileDialog::new()
            .add_filter("音频文件", &["mp3", "flac", "ogg"])
            .pick_files()
    }

    pub fn import_selected(&self) -> Result<Option<LocalMusicImportResult>, LocalMusicError> {
        // Check the EXE-adjacent destination before opening a picker: an
        // unwritable install location is a storage error, not a user choice.
        self.ensure_writable()?;
        let Some(paths) = self.pick_files() else {
            return Ok(None);
        };
        self.import_selected_paths(&paths).map(Some)
    }

    pub fn import_selected_paths(
        &self,
        paths: &[PathBuf],
    ) -> Result<LocalMusicImportResult, LocalMusicError> {
        let _import_guard = self
            .import_lock
            .lock()
            .map_err(|_| LocalMusicError::StorageUnavailable)?;
        let root = self.ensure_writable()?;
        self.cleanup_temporary_files(&root);
        let mut result = LocalMusicImportResult {
            imported: Vec::new(),
            existing_count: 0,
            failures: Vec::new(),
        };
        for path in paths {
            match self.import_one(&root, path) {
                Ok(ImportOutcome::Imported(track)) => result.imported.push(track),
                Ok(ImportOutcome::Existing) => result.existing_count += 1,
                Err(error) => result.failures.push(LocalMusicImportFailure {
                    file_name: safe_file_name(path),
                    code: error.code(),
                }),
            }
        }
        result.imported.sort_by_key(|track| {
            (
                track.title.to_lowercase(),
                track.artist.to_lowercase(),
                track.id.clone(),
            )
        });
        Ok(result)
    }

    /// Prepares deletion of exactly one managed track. The source path is
    /// derived from the strict ID and is never accepted from the renderer.
    pub fn prepare_delete(
        &self,
        value: &str,
    ) -> Result<LocalMusicDeleteGuard<'_>, LocalMusicError> {
        let service_lock = self
            .import_lock
            .lock()
            .map_err(|_| LocalMusicError::StorageUnavailable)?;
        let id = LocalTrackId::parse(value)?;
        let configured_root = self.root()?;
        let root = self.validate_root(&configured_root, false)?;
        let original = root.join(id.filename());
        let metadata = fs::symlink_metadata(&original).map_err(|_| LocalMusicError::FileMissing)?;
        if !metadata.file_type().is_file() || is_reparse_point(&metadata) {
            return Err(LocalMusicError::FileMissing);
        }
        let canonical = fs::canonicalize(&original).map_err(|_| LocalMusicError::FileMissing)?;
        if canonical.parent() != Some(root.as_path()) {
            return Err(LocalMusicError::FileMissing);
        }

        let token = Uuid::new_v4().to_string();
        let tombstone = root.join(tombstone_audio_name(&id, &token));
        // UUID collisions are fantastically unlikely, but never allow rename
        // to replace an existing entry on platforms where rename does so.
        if tombstone.exists() {
            return Err(LocalMusicError::DeleteFailed);
        }
        fs::rename(&original, &tombstone).map_err(|_| LocalMusicError::DeleteFailed)?;

        let sidecar_original = root.join(id.sidecar_filename());
        let sidecar_tombstone = if matches!(
            fs::symlink_metadata(&sidecar_original),
            Ok(ref metadata)
                if metadata.file_type().is_file() && !is_reparse_point(metadata)
        ) {
            let path = root.join(tombstone_sidecar_name(&id, &token));
            if path.exists() {
                let _ = fs::rename(&tombstone, &original);
                return Err(LocalMusicError::DeleteFailed);
            }
            if fs::rename(&sidecar_original, &path).is_err() {
                let restored = fs::rename(&tombstone, &original).is_ok();
                return Err(if restored {
                    LocalMusicError::DeleteFailed
                } else {
                    LocalMusicError::OutcomeUnknown
                });
            }
            Some(path)
        } else {
            None
        };

        Ok(LocalMusicDeleteGuard {
            _service_lock: service_lock,
            original,
            tombstone,
            sidecar_original: sidecar_tombstone.as_ref().map(|_| sidecar_original),
            sidecar_tombstone,
            active: true,
        })
    }

    pub fn list(&self) -> Result<LocalMusicListResult, LocalMusicError> {
        let configured_root = self.root()?;
        let root = match self.validate_root(&configured_root, false) {
            Ok(root) => root,
            Err(LocalMusicError::StorageUnavailable)
                if matches!(
                    fs::symlink_metadata(&configured_root),
                    Err(error) if error.kind() == io::ErrorKind::NotFound
                ) =>
            {
                return Ok(LocalMusicListResult {
                    tracks: Vec::new(),
                    warning_count: 0,
                });
            }
            Err(error) => return Err(error),
        };
        let mut tracks = Vec::new();
        let mut warning_count = 0usize;
        let entries = fs::read_dir(&root).map_err(|_| LocalMusicError::StorageUnavailable)?;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    warning_count += 1;
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_file() && !is_reparse_point(&metadata) => {
                    metadata
                }
                _ => continue,
            };
            let Some(name) = path.file_name().and_then(OsStr::to_str) else {
                continue;
            };
            let Some((id, _)) = parse_audio_name(name) else {
                continue;
            };
            if metadata.len() == 0 || metadata.len() > MAX_AUDIO_BYTES {
                warning_count += 1;
                continue;
            }
            match self.read_track(&root, &path, &id, None) {
                Ok(track) => tracks.push(track),
                Err(_) => warning_count += 1,
            }
        }
        tracks.sort_by_key(|track| {
            (
                track.title.to_lowercase(),
                track.artist.to_lowercase(),
                track.id.clone(),
            )
        });
        Ok(LocalMusicListResult {
            tracks,
            warning_count,
        })
    }

    pub fn resolve_media_file(&self, value: &str) -> Result<PathBuf, LocalMusicError> {
        let id = LocalTrackId::parse(value)?;
        let configured_root = self.root()?;
        let root = self.validate_root(&configured_root, false)?;
        let path = root.join(id.filename());
        let metadata = fs::symlink_metadata(&path).map_err(|_| LocalMusicError::FileMissing)?;
        if !metadata.file_type().is_file() || is_reparse_point(&metadata) {
            return Err(LocalMusicError::FileMissing);
        }
        let canonical = fs::canonicalize(&path).map_err(|_| LocalMusicError::FileMissing)?;
        if canonical.parent() != Some(root.as_path()) {
            return Err(LocalMusicError::FileMissing);
        }
        Ok(canonical)
    }

    fn import_one(&self, root: &Path, source: &Path) -> Result<ImportOutcome, LocalMusicError> {
        let metadata = fs::symlink_metadata(source).map_err(|_| LocalMusicError::InvalidFile)?;
        if !metadata.file_type().is_file() || is_reparse_point(&metadata) {
            return Err(LocalMusicError::InvalidFile);
        }
        if metadata.len() == 0 {
            return Err(LocalMusicError::InvalidFile);
        }
        if metadata.len() > MAX_AUDIO_BYTES {
            return Err(LocalMusicError::FileTooLarge);
        }
        let format = source
            .extension()
            .and_then(OsStr::to_str)
            .and_then(LocalMusicFormat::from_extension)
            .ok_or(LocalMusicError::UnsupportedFormat)?;
        let source_inspection = inspect_audio(source, format)?;
        if source_inspection
            .ogg_codec
            .is_some_and(|codec| !ogg_codec_available(codec))
        {
            return Err(LocalMusicError::CodecUnavailable);
        }
        let digest = copy_and_hash(source, root)?;
        let id = LocalTrackId { digest, format };
        let part = part_path(root, &id);
        // Re-inspect the bytes that were actually copied. This closes the gap
        // where a selected source is replaced while an import is in progress.
        let inspected = match inspect_audio(&part, format) {
            Ok(inspected) => inspected,
            Err(error) => {
                let _ = fs::remove_file(&part);
                return Err(error);
            }
        };
        if inspected
            .ogg_codec
            .is_some_and(|codec| !ogg_codec_available(codec))
        {
            let _ = fs::remove_file(&part);
            return Err(LocalMusicError::CodecUnavailable);
        }
        let destination = root.join(id.filename());
        if destination.exists() {
            let existing_digest = hash_file(&destination)?;
            if existing_digest != digest {
                return Err(LocalMusicError::StorageConflict);
            }
            let _ = remove_part_files(root, &id);
            return Ok(ImportOutcome::Existing);
        }
        let has_title = inspected.title.is_some();
        let title = inspected.title.or_else(|| {
            source
                .file_stem()
                .and_then(OsStr::to_str)
                .map(ToOwned::to_owned)
        });
        let needs_sidecar = !has_title;
        let sidecar = root.join(id.sidecar_filename());
        if needs_sidecar {
            let fallback = normalize_text(title.as_deref().unwrap_or("本地音频"), true);
            write_sidecar(&sidecar, &fallback)?;
        }
        fs::rename(&part, &destination).map_err(|_| {
            if needs_sidecar {
                let _ = fs::remove_file(&sidecar);
            }
            LocalMusicError::CopyFailed
        })?;
        let title = normalize_text(title.as_deref().unwrap_or("本地音频"), false);
        Ok(ImportOutcome::Imported(LocalMusicTrack {
            id: id.as_string(),
            title,
            artist: normalize_text(inspected.artist.as_deref().unwrap_or("未知歌手"), false),
            album: normalize_text(inspected.album.as_deref().unwrap_or(""), true),
            duration_ms: inspected.duration_ms,
            format,
        }))
    }

    fn read_track(
        &self,
        root: &Path,
        path: &Path,
        id: &LocalTrackId,
        stem: Option<&str>,
    ) -> Result<LocalMusicTrack, LocalMusicError> {
        let inspected = inspect_audio(path, id.format)?;
        let title = inspected
            .title
            .or_else(|| read_sidecar(&root.join(id.sidecar_filename())).ok())
            .or_else(|| stem.map(ToOwned::to_owned));
        let title = title.unwrap_or_else(|| format!("本地音频 {}", &hex_digest(&id.digest)[..8]));
        Ok(LocalMusicTrack {
            id: id.as_string(),
            title: normalize_text(&title, false),
            artist: normalize_text(inspected.artist.as_deref().unwrap_or("未知歌手"), false),
            album: normalize_text(inspected.album.as_deref().unwrap_or(""), true),
            duration_ms: inspected.duration_ms,
            format: id.format,
        })
    }

    fn root(&self) -> Result<PathBuf, LocalMusicError> {
        self.root_override
            .clone()
            .map_or_else(current_exe_local_music_root, Ok)
    }

    fn ensure_writable(&self) -> Result<PathBuf, LocalMusicError> {
        let configured_root = self.root()?;
        let root = self.validate_root(&configured_root, true)?;
        let probe = root.join(format!(".write-probe-{}", Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .map_err(|_| LocalMusicError::StorageUnavailable)?;
        file.write_all(b"probe")
            .map_err(|_| LocalMusicError::StorageUnavailable)?;
        file.sync_all()
            .map_err(|_| LocalMusicError::StorageUnavailable)?;
        drop(file);
        fs::remove_file(probe).map_err(|_| LocalMusicError::StorageUnavailable)?;
        Ok(root)
    }

    fn validate_root(&self, root: &Path, create: bool) -> Result<PathBuf, LocalMusicError> {
        let parent = root.parent().ok_or(LocalMusicError::StorageUnavailable)?;
        if !parent.is_dir() {
            return Err(LocalMusicError::StorageUnavailable);
        }
        if create && !root.exists() {
            fs::create_dir(root).map_err(|_| LocalMusicError::StorageUnavailable)?;
        }
        let metadata =
            fs::symlink_metadata(root).map_err(|_| LocalMusicError::StorageUnavailable)?;
        if !metadata.file_type().is_dir() || is_reparse_point(&metadata) {
            return Err(LocalMusicError::StorageUnavailable);
        }
        fs::canonicalize(root).map_err(|_| LocalMusicError::StorageUnavailable)
    }

    fn cleanup_temporary_files(&self, root: &Path) {
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(OsStr::to_str) else {
                continue;
            };
            if (is_controlled_temporary_name(name) || is_controlled_tombstone_name(name))
                && entry
                    .metadata()
                    .ok()
                    .filter(|metadata| metadata.is_file() && !is_reparse_point(metadata))
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                    .is_some_and(|age| age >= TEMPORARY_FILE_MAX_AGE)
            {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn current_exe_local_music_root() -> Result<PathBuf, LocalMusicError> {
    let executable = std::env::current_exe().map_err(|_| LocalMusicError::StorageUnavailable)?;
    let parent = executable
        .parent()
        .ok_or(LocalMusicError::StorageUnavailable)?;
    Ok(parent.join("local-music"))
}

enum ImportOutcome {
    Imported(LocalMusicTrack),
    Existing,
}

struct InspectedAudio {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_ms: u64,
    ogg_codec: Option<OggCodec>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OggCodec {
    Vorbis,
    Opus,
}

fn inspect_audio(
    path: &Path,
    expected: LocalMusicFormat,
) -> Result<InspectedAudio, LocalMusicError> {
    let tagged = Probe::open(path)
        .map_err(|_| LocalMusicError::MetadataUnreadable)?
        .guess_file_type()
        .map_err(|_| LocalMusicError::MetadataUnreadable)?
        .read()
        .map_err(|_| LocalMusicError::MetadataUnreadable)?;
    let file_type = tagged.file_type();
    if !expected.matches_file_type(file_type) {
        return Err(LocalMusicError::UnsupportedFormat);
    }
    let duration = tagged.properties().duration().as_millis();
    let duration_ms = u64::try_from(duration).map_err(|_| LocalMusicError::MetadataUnreadable)?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    Ok(InspectedAudio {
        title: tag
            .and_then(|value| value.title())
            .map(|value| value.into_owned())
            .and_then(non_empty_text),
        artist: tag
            .and_then(|value| value.artist())
            .map(|value| value.into_owned())
            .and_then(non_empty_text),
        album: tag
            .and_then(|value| value.album())
            .map(|value| value.into_owned())
            .and_then(non_empty_text),
        duration_ms,
        ogg_codec: match file_type {
            FileType::Vorbis => Some(OggCodec::Vorbis),
            FileType::Opus => Some(OggCodec::Opus),
            _ => None,
        },
    })
}

#[cfg(windows)]
fn ogg_codec_available(codec: OggCodec) -> bool {
    // SAFETY: the successful apartment initialization is balanced on this thread
    // after all temporary WinRT query objects have been dropped.
    if unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }.is_err() {
        return false;
    }
    let result = (|| {
        let subtype = match codec {
            OggCodec::Opus => CodecSubtypes::AudioFormatOpus().ok()?,
            OggCodec::Vorbis => HSTRING::from("{8D2FD10B-5841-4A6B-8905-588FEC1ADED9}"),
        };
        CodecQuery::new()
            .ok()?
            .FindAllAsync(CodecKind::Audio, CodecCategory::Decoder, &subtype)
            .ok()?
            .get()
            .ok()?
            .Size()
            .ok()
            .is_some_and(|count| count > 0)
            .then_some(())
    })()
    .is_some();
    // SAFETY: balances the successful RoInitialize above.
    unsafe { RoUninitialize() };
    result
}

#[cfg(not(windows))]
fn ogg_codec_available(_codec: OggCodec) -> bool {
    false
}

fn copy_and_hash(source: &Path, root: &Path) -> Result<[u8; 32], LocalMusicError> {
    let extension = source
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("audio");
    let part = root.join(format!(".{}.{}.part", Uuid::new_v4(), extension));
    let input = File::open(source).map_err(|_| LocalMusicError::CopyFailed)?;
    let mut reader = BufReader::new(input);
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part)
        .map_err(|_| LocalMusicError::CopyFailed)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    let mut copied = 0u64;
    let result = (|| -> io::Result<()> {
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            copied = copied.saturating_add(count as u64);
            if copied > MAX_AUDIO_BYTES {
                return Err(io::Error::other("audio file exceeds size limit"));
            }
            digest.update(&buffer[..count]);
            output.write_all(&buffer[..count])?;
        }
        output.sync_all()
    })();
    drop(output);
    if result.is_err() {
        let _ = fs::remove_file(&part);
        return Err(LocalMusicError::CopyFailed);
    }
    let digest: [u8; 32] = digest.finalize().into();
    let final_part = root.join(format!(".{}.part", hex_digest(&digest)));
    if final_part.exists() {
        let _ = fs::remove_file(&final_part);
    }
    fs::rename(&part, &final_part).map_err(|_| {
        let _ = fs::remove_file(&part);
        LocalMusicError::CopyFailed
    })?;
    Ok(digest)
}

fn hash_file(path: &Path) -> Result<[u8; 32], LocalMusicError> {
    let mut file =
        BufReader::new(File::open(path).map_err(|_| LocalMusicError::StorageUnavailable)?);
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| LocalMusicError::StorageUnavailable)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest.finalize().into())
}

fn part_path(root: &Path, id: &LocalTrackId) -> PathBuf {
    root.join(format!(".{}.part", hex_digest(&id.digest)))
}

fn tombstone_audio_name(id: &LocalTrackId, token: &str) -> String {
    format!(
        ".local-music-delete-{}.{}.{}.tombstone",
        hex_digest(&id.digest),
        id.format.extension(),
        token
    )
}

fn tombstone_sidecar_name(id: &LocalTrackId, token: &str) -> String {
    format!(
        ".local-music-delete-{}.metadata.json.{}.tombstone",
        hex_digest(&id.digest),
        token
    )
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn remove_part_files(root: &Path, id: &LocalTrackId) -> io::Result<()> {
    let path = part_path(root, id);
    if path.exists() {
        fs::remove_file(path)
    } else {
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sidecar {
    schema_version: u16,
    fallback_title: String,
}

fn write_sidecar(path: &Path, fallback_title: &str) -> Result<(), LocalMusicError> {
    if !valid_sidecar_title(fallback_title) {
        return Err(LocalMusicError::MetadataUnreadable);
    }
    let value = Sidecar {
        schema_version: SIDECAR_SCHEMA_VERSION,
        fallback_title: fallback_title.to_owned(),
    };
    let bytes = serde_json::to_vec(&value).map_err(|_| LocalMusicError::CopyFailed)?;
    if bytes.len() > MAX_SIDECAR_BYTES {
        return Err(LocalMusicError::MetadataUnreadable);
    }
    let temporary = path.with_file_name(format!(".{}.metadata.json.part", Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        if path.exists() {
            fs::remove_file(path)?;
        }
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
        return Err(LocalMusicError::CopyFailed);
    }
    Ok(())
}

fn read_sidecar(path: &Path) -> Result<String, LocalMusicError> {
    let metadata = fs::metadata(path).map_err(|_| LocalMusicError::MetadataUnreadable)?;
    if metadata.len() as usize > MAX_SIDECAR_BYTES {
        return Err(LocalMusicError::MetadataUnreadable);
    }
    let bytes = fs::read(path).map_err(|_| LocalMusicError::MetadataUnreadable)?;
    let sidecar: Sidecar =
        serde_json::from_slice(&bytes).map_err(|_| LocalMusicError::MetadataUnreadable)?;
    if sidecar.schema_version != SIDECAR_SCHEMA_VERSION {
        return Err(LocalMusicError::MetadataUnreadable);
    }
    if !valid_sidecar_title(&sidecar.fallback_title) {
        return Err(LocalMusicError::MetadataUnreadable);
    }
    let title = normalize_text(&sidecar.fallback_title, false);
    if title.is_empty() {
        return Err(LocalMusicError::MetadataUnreadable);
    }
    Ok(title)
}

fn valid_sidecar_title(value: &str) -> bool {
    !value.is_empty()
        && !value.chars().any(char::is_control)
        && !value.contains(['/', '\\'])
        && !value.contains("://")
        && value.len() <= MAX_TEXT_BYTES
}

fn parse_audio_name(name: &str) -> Option<(LocalTrackId, LocalMusicFormat)> {
    let (digest, extension) = name.rsplit_once('.')?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    let format = LocalMusicFormat::from_extension(extension)?;
    let id = LocalTrackId::from_str(&format!(
        "local_{}_{}",
        digest.to_ascii_lowercase(),
        format.extension()
    ))
    .ok()?;
    Some((id, format))
}

fn is_controlled_temporary_name(name: &str) -> bool {
    let name = name.strip_prefix('.').unwrap_or_default();
    if let Some(digest) = name.strip_suffix(".part") {
        if digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return true;
        }
        if let Some((uuid, extension)) = digest.rsplit_once('.') {
            return Uuid::parse_str(uuid).is_ok() && matches!(extension, "mp3" | "flac" | "ogg");
        }
        return false;
    }
    name.ends_with(".metadata.json.part")
        && Uuid::parse_str(name.trim_end_matches(".metadata.json.part")).is_ok()
}

fn is_controlled_tombstone_name(name: &str) -> bool {
    let Some(body) = name
        .strip_prefix(".local-music-delete-")
        .and_then(|value| value.strip_suffix(".tombstone"))
    else {
        return false;
    };
    let Some((prefix, token)) = body.rsplit_once('.') else {
        return false;
    };
    if Uuid::parse_str(token).is_err() {
        return false;
    }
    let Some((digest, suffix)) = prefix.split_once('.') else {
        return false;
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return false;
    }
    matches!(suffix, "mp3" | "flac" | "ogg" | "metadata.json")
}

fn normalize_text(value: &str, allow_empty: bool) -> String {
    let value = value
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    let value = truncate_utf8_bytes(&value, MAX_TEXT_BYTES);
    if !allow_empty && value.is_empty() {
        "本地音频".to_owned()
    } else {
        value
    }
}

fn truncate_utf8_bytes(value: &str, maximum: usize) -> String {
    if value.len() <= maximum {
        return value.to_owned();
    }
    let mut end = maximum;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn non_empty_text(value: String) -> Option<String> {
    let value = normalize_text(&value, true);
    (!value.is_empty()).then_some(value)
}

fn safe_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(OsStr::to_str)
        .map(|value| normalize_text(value, false))
        .unwrap_or_else(|| "音频文件".to_owned())
}

fn hex_digest(digest: &[u8; 32]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_value(value: u8) -> u8 {
    match value {
        b'0'..=b'9' => value - b'0',
        b'a'..=b'f' => value - b'a' + 10,
        b'A'..=b'F' => value - b'A' + 10,
        _ => 0,
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn local_track_id_is_strict_and_round_trips() {
        let value = "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_flac";
        let id = LocalTrackId::parse(value).expect("valid local ID");
        assert_eq!(id.as_string(), value);
        for invalid in [
            "local_bad_flac",
            "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789ABCDE_flac",
            "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_FLAC",
            "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_wav",
            "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_flac_extra",
            "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_flac/../x",
        ] {
            assert_eq!(
                LocalTrackId::parse(invalid),
                Err(LocalMusicError::InvalidTrackId)
            );
        }
    }

    #[test]
    fn sidecar_is_exact_and_redacted() {
        let root = std::env::temp_dir().join(format!("qqmusic-local-sidecar-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("root");
        let path = root.join("hash.metadata.json");
        write_sidecar(&path, "  fallback title  ").expect("write sidecar");
        assert_eq!(read_sidecar(&path), Ok("fallback title".to_owned()));
        fs::write(
            &path,
            br#"{"schema_version":1,"fallback_title":"x","path":"C:\\secret"}"#,
        )
        .expect("tamper sidecar");
        assert_eq!(
            read_sidecar(&path),
            Err(LocalMusicError::MetadataUnreadable)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn safe_file_name_never_returns_a_path() {
        let value = safe_file_name(Path::new("C:/Users/private/song.mp3"));
        assert_eq!(value, "song.mp3");
        assert!(!value.contains('/'));
    }

    #[test]
    fn normalized_metadata_respects_the_renderer_utf8_byte_limit() {
        let value = normalize_text(&"本地音乐".repeat(200), true);
        assert!(value.len() <= MAX_TEXT_BYTES);
        assert!(value.is_char_boundary(value.len()));
    }

    #[test]
    fn list_treats_an_uncreated_storage_root_as_empty() {
        let parent = std::env::temp_dir().join(format!("qqmusic-local-list-{}", Uuid::new_v4()));
        fs::create_dir_all(&parent).expect("parent");
        let result = LocalMusicService::new(parent.join("local-music"))
            .list()
            .expect("missing root is an empty library");
        assert!(result.tracks.is_empty());
        assert_eq!(result.warning_count, 0);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn prepared_delete_rolls_back_audio_and_sidecar() {
        let root = std::env::temp_dir().join(format!("qqmusic-local-delete-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("root");
        let service = LocalMusicService::new(root.clone());
        let id = LocalTrackId::parse(
            "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_flac",
        )
        .expect("id");
        let audio = root.join(id.filename());
        let sidecar = root.join(id.sidecar_filename());
        fs::write(&audio, b"audio").expect("audio");
        write_sidecar(&sidecar, "fallback").expect("sidecar");

        let guard = service.prepare_delete(&id.as_string()).expect("prepare");
        assert!(!audio.exists());
        assert!(!sidecar.exists());
        assert!(fs::read_dir(&root)
            .expect("entries")
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_str()
                .is_some_and(is_controlled_tombstone_name)));
        guard.rollback().expect("rollback");
        assert_eq!(fs::read(&audio).expect("audio restored"), b"audio");
        assert_eq!(read_sidecar(&sidecar), Ok("fallback".to_owned()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prepared_delete_commit_removes_audio_without_sidecar() {
        let root = std::env::temp_dir().join(format!("qqmusic-local-delete-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("root");
        let service = LocalMusicService::new(root.clone());
        let id = LocalTrackId::parse(
            "local_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789_mp3",
        )
        .expect("id");
        let audio = root.join(id.filename());
        fs::write(&audio, b"audio").expect("audio");
        service
            .prepare_delete(&id.as_string())
            .expect("prepare")
            .commit()
            .expect("commit");
        assert!(!audio.exists());
        assert!(!fs::read_dir(&root)
            .expect("entries")
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_str()
                .is_some_and(is_controlled_tombstone_name)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tombstone_cleanup_pattern_does_not_match_unknown_files() {
        let token = Uuid::new_v4().to_string();
        let valid = format!(
            ".local-music-delete-{}.flac.{}.tombstone",
            "0".repeat(64),
            token
        );
        assert!(is_controlled_tombstone_name(&valid));
        assert!(!is_controlled_tombstone_name(
            ".local-music-delete-secret.flac.tombstone"
        ));
        assert!(!is_controlled_tombstone_name(".user-file.tombstone"));
    }
}
