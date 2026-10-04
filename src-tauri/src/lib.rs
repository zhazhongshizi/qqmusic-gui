pub mod auth;
pub mod catalog;
mod commands;
pub mod cover;
pub mod credentials;
mod desktop;
pub mod device_identity;
pub mod diagnostics;
mod file_logging;
pub mod library;
pub mod listening_stats;
pub mod local_music;
pub mod lyrics;
pub mod network_policy;
pub mod organizer;
pub mod persistence;
pub mod personal;
pub mod playback;
pub mod playback_session;
pub mod player;
#[cfg(windows)]
mod process_loopback;
pub mod provider;
pub mod queue;
mod remote;
pub mod smart_shuffle;
pub(crate) mod smtc_artwork;
pub(crate) mod smtc_dynamic_lyrics;
pub(crate) mod spectrum;
#[cfg(all(windows, not(test)))]
mod spectrum_service;

use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::RecvTimeoutError,
        Arc, RwLock,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use auth::{
    AuthError, AuthQrEvent, AuthQrEventError, AuthRecoveryCoordinator, AuthService, QrLoginStart,
    QrLoginState, RecoveringProviderPort, RecoveryState, AUTH_QR_PROVIDER_EVENT,
    AUTH_QR_RENDERER_EVENT,
};
use catalog::{CatalogArtist, CatalogError, CatalogService, CatalogSongPage};
use cover::{CoverError, CoverPayload, CoverService};
#[cfg(windows)]
use credentials::WindowsCredentialStore;
#[cfg(windows)]
use device_identity::ProviderDevicePath;
use diagnostics::{Operation, PublicError, PublicErrorKind};
use library::{LibraryError, LibraryService, PlaylistKind, PlaylistPage, WriteReceipt};
use local_music::{
    LocalMusicError, LocalMusicImportResult, LocalMusicListResult, LocalMusicService,
};
use lyrics::{LyricError, LyricService, LyricTimeline};
use organizer::{
    OrganizerError, OrganizerExecution, OrganizerPreview, OrganizerPreviewRequest, OrganizerService,
};
use persistence::{AppSettings, PersistenceError, PersistenceService, PreferredQuality};
use playback::{PlaybackController, PlaybackError, PlaybackQuality};
use playback_session::{
    LocalMusicDeleteResult, PlaybackMode, PlaybackSession, PlaybackSessionError,
    PlaybackSessionSnapshot, SessionPlayResult,
};
use player::PlayerSnapshot;
#[cfg(windows)]
use player::WindowsMediaPlayerEngine;
use provider::{ProviderSnapshot, ProviderSupervisor, SupervisorConfig, VerifiedProviderBundle};
use queue::{QueueError, QueueService, QueueSnapshot, QueueTrack};
use serde::Serialize;
#[cfg(windows)]
use smtc_artwork::SmtcArtworkCoordinator;
#[cfg(windows)]
use smtc_dynamic_lyrics::SmtcDynamicLyricsCoordinator;
#[cfg(all(windows, not(test)))]
use spectrum_service::SpectrumService;
use tauri::{Emitter, Manager, State};

const SNAPSHOT_SCHEMA_VERSION: u16 = 1;

#[cfg(all(target_os = "windows", not(target_arch = "x86_64")))]
compile_error!("QQ Music GUI currently supports only x86_64 Windows builds");

#[cfg(all(feature = "desktop-e2e", not(debug_assertions)))]
compile_error!("desktop-e2e is a debug-only test feature and must never enter a release build");

