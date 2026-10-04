use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use uuid::Uuid;

const LOG_FORMAT_VERSION: u16 = 1;
const MAX_LOG_BYTES: u64 = 1_048_576;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Startup,
    Authentication,
    CatalogRead,
    LibraryWrite,
    LocalMusic,
    Playback,
    Persistence,
    Provider,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicErrorKind {
    LocalStateUnavailable,
    LocalMusicStorageUnavailable,
    LocalMusicFileMissing,
    LocalMusicCodecUnavailable,
    LocalMusicDeleteFailed,
    LocalMusicOutcomeUnknown,
    SecureStorageUnavailable,
    ProviderUnavailable,
    ProviderIncompatible,
    NetworkUnavailable,
    AuthenticationRequired,
    AccessDenied,
    UpstreamSchemaChanged,
    PlaybackUnavailable,
    PlaybackEntitlementDenied,
    PlaybackDeviceLimit,
    UnsafeMediaUrl,
    NativePlayerUnavailable,
    WriteOutcomeUnknown,
    OrganizerPlanDrifted,
    OrganizerPlanExpired,
    InvalidRequest,
}

impl PublicErrorKind {
    fn code(self) -> &'static str {
        match self {
            Self::LocalStateUnavailable => "local_state_unavailable",
            Self::LocalMusicStorageUnavailable => "local_music_storage_unavailable",
            Self::LocalMusicFileMissing => "local_music_file_missing",
            Self::LocalMusicCodecUnavailable => "local_music_codec_unavailable",
            Self::LocalMusicDeleteFailed => "local_music_delete_failed",
            Self::LocalMusicOutcomeUnknown => "local_music_delete_outcome_unknown",
            Self::SecureStorageUnavailable => "secure_storage_unavailable",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::ProviderIncompatible => "provider_incompatible",
            Self::NetworkUnavailable => "network_unavailable",
            Self::AuthenticationRequired => "authentication_required",
            Self::AccessDenied => "access_denied",
            Self::UpstreamSchemaChanged => "upstream_schema_changed",
            Self::PlaybackUnavailable => "playback_unavailable",
            Self::PlaybackEntitlementDenied => "playback_entitlement_denied",
            Self::PlaybackDeviceLimit => "playback_device_limit",
            Self::UnsafeMediaUrl => "playback_unsafe_media_url",
            Self::NativePlayerUnavailable => "playback_native_unavailable",
            Self::WriteOutcomeUnknown => "write_outcome_unknown",
            Self::OrganizerPlanDrifted => "organizer_plan_drifted",
            Self::OrganizerPlanExpired => "organizer_plan_expired",
            Self::InvalidRequest => "invalid_request",
        }
    }

    fn retryable(self) -> bool {
        matches!(
            self,
            Self::LocalStateUnavailable
                | Self::LocalMusicStorageUnavailable
                | Self::LocalMusicDeleteFailed
                | Self::SecureStorageUnavailable
                | Self::ProviderUnavailable
                | Self::NetworkUnavailable
                | Self::PlaybackUnavailable
                | Self::NativePlayerUnavailable
        )
    }

    fn user_message(self) -> &'static str {
        match self {
            Self::LocalStateUnavailable => "本地状态暂时不可用，请重试。",
            Self::LocalMusicStorageUnavailable => "软件所在目录不可写，无法导入本地音乐。",
            Self::LocalMusicFileMissing => "本地音乐文件不存在，请重新导入。",
            Self::LocalMusicCodecUnavailable => "当前系统缺少播放此 OGG 文件所需的解码支持。",
            Self::LocalMusicDeleteFailed => "本地音乐删除失败，请稍后重试。",
            Self::LocalMusicOutcomeUnknown => "本地音乐删除结果待核对，请先刷新本地音乐列表。",
            Self::SecureStorageUnavailable => "登录状态无法安全保存，请检查系统凭据服务。",
            Self::ProviderUnavailable => "音乐服务暂时不可用，请稍后重试。",
            Self::ProviderIncompatible => "本地音乐服务版本不兼容，请更新应用。",
            Self::NetworkUnavailable => "网络连接不可用，请检查网络后重试。",
            Self::AuthenticationRequired => "请先使用 QQ 或微信扫码登录。",
            Self::AccessDenied => "当前账号没有执行此操作的权限。",
            Self::UpstreamSchemaChanged => "音乐服务返回格式已变化，请更新应用。",
            Self::PlaybackUnavailable => "当前歌曲暂时无法播放。",
            Self::PlaybackEntitlementDenied => "当前账号没有这首歌曲的播放权益。",
            Self::PlaybackDeviceLimit => "当前账号的播放设备数已达上限。",
            Self::UnsafeMediaUrl => "媒体地址未通过本地安全检查。",
            Self::NativePlayerUnavailable => "Windows 播放器暂时无法打开媒体。",
            Self::WriteOutcomeUnknown => "写入结果待核对，应用不会自动重复提交。",
            Self::OrganizerPlanDrifted => "歌单已发生变化，请重新预览整理计划。",
            Self::OrganizerPlanExpired => "整理计划已过期，请重新生成预览。",
            Self::InvalidRequest => "请求参数无效，请重新操作。",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicError {
    pub code: &'static str,
    pub retryable: bool,
    pub operation: Operation,
    pub correlation_id: String,
    pub user_message: &'static str,
}

impl PublicError {
    pub fn new(kind: PublicErrorKind, operation: Operation) -> Self {
        let error = Self {
            code: kind.code(),
            retryable: kind.retryable(),
            operation,
            correlation_id: Uuid::new_v4().to_string(),
            user_message: kind.user_message(),
        };
        crate::file_logging::public_error(&error);
        error
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticRecord<'a> {
    format_version: u16,
    level: DiagnosticLevel,
    event: &'static str,
    operation: Operation,
    code: &'static str,
    correlation_id: &'a str,
}

pub struct DiagnosticLogger {
    file: Mutex<Option<File>>,
    path: std::path::PathBuf,
    entries_written: AtomicU64,
}

impl DiagnosticLogger {
    pub fn open(path: &Path) -> Result<Self, std::io::Error> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        rotate_if_needed(path)?;
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Self {
            file: Mutex::new(Some(file)),
            path: path.to_owned(),
            entries_written: AtomicU64::new(0),
        })
    }

    pub fn record_public_error(
        &self,
        level: DiagnosticLevel,
        error: &PublicError,
    ) -> Result<(), std::io::Error> {
        self.record(&DiagnosticRecord {
            format_version: LOG_FORMAT_VERSION,
            level,
            event: "operation_failed",
            operation: error.operation,
            code: error.code,
            correlation_id: &error.correlation_id,
        })
    }

    pub fn summary(
        &self,
        database_schema_version: u32,
        provider_protocol_version: u16,
    ) -> DiagnosticSummary {
        DiagnosticSummary {
            format_version: LOG_FORMAT_VERSION,
            app_version: env!("CARGO_PKG_VERSION"),
            target_os: std::env::consts::OS,
            target_architecture: std::env::consts::ARCH,
            database_schema_version,
            provider_protocol_version,
            entries_written_this_session: self.entries_written.load(Ordering::Relaxed),
        }
    }

    pub fn install_panic_hook(self: &Arc<Self>) {
        let logger = Arc::clone(self);
        std::panic::set_hook(Box::new(move |_| {
            let correlation_id = Uuid::new_v4().to_string();
            let _ = logger.record(&DiagnosticRecord {
                format_version: LOG_FORMAT_VERSION,
                level: DiagnosticLevel::Error,
                event: "panic",
                operation: Operation::Startup,
                code: "unexpected_failure",
                correlation_id: &correlation_id,
            });
        }));
    }

    fn record(&self, record: &DiagnosticRecord<'_>) -> Result<(), std::io::Error> {
        self.record_value(record)
    }

    pub(crate) fn record_value(&self, record: &impl Serialize) -> Result<(), std::io::Error> {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let encoded = serde_json::to_vec(&serde_json::json!({"timestampUnixMs": timestamp, "pid": std::process::id(), "appVersion": env!("CARGO_PKG_VERSION"), "record": record})).map_err(std::io::Error::other)?;
        let mut file = self
            .file
            .lock()
            .map_err(|_| std::io::Error::other("diagnostic log lock poisoned"))?;
        if file.as_ref().is_some_and(|f| {
            f.metadata()
                .map(|m| m.len() >= MAX_LOG_BYTES)
                .unwrap_or(false)
        }) {
            file.take(); // Windows requires closing the handle before renaming.
            rotate_if_needed(&self.path)?;
        }
        if file.is_none() {
            *file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)?,
            );
        }
        let handle = file.as_mut().unwrap();
        handle.write_all(&encoded)?;
        handle.write_all(b"\n")?;
        handle.flush()?;
        self.entries_written.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSummary {
    pub format_version: u16,
    pub app_version: &'static str,
    pub target_os: &'static str,
    pub target_architecture: &'static str,
    pub database_schema_version: u32,
    pub provider_protocol_version: u16,
    pub entries_written_this_session: u64,
}

