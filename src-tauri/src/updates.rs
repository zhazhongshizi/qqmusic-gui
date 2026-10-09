use rusqlite::Connection;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const RELEASES: &str = "https://github.com/zhazhongshizi/qqmusic-gui/releases";
pub const API: &str = "https://api.github.com/repos/zhazhongshizi/qqmusic-gui/releases/latest";
const MAX_RESPONSE: u64 = 512 * 1024;

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub name: String,
    pub notes: String,
    pub url: String,
    pub published_at: Option<String>,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    pub current_version: String,
    pub build_channel: &'static str,
    pub automatic: bool,
    pub state: &'static str,
    pub release: Option<Release>,
    pub checked_ms: Option<u64>,
    pub application_data: String,
    pub local_music: String,
    pub smart_shuffle: String,
    pub migration_backups: String,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum UpdateRequest {
    Status {},
    Check {},
    SetAutomatic { enabled: bool },
    OpenRelease {},
    OpenReleases {},
}
#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
}

pub fn parse_release(bytes: &[u8]) -> Result<Release, &'static str> {
    let raw: GitHubRelease =
        serde_json::from_slice(bytes).map_err(|_| "update_invalid_response")?;
    let version = Version::parse(raw.tag_name.strip_prefix('v').unwrap_or(&raw.tag_name))
        .map_err(|_| "update_invalid_response")?;
    if raw.draft || raw.prerelease || !version.pre.is_empty() {
        return Err("update_invalid_response");
    }
    let mut url = url::Url::parse(RELEASES).unwrap();
    url.path_segments_mut()
        .unwrap()
        .push("tag")
        .push(&raw.tag_name);
    if raw.html_url != url.as_str() {
        return Err("update_invalid_response");
    }
    let name = raw
        .name
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| raw.tag_name.clone());
    let notes = raw.body.unwrap_or_default();
    if name.len() > 512
        || notes.len() > 128 * 1024
        || raw.published_at.as_ref().is_some_and(|p| p.len() > 64)
    {
        return Err("update_invalid_response");
    }
    Ok(Release {
        version: version.to_string(),
        name,
        notes,
        url: url.to_string(),
        published_at: raw.published_at,
    })
}

pub fn newer(current: &str, latest: &str) -> Result<bool, &'static str> {
    let current = Version::parse(current).map_err(|_| "update_invalid_version")?;
    let latest = Version::parse(latest).map_err(|_| "update_invalid_version")?;
    Ok(latest.cmp_precedence(&current).is_gt())
}

fn preferences(path: &Path) -> Result<Connection, &'static str> {
    fs::create_dir_all(path.parent().ok_or("update_storage_unavailable")?)
        .map_err(|_| "update_storage_unavailable")?;
    let db = Connection::open(path).map_err(|_| "update_storage_unavailable")?;
    db.busy_timeout(Duration::from_secs(3))
        .map_err(|_| "update_storage_unavailable")?;
    let version: i64 = db
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|_| "update_storage_unavailable")?;
    if version > 1 {
        return Err("update_storage_unavailable");
    }
    db.execute_batch("CREATE TABLE IF NOT EXISTS update_preferences(id INTEGER PRIMARY KEY CHECK(id=1),automatic INTEGER NOT NULL CHECK(automatic IN (0,1))); INSERT OR IGNORE INTO update_preferences VALUES(1,0); PRAGMA user_version=1;").map_err(|_|"update_storage_unavailable")?;
    Ok(db)
}