/// Renderer-safe startup state. This DTO intentionally contains no credentials,
/// upstream payloads, media URLs, request headers, or filesystem paths.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    schema_version: u16,
    app_version: &'static str,
    target: TargetSnapshot,
    provider: ProviderSnapshot,
    player: PlayerSnapshot,
    extensions: ExtensionCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetSnapshot {
    os: &'static str,
    architecture: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionCapabilities {
    playlist_rename: bool,
    playlist_description_edit: bool,
}

impl AppSnapshot {
    fn bootstrap() -> Self {
        Self {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            app_version: env!("CARGO_PKG_VERSION"),
            target: TargetSnapshot {
                os: std::env::consts::OS,
                architecture: std::env::consts::ARCH,
            },
            provider: ProviderSnapshot::not_started(),
            player: PlayerSnapshot::idle(),
            extensions: ExtensionCapabilities {
                playlist_rename: false,
                playlist_description_edit: false,
            },
        }
    }
}

/// Tauri-managed boundary for state projected into the renderer.
/// Provider and player actors can replace the bootstrap projections without
/// changing the command contract or exposing their secret-bearing internals.
struct AppState {
    remote: Arc<remote::RemoteControl>,
    snapshot: RwLock<AppSnapshot>,
    provider: Option<Arc<ProviderSupervisor>>,
    auth: Option<Arc<AuthService>>,
    catalog: Option<Arc<CatalogService>>,
    library: Option<Arc<LibraryService>>,
    organizer: Option<Arc<OrganizerService>>,
    playback: Option<Arc<PlaybackController>>,
    playback_session: Option<Arc<PlaybackSession>>,
    local_music: Option<Arc<LocalMusicService>>,
    #[cfg(windows)]
    smtc_artwork: Option<Arc<SmtcArtworkCoordinator>>,
    #[cfg(windows)]
    smtc_dynamic_lyrics: Option<Arc<SmtcDynamicLyricsCoordinator>>,
    lyrics: Option<Arc<LyricService>>,
    queue: Option<Arc<QueueService>>,
    persistence: Option<Arc<PersistenceService>>,
    cover: Option<Arc<CoverService>>,
    auth_snapshot: Arc<RwLock<AuthSnapshot>>,
    #[cfg(windows)]
    auth_event_stop: Option<Arc<AtomicBool>>,
    #[cfg(windows)]
    auth_event_thread: Option<JoinHandle<()>>,
    #[cfg(all(windows, not(test)))]
    spectrum: Option<Arc<SpectrumService>>,
}

impl AppState {
    fn bootstrap() -> Self {
        Self {
            remote: Arc::new(remote::RemoteControl::default()),
            snapshot: RwLock::new(AppSnapshot::bootstrap()),
            provider: None,
            auth: None,
            catalog: None,
            library: None,
            organizer: None,
            playback: None,
            playback_session: None,
            local_music: None,
            #[cfg(windows)]
            smtc_artwork: None,
            #[cfg(windows)]
            smtc_dynamic_lyrics: None,
            lyrics: None,
            queue: None,
            persistence: None,
            cover: None,
            auth_snapshot: Arc::new(RwLock::new(AuthSnapshot::unavailable())),
            #[cfg(windows)]
            auth_event_stop: None,
            #[cfg(windows)]
            auth_event_thread: None,
            #[cfg(all(windows, not(test)))]
            spectrum: None,
        }
    }

    fn snapshot(&self) -> AppSnapshot {
        let mut snapshot = self
            .snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(provider) = &self.provider {
            snapshot.provider = provider.snapshot();
        }
        if let Some(playback) = &self.playback {
            snapshot.player = playback.snapshot();
        }
        snapshot
    }

    #[cfg(windows)]
    fn initialize(app: &tauri::AppHandle) -> Self {
        let mut state = Self::bootstrap();
        state.cover = std::env::current_exe()
            .ok()
            .and_then(|executable| executable.parent().map(|root| root.join("cover-cache")))
            .and_then(|root| CoverService::new(root).ok())
            .map(Arc::new);
        state.local_music = LocalMusicService::from_current_exe().ok().map(Arc::new);
        state.queue = queue_service(app).map(Arc::new);
        state.persistence = persistence_service(app).map(Arc::new);
        if state.persistence.is_none() || state.queue.is_none() {
            file_logging::event("startup_storage_unavailable");
        }
        if state.local_music.is_none() {
            file_logging::event("startup_local_music_unavailable");
        }
        #[cfg(not(test))]
        {
            let spectrum_enabled = state
                .persistence
                .as_ref()
                .and_then(|persistence| persistence.load_settings().ok())
                .is_some_and(|settings| settings.live_spectrum_enabled);
            state.spectrum = Some(Arc::new(SpectrumService::new(
                app.clone(),
                spectrum_enabled,
            )));
        }
        let device_path = app
            .path()
            .app_data_dir()
            .ok()
            .and_then(|root| ProviderDevicePath::prepare(&root).ok());
        let Some(device_path) = device_path else {
            file_logging::event("startup_provider_device_unavailable");
            state
                .snapshot
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .provider = ProviderSnapshot::failed();
            return state;
        };
        let Some(provider_root) = provider_root(app) else {
            file_logging::event("startup_provider_root_unavailable");
            state
                .snapshot
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .provider = ProviderSnapshot::failed();
            return state;
        };
        let credential_store: Arc<dyn credentials::CredentialStore> =
            Arc::new(WindowsCredentialStore::new());
        let recovery = Arc::new(AuthRecoveryCoordinator::new(credential_store.clone()));
        let provider = match VerifiedProviderBundle::verify(provider_root)
            .and_then(|bundle| {
                bundle
                    .launch_with_device_path(&device_path)
                    .map_err(|_| provider::ProviderBundleError::Io)
            })
            .and_then(|launch| {
                ProviderSupervisor::start_with_recovery_allow_initial_failure(
                    launch,
                    SupervisorConfig::default(),
                    recovery.clone(),
                )
                .map_err(|_| provider::ProviderBundleError::Io)
            }) {
            Ok(provider) => Arc::new(provider),
            Err(_) => {
                file_logging::event("startup_provider_bundle_or_launch_failed");
                state
                    .snapshot
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .provider = ProviderSnapshot::failed();
                return state;
            }
        };
        let auth = Arc::new(AuthService::new(provider.clone(), credential_store));
        let (event_stop, event_thread) = spawn_auth_event_bridge(
            app,
            provider.clone(),
            auth.clone(),
            state.auth_snapshot.clone(),
        );
        state.auth_event_stop = Some(event_stop);
        state.auth_event_thread = event_thread;
        let business_provider: Arc<dyn provider::ProviderRequestPort> = Arc::new(
            RecoveringProviderPort::new(provider.clone(), recovery.clone()),
        );
        let lyrics = Arc::new(LyricService::new(business_provider.clone()));
        state.lyrics = Some(lyrics.clone());
        state.catalog = Some(Arc::new(CatalogService::new(business_provider.clone())));
        let library = Arc::new(LibraryService::new(business_provider.clone()));
        state.library = Some(library.clone());
        if let Some(persistence) = state.persistence.clone() {
            state.organizer = Some(Arc::new(OrganizerService::new(library, persistence)));
        }
        state.playback = WindowsMediaPlayerEngine::new().ok().map(|player| {
            Arc::new(PlaybackController::new(
                business_provider.clone(),
                Box::new(player),
            ))
        });
        #[cfg(windows)]
        let artwork = match (&state.cover, &state.playback) {
            (Some(cover), Some(playback)) => {
                let coordinator =
                    SmtcArtworkCoordinator::new(cover.clone(), Arc::downgrade(playback));
                state.smtc_artwork = Some(coordinator.clone());
                Some(coordinator)
            }
            _ => None,
        };
        #[cfg(windows)]
        let dynamic_lyrics = state.playback.as_ref().map(|playback| {
            let coordinator =
                SmtcDynamicLyricsCoordinator::new(lyrics.clone(), Arc::downgrade(playback));
            state.smtc_dynamic_lyrics = Some(coordinator.clone());
            coordinator
        });
        if let (Some(queue), Some(playback)) = (&state.queue, &state.playback) {
            #[cfg(windows)]
            let artwork_port = artwork
                .as_ref()
                .map(|value| value.clone() as Arc<dyn smtc_artwork::SmtcArtworkPort>);
            #[cfg(not(windows))]
            let artwork_port = None;
            #[cfg(windows)]
            let dynamic_lyrics_port = dynamic_lyrics
                .as_ref()
                .map(|value| value.clone() as Arc<dyn smtc_dynamic_lyrics::SmtcDynamicLyricsPort>);
            #[cfg(not(windows))]
            let dynamic_lyrics_port = None;
            let default_quality = state
                .persistence
                .as_ref()
                .and_then(|persistence| persistence.load_settings().ok())
                .map(|settings| playback_quality_from_preferred(settings.preferred_quality))
                .unwrap_or(PlaybackQuality::Kbps320);
            let session = Arc::new(
                PlaybackSession::with_ports_and_local_music(
                    queue.clone(),
                    playback.clone(),
                    artwork_port,
                    dynamic_lyrics_port,
                    state.local_music.clone(),
                )
                .with_lyric_service(state.lyrics.clone()),
            );
            session.set_default_quality(default_quality);
            PlaybackSession::start_auto_advance_worker(&session);
            state.playback_session = Some(session);
        }
        *state
            .auth_snapshot
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = match recovery.state() {
            RecoveryState::SignedOut => AuthSnapshot::signed_out(),
            RecoveryState::Authenticated { account } => AuthSnapshot::authenticated(Some(account)),
        };
        state.provider = Some(provider);
        state.auth = Some(auth);
        state
    }
}

#[cfg(windows)]
fn spawn_auth_event_bridge(
    app: &tauri::AppHandle,
    provider: Arc<ProviderSupervisor>,
    auth: Arc<AuthService>,
    auth_snapshot: Arc<RwLock<AuthSnapshot>>,
) -> (Arc<AtomicBool>, Option<JoinHandle<()>>) {
    let stop = Arc::new(AtomicBool::new(false));
    let Ok(events) = provider.subscribe_events() else {
        return (stop, None);
    };
    let thread_stop = stop.clone();
    let app = app.clone();
    let thread = thread::Builder::new()
        .name("qqmusic-auth-events".to_owned())
        .spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                match events.recv_timeout(Duration::from_millis(100)) {
                    Ok(event) if event.name == AUTH_QR_PROVIDER_EVENT => {
                        let public_event = match auth.apply_qr_event(event.payload) {
                            Ok(event) => event,
                            Err(error) => auth_qr_event_error(error),
                        };
                        #[cfg(debug_assertions)]
                        {
                            let state = auth_qr_event_state(&public_event);
                            let detail = match &public_event {
                                AuthQrEvent::Error { code, .. } => {
                                    format!(",\"authCode\":\"{}\"", code)
                                }
                                _ => String::new(),
                            };
                            eprintln!(
                                "{{\"level\":\"debug\",\"code\":\"auth_qr_event_received\",\"state\":\"{}\"{} }}",
                                state, detail
                            );
                        }
                        if let AuthQrEvent::Authenticated { account, .. } = &public_event {
                            *auth_snapshot
                                .write()
                                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                                AuthSnapshot::authenticated(Some(account.clone()));
                        }
                        if app.emit(AUTH_QR_RENDERER_EVENT, &public_event).is_err() {
                            #[cfg(debug_assertions)]
                            eprintln!(
                                "{{\"level\":\"debug\",\"code\":\"auth_qr_event_emit_failed\"}}"
                            );
                        }
                    }
                    Ok(_) => {}
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .ok();
    (stop, thread)
}

#[cfg(all(windows, debug_assertions))]
fn auth_qr_event_state(event: &AuthQrEvent) -> &'static str {
    match event {
        AuthQrEvent::WaitingScan { .. } => "waitingScan",
        AuthQrEvent::WaitingConfirmation { .. } => "waitingConfirmation",
        AuthQrEvent::Authenticated { .. } => "authenticated",
        AuthQrEvent::Expired { .. } => "expired",
        AuthQrEvent::Rejected { .. } => "rejected",
        AuthQrEvent::Error { .. } => "error",
    }
}

#[cfg(windows)]
fn auth_qr_event_error(error: AuthQrEventError) -> AuthQrEvent {
    let retryable = matches!(
        error.error,
        AuthError::ProviderUnavailable | AuthError::NetworkUnavailable | AuthError::RateLimited
    );
    AuthQrEvent::Error {
        session_id: error.session_id,
        code: error.error.code().to_owned(),
        retryable,
    }
}

#[cfg(windows)]
impl Drop for AppState {
    fn drop(&mut self) {
        if let Some(stop) = &self.auth_event_stop {
            stop.store(true, Ordering::Release);
        }
        if let Some(thread) = self.auth_event_thread.take() {
            let _ = thread.join();
        }
        #[cfg(not(test))]
        self.spectrum.take();
        self.playback_session.take();
        self.smtc_dynamic_lyrics.take();
        self.smtc_artwork.take();
        self.playback.take();
        self.lyrics.take();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthSnapshot {
    state: AuthPublicState,
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<auth::PublicAccount>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicLogoutResult {
    upstream_revoked: bool,
    cover_cache_cleared: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmtcDynamicLyricsSetting {
    enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub preferred_quality: String,
    pub live_spectrum_enabled: bool,
    pub mv_fallback_enabled: bool,
}

impl SettingsSnapshot {
    fn from_settings(settings: &AppSettings) -> Self {
        Self {
            preferred_quality: match settings.preferred_quality {
                PreferredQuality::Flac => "flac",
                PreferredQuality::High320 => "320k",
                PreferredQuality::Standard128 => "128k",
            }
            .to_owned(),
            live_spectrum_enabled: settings.live_spectrum_enabled,
            mv_fallback_enabled: settings.mv_fallback_enabled,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum AuthPublicState {
    Unavailable,
    SignedOut,
    Authenticated,
}

impl AuthSnapshot {
    fn unavailable() -> Self {
        Self {
            state: AuthPublicState::Unavailable,
            account: None,
        }
    }

    fn signed_out() -> Self {
        Self {
            state: AuthPublicState::SignedOut,
            account: None,
        }
    }

    fn authenticated(account: Option<auth::PublicAccount>) -> Self {
        Self {
            state: AuthPublicState::Authenticated,
            account,
        }
    }
}

async fn run_auth_blocking<T>(
    operation: impl FnOnce() -> Result<T, AuthError> + Send + 'static,
) -> Result<T, PublicError>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| provider_unavailable())?
        .map_err(public_auth_error)
}

async fn run_session_blocking<T>(
    operation: impl FnOnce() -> Result<T, PlaybackSessionError> + Send + 'static,
) -> Result<T, PublicError>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| playback_unavailable())?
        .map_err(public_session_error)
}

async fn run_queue_blocking<T>(
    operation: impl FnOnce() -> Result<T, QueueError> + Send + 'static,
) -> Result<T, PublicError>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| queue_unavailable())?
        .map_err(public_queue_error)
}

async fn run_library_blocking<T>(
    operation: impl FnOnce() -> Result<T, LibraryError> + Send + 'static,
) -> Result<T, PublicError>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| provider_unavailable())?
        .map_err(public_library_error)
}