fn rotate_if_needed(path: &Path) -> Result<(), std::io::Error> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() < MAX_LOG_BYTES {
        return Ok(());
    }
    let rotated = path.with_extension("previous.jsonl");
    if rotated.exists() {
        fs::remove_file(&rotated)?;
    }
    fs::rename(path, rotated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct TestLog {
        root: PathBuf,
        path: PathBuf,
    }

    impl TestLog {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("qqmusic-gui-log-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).expect("create test log root");
            let path = root.join("diagnostics.jsonl");
            Self { root, path }
        }
    }

    impl Drop for TestLog {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn rotates_during_session_and_retains_only_one_previous_file() {
        let test_log = TestLog::new();
        let logger = DiagnosticLogger::open(&test_log.path).unwrap();
        for cycle in 0..3 {
            for _ in 0..1100 {
                logger
                    .record_value(&serde_json::json!({"cycle":cycle,"padding":"x".repeat(1024)}))
                    .unwrap();
            }
        }
        assert!(fs::metadata(&test_log.path).unwrap().len() < MAX_LOG_BYTES + 2048);
        assert!(
            fs::metadata(test_log.path.with_extension("previous.jsonl"))
                .unwrap()
                .len()
                < MAX_LOG_BYTES + 2048
        );
        assert_eq!(fs::read_dir(&test_log.root).unwrap().count(), 2);
        let contents = fs::read_to_string(&test_log.path).unwrap();
        for line in contents.lines() {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            assert!(value["timestampUnixMs"].is_number());
        }
    }

    #[test]
    fn public_error_has_stable_shape_and_fresh_correlation_id() {
        let first = PublicError::new(PublicErrorKind::ProviderUnavailable, Operation::Provider);
        let second = PublicError::new(PublicErrorKind::ProviderUnavailable, Operation::Provider);
        assert_eq!(first.code, "provider_unavailable");
        assert!(first.retryable);
        assert_ne!(first.correlation_id, second.correlation_id);
        assert!(Uuid::parse_str(&first.correlation_id).is_ok());

        let value = serde_json::to_value(first).expect("serialize public error");
        assert_eq!(
            value
                .as_object()
                .expect("public error object")
                .keys()
                .collect::<Vec<_>>(),
            vec![
                "code",
                "correlationId",
                "operation",
                "retryable",
                "userMessage"
            ]
        );
    }

    #[test]
    fn structured_log_never_accepts_raw_causes_or_secret_fields() {
        let test_log = TestLog::new();
        let logger = DiagnosticLogger::open(&test_log.path).expect("open logger");
        let upstream_secret =
            "Cookie: uin=SENTINEL_UIN; qqmusic_key=SENTINEL_QQMUSIC_KEY; https://dl.stream.qqmusic.qq.com/x?token=SENTINEL_TOKEN";
        let error = PublicError::new(PublicErrorKind::ProviderUnavailable, Operation::Provider);
        logger
            .record_public_error(DiagnosticLevel::Error, &error)
            .expect("write safe log");

        let contents = fs::read_to_string(&test_log.path).expect("read log");
        assert!(contents.contains("provider_unavailable"));
        assert!(!contents.contains(upstream_secret));
        for sentinel in [
            "SENTINEL_UIN",
            "SENTINEL_QQMUSIC_KEY",
            "SENTINEL_TOKEN",
            "dl.stream.qqmusic.qq.com",
        ] {
            assert!(!contents.contains(sentinel));
        }
    }

    #[test]
    fn diagnostic_summary_contains_versions_not_paths() {
        let test_log = TestLog::new();
        let logger = DiagnosticLogger::open(&test_log.path).expect("open logger");
        let summary = logger.summary(1, 1);
        let value = serde_json::to_value(summary).expect("serialize summary");
        assert_eq!(value["databaseSchemaVersion"], 1);
        assert_eq!(value["providerProtocolVersion"], 1);
        assert!(value.get("path").is_none());
        assert!(value.get("username").is_none());
    }
}
