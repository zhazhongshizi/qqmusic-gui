mod library;
pub(crate) use library::RemoteLibrary;
// Opt-in LAN remote. Only explicit playback operations cross this boundary.
// The desktop owns credentials, sources and the single PlaybackSession.
use crate::{
    cover::CoverService,
    lyrics::LyricService,
    playback_session::{PlaybackMode, PlaybackSession, PlaybackSessionError},
};
use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, ToSocketAddrs, UdpSocket},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::{oneshot, Semaphore};

const PORT: u16 = 19653;
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub addresses: Vec<String>,
    pub pairing_code: Option<String>,
}

#[derive(Default)]
pub struct RemoteControl {
    running: Mutex<Option<Running>>,
}
struct Running {
    status: RemoteStatus,
    alive: Arc<AtomicBool>,
    stop: Option<oneshot::Sender<()>>,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

impl RemoteControl {
    pub fn status(&self) -> RemoteStatus {
        self.running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|r| r.alive.load(Ordering::Acquire))
            .map(|r| r.status.clone())
            .unwrap_or_default()
    }

    pub fn set_enabled(
        &self,
        enabled: bool,
        session: Option<Arc<PlaybackSession>>,
        cover: Option<Arc<CoverService>>,
        lyrics: Option<Arc<LyricService>>,
        library: Option<Arc<RemoteLibrary>>,
    ) -> Result<RemoteStatus, &'static str> {
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !enabled {
            *running = None;
            return Ok(RemoteStatus::default());
        }
        if let Some(r) = running.as_ref().filter(|r| r.alive.load(Ordering::Acquire)) {
            return Ok(r.status.clone());
        }
        let session = session.ok_or("播放核心尚未就绪")?;
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, PORT))
            .map_err(|_| "遥控端口 19653 被占用或无法监听")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "无法启动局域网遥控")?;
        let code = uuid::Uuid::new_v4().simple().to_string();
        let alive = Arc::new(AtomicBool::new(true));
        let status = RemoteStatus {
            enabled: true,
            addresses: addresses(PORT),
            pairing_code: Some(code.clone()),
        };
        let data = Arc::new(RemoteState {
            session,
            cover,
            lyrics,
            library,
            code,
            alive: alive.clone(),
            permits: Arc::new(Semaphore::new(4)),
            port: PORT,
        });
        let (stop, stopped) = oneshot::channel();
        let server_alive = alive.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
                let _ = axum::serve(
                    listener,
                    router(data).into_make_service_with_connect_info::<SocketAddr>(),
                )
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await;
            }
            server_alive.store(false, Ordering::Release);
        });
        *running = Some(Running {
            status: status.clone(),
            alive,
            stop: Some(stop),
        });
        Ok(status)
    }
}

fn addresses(port: u16) -> Vec<String> {
    let mut result = Vec::new();
    // UDP connect selects the current route; it does not transmit a packet.
    if let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) {
        if socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).is_ok() {
            if let Ok(addr) = socket.local_addr() {
                if lan_ip(addr.ip()) && !addr.ip().is_loopback() {
                    result.push(format!("http://{}:{port}", addr.ip()));
                }
            }
        }
    }
    // A VPN may own the default route. Also list this computer's LAN interfaces.
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        if let Ok(addrs) = (name.as_str(), port).to_socket_addrs() {
            for addr in addrs {
                let address = format!("http://{}:{port}", addr.ip());
                if lan_ip(addr.ip()) && !addr.ip().is_loopback() && !result.contains(&address) {
                    result.push(address);
                }
            }
        }
    }
    result.push(format!("http://127.0.0.1:{port}"));
    result
}

struct RemoteState {
    session: Arc<PlaybackSession>,
    cover: Option<Arc<CoverService>>,
    lyrics: Option<Arc<LyricService>>,
    library: Option<Arc<RemoteLibrary>>,
    code: String,
    alive: Arc<AtomicBool>,
    permits: Arc<Semaphore>,
    port: u16,
}