pub struct UpdateService {
    snapshot: Mutex<UpdateSnapshot>,
    check_lock: Mutex<()>,
    preferences: PathBuf,
}
impl UpdateService {
    pub fn new(application_data: PathBuf, exe_directory: PathBuf) -> Self {
        let preferences_path = application_data.join("updates.sqlite3");
        let automatic = preferences(&preferences_path)
            .and_then(|db| {
                db.query_row(
                    "SELECT automatic FROM update_preferences WHERE id=1",
                    [],
                    |r| r.get(0),
                )
                .map_err(|_| "update_storage_unavailable")
            })
            .unwrap_or(false);
        Self {
            preferences: preferences_path,
            check_lock: Mutex::new(()),
            snapshot: Mutex::new(UpdateSnapshot {
                current_version: env!("CARGO_PKG_VERSION").into(),
                build_channel: if cfg!(debug_assertions) {
                    "Debug"
                } else {
                    "Release"
                },
                automatic,
                state: "idle",
                release: None,
                checked_ms: None,
                migration_backups: application_data
                    .join("migration-backups")
                    .to_string_lossy()
                    .into(),
                application_data: application_data.to_string_lossy().into(),
                local_music: exe_directory.join("local-music").to_string_lossy().into(),
                smart_shuffle: exe_directory
                    .join("smart-shuffle.sqlite3")
                    .to_string_lossy()
                    .into(),
            }),
        }
    }
    pub fn snapshot(&self) -> UpdateSnapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
    pub fn set_automatic(&self, enabled: bool) -> Result<UpdateSnapshot, &'static str> {
        let mut snapshot = self
            .snapshot
            .lock()
            .map_err(|_| "update_storage_unavailable")?;
        let db = preferences(&self.preferences)?;
        db.execute(
            "UPDATE update_preferences SET automatic=?1 WHERE id=1",
            [enabled],
        )
        .map_err(|_| "update_storage_unavailable")?;
        snapshot.automatic = enabled;
        Ok(snapshot.clone())
    }
    pub fn schedule_startup(self: &Arc<Self>) {
        let service = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(10));
            if service.snapshot().automatic {
                service.check();
            }
        });
    }
    pub fn check(&self) -> UpdateSnapshot {
        self.check_with(fetch_release)
    }
    fn check_with(&self, fetch: impl FnOnce() -> Result<Release, &'static str>) -> UpdateSnapshot {
        let Ok(_permit) = self.check_lock.try_lock() else {
            return self.snapshot();
        };
        {
            let mut s = self
                .snapshot
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            s.state = "checking";
        }
        let result = fetch();
        let mut s = self
            .snapshot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        s.checked_ms = Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        );
        match result {
            Ok(release) => {
                s.state = if newer(&s.current_version, &release.version).unwrap_or(false) {
                    "available"
                } else {
                    "upToDate"
                };
                s.release = Some(release);
            }
            Err(code) => {
                s.state = match code {
                    "update_no_release" => "noRelease",
                    "update_rate_limited" => "rateLimited",
                    _ => "unavailable",
                };
            }
        }
        s.clone()
    }
    pub fn control(&self, request: UpdateRequest) -> Result<UpdateSnapshot, &'static str> {
        match request {
            UpdateRequest::Status {} => {}
            UpdateRequest::Check {} => return Ok(self.check()),
            UpdateRequest::SetAutomatic { enabled } => return self.set_automatic(enabled),
            UpdateRequest::OpenRelease {} => {
                let url = self.snapshot().release.ok_or("update_no_release")?.url;
                open_page(&url)?;
            }
            UpdateRequest::OpenReleases {} => open_page(RELEASES)?,
        }
        Ok(self.snapshot())
    }
}