async fn run_organizer_blocking<T>(
    operation: impl FnOnce() -> Result<T, OrganizerError> + Send + 'static,
) -> Result<T, PublicError>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| queue_unavailable())?
        .map_err(public_organizer_error)
}

fn authenticated_account_id(state: &AppState) -> Result<String, PublicError> {
    state
        .auth_snapshot
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .account
        .as_ref()
        .map(|account| account.music_id.clone())
        .ok_or_else(|| {
            PublicError::new(
                PublicErrorKind::AuthenticationRequired,
                Operation::LibraryWrite,
            )
        })
}

fn provider_unavailable() -> PublicError {
    PublicError::new(
        PublicErrorKind::ProviderUnavailable,
        Operation::Authentication,
    )
}

fn playback_unavailable() -> PublicError {
    PublicError::new(PublicErrorKind::PlaybackUnavailable, Operation::Playback)
}

fn queue_unavailable() -> PublicError {
    PublicError::new(
        PublicErrorKind::LocalStateUnavailable,
        Operation::Persistence,
    )
}

fn persistence_unavailable() -> PublicError {
    PublicError::new(
        PublicErrorKind::LocalStateUnavailable,
        Operation::Persistence,
    )
}

fn public_persistence_error(error: PersistenceError) -> PublicError {
    let kind = match error {
        PersistenceError::InvalidData | PersistenceError::LimitExceeded => {
            PublicErrorKind::InvalidRequest
        }
        PersistenceError::Unavailable | PersistenceError::IncompatibleSchema => {
            PublicErrorKind::LocalStateUnavailable
        }
    };
    PublicError::new(kind, Operation::Persistence)
}