fn router(state: Arc<RemoteState>) -> Router {
    Router::new()
        .route(
            "/",
            get(|| async {
                (
                    [("content-type", "text/html; charset=utf-8")],
                    include_str!("../../src/remote/index.html"),
                )
            }),
        )
        .route(
            "/remote.js",
            get(|| async {
                (
                    [("content-type", "text/javascript; charset=utf-8")],
                    include_str!("../remote-dist/remote.js"),
                )
            }),
        )
        .route(
            "/remote.css",
            get(|| async {
                (
                    [("content-type", "text/css; charset=utf-8")],
                    include_str!("../remote-dist/remote.css"),
                )
            }),
        )
        .route("/api/state", get(snapshot))
        .route("/api/preview", get(preview))
        .route(
            "/api/library",
            post(library::request).layer(DefaultBodyLimit::max(192 * 1024)),
        )
        .route("/api/library-cover", get(library::cover))
        .route("/api/command", post(command))
        .route("/api/lyrics", get(lyrics))
        .route("/api/cover", get(cover))
        .layer(DefaultBodyLimit::max(2048))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

fn lan_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_loopback() || v.is_link_local(),
        IpAddr::V6(_) => false,
    }
}
fn valid_host(host: &str, port: u16) -> bool {
    host.parse::<SocketAddr>()
        .is_ok_and(|a| a.port() == port && lan_ip(a.ip()))
}
fn authorized(headers: &HeaderMap, code: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .is_some_and(|v| {
            v.len() == code.len()
                && v.bytes()
                    .zip(code.bytes())
                    .fold(0u8, |diff, (a, b)| diff | (a ^ b))
                    == 0
        })
}
async fn guard(State(state): State<Arc<RemoteState>>, request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let origin_ok = request
        .headers()
        .get("origin")
        .is_none_or(|o| o.to_str().is_ok_and(|o| o == format!("http://{host}")));
    let peer_ok = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|peer| lan_ip(peer.0.ip()));
    let mut response = if !state.alive.load(Ordering::Acquire) {
        error(StatusCode::SERVICE_UNAVAILABLE, "电脑已关闭遥控")
    } else if !peer_ok || !valid_host(host, state.port) || !origin_ok {
        error(StatusCode::FORBIDDEN, "请使用电脑显示的局域网地址")
    } else if request.uri().path().starts_with("/api/")
        && !authorized(request.headers(), &state.code)
    {
        error(
            StatusCode::UNAUTHORIZED,
            "连接码无效，请在电脑上查看新的连接信息",
        )
    } else {
        next.run(request).await
    };
    for (name, value) in [
        ("cache-control", "no-store"),
        ("content-security-policy", CSP),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
    ] {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    response
}
fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({"message": message}))).into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotQuery {
    known: Option<u64>,
}
async fn snapshot(
    State(state): State<Arc<RemoteState>>,
    Query(query): Query<SnapshotQuery>,
) -> Response {
    match tauri::async_runtime::spawn_blocking(move || state.session.snapshot_update(query.known))
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(_) => error(StatusCode::SERVICE_UNAVAILABLE, "无法读取播放状态"),
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    Play {},
    Pause {},
    Next {},
    Previous {},
    Seek {
        position_ms: u64,
        generation: u64,
    },
    Volume {
        value: f32,
    },
    Muted {
        value: bool,
    },
    Mode {
        value: String,
    },
    Quality {
        value: String,
    },
    MvLyricOffset {
        id: String,
        generation: u64,
        offset_ms: i64,
    },
    PlayTrack {
        id: String,
        queue_generation: u64,
    },
}
async fn command(State(state): State<Arc<RemoteState>>, Json(command): Json<Command>) -> Response {
    let Ok(permit) = state.permits.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "操作繁忙，请稍后重试");
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        if !state.alive.load(Ordering::Acquire) {
            return Err(PlaybackSessionError::Superseded);
        }
        let s = &state.session;
        match command {
            Command::Play {} => s.play().map(|value| serde_json::json!(value)),
            Command::Pause {} => s.pause().map(|value| serde_json::json!(value)),
            Command::Next {} => s.next().map(|value| serde_json::json!(value)),
            Command::Previous {} => s.previous().map(|value| serde_json::json!(value)),
            Command::Seek {
                position_ms,
                generation,
            } => s
                .seek_generation(position_ms, generation)
                .map(|value| serde_json::json!(value)),
            Command::Volume { value } if value.is_finite() && (0.0..=1.0).contains(&value) => {
                s.set_volume(value).map(|value| serde_json::json!(value))
            }
            Command::Muted { value } => s.set_muted(value).map(|value| serde_json::json!(value)),
            Command::Quality { value } => crate::playback::PlaybackQuality::parse(&value)
                .map_err(PlaybackSessionError::Playback)
                .and_then(|quality| s.change_quality(quality))
                .map(|value| serde_json::json!(value)),
            Command::MvLyricOffset {
                id,
                generation,
                offset_ms,
            } => s
                .set_mv_lyric_offset(&id, generation, offset_ms)
                .map(|value| serde_json::json!(value)),
            Command::Mode { value } => PlaybackMode::parse(&value)
                .and_then(|v| s.set_mode(v))
                .map(|value| serde_json::json!(value)),
            Command::PlayTrack {
                id,
                queue_generation,
            } if id.len() <= 128 => s
                .play_remote_track(&id, queue_generation)
                .map(|value| serde_json::json!(value)),
            _ => Err(PlaybackSessionError::InvalidMode),
        }
    })
    .await;
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(PlaybackSessionError::Superseded)) => {
            error(StatusCode::CONFLICT, "歌曲或队列已变化，请刷新后重试")
        }
        Ok(Err(e)) => (
            StatusCode::BAD_REQUEST,
            Json(crate::public_session_error(e)),
        )
            .into_response(),
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "播放操作未完成，请检查电脑状态",
        ),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TrackQuery {
    generation: u64,
    track: String,
}

