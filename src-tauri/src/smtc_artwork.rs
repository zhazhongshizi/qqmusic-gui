use std::{
    fs::{self, OpenOptions},
    io::{BufReader, Cursor, Write},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, Weak},
    thread::{self, JoinHandle},
    time::SystemTime,
};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{cover::CoverService, playback::PlaybackController, player::SmtcArtwork};

const MAX_CACHE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CACHE_FILES: usize = 32;
const MAX_SMTC_ARTWORK_BYTES: usize = 2 * 1024 * 1024;
const MAX_SMTC_ARTWORK_DIMENSION: u32 = 1024;
const MAX_SMTC_ARTWORK_PIXELS: u64 = 1_048_576;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SmtcArtworkCacheError {
    Unavailable,
    InvalidArtwork,
}

/// Stable, format-aware files used by Windows Shell's delayed thumbnail reader.
pub(crate) struct SmtcArtworkFileCache {
    root: PathBuf,
    available: bool,
    protected: Mutex<Option<PathBuf>>,
}

impl SmtcArtworkFileCache {
    pub(crate) fn from_current_exe() -> Result<Self, SmtcArtworkCacheError> {
        let executable = std::env::current_exe().map_err(|_| SmtcArtworkCacheError::Unavailable)?;
        let root = smtc_cache_root_from_executable(&executable)
            .ok_or(SmtcArtworkCacheError::Unavailable)?;
        Self::with_root(root)
    }

    pub(crate) fn with_root(root: PathBuf) -> Result<Self, SmtcArtworkCacheError> {
        fs::create_dir_all(&root).map_err(|_| SmtcArtworkCacheError::Unavailable)?;
        if !root.is_dir() {
            return Err(SmtcArtworkCacheError::Unavailable);
        }
        Ok(Self {
            root,
            available: true,
            protected: Mutex::new(None),
        })
    }

    fn disabled() -> Self {
        Self {
            root: PathBuf::new(),
            available: false,
            protected: Mutex::new(None),
        }
    }

    pub(crate) fn materialize(
        &self,
        artwork: &SmtcArtwork,
    ) -> Result<crate::player::SmtcArtworkFile, SmtcArtworkCacheError> {
        if !self.available {
            return Err(SmtcArtworkCacheError::Unavailable);
        }
        let artwork = normalize_for_smtc(artwork)?;
        let extension = match artwork.mime_type() {
            "image/jpeg" => "jpg",
            "image/png" => "png",
            _ => return Err(SmtcArtworkCacheError::InvalidArtwork),
        };
        let mut digest = Sha256::new();
        digest.update(artwork.bytes());
        let hash = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let destination = self.root.join(format!("{hash}.{extension}"));
        let valid_existing = fs::read(&destination)
            .ok()
            .and_then(|bytes| SmtcArtwork::new(artwork.mime_type().to_owned(), bytes).ok())
            .is_some_and(|existing| existing.bytes() == artwork.bytes());
        if !valid_existing {
            let temporary = self.root.join(format!(".{hash}.{}.tmp", Uuid::new_v4()));
            let result = (|| {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)
                    .map_err(|_| SmtcArtworkCacheError::Unavailable)?;
                file.write_all(artwork.bytes())
                    .map_err(|_| SmtcArtworkCacheError::Unavailable)?;
                file.sync_all()
                    .map_err(|_| SmtcArtworkCacheError::Unavailable)?;
                if destination.exists() {
                    fs::remove_file(&destination)
                        .map_err(|_| SmtcArtworkCacheError::Unavailable)?;
                }
                fs::rename(&temporary, &destination).map_err(|_| SmtcArtworkCacheError::Unavailable)
            })();
            if result.is_err() {
                let _ = fs::remove_file(&temporary);
                return Err(SmtcArtworkCacheError::Unavailable);
            }
        }
        touch(&destination);
        self.prune();
        crate::player::SmtcArtworkFile::new(artwork.mime_type().to_owned(), destination)
            .map_err(|_| SmtcArtworkCacheError::Unavailable)
    }

    pub(crate) fn protect(&self, path: &Path) {
        if let Ok(mut protected) = self.protected.lock() {
            *protected = Some(path.to_owned());
        }
    }

    pub(crate) fn clear_protected(&self) {
        if let Ok(mut protected) = self.protected.lock() {
            *protected = None;
        }
    }

    pub(crate) fn clear_all(&self) {
        self.clear_protected();
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let _ = fs::remove_file(path);
            }
        }
    }

    fn prune(&self) {
        if !self.available {
            return;
        }
        let protected = self.protected.lock().ok().and_then(|value| value.clone());
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        let mut files = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                let extension = path.extension().and_then(|value| value.to_str());
                if !path.is_file() || !matches!(extension, Some("jpg" | "png" | "webp")) {
                    return None;
                }
                let metadata = entry.metadata().ok()?;
                Some((
                    path,
                    metadata.len(),
                    metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                ))
            })
            .collect::<Vec<_>>();
        let mut total = files.iter().map(|(_, size, _)| *size).sum::<u64>();
        files.sort_by_key(|(_, _, modified)| *modified);
        while total > MAX_CACHE_BYTES || files.len() > MAX_CACHE_FILES {
            let Some((path, size, _)) = files.first().cloned() else {
                break;
            };
            files.remove(0);
            if protected.as_deref() == Some(path.as_path()) {
                files.push((path, size, SystemTime::now()));
                continue;
            }
            if fs::remove_file(path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
    }
}