fn cover_unavailable() -> PublicError {
    PublicError::new(
        PublicErrorKind::LocalStateUnavailable,
        Operation::CatalogRead,
    )
}

fn public_cover_error(error: CoverError) -> PublicError {
    let kind = match error {
        CoverError::InvalidKey => PublicErrorKind::InvalidRequest,
        CoverError::NetworkUnavailable => PublicErrorKind::NetworkUnavailable,
        CoverError::CacheUnavailable => PublicErrorKind::LocalStateUnavailable,
        CoverError::UnsafeUrl
        | CoverError::RedirectRejected
        | CoverError::CoverUnavailable
        | CoverError::UnsupportedImage
        | CoverError::ImageTooLarge => PublicErrorKind::ProviderUnavailable,
    };
    PublicError::new(kind, Operation::CatalogRead)
}

fn public_queue_error(error: QueueError) -> PublicError {
    let kind = match error {
        QueueError::InvalidItem | QueueError::InvalidIndex | QueueError::LimitExceeded => {
            PublicErrorKind::InvalidRequest
        }
        QueueError::PersistenceUnavailable => PublicErrorKind::LocalStateUnavailable,
    };
    PublicError::new(kind, Operation::Persistence)
}

fn public_session_error(error: PlaybackSessionError) -> PublicError {
    match error {
        PlaybackSessionError::InvalidMode => {
            PublicError::new(PublicErrorKind::InvalidRequest, Operation::Playback)
        }
        PlaybackSessionError::Superseded => {
            PublicError::new(PublicErrorKind::PlaybackUnavailable, Operation::Playback)
        }
        PlaybackSessionError::Queue(error) => public_queue_error(error),
        PlaybackSessionError::Playback(error) => public_playback_error(error),
        PlaybackSessionError::LocalMusic(error) => public_local_music_error(error),
    }
}