fn display_track_id(snapshot: &crate::playback_session::PlaybackSessionSnapshot) -> Option<&str> {
    snapshot
        .player
        .current_track
        .as_ref()
        .map(|t| t.id.as_str())
        .or_else(|| {
            snapshot
                .queue
                .selected_index
                .and_then(|index| snapshot.queue.items.get(index))
                .map(|t| t.id.as_str())
        })
}
async fn lyrics(
    State(state): State<Arc<RemoteState>>,
    Query(query): Query<TrackQuery>,
) -> Response {
    let snapshot = state.session.snapshot();
    if snapshot.player.generation != query.generation
        || display_track_id(&snapshot) != Some(query.track.as_str())
    {
        return error(StatusCode::CONFLICT, "歌曲已变化");
    }
    if query.track.starts_with("local_") {
        return error(StatusCode::NOT_FOUND, "本地歌曲暂不提供歌词");
    }
    let Some(lyrics) = state.lyrics.clone() else {
        return error(StatusCode::NOT_FOUND, "暂无歌词");
    };
    let Ok(permit) = state.permits.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "请稍后重试");
    };
    match tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        lyrics.timeline(&query.track, query.generation)
    })
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        _ => error(StatusCode::NOT_FOUND, "暂无可用歌词"),
    }
}
async fn preview(State(state): State<Arc<RemoteState>>) -> Response {
    match tauri::async_runtime::spawn_blocking(move || state.session.preview_next_track()).await {
        Ok(value) => Json(value).into_response(),
        Err(_) => error(StatusCode::SERVICE_UNAVAILABLE, "无法读取下一首"),
    }
}