fn fetch_release() -> Result<Release, &'static str> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "update_network_unavailable")?;
    let response = client
        .get(API)
        .header(
            "User-Agent",
            concat!("QQMusic-GUI/", env!("CARGO_PKG_VERSION")),
        )
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|_| "update_network_unavailable")?;
    match response.status().as_u16() {
        200 => {}
        404 => return Err("update_no_release"),
        403 | 429 => return Err("update_rate_limited"),
        _ => return Err("update_network_unavailable"),
    }
    if response.content_length().is_some_and(|n| n > MAX_RESPONSE) {
        return Err("update_invalid_response");
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "update_network_unavailable")?;
    if bytes.len() as u64 > MAX_RESPONSE {
        return Err("update_invalid_response");
    }
    parse_release(&bytes)
}
fn open_page(value: &str) -> Result<(), &'static str> {
    // Only this service's official release pages may leave the WebView.
    let url = url::Url::parse(value).map_err(|_| "update_invalid_response")?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(value == RELEASES || value.starts_with(&format!("{RELEASES}/tag/")))
    {
        return Err("update_invalid_response");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let system = std::env::var_os("SystemRoot").ok_or("update_open_failed")?;
        std::process::Command::new(PathBuf::from(system).join("System32/rundll32.exe"))
            .arg("url.dll,FileProtocolHandler")
            .arg(value)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|_| "update_open_failed")?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("update_open_failed")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slow_check_does_not_block_status_or_launch_duplicate_requests() {
        let root = std::env::temp_dir().join(format!("qmg-updates-{}", uuid::Uuid::new_v4()));
        let service = Arc::new(UpdateService::new(root.clone(), root.clone()));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let worker_service = service.clone();
        let worker = std::thread::spawn(move || {
            worker_service.check_with(|| {
                started_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                parse_release(&payload("v999.0.0"))
            })
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(service.snapshot().state, "checking");
        assert_eq!(
            service
                .check_with(|| panic!("duplicate network request"))
                .state,
            "checking"
        );
        service.set_automatic(true).unwrap();
        finish_tx.send(()).unwrap();
        assert_eq!(worker.join().unwrap().state, "available");
        assert!(service.snapshot().automatic);
        drop(service);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "requires the live public GitHub API"]
    fn official_latest_release_live() {
        let release = fetch_release().expect("official public latest Release response");
        eprintln!(
            "official stable release: {} {}",
            release.version, release.url
        );
    }
    fn payload(tag: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"tag_name":tag,"name":"更新","body":"说明","html_url":format!("{RELEASES}/tag/{tag}"),"draft":false,"prerelease":false,"published_at":null})).unwrap()
    }
    #[test]
    fn semantic_versions_compare_numbers_and_prereleases() {
        assert!(newer("1.9.0", "1.10.0").unwrap());
        assert!(!newer("1.10.0", "1.9.0").unwrap());
        assert!(newer("1.1.0-beta.1", "1.1.0").unwrap());
        assert!(!newer("1.1.0+dev", "1.1.0").unwrap());
        assert!(newer("bad", "1.0.0").is_err());
    }
    #[test]
    fn only_stable_official_release_metadata_is_accepted() {
        assert_eq!(
            parse_release(&payload("v1.10.0")).unwrap().version,
            "1.10.0"
        );
        assert!(parse_release(&payload("v1.1.0-beta.1")).is_err());
        assert!(parse_release(&payload("not-a-version")).is_err());
        let mut v: serde_json::Value = serde_json::from_slice(&payload("v1.2.0")).unwrap();
        for field in ["draft", "prerelease"] {
            v[field] = true.into();
            assert!(parse_release(&serde_json::to_vec(&v).unwrap()).is_err());
            v[field] = false.into();
        }
        v["html_url"] = "https://example.com/release".into();
        assert!(parse_release(&serde_json::to_vec(&v).unwrap()).is_err());
    }
    #[test]
    fn preferences_survive_restart_and_offline_checks_do_not_change_them() {
        let root = std::env::temp_dir().join(format!("qmg-updates-{}", uuid::Uuid::new_v4()));
        let service = UpdateService::new(root.clone(), root.clone());
        assert!(!service.snapshot().automatic);
        service.set_automatic(true).unwrap();
        let again = UpdateService::new(root.clone(), root.clone());
        assert!(again.snapshot().automatic);
        assert_eq!(again.check_with(|| Err("offline")).state, "unavailable");
        assert!(again.snapshot().automatic);
        assert_eq!(
            again
                .check_with(|| parse_release(&payload("v999.0.0")))
                .state,
            "available"
        );
        assert_eq!(
            again.check_with(|| Err("update_rate_limited")).state,
            "rateLimited"
        );
        assert_eq!(
            again.check_with(|| Err("update_no_release")).state,
            "noRelease"
        );
        drop(service);
        drop(again);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unknown_requests_and_renderer_urls_are_rejected() {
        assert!(serde_json::from_str::<UpdateRequest>(
            r#"{"action":"openRelease","url":"https://evil.test"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<UpdateRequest>(r#"{"action":"install"}"#).is_err());
    }
}
