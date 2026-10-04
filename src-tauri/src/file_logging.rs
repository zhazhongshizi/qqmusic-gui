//! Opt-in release diagnostics. Only typed, redacted records cross this boundary.
use crate::diagnostics::{DiagnosticLevel, DiagnosticLogger, PublicError};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

static LOG: OnceLock<Mutex<Logging>> = OnceLock::new();
const WRITE_ERROR: &str = "日志写入失败，请检查软件所在目录的写入权限和磁盘空间";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    enabled: bool,
    error: Option<&'static str>,
}

struct Logging {
    root: PathBuf,
    enabled: bool,
    logger: Option<DiagnosticLogger>,
    error: Option<&'static str>,
}

impl Logging {
    fn load(root: PathBuf) -> Self {
        let mut this = Self {
            root,
            enabled: false,
            logger: None,
            error: None,
        };
        match std::fs::read(this.root.join("diagnostic-logging.enabled")) {
            Ok(value) if value.trim_ascii() == b"enabled" => {
                this.enabled = true;
                match DiagnosticLogger::open(&this.root.join("logs/diagnostics.jsonl")) {
                    Ok(logger) => this.logger = Some(logger),
                    Err(_) => this.error = Some(WRITE_ERROR),
                }
            }
            Ok(_) => this.error = Some("日志设置无效，请重新设置开关"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => this.error = Some("日志设置读取失败，请检查软件目录权限"),
        }
        this
    }

    fn status(&self) -> Status {
        Status {
            enabled: self.enabled,
            error: self.error,
        }
    }

    fn set_enabled(&mut self, enabled: bool) -> Result<Status, &'static str> {
        if self.enabled == enabled && self.error.is_none() {
            return Ok(self.status());
        }
        let marker = self.root.join("diagnostic-logging.enabled");
        if enabled {
            let logger = DiagnosticLogger::open(&self.root.join("logs/diagnostics.jsonl"))
                .map_err(|_| WRITE_ERROR)?;
            logger
                .record_value(&serde_json::json!({"event":"logging_enabled"}))
                .map_err(|_| WRITE_ERROR)?;
            std::fs::write(marker, b"enabled\n").map_err(|_| WRITE_ERROR)?;
            self.logger = Some(logger);
        } else {
            match std::fs::remove_file(marker) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err("日志开关保存失败，请检查软件目录权限"),
            }
            self.logger = None;
        }
        self.enabled = enabled;
        self.error = None;
        Ok(self.status())
    }

    fn record(&mut self, record: &impl Serialize) {
        if let Some(logger) = &self.logger {
            if logger.record_value(record).is_err() {
                self.error = Some(WRITE_ERROR);
                self.logger = None;
            }
        }
    }
}

pub(crate) fn initialize() {
    if let Some(root) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
    {
        let _ = LOG.set(Mutex::new(Logging::load(root)));
    }
    event("app_starting");
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Never include panic payloads, which may contain URLs or credentials.
        if let Some(mut state) = LOG.get().and_then(|log| log.try_lock().ok()) {
            state.record(&serde_json::json!({"event":"rust_panic", "line":info.location().map(|l| l.line())}));
        }
        previous(info);
    }));
}

pub(crate) fn event(event: &'static str) {
    record(&serde_json::json!({"event":event}));
}
pub(crate) fn native_failure(generation: u64, hresult: Option<i32>) {
    record(
        &serde_json::json!({"event":"native_media_failed", "generation":generation, "hresult":hresult.map(|v| format!("0x{:08X}", v as u32))}),
    );
}
pub(crate) fn native_event(event: &'static str, generation: u64) {
    record(&serde_json::json!({"event":event, "generation":generation}));
}
pub(crate) fn provider_failure(code: &'static str, generation: u64) {
    record(&serde_json::json!({"event":"provider_recovery", "code":code,"generation":generation}));
}
pub(crate) fn public_error(error: &PublicError) {
    record(
        &serde_json::json!({"event":"operation_failed", "level":DiagnosticLevel::Error,"error":error}),
    );
}
fn record(record: &impl Serialize) {
    if let Some(mut state) = LOG.get().and_then(|log| log.lock().ok()) {
        state.record(record);
    }
}

#[tauri::command]
pub(crate) fn logging_status() -> Result<Status, &'static str> {
    LOG.get()
        .and_then(|log| log.lock().ok())
        .map(|state| state.status())
        .ok_or(WRITE_ERROR)
}
#[tauri::command]
pub(crate) fn logging_set_enabled(enabled: bool) -> Result<Status, &'static str> {
    LOG.get()
        .and_then(|log| log.lock().ok())
        .ok_or(WRITE_ERROR)?
        .set_enabled(enabled)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FrontendFailure {
    Error,
    UnhandledRejection,
    ReactError,
}

#[tauri::command]
pub(crate) fn logging_frontend_error(kind: FrontendFailure) {
    event(match kind {
        FrontendFailure::Error => "frontend_error",
        FrontendFailure::UnhandledRejection => "frontend_unhandled_rejection",
        FrontendFailure::ReactError => "frontend_react_error",
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opt_in_persists_and_disable_stops_writes() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&root).unwrap();
        let mut log = Logging::load(root.clone());
        assert!(!log.enabled);
        log.record(&"off");
        assert!(!root.join("logs").exists());
        log.set_enabled(true).unwrap();
        assert!(Logging::load(root.clone()).enabled);
        log.record(&"on");
        let path = root.join("logs/diagnostics.jsonl");
        let before = std::fs::read(&path).unwrap();
        log.set_enabled(false).unwrap();
        log.record(&"off");
        assert_eq!(before, std::fs::read(path).unwrap());
        assert!(!Logging::load(root.clone()).enabled);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn manual_windows_marker_restores_logging() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("diagnostic-logging.enabled"), b"enabled\r\n").unwrap();
        let mut log = Logging::load(root.clone());
        assert!(log.enabled && log.logger.is_some());
        log.set_enabled(true).unwrap();
        log.set_enabled(false).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unwritable_destination_does_not_enable() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::write(&root, b"file, not directory").unwrap();
        let mut log = Logging::load(root.clone());
        assert!(log.set_enabled(true).is_err());
        assert!(!log.enabled);
        std::fs::remove_file(root).unwrap();
    }
}