fn public_lyric_error(error: LyricError) -> PublicError {
    let kind = match error {
        LyricError::InvalidRequest => PublicErrorKind::InvalidRequest,
        LyricError::ProviderUnavailable => PublicErrorKind::ProviderUnavailable,
        LyricError::NetworkUnavailable => PublicErrorKind::NetworkUnavailable,
        LyricError::UpstreamUnavailable => PublicErrorKind::ProviderUnavailable,
        LyricError::AuthenticationRequired => PublicErrorKind::AuthenticationRequired,
        LyricError::Unavailable => PublicErrorKind::ProviderUnavailable,
        LyricError::UpstreamSchemaChanged => PublicErrorKind::UpstreamSchemaChanged,
    };
    PublicError::new(kind, Operation::CatalogRead)
}

fn public_catalog_error(error: CatalogError) -> PublicError {
    let kind = match error {
        CatalogError::InvalidRequest => PublicErrorKind::InvalidRequest,
        CatalogError::ProviderUnavailable => PublicErrorKind::ProviderUnavailable,
        CatalogError::NetworkUnavailable => PublicErrorKind::NetworkUnavailable,
        CatalogError::AuthenticationRequired => PublicErrorKind::AuthenticationRequired,
        CatalogError::Unavailable => PublicErrorKind::ProviderUnavailable,
        CatalogError::UpstreamSchemaChanged => PublicErrorKind::UpstreamSchemaChanged,
    };
    PublicError::new(kind, Operation::CatalogRead)
}