fn normalize_for_smtc(artwork: &SmtcArtwork) -> Result<SmtcArtwork, SmtcArtworkCacheError> {
    if artwork.mime_type() != "image/webp" {
        return Ok(artwork.clone());
    }

    use image::{codecs::webp::WebPDecoder, DynamicImage, ImageDecoder, ImageFormat};

    let decoder = WebPDecoder::new(BufReader::new(Cursor::new(artwork.bytes())))
        .map_err(|_| SmtcArtworkCacheError::InvalidArtwork)?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > MAX_SMTC_ARTWORK_DIMENSION
        || height > MAX_SMTC_ARTWORK_DIMENSION
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_SMTC_ARTWORK_PIXELS
    {
        return Err(SmtcArtworkCacheError::InvalidArtwork);
    }
    let image =
        DynamicImage::from_decoder(decoder).map_err(|_| SmtcArtworkCacheError::InvalidArtwork)?;
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| SmtcArtworkCacheError::InvalidArtwork)?;
    let bytes = output.into_inner();
    if bytes.len() > MAX_SMTC_ARTWORK_BYTES {
        return Err(SmtcArtworkCacheError::InvalidArtwork);
    }
    SmtcArtwork::new("image/png".to_owned(), bytes)
        .map_err(|_| SmtcArtworkCacheError::InvalidArtwork)
}

fn smtc_cache_root_from_executable(executable: &Path) -> Option<PathBuf> {
    executable
        .parent()
        .map(|parent| parent.join("cover-cache").join("smtc"))
}

