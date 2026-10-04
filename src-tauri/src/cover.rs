use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};

use reqwest::blocking::Client;
use serde::Serialize;
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

use crate::network_policy::{DnsResolver, RemoteUrlPurpose, SystemDnsResolver, TrustedRemoteUrl};

pub const MAX_COVER_BYTES: usize = 2 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CACHE_FILES: usize = 256;
const MAX_REDIRECTS: usize = 3;
const CACHE_EXTENSION: &str = "cover";
const ALBUM_COVER_URL_PREFIX: &str = "https://y.gtimg.cn/music/photo_new/T002R300x300M000";
const ARTIST_COVER_URL_PREFIX: &str = "https://y.gtimg.cn/music/photo_new/T001R300x300M000";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CoverKind {
    Album,
    Artist,
}

impl CoverKind {
    const fn cache_namespace(self) -> &'static str {
        match self {
            Self::Album => "album",
            Self::Artist => "artist",
        }
    }

    const fn url_prefix(self) -> &'static str {
        match self {
            Self::Album => ALBUM_COVER_URL_PREFIX,
            Self::Artist => ARTIST_COVER_URL_PREFIX,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoverError {
    InvalidKey,
    UnsafeUrl,
    NetworkUnavailable,
    RedirectRejected,
    CoverUnavailable,
    UnsupportedImage,
    ImageTooLarge,
    CacheUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverPayload {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct CoverResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub location: Option<String>,
    pub body: Vec<u8>,
}

pub trait CoverTransport: Send + Sync {
    fn fetch(&self, url: &Url) -> Result<CoverResponse, CoverError>;
}

struct ReqwestCoverTransport {
    client: Client,
}

impl ReqwestCoverTransport {
    fn new() -> Result<Self, CoverError> {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map(|client| Self { client })
            .map_err(|_| CoverError::NetworkUnavailable)
    }
}

impl CoverTransport for ReqwestCoverTransport {
    fn fetch(&self, url: &Url) -> Result<CoverResponse, CoverError> {
        let response = self
            .client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "image/jpeg,image/png,image/webp")
            .send()
            .map_err(|_| CoverError::NetworkUnavailable)?;
        let status = response.status().as_u16();
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);

        if (300..400).contains(&status) {
            return Ok(CoverResponse {
                status,
                content_type,
                location,
                body: Vec::new(),
            });
        }

        if response
            .content_length()
            .is_some_and(|length| length > MAX_COVER_BYTES as u64)
        {
            return Err(CoverError::ImageTooLarge);
        }

        let mut body = Vec::new();
        response
            .take((MAX_COVER_BYTES + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|_| CoverError::NetworkUnavailable)?;
        if body.len() > MAX_COVER_BYTES {
            return Err(CoverError::ImageTooLarge);
        }

        Ok(CoverResponse {
            status,
            content_type,
            location,
            body,
        })
    }
}

pub struct CoverService {
    cache_root: PathBuf,
    resolver: Arc<dyn DnsResolver>,
    transport: Arc<dyn CoverTransport>,
}

impl CoverService {
    pub fn new(cache_root: PathBuf) -> Result<Self, CoverError> {
        let transport = Arc::new(ReqwestCoverTransport::new()?);
        Self::with_parts(cache_root, Arc::new(SystemDnsResolver), transport)
    }

    pub fn with_parts(
        cache_root: PathBuf,
        resolver: Arc<dyn DnsResolver>,
        transport: Arc<dyn CoverTransport>,
    ) -> Result<Self, CoverError> {
        fs::create_dir_all(&cache_root).map_err(|_| CoverError::CacheUnavailable)?;
        if !cache_root.is_dir() {
            return Err(CoverError::CacheUnavailable);
        }
        Ok(Self {
            cache_root,
            resolver,
            transport,
        })
    }

    pub fn get(&self, raw_key: &str) -> Result<CoverPayload, CoverError> {
        self.get_with_kind(CoverKind::Album, raw_key)
    }

    pub fn get_artist(&self, raw_key: &str) -> Result<CoverPayload, CoverError> {
        self.get_with_kind(CoverKind::Artist, raw_key)
    }

    fn get_with_kind(&self, kind: CoverKind, raw_key: &str) -> Result<CoverPayload, CoverError> {
        let key = validate_cache_key(raw_key)?;
        let cache_path = self.cache_path(kind, key);
        if cache_path.is_file() {
            match read_cached(&cache_path) {
                Ok(payload) => {
                    touch(&cache_path);
                    return Ok(payload);
                }
                Err(CoverError::UnsupportedImage | CoverError::ImageTooLarge) => {
                    let _ = fs::remove_file(&cache_path);
                }
                Err(error) => return Err(error),
            }
        }

        let mut target = self.trusted_url(kind, key)?;
        for redirect_count in 0..=MAX_REDIRECTS {
            let response = self.transport.fetch(target.expose_to_trusted_backend())?;
            if (200..300).contains(&response.status) {
                let payload = validate_image(response.content_type.as_deref(), response.body)?;
                self.write_cached(kind, key, &payload)?;
                self.prune_cache();
                return Ok(payload);
            }
            if (300..400).contains(&response.status) {
                if redirect_count == MAX_REDIRECTS {
                    return Err(CoverError::RedirectRejected);
                }
                let location = response.location.ok_or(CoverError::RedirectRejected)?;
                let next = target
                    .expose_to_trusted_backend()
                    .join(&location)
                    .map_err(|_| CoverError::RedirectRejected)?;
                target = TrustedRemoteUrl::validate(
                    next.as_str(),
                    RemoteUrlPurpose::Cover,
                    self.resolver.as_ref(),
                )
                .map_err(|_| CoverError::RedirectRejected)?;
                continue;
            }
            return Err(CoverError::CoverUnavailable);
        }
        Err(CoverError::RedirectRejected)
    }

    pub fn clear(&self) -> Result<(), CoverError> {
        let entries = match fs::read_dir(&self.cache_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(CoverError::CacheUnavailable),
        };
        for entry in entries {
            let entry = entry.map_err(|_| CoverError::CacheUnavailable)?;
            let path = entry.path();
            if path.is_file()
                && path.extension().and_then(|value| value.to_str()) == Some(CACHE_EXTENSION)
            {
                fs::remove_file(path).map_err(|_| CoverError::CacheUnavailable)?;
            }
        }
        Ok(())
    }

    fn trusted_url(&self, kind: CoverKind, key: &str) -> Result<TrustedRemoteUrl, CoverError> {
        let value = format!("{}{key}.jpg", kind.url_prefix());
        TrustedRemoteUrl::validate(&value, RemoteUrlPurpose::Cover, self.resolver.as_ref())
            .map_err(|_| CoverError::UnsafeUrl)
    }

    fn cache_path(&self, kind: CoverKind, key: &str) -> PathBuf {
        let mut digest = Sha256::new();
        digest.update(kind.cache_namespace().as_bytes());
        digest.update(b":");
        digest.update(key.as_bytes());
        let name = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        self.cache_root.join(format!("{name}.{CACHE_EXTENSION}"))
    }

    fn write_cached(
        &self,
        kind: CoverKind,
        key: &str,
        payload: &CoverPayload,
    ) -> Result<(), CoverError> {
        let destination = self.cache_path(kind, key);
        let temporary = self.cache_root.join(format!(
            ".{}.{}.tmp",
            destination
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("cover"),
            Uuid::new_v4()
        ));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| CoverError::CacheUnavailable)?;
            file.write_all(&payload.bytes)
                .map_err(|_| CoverError::CacheUnavailable)?;
            file.sync_all().map_err(|_| CoverError::CacheUnavailable)?;
            if destination.exists() {
                fs::remove_file(&destination).map_err(|_| CoverError::CacheUnavailable)?;
            }
            fs::rename(&temporary, &destination).map_err(|_| CoverError::CacheUnavailable)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn prune_cache(&self) {
        let Ok(entries) = fs::read_dir(&self.cache_root) else {
            return;
        };
        let mut files = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                if !path.is_file()
                    || path.extension().and_then(|value| value.to_str()) != Some(CACHE_EXTENSION)
                {
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
            if fs::remove_file(path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
    }
}

fn validate_cache_key(value: &str) -> Result<&str, CoverError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(CoverError::InvalidKey);
    }
    Ok(value)
}

fn read_cached(path: &Path) -> Result<CoverPayload, CoverError> {
    let bytes = fs::read(path).map_err(|_| CoverError::CacheUnavailable)?;
    validate_image(None, bytes)
}

fn validate_image(content_type: Option<&str>, bytes: Vec<u8>) -> Result<CoverPayload, CoverError> {
    if bytes.len() > MAX_COVER_BYTES {
        return Err(CoverError::ImageTooLarge);
    }
    let mime_type = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return Err(CoverError::UnsupportedImage);
    };
    if let Some(content_type) = content_type {
        let normalized = content_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let matches =
            normalized == mime_type || (mime_type == "image/jpeg" && normalized == "image/jpg");
        if !matches {
            return Err(CoverError::UnsupportedImage);
        }
    }
    Ok(CoverPayload {
        mime_type: mime_type.to_owned(),
        bytes,
    })
}