fn public_library_error(error: LibraryError) -> PublicError {
    let kind = match error {
        LibraryError::InvalidRequest => PublicErrorKind::InvalidRequest,
        LibraryError::ProviderUnavailable | LibraryError::Unavailable => {
            PublicErrorKind::ProviderUnavailable
        }
        LibraryError::NetworkUnavailable => PublicErrorKind::NetworkUnavailable,
        LibraryError::AuthenticationRequired => PublicErrorKind::AuthenticationRequired,
        LibraryError::WriteRejected => PublicErrorKind::AccessDenied,
        LibraryError::OutcomeUnknown => PublicErrorKind::WriteOutcomeUnknown,
        LibraryError::UpstreamSchemaChanged => PublicErrorKind::UpstreamSchemaChanged,
    };
    PublicError::new(kind, Operation::LibraryWrite)
}

fn public_organizer_error(error: OrganizerError) -> PublicError {
    let kind = match error {
        OrganizerError::InvalidRequest | OrganizerError::PlanUnavailable => {
            PublicErrorKind::InvalidRequest
        }
        OrganizerError::AuthenticationRequired | OrganizerError::PlanAccountChanged => {
            PublicErrorKind::AuthenticationRequired
        }
        OrganizerError::PlaylistUnavailable => PublicErrorKind::ProviderUnavailable,
        OrganizerError::PlanExpired => PublicErrorKind::OrganizerPlanExpired,
        OrganizerError::PlanDrifted => PublicErrorKind::OrganizerPlanDrifted,
        OrganizerError::WriteRejected => PublicErrorKind::AccessDenied,
        OrganizerError::OutcomeUnknown => PublicErrorKind::WriteOutcomeUnknown,
        OrganizerError::PersistenceUnavailable => PublicErrorKind::LocalStateUnavailable,
    };
    PublicError::new(kind, Operation::LibraryWrite)
}

fn public_playback_error(error: PlaybackError) -> PublicError {
    let kind = match error {
        PlaybackError::InvalidRequest => PublicErrorKind::InvalidRequest,
        PlaybackError::ProviderUnavailable => PublicErrorKind::PlaybackUnavailable,
        PlaybackError::NativePlayerUnavailable => PublicErrorKind::NativePlayerUnavailable,
        PlaybackError::NetworkUnavailable => PublicErrorKind::NetworkUnavailable,
        PlaybackError::AuthenticationRequired => PublicErrorKind::AuthenticationRequired,
        PlaybackError::EntitlementDenied => PublicErrorKind::PlaybackEntitlementDenied,
        PlaybackError::DeviceLimit => PublicErrorKind::PlaybackDeviceLimit,
        PlaybackError::Unavailable => PublicErrorKind::PlaybackUnavailable,
        PlaybackError::UnsafeMediaUrl => PublicErrorKind::UnsafeMediaUrl,
        PlaybackError::LocalFileMissing => PublicErrorKind::LocalMusicFileMissing,
        PlaybackError::LocalCodecUnavailable => PublicErrorKind::LocalMusicCodecUnavailable,
        PlaybackError::UpstreamSchemaChanged => PublicErrorKind::UpstreamSchemaChanged,
    };
    PublicError::new(kind, Operation::Playback)
}

fn local_music_unavailable() -> PublicError {
    PublicError::new(
        PublicErrorKind::LocalMusicStorageUnavailable,
        Operation::LocalMusic,
    )
}

fn public_local_music_error(error: LocalMusicError) -> PublicError {
    let kind = match error {
        LocalMusicError::StorageUnavailable => PublicErrorKind::LocalMusicStorageUnavailable,
        LocalMusicError::CodecUnavailable => PublicErrorKind::LocalMusicCodecUnavailable,
        LocalMusicError::FileMissing => PublicErrorKind::LocalMusicFileMissing,
        LocalMusicError::InvalidTrackId
        | LocalMusicError::InvalidFile
        | LocalMusicError::UnsupportedFormat
        | LocalMusicError::FileTooLarge
        | LocalMusicError::MetadataUnreadable
        | LocalMusicError::CopyFailed
        | LocalMusicError::StorageConflict => PublicErrorKind::InvalidRequest,
        LocalMusicError::DeleteFailed => PublicErrorKind::LocalMusicDeleteFailed,
        LocalMusicError::OutcomeUnknown => PublicErrorKind::LocalMusicOutcomeUnknown,
    };
    PublicError::new(kind, Operation::LocalMusic)
}

fn public_auth_error(error: AuthError) -> PublicError {
    let kind = match error {
        AuthError::NetworkUnavailable | AuthError::RateLimited => {
            PublicErrorKind::NetworkUnavailable
        }
        AuthError::AccountRestricted | AuthError::DeviceLimit => PublicErrorKind::AccessDenied,
        AuthError::CredentialUnavailable => PublicErrorKind::SecureStorageUnavailable,
        AuthError::CredentialInvalid => PublicErrorKind::AuthenticationRequired,
        AuthError::UpstreamSchemaChanged | AuthError::InvalidResponse => {
            PublicErrorKind::UpstreamSchemaChanged
        }
        AuthError::ProviderUnavailable => PublicErrorKind::ProviderUnavailable,
        AuthError::ProviderRejected | AuthError::SessionNotFound => PublicErrorKind::InvalidRequest,
    };
    PublicError::new(kind, Operation::Authentication)
}

