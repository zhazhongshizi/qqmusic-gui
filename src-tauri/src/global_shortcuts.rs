//! Persisted global controls shared by every desktop presentation.
use crate::{playback_session::PlaybackSession, PlaybackSessionError};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Action {
    Next,
    Previous,
    VolumeUp,
    VolumeDown,
    TogglePlayback,
}

impl Action {
    fn label(self) -> &'static str {
        match self {
            Self::Next => "下一首",
            Self::Previous => "上一首",
            Self::VolumeUp => "音量增加",
            Self::VolumeDown => "音量降低",
            Self::TogglePlayback => "播放／暂停",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    action: Action,
    enabled: bool,
    shortcut: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    enabled: bool,
    bindings: Vec<Binding>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            bindings: [
                (Action::TogglePlayback, "Space"),
                (Action::Next, "ArrowRight"),
                (Action::Previous, "ArrowLeft"),
                (Action::VolumeUp, "ArrowUp"),
                (Action::VolumeDown, "ArrowDown"),
            ]
            .into_iter()
            .map(|(action, key)| Binding {
                action,
                enabled: true,
                shortcut: format!("Control+Alt+{key}"),
            })
            .collect(),
        }
    }
}

type Active = Vec<(Shortcut, Action)>;

impl Settings {
    fn validate(&self) -> Result<Active, String> {
        if self.bindings.len() != 5 {
            return Err("快捷键配置必须包含全部五个操作".into());
        }
        let mut actions = HashSet::new();
        let mut keys = HashSet::new();
        let mut active = Vec::new();
        for binding in &self.bindings {
            if !actions.insert(binding.action) {
                return Err("快捷键操作不能重复".into());
            }
            if binding.shortcut.len() > 100 {
                return Err("快捷键组合过长".into());
            }
            let shortcut: Shortcut = binding
                .shortcut
                .parse()
                .map_err(|_| format!("{}的快捷键无效", binding.action.label()))?;
            if self.enabled && binding.enabled {
                if !keys.insert(shortcut.id()) {
                    return Err("已启用的操作不能使用相同快捷键".into());
                }
                active.push((shortcut, binding.action));
            }
        }
        Ok(active)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    settings: Settings,
    errors: Vec<String>,
}
struct Inner {
    settings: Settings,
    active: Active,
    errors: Vec<String>,
}
struct Service {
    path: Option<PathBuf>,
    inner: Mutex<Inner>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SavedSettings {
    version: u8,
    settings: Settings,
}

fn load(path: &Path) -> Result<Settings, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let saved: SavedSettings = serde_json::from_slice(&bytes)
                .map_err(|_| "快捷键配置读取失败，请恢复默认后保存")?;
            if saved.version != 1 {
                return Err("快捷键配置版本不受支持".into());
            }
            saved.settings.validate()?;
            Ok(saved.settings)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(_) => Err("快捷键配置读取失败，请检查应用数据目录权限".into()),
    }
}

fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    let write = || -> Result<(), Box<dyn std::error::Error>> {
        fs::create_dir_all(path.parent().ok_or("missing parent")?)?;
        let temporary = path.with_extension("json.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(&SavedSettings {
                version: 1,
                settings: settings.clone(),
            })?,
        )?;
        fs::rename(temporary, path)?;
        Ok(())
    };
    write().map_err(|_| "快捷键配置保存失败，请检查应用数据目录权限和磁盘空间".into())
}

trait Registry {
    fn register(&self, shortcut: Shortcut) -> Result<(), ()>;
    fn unregister(&self, shortcut: Shortcut) -> Result<(), ()>;
}
struct NativeRegistry<'a>(&'a AppHandle);
impl Registry for NativeRegistry<'_> {
    fn register(&self, shortcut: Shortcut) -> Result<(), ()> {
        self.0.global_shortcut().register(shortcut).map_err(|_| ())
    }
    fn unregister(&self, shortcut: Shortcut) -> Result<(), ()> {
        self.0
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|_| ())
    }
}
fn contains(active: &Active, key: Shortcut) -> bool {
    active.iter().any(|(other, _)| other.id() == key.id())
}

// Reuse common registrations so swapping actions never conflicts with our own keys.
fn reconcile(inner: &mut Inner, target: &Active, registry: &impl Registry) -> Result<(), String> {
    for &(key, action) in target {
        if !contains(&inner.active, key) {
            registry
                .register(key)
                .map_err(|_| format!("{}的快捷键注册失败，可能已被其他程序占用", action.label()))?;
            inner.active.push((key, action));
        }
    }
    for (key, action) in inner.active.clone() {
        if !contains(target, key) {
            registry
                .unregister(key)
                .map_err(|_| format!("{}的旧快捷键释放失败", action.label()))?;
            inner.active.retain(|(other, _)| other.id() != key.id());
        }
    }
    inner.active = target.clone();
    Ok(())
}