fn touch(path: &Path) {
    if let Ok(file) = OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

/// A narrow boundary between queue/session lifecycle and the native SMTC artwork worker.
pub(crate) trait SmtcArtworkPort: Send + Sync {
    fn request(&self, generation: u64, cover_cache_key: Option<String>);
    fn clear(&self);
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ArtworkRequest {
    generation: u64,
    cover_cache_key: String,
    epoch: u64,
}

#[derive(Default)]
struct CoordinatorState {
    pending: Option<ArtworkRequest>,
    epoch: u64,
    stopped: bool,
}

impl CoordinatorState {
    fn queue(&mut self, generation: u64, cover_cache_key: String) -> u64 {
        self.epoch = self.epoch.wrapping_add(1);
        self.pending = Some(ArtworkRequest {
            generation,
            cover_cache_key,
            epoch: self.epoch,
        });
        self.epoch
    }

    fn cancel(&mut self) -> u64 {
        self.epoch = self.epoch.wrapping_add(1);
        self.pending = None;
        self.epoch
    }

    fn request_is_current(&self, request: &ArtworkRequest) -> bool {
        !self.stopped && self.epoch == request.epoch && self.pending.is_none()
    }
}

struct SharedState {
    state: Mutex<CoordinatorState>,
    wake: Condvar,
}

/// Latest-wins cover loader. It never owns the playback controller, avoiding an
/// Arc cycle while still allowing an in-flight request to be discarded safely.
pub(crate) struct SmtcArtworkCoordinator {
    shared: Arc<SharedState>,
    playback: Weak<PlaybackController>,
    cache: Arc<SmtcArtworkFileCache>,
    worker: Option<JoinHandle<()>>,
}

impl SmtcArtworkCoordinator {
    pub(crate) fn new(cover: Arc<CoverService>, playback: Weak<PlaybackController>) -> Arc<Self> {
        let cache = SmtcArtworkFileCache::from_current_exe()
            .ok()
            .map(Arc::new)
            .unwrap_or_else(|| Arc::new(SmtcArtworkFileCache::disabled()));
        Self::with_cache(cover, playback, cache)
    }

    pub(crate) fn with_cache(
        cover: Arc<CoverService>,
        playback: Weak<PlaybackController>,
        cache: Arc<SmtcArtworkFileCache>,
    ) -> Arc<Self> {
        let shared = Arc::new(SharedState {
            state: Mutex::new(CoordinatorState::default()),
            wake: Condvar::new(),
        });
        let worker_shared = Arc::clone(&shared);
        let worker_playback = playback.clone();
        let worker_cache = cache.clone();
        let worker = thread::Builder::new()
            .name("qqmusic-smtc-artwork".to_owned())
            .spawn(move || artwork_loop(worker_shared, cover, worker_playback, worker_cache))
            .ok();
        Arc::new(Self {
            shared,
            playback,
            cache,
            worker,
        })
    }

    pub(crate) fn clear(&self) {
        let epoch = {
            let mut state = self
                .shared
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.cancel()
        };
        self.shared.wake.notify_one();
        if let Some(playback) = self.playback.upgrade() {
            let generation = playback.snapshot().generation;
            let _ = playback.clear_smtc_artwork(generation, epoch);
        }
        self.cache.clear_protected();
    }

    pub(crate) fn clear_for_logout(&self) {
        self.clear();
        self.cache.clear_all();
    }
}

impl SmtcArtworkPort for SmtcArtworkCoordinator {
    fn request(&self, generation: u64, cover_cache_key: Option<String>) {
        let Some(cover_cache_key) = cover_cache_key else {
            self.clear();
            return;
        };
        {
            let mut state = self
                .shared
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.stopped {
                return;
            }
            state.queue(generation, cover_cache_key);
        }
        self.shared.wake.notify_one();
    }

    fn clear(&self) {
        SmtcArtworkCoordinator::clear(self);
    }
}

impl Drop for SmtcArtworkCoordinator {
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

fn artwork_loop(
    shared: Arc<SharedState>,
    cover: Arc<CoverService>,
    playback: Weak<PlaybackController>,
    cache: Arc<SmtcArtworkFileCache>,
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
        let payload = match cover.get(&request.cover_cache_key) {
            Ok(payload) => payload,
            Err(_) => {
                #[cfg(debug_assertions)]
                eprintln!(
                    "[smtc-artwork] cover unavailable generation={} epoch={}",
                    request.generation, request.epoch
                );
                continue;
            }
        };
        let still_current = {
            let state = shared
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.request_is_current(&request)
        };
        if !still_current {
            continue;
        }
        let Some(playback) = playback.upgrade() else {
            return;
        };
        if playback.snapshot().generation != request.generation {
            continue;
        }
        if let Ok(artwork) = SmtcArtwork::new(payload.mime_type, payload.bytes) {
            #[cfg(debug_assertions)]
            eprintln!(
                "[smtc-artwork] cover ready generation={} epoch={}",
                request.generation, request.epoch
            );
            let Ok(file) = cache.materialize(&artwork) else {
                continue;
            };
            let still_current = {
                let state = shared
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                state.request_is_current(&request)
            };
            if !still_current || playback.snapshot().generation != request.generation {
                continue;
            }
            if playback
                .set_smtc_artwork(request.generation, request.epoch, file.clone())
                .is_ok()
            {
                cache.protect(file.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_artwork(mime_type: &str, seed: u8) -> SmtcArtwork {
        let bytes = match mime_type {
            "image/jpeg" => vec![0xff, 0xd8, 0xff, seed, 0xd9],
            "image/png" => vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed],
            _ => panic!("unsupported test MIME"),
        };
        SmtcArtwork::new(mime_type.to_owned(), bytes).expect("test artwork")
    }

    fn encoded_webp(width: u32, height: u32, pixels: &[u8]) -> Vec<u8> {
        use image::{codecs::webp::WebPEncoder, ExtendedColorType, ImageEncoder};

        let mut output = Cursor::new(Vec::new());
        WebPEncoder::new_lossless(&mut output)
            .write_image(pixels, width, height, ExtendedColorType::Rgba8)
            .expect("encode WebP fixture");
        output.into_inner()
    }

    #[test]
    fn cache_root_is_derived_only_from_executable_parent() {
        let executable = PathBuf::from(r"C:\Program Files\QQ Music\qqmusic-gui.exe");
        assert_eq!(
            smtc_cache_root_from_executable(&executable),
            Some(PathBuf::from(r"C:\Program Files\QQ Music\cover-cache\smtc"))
        );
        assert!(!smtc_cache_root_from_executable(&executable)
            .expect("cache root")
            .to_string_lossy()
            .contains("AppData"));
    }

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("qqmusic-smtc-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("cache root");
        root
    }

    #[test]
    fn latest_slot_replacement_and_cancel_invalidate_older_requests() {
        let mut state = CoordinatorState::default();
        let old_epoch = state.queue(1, "old".to_owned());
        let old = state.pending.clone().expect("old request");
        let new_epoch = state.queue(2, "new".to_owned());
        assert_eq!(state.pending.as_ref().map(|item| item.generation), Some(2));
        assert_eq!(
            state
                .pending
                .as_ref()
                .map(|item| item.cover_cache_key.as_str()),
            Some("new")
        );
        assert_eq!(old_epoch, 1);
        assert_eq!(new_epoch, 2);
        assert!(!state.request_is_current(&old));

        let current = state.pending.take().expect("current request");
        assert!(state.request_is_current(&current));
        assert_eq!(state.cancel(), 3);
        assert!(!state.request_is_current(&current));
        assert!(state.pending.is_none());
    }

    #[test]
    fn file_cache_uses_content_hash_and_format_extension() {
        let root = test_root("hash");
        let cache = SmtcArtworkFileCache::with_root(root.clone()).expect("file cache");
        let formats = [("image/jpeg", "jpg"), ("image/png", "png")];
        for (index, (mime_type, extension)) in formats.iter().enumerate() {
            let artwork = test_artwork(mime_type, index as u8 + 1);
            let file = cache.materialize(&artwork).expect("format file");
            assert_eq!(
                file.path().extension().and_then(|value| value.to_str()),
                Some(*extension)
            );
            assert_eq!(
                fs::read(file.path()).expect("cached bytes"),
                artwork.bytes()
            );
        }
        let artwork = test_artwork("image/jpeg", 1);
        let first = cache.materialize(&artwork).expect("first file");
        let second = cache.materialize(&artwork).expect("reused file");
        assert_eq!(first.path(), second.path());
        assert_eq!(
            first.path().extension().and_then(|value| value.to_str()),
            Some("jpg")
        );
        assert!(!first.path().to_string_lossy().contains("track"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn valid_webp_is_losslessly_materialized_as_png() {
        use image::{GenericImageView, ImageFormat};

        let pixels = [
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
        ];
        let webp = encoded_webp(2, 2, &pixels);
        assert!(webp.len() <= MAX_SMTC_ARTWORK_BYTES);
        let source = SmtcArtwork::new("image/webp".to_owned(), webp).expect("valid WebP");

        let normalized = normalize_for_smtc(&source).expect("normalize WebP");
        assert_eq!(normalized.mime_type(), "image/png");
        assert!(normalized.bytes().starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(normalized.bytes().len() <= MAX_SMTC_ARTWORK_BYTES);
        let decoded = image::load_from_memory_with_format(normalized.bytes(), ImageFormat::Png)
            .expect("decode normalized PNG");
        assert_eq!(decoded.dimensions(), (2, 2));
        assert_eq!(decoded.to_rgba8().as_raw(), &pixels);

        let root = test_root("webp-to-png");
        let cache = SmtcArtworkFileCache::with_root(root.clone()).expect("file cache");
        let first = cache.materialize(&source).expect("materialize PNG");
        let second = cache.materialize(&source).expect("reuse PNG");
        assert_eq!(first.path(), second.path());
        assert_eq!(
            first.path().extension().and_then(|value| value.to_str()),
            Some("png")
        );
        assert_eq!(
            fs::read(first.path()).expect("materialized PNG bytes"),
            normalized.bytes()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn damaged_or_oversized_webp_is_rejected_before_materialization() {
        let damaged = SmtcArtwork::new("image/webp".to_owned(), b"RIFF\0\0\0\0WEBP".to_vec())
            .expect("magic-only WebP passes the outer boundary");
        assert_eq!(
            normalize_for_smtc(&damaged),
            Err(SmtcArtworkCacheError::InvalidArtwork)
        );

        let pixels = vec![0_u8; (MAX_SMTC_ARTWORK_DIMENSION as usize + 1) * 4];
        let oversized = encoded_webp(MAX_SMTC_ARTWORK_DIMENSION + 1, 1, &pixels);
        assert!(oversized.len() <= MAX_SMTC_ARTWORK_BYTES);
        let oversized = SmtcArtwork::new("image/webp".to_owned(), oversized)
            .expect("valid oversized WebP fixture");
        assert_eq!(
            normalize_for_smtc(&oversized),
            Err(SmtcArtworkCacheError::InvalidArtwork)
        );
    }

    #[test]
    fn disabled_cache_does_not_fallback_when_materializing() {
        let cache = SmtcArtworkFileCache::disabled();
        assert_eq!(
            cache.materialize(&test_artwork("image/jpeg", 1)),
            Err(SmtcArtworkCacheError::Unavailable)
        );
    }

    #[test]
    fn file_cache_prunes_old_files_but_keeps_protected_path() {
        let root = test_root("prune");
        let cache = SmtcArtworkFileCache::with_root(root.clone()).expect("file cache");
        let protected = cache
            .materialize(&test_artwork("image/jpeg", 0))
            .expect("protected file");
        cache.protect(protected.path());
        for seed in 1..=32 {
            let _ = cache.materialize(&test_artwork("image/jpeg", seed));
        }
        let files = fs::read_dir(&root)
            .expect("entries")
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some())
            .count();
        assert!(files <= MAX_CACHE_FILES);
        assert!(protected.path().is_file());
        cache.clear_all();
        assert_eq!(fs::read_dir(&root).expect("entries").count(), 0);
        let _ = fs::remove_dir_all(root);
    }
}