#[cfg(windows)]
fn provider_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        let development =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../provider/dist/qqmusic-provider");
        if development.is_dir() {
            return Some(development);
        }
    }
    app.path()
        .resource_dir()
        .ok()
        .map(|root| root.join("provider"))
}

#[cfg(windows)]
fn queue_service(app: &tauri::AppHandle) -> Option<QueueService> {
    let root = app.path().app_data_dir().ok()?;
    fs::create_dir_all(&root).ok()?;
    let mut queue = QueueService::open(&root.join("state.sqlite3")).ok()?;
    queue.shuffle_path = std::env::current_exe()
        .ok()?
        .parent()?
        .join("smart-shuffle.sqlite3");
    Some(queue)
}

#[cfg(windows)]
fn persistence_service(app: &tauri::AppHandle) -> Option<PersistenceService> {
    let root = app.path().app_data_dir().ok()?;
    fs::create_dir_all(&root).ok()?;
    PersistenceService::open(&root.join("state.sqlite3")).ok()
}

fn playback_quality_from_preferred(quality: PreferredQuality) -> PlaybackQuality {
    match quality {
        PreferredQuality::Flac => PlaybackQuality::Flac,
        PreferredQuality::High320 => PlaybackQuality::Kbps320,
        PreferredQuality::Standard128 => PlaybackQuality::Kbps128,
    }
}