fn apply(
    inner: &mut Inner,
    settings: Settings,
    registry: &impl Registry,
    persist: impl FnOnce(&Settings) -> Result<(), String>,
) -> Result<(), String> {
    let target = settings.validate()?;
    let previous = inner.active.clone();
    let result = reconcile(inner, &target, registry).and_then(|_| persist(&settings));
    if let Err(error) = result {
        if let Err(restore_error) = reconcile(inner, &previous, registry) {
            let warning = format!("部分旧快捷键未能恢复：{restore_error}，请重新保存配置");
            inner.errors.push(warning.clone());
            return Err(format!("{error}。配置未保存；{warning}"));
        }
        return Err(format!("{error}。配置未保存"));
    }
    inner.settings = settings;
    inner.errors.clear();
    Ok(())
}

fn execute(session: &PlaybackSession, action: Action) -> Result<(), PlaybackSessionError> {
    match action {
        Action::Next => session.next().map(|_| ()),
        Action::Previous => session.previous().map(|_| ()),
        Action::VolumeUp => session.adjust_volume(0.1).map(|_| ()),
        Action::VolumeDown => session.adjust_volume(-0.1).map(|_| ()),
        Action::TogglePlayback => session.toggle_playback().map(|_| ()),
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Status,
    Save { settings: Settings },
}

pub(crate) fn control(
    app: &AppHandle,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request: Request = serde_json::from_value(request).map_err(|_| "快捷键请求无效")?;
    let service = app.try_state::<Service>().ok_or("全局快捷键服务不可用")?;
    let mut inner = service
        .inner
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Request::Save { settings } = request {
        let path = service.path.as_ref().ok_or("快捷键配置目录不可用")?;
        apply(&mut inner, settings, &NativeRegistry(app), |settings| {
            save(path, settings)
        })?;
    }
    serde_json::to_value(Snapshot {
        settings: inner.settings.clone(),
        errors: inner.errors.clone(),
    })
    .map_err(|_| "快捷键状态读取失败".into())
}

pub(crate) fn install(app: &AppHandle) -> tauri::Result<()> {
    let path =
        crate::application_data_directory(app).map(|root| root.join("global-shortcuts.json"));
    let loaded = path
        .as_deref()
        .ok_or_else(|| "快捷键配置目录不可用".to_owned())
        .and_then(load);
    let (settings, errors) = match loaded {
        Ok(settings) => (settings, Vec::new()),
        Err(error) => (
            Settings {
                enabled: false,
                ..Settings::default()
            },
            vec![error],
        ),
    };
    app.manage(Service {
        path,
        inner: Mutex::new(Inner {
            settings,
            active: Vec::new(),
            errors,
        }),
    });
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                let Some(service) = app.try_state::<Service>() else {
                    return;
                };
                // Registration can synchronously use the main thread. Never wait for its lock here.
                let Ok(inner) = service.inner.try_lock() else {
                    return;
                };
                let action = inner
                    .settings
                    .validate()
                    .ok()
                    .and_then(|desired| {
                        desired
                            .into_iter()
                            .find(|(key, _)| key.id() == shortcut.id())
                    })
                    .filter(|(key, _)| contains(&inner.active, *key))
                    .map(|(_, action)| action);
                drop(inner);
                let Some(action) = action else {
                    return;
                };
                let Some(session) = app.state::<crate::AppState>().playback_session.clone() else {
                    return;
                };
                tauri::async_runtime::spawn(async move {
                    if let Err(error) =
                        crate::run_session_blocking(move || execute(&session, action)).await
                    {
                        crate::file_logging::public_error(&error);
                    }
                });
            })
            .build(),
    )?;
    let service = app.state::<Service>();
    let mut inner = service
        .inner
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    for (key, action) in inner.settings.validate().unwrap_or_default() {
        if NativeRegistry(app).register(key).is_ok() {
            inner.active.push((key, action));
        } else {
            inner.errors.push(format!(
                "{}的快捷键无法启用，可能已被其他程序占用",
                action.label()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeRegistry {
        keys: RefCell<HashSet<u32>>,
        occupied: RefCell<HashSet<u32>>,
        fail_remove: RefCell<HashSet<u32>>,
    }
    impl Registry for FakeRegistry {
        fn register(&self, key: Shortcut) -> Result<(), ()> {
            if self.occupied.borrow().contains(&key.id())
                || !self.keys.borrow_mut().insert(key.id())
            {
                Err(())
            } else {
                Ok(())
            }
        }
        fn unregister(&self, key: Shortcut) -> Result<(), ()> {
            if self.fail_remove.borrow().contains(&key.id())
                || !self.keys.borrow_mut().remove(&key.id())
            {
                Err(())
            } else {
                Ok(())
            }
        }
    }
    fn fixture() -> (Inner, FakeRegistry) {
        let settings = Settings::default();
        let active = settings.validate().unwrap();
        let registry = FakeRegistry::default();
        for (key, _) in &active {
            registry.register(*key).unwrap();
        }
        (
            Inner {
                settings,
                active,
                errors: vec![],
            },
            registry,
        )
    }

    #[test]
    fn validates_alias_duplicates_and_only_active_combinations_conflict() {
        let mut settings = Settings::default();
        settings.bindings[1].shortcut = "Alt+Ctrl+Space".into();
        assert!(settings.validate().is_err());
        settings.bindings[1].enabled = false;
        assert_eq!(settings.validate().unwrap().len(), 4);
        settings.bindings[1].enabled = true;
        settings.enabled = false;
        assert!(settings.validate().unwrap().is_empty());
        settings.bindings[1].shortcut = "Ctrl+NotAKey".into();
        assert!(settings.validate().is_err());
        let mut missing = Settings::default();
        missing.bindings.pop();
        assert!(missing.validate().is_err());
        let mut duplicate = Settings::default();
        duplicate.bindings[1].action = duplicate.bindings[0].action;
        assert!(duplicate.validate().is_err());
    }

    #[test]
    fn individual_and_master_switches_release_keys_and_preserve_combinations() {
        let (mut inner, registry) = fixture();
        let original = inner.settings.clone();
        let mut single = original.clone();
        single.bindings[0].enabled = false;
        apply(&mut inner, single.clone(), &registry, |_| Ok(())).unwrap();
        assert_eq!(registry.keys.borrow().len(), 4);
        assert_eq!(
            inner.settings.bindings[0].shortcut,
            original.bindings[0].shortcut
        );
        single.enabled = false;
        apply(&mut inner, single, &registry, |_| Ok(())).unwrap();
        assert!(registry.keys.borrow().is_empty());
        apply(&mut inner, original, &registry, |_| Ok(())).unwrap();
        assert_eq!(registry.keys.borrow().len(), 5);
    }

    #[test]
    fn remapping_and_swapping_actions_reuses_common_registrations() {
        let (mut inner, registry) = fixture();
        let mut settings = inner.settings.clone();
        let first = settings.bindings[0].shortcut.clone();
        settings.bindings[0].shortcut = settings.bindings[1].shortcut.clone();
        settings.bindings[1].shortcut = first;
        apply(&mut inner, settings.clone(), &registry, |_| Ok(())).unwrap();
        assert_eq!(inner.active, settings.validate().unwrap());
        assert_eq!(registry.keys.borrow().len(), 5);
        settings.bindings[2].shortcut = "Control+Shift+KeyP".into();
        apply(&mut inner, settings.clone(), &registry, |_| Ok(())).unwrap();
        assert_eq!(inner.active, settings.validate().unwrap());
        assert_eq!(registry.keys.borrow().len(), 5);
    }

    #[test]
    fn conflict_and_write_failure_restore_previous_runtime_and_config() {
        let (mut inner, registry) = fixture();
        let old_settings = inner.settings.clone();
        let old_active = inner.active.clone();
        let mut settings = old_settings.clone();
        settings.bindings[0].shortcut = "Control+KeyQ".into();
        settings.bindings[1].shortcut = "Control+KeyW".into();
        let occupied: Shortcut = "Control+KeyW".parse().unwrap();
        registry.occupied.borrow_mut().insert(occupied.id());
        assert!(apply(&mut inner, settings.clone(), &registry, |_| panic!(
            "conflicts must not save"
        ))
        .is_err());
        assert_eq!(inner.settings, old_settings);
        assert_eq!(inner.active, old_active);
        assert_eq!(
            *registry.keys.borrow(),
            old_active.iter().map(|(key, _)| key.id()).collect()
        );
        registry.occupied.borrow_mut().clear();
        assert!(apply(&mut inner, settings, &registry, |_| Err("disk full".into())).is_err());
        assert_eq!(inner.settings, old_settings);
        assert_eq!(inner.active, old_active);
        assert_eq!(
            *registry.keys.borrow(),
            old_active.iter().map(|(key, _)| key.id()).collect()
        );
    }

    #[test]
    fn release_failure_does_not_save_or_claim_disabled() {
        let (mut inner, registry) = fixture();
        let original = inner.settings.clone();
        registry
            .fail_remove
            .borrow_mut()
            .insert(inner.active[1].0.id());
        let mut settings = original.clone();
        settings.enabled = false;
        assert!(apply(&mut inner, settings, &registry, |_| panic!(
            "must not persist"
        ))
        .is_err());
        assert_eq!(inner.settings, original);
        assert_eq!(registry.keys.borrow().len(), 5);
    }

    #[test]
    fn settings_round_trip_replace_existing_and_preserve_corrupt_file() {
        let root = std::env::temp_dir().join(format!("qqmusic-shortcuts-{}", uuid::Uuid::new_v4()));
        let path = root.join("global-shortcuts.json");
        assert_eq!(load(&path).unwrap(), Settings::default());
        let mut settings = Settings::default();
        save(&path, &settings).unwrap();
        settings.enabled = false;
        settings.bindings[0].shortcut = "Control+Shift+KeyP".into();
        save(&path, &settings).unwrap();
        assert_eq!(load(&path).unwrap(), settings);
        fs::write(&path, b"invalid").unwrap();
        assert!(load(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid");
        fs::remove_dir_all(root).unwrap();
    }
}