fn touch(path: &Path) {
    if let Ok(file) = OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

#[cfg(test)]
mod tests {
    use std::{
        net::{IpAddr, Ipv4Addr},
        sync::{Arc, Mutex},
    };

    use super::*;

    struct PublicResolver;

    impl DnsResolver for PublicResolver {
        fn resolve(
            &self,
            _host: &str,
            _port: u16,
        ) -> Result<Vec<IpAddr>, crate::network_policy::RemoteUrlError> {
            Ok(vec![IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))])
        }
    }

    struct FakeTransport {
        responses: Mutex<Vec<CoverResponse>>,
        calls: Mutex<Vec<String>>,
    }

    impl FakeTransport {
        fn new(responses: Vec<CoverResponse>) -> Self {
            Self {
                responses: Mutex::new(responses),
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    impl CoverTransport for FakeTransport {
        fn fetch(&self, url: &Url) -> Result<CoverResponse, CoverError> {
            self.calls.lock().expect("calls").push(url.to_string());
            self.responses
                .lock()
                .expect("responses")
                .pop()
                .ok_or(CoverError::NetworkUnavailable)
        }
    }

    fn root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("qqmusic-cover-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("cover root");
        path
    }

    fn jpeg_response() -> CoverResponse {
        CoverResponse {
            status: 200,
            content_type: Some("image/jpeg".to_owned()),
            location: None,
            body: vec![0xff, 0xd8, 0xff, 0xd9],
        }
    }

    #[test]
    fn validates_key_downloads_and_reuses_cached_image() {
        let root = root("cache");
        let transport = Arc::new(FakeTransport::new(vec![jpeg_response()]));
        let service =
            CoverService::with_parts(root.clone(), Arc::new(PublicResolver), transport.clone())
                .expect("service");
        let first = service.get("album-mid-1").expect("first cover");
        let second = service.get("album-mid-1").expect("cached cover");
        assert_eq!(first, second);
        assert_eq!(transport.calls.lock().expect("calls").len(), 1);
        assert!(fs::read_dir(&root).expect("cache entries").count() >= 1);
        assert_eq!(service.get("bad/key"), Err(CoverError::InvalidKey));
        service.clear().expect("clear cache");
        assert_eq!(fs::read_dir(&root).expect("cache entries").count(), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn separates_album_and_artist_cache_namespaces_and_urls() {
        let root = root("artist-kind");
        let transport = Arc::new(FakeTransport::new(vec![jpeg_response(), jpeg_response()]));
        let service =
            CoverService::with_parts(root.clone(), Arc::new(PublicResolver), transport.clone())
                .expect("service");

        service.get("shared-mid").expect("album cover");
        service.get_artist("shared-mid").expect("artist portrait");

        let calls = transport.calls.lock().expect("calls");
        assert_eq!(calls.len(), 2);
        assert!(calls[0].contains("/T002R300x300M000shared-mid.jpg"));
        assert!(calls[1].contains("/T001R300x300M000shared-mid.jpg"));
        assert_eq!(fs::read_dir(&root).expect("cache entries").count(), 2);
        drop(calls);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_bad_image_and_redirect_to_untrusted_host() {
        let root = root("reject");
        let bad_image = Arc::new(FakeTransport::new(vec![CoverResponse {
            status: 200,
            content_type: Some("image/jpeg".to_owned()),
            location: None,
            body: b"not an image".to_vec(),
        }]));
        let service = CoverService::with_parts(root.clone(), Arc::new(PublicResolver), bad_image)
            .expect("service");
        assert_eq!(
            service.get("album-mid-1"),
            Err(CoverError::UnsupportedImage)
        );

        let redirect = Arc::new(FakeTransport::new(vec![CoverResponse {
            status: 302,
            content_type: None,
            location: Some("https://example.com/cover.jpg".to_owned()),
            body: Vec::new(),
        }]));
        let service = CoverService::with_parts(root.clone(), Arc::new(PublicResolver), redirect)
            .expect("service");
        assert_eq!(
            service.get("album-mid-2"),
            Err(CoverError::RedirectRejected)
        );
        let _ = fs::remove_dir_all(root);
    }
}