async fn cover(State(state): State<Arc<RemoteState>>, Query(query): Query<TrackQuery>) -> Response {
    let snapshot = state.session.snapshot();
    if snapshot.player.generation != query.generation
        || !snapshot
            .queue
            .items
            .iter()
            .any(|item| item.id == query.track)
    {
        return error(StatusCode::CONFLICT, "歌曲已变化");
    }
    let key = snapshot
        .queue
        .items
        .iter()
        .find(|q| q.id == query.track)
        .and_then(|q| q.cover_cache_key.clone());
    let (Some(key), Some(cover)) = (key, state.cover.clone()) else {
        return error(StatusCode::NOT_FOUND, "暂无封面");
    };
    let Ok(permit) = state.permits.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "请稍后重试");
    };
    match tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        cover.get(&key)
    })
    .await
    {
        Ok(Ok(value)) => ([("content-type", value.mime_type)], value.bytes).into_response(),
        _ => error(StatusCode::NOT_FOUND, "暂无封面"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_requires_literal_local_address_and_matching_port() {
        for host in ["192.168.1.8:19653", "10.0.0.1:19653", "127.0.0.1:19653"] {
            assert!(valid_host(host, PORT));
        }
        for host in [
            "evil.example:19653",
            "192.168.1.8:80",
            "8.8.8.8:19653",
            "192.168.1.8",
            "0.0.0.0:19653",
        ] {
            assert!(!valid_host(host, PORT));
        }
    }
    #[test]
    fn authorization_requires_exact_bearer_secret() {
        let mut h = HeaderMap::new();
        assert!(!authorized(&h, "secret"));
        h.insert("authorization", HeaderValue::from_static("Bearer secret"));
        assert!(authorized(&h, "secret"));
        assert!(!authorized(&h, "secrex"));
        assert!(!authorized(&h, "secret-extra"));
    }
    #[test]
    fn command_whitelist_rejects_arbitrary_methods_and_extra_fields() {
        for body in [
            r#"{"action":"authLogout"}"#,
            r#"{"action":"play","url":"http://example.com"}"#,
            r#"{"action":"playTrack","id":"one"}"#,
        ] {
            assert!(serde_json::from_str::<Command>(body).is_err());
        }
        assert!(serde_json::from_str::<Command>(
            r#"{"action":"seek","position_ms":1000,"generation":1}"#
        )
        .is_ok());
    }
    #[test]
    fn closing_service_revokes_existing_connections() {
        let alive = Arc::new(AtomicBool::new(true));
        let (tx, mut rx) = oneshot::channel();
        drop(Running {
            status: RemoteStatus::default(),
            alive: alive.clone(),
            stop: Some(tx),
        });
        assert!(!alive.load(Ordering::Acquire));
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn http_boundary_authenticates_and_controls_the_shared_session() {
        use crate::{
            playback::PlaybackController,
            player::{PlayerCommand, PlayerEngine, PlayerError, PlayerSnapshot, PlayerState},
            provider::{ProviderError, ProviderReply, ProviderRequest, ProviderRequestPort},
            queue::QueueService,
        };
        struct NoProvider;
        struct CatalogProvider;
        impl ProviderRequestPort for CatalogProvider {
            fn request(&self, _: ProviderRequest) -> Result<ProviderReply, ProviderError> {
                Ok(ProviderReply::Success { warnings: vec![], result: serde_json::json!({
                    "page": 1, "hasMore": false,
                    "items": [{"id":"remote-song", "title":"Remote song", "subtitle":"", "artists":[{"id":"artist1","name":"Artist"}], "album":{"id":"album1","title":"Album","publishDate":""}, "durationMs":20000,
                        "qualityCandidates":[{"quality":"flac","available":false,"requiresSubscription":false},{"quality":"320k","available":true,"requiresSubscription":false},{"quality":"128k","available":true,"requiresSubscription":false}],
                        "availability":{"status":"unknown","requiresSubscription":false}}]
                }).as_object().unwrap().clone() })
            }
        }
        impl ProviderRequestPort for NoProvider {
            fn request(&self, _: ProviderRequest) -> Result<ProviderReply, ProviderError> {
                panic!("remote transport must not call provider");
            }
        }
        struct TestPlayer(PlayerSnapshot);
        impl PlayerEngine for TestPlayer {
            fn snapshot(&self) -> PlayerSnapshot {
                self.0.clone()
            }
            fn handle(&mut self, command: PlayerCommand) -> Result<(), PlayerError> {
                match command {
                    PlayerCommand::Pause => self.0.state = PlayerState::Paused,
                    PlayerCommand::SetVolume { volume } => self.0.volume = volume.get(),
                    _ => {}
                }
                Ok(())
            }
        }
        let root = std::env::temp_dir().join(format!("qmg-remote-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let queue = Arc::new(QueueService::open(&root.join("state.sqlite3")).unwrap());
        queue
            .persistence
            .record_listening(
                "stats-song",
                "Statistics song",
                "Artist",
                1000,
                true,
                crate::personal::now_ms(),
            )
            .unwrap();
        let session = Arc::new(PlaybackSession::new(
            queue.clone(),
            Arc::new(PlaybackController::new(
                Arc::new(NoProvider),
                Box::new(TestPlayer(PlayerSnapshot::idle())),
            )),
        ));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let alive = Arc::new(AtomicBool::new(true));
        let data = Arc::new(RemoteState {
            session: session.clone(),
            cover: None,
            lyrics: None,
            library: Some(Arc::new(RemoteLibrary {
                local: Some(Arc::new(crate::local_music::LocalMusicService::new(
                    root.join("local-music"),
                ))),
                catalog: Some(Arc::new(crate::catalog::CatalogService::new(Arc::new(
                    CatalogProvider,
                )))),
                library: None,
                queue: Some(queue),
                auth: Arc::new(std::sync::RwLock::new(crate::AuthSnapshot::signed_out())),
                tracks: Mutex::new(std::collections::HashMap::new()),
                covers: Mutex::new(std::collections::HashSet::new()),
            })),
            code: "test-only-secret".into(),
            alive: alive.clone(),
            permits: Arc::new(Semaphore::new(4)),
            port,
        });
        let (stop, stopped) = oneshot::channel();
        let task = tauri::async_runtime::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            axum::serve(
                listener,
                router(data).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        });
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let url = format!("http://127.0.0.1:{port}");
        let page = client.get(&url).send().unwrap();
        assert_eq!(page.status(), 200);
        assert!(page.headers().contains_key("content-security-policy"));
        assert_eq!(
            client
                .get(format!("{url}/api/state"))
                .send()
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            client
                .get(format!("{url}/api/state"))
                .bearer_auth("wrong")
                .send()
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            client
                .get(format!("{url}/api/state"))
                .bearer_auth("test-only-secret")
                .header("Origin", "http://evil.example")
                .send()
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            client
                .get(format!("{url}/api/state"))
                .bearer_auth("test-only-secret")
                .header("Host", format!("evil.example:{port}"))
                .send()
                .unwrap()
                .status(),
            403
        );
        let response = client
            .get(format!("{url}/api/state"))
            .bearer_auth("test-only-secret")
            .send()
            .unwrap();
        assert_eq!(response.status(), 200);
        let snapshot: serde_json::Value = serde_json::from_str(&response.text().unwrap()).unwrap();
        assert!(snapshot["queue"].is_object());
        assert!(!snapshot.to_string().contains("secret"));
        let query = format!("{url}/api/state?known={}", snapshot["queue"]["generation"]);
        let delta: serde_json::Value = serde_json::from_str(
            &client
                .get(query)
                .bearer_auth("test-only-secret")
                .send()
                .unwrap()
                .text()
                .unwrap(),
        )
        .unwrap();
        assert!(delta["queue"].is_null());
        let send = |body: &str| {
            client
                .post(format!("{url}/api/command"))
                .bearer_auth("test-only-secret")
                .header("Content-Type", "application/json")
                .body(body.to_owned())
                .send()
                .unwrap()
        };
        let catalog = |body: &str| {
            client
                .post(format!("{url}/api/library"))
                .bearer_auth("test-only-secret")
                .header("Content-Type", "application/json")
                .body(body.to_owned())
                .send()
                .unwrap()
        };
        let auth = catalog(r#"{"command":"auth_status"}"#);
        assert_eq!(auth.status(), 200);
        assert_eq!(auth.text().unwrap(), r#"{"state":"signedOut"}"#);
        assert_eq!(
            catalog(r#"{"command":"queue_enqueue","id":"unseen"}"#).status(),
            400
        );
        assert_eq!(catalog(r#"{"command":"auth_logout"}"#).status(), 422);
        assert_eq!(
            catalog(r#"{"command":"local_music_delete","trackId":"local_fake"}"#).status(),
            422
        );
        let local = catalog(r#"{"command":"local_music_list"}"#);
        assert_eq!(local.status(), 200);
        let local: serde_json::Value = serde_json::from_str(&local.text().unwrap()).unwrap();
        assert_eq!(local, serde_json::json!({"tracks":[],"warningCount":0}));
        let volume = send(r#"{"action":"volume","value":0.37}"#);
        assert_eq!(volume.status(), 200);
        let volume: serde_json::Value = serde_json::from_str(&volume.text().unwrap()).unwrap();
        assert!((volume["volume"].as_f64().unwrap() - 0.37).abs() < 0.001);
        let preview = client
            .get(format!("{url}/api/preview"))
            .bearer_auth("test-only-secret")
            .send()
            .unwrap();
        assert_eq!(preview.status(), 200);
        assert_eq!(preview.text().unwrap(), "null");
        let page = catalog(
            r#"{"command":"catalog_search_songs","keyword":"Remote","page":1,"pageSize":20,"generation":42}"#,
        );
        assert_eq!(page.status(), 200);
        let page: serde_json::Value = serde_json::from_str(&page.text().unwrap()).unwrap();
        assert_eq!(page["generation"], 42);
        assert_eq!(page["items"][0]["id"], "remote-song");
        let queued = catalog(r#"{"command":"queue_enqueue","id":"remote-song"}"#);
        assert_eq!(queued.status(), 200);
        let queued: serde_json::Value = serde_json::from_str(&queued.text().unwrap()).unwrap();
        assert_eq!(queued["items"][0]["title"], "Remote song");
        assert_eq!(session.snapshot().queue.items[0].id, "remote-song");
        let next = catalog(r#"{"command":"queue_enqueue_next","id":"remote-song"}"#);
        assert_eq!(next.status(), 200);
        assert!(next.text().unwrap().contains("Remote song"));
        assert_eq!(
            catalog(r#"{"command":"queue_enqueue_next","id":"unseen"}"#).status(),
            400
        );
        let queue_before = session.snapshot().queue;
        assert_eq!(
            catalog(r#"{"command":"queue_replace","ids":["remote-song","unseen"]}"#).status(),
            400
        );
        assert_eq!(session.snapshot().queue, queue_before);
        assert_eq!(
            catalog(r#"{"command":"queue_replace","ids":["remote-song"]}"#).status(),
            200
        );
        assert!((session.snapshot().player.volume - 0.37).abs() < 0.001);
        let before_batch = session.snapshot().queue;
        assert_eq!(
            catalog(r#"{"command":"queue_enqueue_many","ids":["remote-song","unseen"]}"#).status(),
            400
        );
        assert_eq!(session.snapshot().queue, before_batch);
        assert_eq!(
            catalog(r#"{"command":"personal_library","request":{"action":"statistics"}}"#).status(),
            200
        );
        assert_eq!(
            catalog(r#"{"command":"queue_enqueue_many","ids":["remote-song","stats-song"]}"#)
                .status(),
            200
        );
        assert_eq!(session.snapshot().queue.items.len(), 2);
        assert_eq!(
            catalog(
                r#"{"command":"personal_library","request":{"action":"saveQueue","name":"work"}}"#
            )
            .status(),
            200
        );
        let preview = catalog(
            r#"{"command":"personal_library","request":{"action":"previewQueue","name":"work"}}"#,
        );
        assert_eq!(preview.status(), 200);
        let preview: serde_json::Value = serde_json::from_str(&preview.text().unwrap()).unwrap();
        assert_eq!(preview["items"].as_array().unwrap().len(), 2);
        assert_eq!(catalog(r#"{"command":"personal_library","request":{"action":"renameQueue","name":"work","target":"commute"}}"#).status(),200);
        assert_eq!(catalog(r#"{"command":"personal_library","request":{"action":"deleteQueue","name":"commute"}}"#).status(),200);
        assert_eq!(
            catalog(r#"{"command":"personal_library","request":{"action":"undoDeleteQueue"}}"#)
                .status(),
            200
        );
        assert_eq!(send(r#"{"action":"volume","value":2}"#).status(), 400);
        assert_eq!(
            send(r#"{"action":"seek","generation":999,"position_ms":100}"#).status(),
            409
        );
        assert_eq!(send(r#"{"action":"authLogout"}"#).status(), 422);
        assert_eq!(
            send(&format!(
                r#"{{"action":"play","extra":"{}"}}"#,
                "x".repeat(3000)
            ))
            .status(),
            413
        );
        alive.store(false, Ordering::Release);
        assert_eq!(send(r#"{"action":"volume","value":0.9}"#).status(), 503);
        assert!((session.snapshot().player.volume - 0.37).abs() < 0.001);
        let _ = stop.send(());
        drop(client);
        tauri::async_runtime::block_on(task).unwrap();
        drop(session);
        std::fs::remove_dir_all(root).unwrap();
    }
}