fn preferred_quality_from_playback(quality: PlaybackQuality) -> Option<PreferredQuality> {
    match quality {
        PlaybackQuality::Flac => Some(PreferredQuality::Flac),
        PlaybackQuality::Kbps320 => Some(PreferredQuality::High320),
        PlaybackQuality::Kbps128 => Some(PreferredQuality::Standard128),
        PlaybackQuality::Auto => None,
    }
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        desktop::show_main_window(app);
    }));
    #[cfg(feature = "desktop-e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio_webdriver::init())
        .plugin(tauri_plugin_wdio::init());

    builder
        .setup(|app| {
            file_logging::initialize();
            #[cfg(windows)]
            {
                app.manage(AppState::initialize(app.handle()));
                desktop::install_tray(app.handle())?;
            }
            #[cfg(not(windows))]
            app.manage(AppState::bootstrap());
            file_logging::event("app_ready");
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(windows)]
            desktop::handle_window_event(window, event);
        })
        .invoke_handler(tauri::generate_handler![
            file_logging::logging_status,
            file_logging::logging_set_enabled,
            file_logging::logging_frontend_error,
            commands::remote::remote_status,
            commands::remote::remote_set_enabled,
            commands::playback::playback_history,
            commands::personal::personal_library,
            commands::playback::smart_shuffle_status,
            commands::playback::smart_shuffle_set_enabled,
            commands::settings::app_snapshot,
            commands::auth::auth_status,
            commands::auth::auth_recover,
            commands::auth::auth_qr_start,
            commands::auth::auth_qr_poll,
            commands::auth::auth_qr_cancel,
            commands::auth::auth_logout,
            commands::catalog::cover_get,
            commands::playback::player_snapshot,
            commands::playback::player_play,
            commands::playback::player_pause,
            commands::playback::player_stop,
            commands::playback::player_seek,
            commands::playback::player_set_volume,
            commands::playback::player_set_muted,
            commands::catalog::lyrics_get,
            commands::settings::smtc_dynamic_lyrics_set_enabled,
            commands::catalog::catalog_search_songs,
            commands::catalog::catalog_discover_new_songs,
            commands::catalog::catalog_playlist_songs,
            commands::catalog::catalog_artist_detail,
            commands::catalog::catalog_song_artists,
            commands::catalog::catalog_artist_songs,
            commands::catalog::catalog_search_entities,
            commands::catalog::catalog_album_detail,
            commands::catalog::catalog_album_songs,
            commands::catalog::catalog_artist_albums,
            commands::library::library_playlists,
            commands::library::library_liked_songs,
            commands::library::library_create_playlist,
            commands::library::library_delete_playlist,
            commands::library::library_add_songs,
            commands::library::library_remove_songs,
            commands::library::library_set_liked,
            commands::library::library_set_favorite_playlist,
            commands::local_music::local_music_list,
            commands::local_music::local_music_import,
            commands::local_music::local_music_delete,
            commands::library::organizer_preview,
            commands::library::organizer_execute,
            commands::playback::queue_snapshot,
            commands::playback::queue_replace,
            commands::playback::queue_enqueue,
            commands::playback::queue_enqueue_many,
            commands::playback::queue_enqueue_next,
            commands::playback::playback_set_mv_lyric_offset,
            commands::settings::settings_set_mv_fallback_enabled,
            commands::playback::queue_remove,
            commands::playback::queue_move,
            commands::playback::queue_play,
            commands::settings::settings_snapshot,
            commands::settings::settings_set_preferred_quality,
            commands::settings::settings_set_live_spectrum_enabled,
            commands::settings::spectrum_set_stage_active,
            commands::playback::playback_change_quality,
            commands::playback::playback_session_snapshot,
            commands::playback::playback_set_mode,
            commands::playback::queue_preview_next,
            commands::playback::queue_next,
            commands::playback::queue_previous,
            desktop::tray_menu_action
        ])
        .build(tauri::generate_context!())
        .expect("failed to build QQ Music GUI")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                file_logging::event("app_exit");
            }
            #[cfg(windows)]
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                if desktop::should_prevent_exit(code) {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_snapshot_is_stable_and_redacted() {
        let snapshot = AppState::bootstrap().snapshot();

        assert_eq!(snapshot.schema_version, SNAPSHOT_SCHEMA_VERSION);
        assert_eq!(snapshot.provider, ProviderSnapshot::not_started());
        assert_eq!(snapshot.player, PlayerSnapshot::idle());
        assert!(!snapshot.extensions.playlist_rename);
        assert!(!snapshot.extensions.playlist_description_edit);

        let value = serde_json::to_value(snapshot).expect("snapshot must serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
                "appVersion": env!("CARGO_PKG_VERSION"),
                "target": {
                    "os": std::env::consts::OS,
                    "architecture": std::env::consts::ARCH,
                },
                "provider": {
                    "protocolVersion": provider::PROVIDER_PROTOCOL_VERSION,
                    "state": "notStarted",
                },
                "player": {
                    "state": "idle",
                    "generation": 0,
                    "positionMs": 0,
                    "durationMs": null,
                    "volume": 1.0,
                    "muted": false,
                    "currentTrack": null,
                    "failure": null,
                },
                "extensions": {
                    "playlistRename": false,
                    "playlistDescriptionEdit": false,
                },
            })
        );
    }

    #[test]
    fn bootstrap_snapshot_uses_camel_case_wire_names() {
        let value = serde_json::to_value(AppState::bootstrap().snapshot())
            .expect("snapshot must serialize");

        assert_eq!(value["schemaVersion"], SNAPSHOT_SCHEMA_VERSION);
        assert_eq!(value["provider"]["state"], "notStarted");
        assert_eq!(value["player"]["state"], "idle");
        assert_eq!(value["extensions"]["playlistRename"], false);
    }

    #[test]
    fn settings_snapshot_is_strict_camel_case_and_defaults_spectrum_off() {
        let value = serde_json::to_value(SettingsSnapshot::from_settings(&AppSettings::default()))
            .expect("settings snapshot must serialize");

        assert_eq!(
            value,
            serde_json::json!({
                "preferredQuality": "320k",
                "liveSpectrumEnabled": false,
                "mvFallbackEnabled": true,
            })
        );
    }

    #[test]
    fn credential_sentinel_never_enters_sqlite_or_wal() {
        use crate::credentials::{CredentialStore, MemoryCredentialStore, SecretBlob};
        use crate::persistence::{PersistedTrack, PersistenceService};
        use std::fs;
        use uuid::Uuid;

        let root = std::env::temp_dir().join(format!("qqmusic-gui-boundary-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create boundary test root");
        let persistence =
            PersistenceService::open(&root.join("state.sqlite3")).expect("open persistence");
        persistence
            .replace_queue(&[PersistedTrack {
                track_id: "fixture-track".to_owned(),
                media_mid: None,
                title: "纸月光".to_owned(),
                artist: "林间电台".to_owned(),
                album: "温室唱片".to_owned(),
                duration_ms: 234_567,
                cover_cache_key: Some("cover_fixture".to_owned()),
            }])
            .expect("persist non-secret queue");

        let sentinel = b"Cookie=SENTINEL_COOKIE;qqmusic_key=SENTINEL_KEY";
        let credential_store = MemoryCredentialStore::default();
        credential_store
            .replace(&SecretBlob::new(sentinel.to_vec()).expect("sentinel secret"))
            .expect("store sentinel only in credential backend");
        assert_eq!(
            credential_store
                .read()
                .expect("read sentinel")
                .expect("stored sentinel")
                .payload(),
            sentinel
        );

        for entry in fs::read_dir(&root).expect("list SQLite files") {
            let path = entry.expect("SQLite file entry").path();
            if !path.is_file() {
                continue;
            }
            let bytes = fs::read(&path).expect("read SQLite boundary file");
            assert!(
                !bytes
                    .windows(sentinel.len())
                    .any(|window| window == sentinel),
                "credential sentinel leaked into local state file"
            );
            assert!(!bytes.windows(15).any(|window| window == b"SENTINEL_COOKIE"));
            assert!(!bytes.windows(12).any(|window| window == b"SENTINEL_KEY"));
        }

        drop(persistence);
        let _ = fs::remove_dir_all(root);
    }
}
