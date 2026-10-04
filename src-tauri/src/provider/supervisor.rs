use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::OsString,
    io::{self, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError},
        Arc, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::{Map, Value};
use zeroize::{Zeroize, Zeroizing};

use super::{
    protocol::{read_provider_frame, ProviderFailure},
    ProtocolError, ProviderFrame, ProviderSnapshot, RequestFrame, WarningFrame, MAX_LINE_BYTES,
    PROVIDER_PROTOCOL_VERSION,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_HANDSHAKE_ITEMS: usize = 128;
const EVENT_BUFFER: usize = 64;
const COORDINATOR_POLL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    InvalidLaunch,
    SpawnFailed,
    HandshakeFailed,
    ProtocolViolation(&'static str),
    RequestTimeout,
    Cancelled,
    Unavailable,
    OutcomeUnknown,
    SupervisorStopped,
}

impl ProviderError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidLaunch => "provider_invalid_launch",
            Self::SpawnFailed => "provider_spawn_failed",
            Self::HandshakeFailed => "provider_handshake_failed",
            Self::ProtocolViolation(_) => "provider_protocol_violation",
            Self::RequestTimeout => "provider_request_timeout",
            Self::Cancelled => "provider_request_cancelled",
            Self::Unavailable => "provider_unavailable",
            Self::OutcomeUnknown => "provider_write_outcome_unknown",
            Self::SupervisorStopped => "provider_supervisor_stopped",
        }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ProtocolViolation(code) => write!(formatter, "{}: {code}", self.code()),
            _ => formatter.write_str(self.code()),
        }
    }
}

impl std::error::Error for ProviderError {}

#[derive(Debug, Clone)]
pub struct ProviderLaunch {
    executable: PathBuf,
    args: Vec<OsString>,
    current_dir: Option<PathBuf>,
}

impl ProviderLaunch {
    pub fn new(executable: impl Into<PathBuf>) -> Result<Self, ProviderError> {
        let executable = executable.into();
        if !executable.is_absolute() || !executable.is_file() {
            return Err(ProviderError::InvalidLaunch);
        }
        Ok(Self {
            executable,
            args: Vec::new(),
            current_dir: None,
        })
    }

    pub fn args(mut self, args: impl IntoIterator<Item = impl Into<OsString>>) -> Self {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    pub fn current_dir(mut self, directory: impl Into<PathBuf>) -> Result<Self, ProviderError> {
        let directory = directory.into();
        if !directory.is_absolute() || !directory.is_dir() {
            return Err(ProviderError::InvalidLaunch);
        }
        self.current_dir = Some(directory);
        Ok(self)
    }
}

#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    pub handshake_timeout: Duration,
    pub request_timeout: Duration,
    pub restart_backoff: Duration,
    pub max_restarts: u8,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            handshake_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(30),
            restart_backoff: Duration::from_millis(100),
            max_restarts: 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestSemantics {
    ReadOnlyReplayable,
    WriteNeverReplay,
}

#[derive(Clone)]
pub struct ProviderRequest {
    method: String,
    params: Map<String, Value>,
    semantics: RequestSemantics,
    timeout: Option<Duration>,
}

impl std::fmt::Debug for ProviderRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProviderRequest")
            .field("method", &self.method)
            .field("params", &"[REDACTED]")
            .field("semantics", &self.semantics)
            .field("timeout", &self.timeout)
            .finish()
    }
}

impl Drop for ProviderRequest {
    fn drop(&mut self) {
        self.method.zeroize();
        zeroize_json_map(&mut self.params);
    }
}

impl ProviderRequest {
    pub fn read_only(method: impl Into<String>, params: Map<String, Value>) -> Self {
        Self {
            method: method.into(),
            params,
            semantics: RequestSemantics::ReadOnlyReplayable,
            timeout: None,
        }
    }

    pub fn write(method: impl Into<String>, params: Map<String, Value>) -> Self {
        Self {
            method: method.into(),
            params,
            semantics: RequestSemantics::WriteNeverReplay,
            timeout: None,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub(crate) fn semantics(&self) -> RequestSemantics {
        self.semantics
    }
}

#[derive(Clone, PartialEq)]
pub enum ProviderReply {
    Success {
        result: Map<String, Value>,
        warnings: Vec<WarningFrame>,
    },
    Failure {
        code: String,
        retryable: bool,
    },
}

impl std::fmt::Debug for ProviderReply {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Success { warnings, .. } => formatter
                .debug_struct("Success")
                .field("result", &"[REDACTED]")
                .field("warnings", warnings)
                .finish(),
            Self::Failure { code, retryable } => formatter
                .debug_struct("Failure")
                .field("code", code)
                .field("retryable", retryable)
                .finish(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderEvent {
    pub name: String,
    pub payload: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderCapabilities {
    pub auth_methods: Vec<String>,
    pub search_types: Vec<String>,
    pub recommend_modules: Vec<String>,
    pub playlist_writes: Vec<String>,
    pub lyric_variants: Vec<String>,
    pub quality_candidates: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandshakeInfo {
    pub provider_name: String,
    pub provider_version: String,
    pub provider_mode: String,
    pub implemented_methods: Vec<String>,
    pub capabilities: ProviderCapabilities,
}

pub struct PendingProviderRequest {
    id: String,
    inbound: Sender<Inbound>,
    response: Receiver<Result<ProviderReply, ProviderError>>,
    finished: bool,
}

impl PendingProviderRequest {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn wait(mut self) -> Result<ProviderReply, ProviderError> {
        let response = self
            .response
            .recv()
            .unwrap_or(Err(ProviderError::SupervisorStopped));
        self.finished = true;
        response
    }

    pub fn cancel(mut self) -> Result<(), ProviderError> {
        self.inbound
            .send(Inbound::Cancel {
                id: self.id.clone(),
            })
            .map_err(|_| ProviderError::SupervisorStopped)?;
        let response = self
            .response
            .recv()
            .unwrap_or(Err(ProviderError::SupervisorStopped));
        self.finished = true;
        match response {
            Err(ProviderError::Cancelled) => Ok(()),
            Err(error) => Err(error),
            Ok(_) => Ok(()),
        }
    }
}

impl Drop for PendingProviderRequest {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.inbound.send(Inbound::Cancel {
                id: self.id.clone(),
            });
        }
    }
}

pub struct ProviderSupervisor {
    inbound: Sender<Inbound>,
    snapshot: Arc<RwLock<ProviderSnapshot>>,
    next_request_id: AtomicU64,
    coordinator: Option<JoinHandle<()>>,
}

impl ProviderSupervisor {
    pub fn start(launch: ProviderLaunch, config: SupervisorConfig) -> Result<Self, ProviderError> {
        Self::start_inner(launch, config, None, false)
    }

    pub fn start_with_recovery(
        launch: ProviderLaunch,
        config: SupervisorConfig,
        recovery: Arc<dyn ProviderRecoveryHook>,
    ) -> Result<Self, ProviderError> {
        Self::start_inner(launch, config, Some(recovery), false)
    }

    /// Starts a Provider while allowing only the first generation's auth
    /// recovery to be deferred when the child remains alive. This keeps the
    /// anonymous QR login path available during a transient startup outage;
    /// later Provider generations retain the strict recovery barrier.
    pub fn start_with_recovery_allow_initial_failure(
        launch: ProviderLaunch,
        config: SupervisorConfig,
        recovery: Arc<dyn ProviderRecoveryHook>,
    ) -> Result<Self, ProviderError> {
        Self::start_inner(launch, config, Some(recovery), true)
    }

    fn start_inner(
        launch: ProviderLaunch,
        config: SupervisorConfig,
        recovery: Option<Arc<dyn ProviderRecoveryHook>>,
        allow_initial_recovery_failure: bool,
    ) -> Result<Self, ProviderError> {
        if config.handshake_timeout.is_zero() || config.request_timeout.is_zero() {
            return Err(ProviderError::InvalidLaunch);
        }

        let (inbound, receiver) = mpsc::channel();
        let (startup, startup_receiver) = mpsc::sync_channel(1);
        let snapshot = Arc::new(RwLock::new(ProviderSnapshot::starting()));
        let coordinator_snapshot = Arc::clone(&snapshot);
        let coordinator_inbound = inbound.clone();
        let coordinator = thread::Builder::new()
            .name("qqmusic-provider-supervisor".to_owned())
            .spawn(move || {
                Coordinator::new(
                    launch,
                    config,
                    receiver,
                    coordinator_inbound,
                    coordinator_snapshot,
                    recovery,
                    allow_initial_recovery_failure,
                )
                .run(startup);
            })
            .map_err(|_| ProviderError::SpawnFailed)?;

        match startup_receiver.recv() {
            Ok(Ok(_)) => Ok(Self {
                inbound,
                snapshot,
                next_request_id: AtomicU64::new(1),
                coordinator: Some(coordinator),
            }),
            Ok(Err(error)) => {
                let _ = coordinator.join();
                Err(error)
            }
            Err(_) => {
                let _ = coordinator.join();
                Err(ProviderError::SupervisorStopped)
            }
        }
    }

    pub fn begin_request(
        &self,
        request: ProviderRequest,
    ) -> Result<PendingProviderRequest, ProviderError> {
        let sequence = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let id = format!("host-{sequence}");
        let (response, response_receiver) = mpsc::sync_channel(1);
        self.inbound
            .send(Inbound::Submit {
                id: id.clone(),
                request,
                response,
            })
            .map_err(|_| ProviderError::SupervisorStopped)?;
        Ok(PendingProviderRequest {
            id,
            inbound: self.inbound.clone(),
            response: response_receiver,
            finished: false,
        })
    }

    pub fn request(&self, request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
        self.begin_request(request)?.wait()
    }

    pub fn subscribe_events(&self) -> Result<Receiver<ProviderEvent>, ProviderError> {
        let (sender, receiver) = mpsc::sync_channel(EVENT_BUFFER);
        self.inbound
            .send(Inbound::Subscribe { sender })
            .map_err(|_| ProviderError::SupervisorStopped)?;
        Ok(receiver)
    }

    pub fn snapshot(&self) -> ProviderSnapshot {
        self.snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// Direct request channel exposed only while a newly spawned Provider is behind
/// the ready barrier. Implementations must not call the public Supervisor API.
pub trait ProviderRecoveryPort {
    fn request(&mut self, request: ProviderRequest) -> Result<ProviderReply, ProviderError>;
}

pub trait ProviderRecoveryHook: Send + Sync {
    fn recover(
        &self,
        generation: u64,
        provider: &mut dyn ProviderRecoveryPort,
    ) -> Result<(), ProviderError>;
}

impl super::ProviderPort for ProviderSupervisor {
    fn snapshot(&self) -> ProviderSnapshot {
        self.snapshot()
    }
}

impl Drop for ProviderSupervisor {
    fn drop(&mut self) {
        let _ = self.inbound.send(Inbound::Shutdown);
        if let Some(coordinator) = self.coordinator.take() {
            let _ = coordinator.join();
        }
    }
}

enum Inbound {
    Submit {
        id: String,
        request: ProviderRequest,
        response: SyncSender<Result<ProviderReply, ProviderError>>,
    },
    Cancel {
        id: String,
    },
    Subscribe {
        sender: SyncSender<ProviderEvent>,
    },
    ChildFrame {
        generation: u64,
        frame: Result<Option<ProviderFrame>, ProtocolError>,
    },
    Shutdown,
}

struct PendingEntry {
    request: ProviderRequest,
    response: SyncSender<Result<ProviderReply, ProviderError>>,
    deadline: Option<Instant>,
    replay_count: u8,
}

struct ChildProcess {
    child: Child,
    stdin: ChildStdin,
    reader: Option<JoinHandle<()>>,
    stderr: Option<JoinHandle<()>>,
}

impl ChildProcess {
    fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn terminate(&mut self) {
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.join();
        }
    }
}

impl Drop for ChildProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

struct Coordinator {
    launch: ProviderLaunch,
    config: SupervisorConfig,
    receiver: Receiver<Inbound>,
    inbound: Sender<Inbound>,
    snapshot: Arc<RwLock<ProviderSnapshot>>,
    child: Option<ChildProcess>,
    deferred: VecDeque<Inbound>,
    pending: HashMap<String, PendingEntry>,
    completed_ids: HashSet<String>,
    abandoned_ids: HashSet<String>,
    subscribers: Vec<SyncSender<ProviderEvent>>,
    generation: u64,
    restarts_used: u8,
    recovery: Option<Arc<dyn ProviderRecoveryHook>>,
    allow_initial_recovery_failure: bool,
}

impl Coordinator {
    fn new(
        launch: ProviderLaunch,
        config: SupervisorConfig,
        receiver: Receiver<Inbound>,
        inbound: Sender<Inbound>,
        snapshot: Arc<RwLock<ProviderSnapshot>>,
        recovery: Option<Arc<dyn ProviderRecoveryHook>>,
        allow_initial_recovery_failure: bool,
    ) -> Self {
        Self {
            launch,
            config,
            receiver,
            inbound,
            snapshot,
            child: None,
            deferred: VecDeque::new(),
            pending: HashMap::new(),
            completed_ids: HashSet::new(),
            abandoned_ids: HashSet::new(),
            subscribers: Vec::new(),
            generation: 0,
            restarts_used: 0,
            recovery,
            allow_initial_recovery_failure,
        }
    }

    fn run(mut self, startup: SyncSender<Result<HandshakeInfo, ProviderError>>) {
        let initial = self.spawn_and_handshake();
        match initial {
            Ok(handshake) => {
                self.set_snapshot(ProviderSnapshot::ready(&handshake));
                let _ = startup.send(Ok(handshake));
            }
            Err(error) => {
                self.set_snapshot(ProviderSnapshot::failed());
                let _ = startup.send(Err(error));
                return;
            }
        }

        loop {
            self.expire_requests();
            let message = if let Some(message) = self.deferred.pop_front() {
                Ok(message)
            } else {
                self.receiver.recv_timeout(self.next_wait())
            };

            match message {
                Ok(Inbound::Submit {
                    id,
                    request,
                    response,
                }) => self.submit(id, request, response),
                Ok(Inbound::Cancel { id }) => self.cancel(&id),
                Ok(Inbound::Subscribe { sender }) => self.subscribers.push(sender),
                Ok(Inbound::ChildFrame { generation, frame }) => {
                    if generation == self.generation && !self.handle_child_frame(frame) {
                        break;
                    }
                }
                Ok(Inbound::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
        }

        self.fail_all(ProviderError::SupervisorStopped);
        self.child.take();
        self.set_snapshot(ProviderSnapshot::failed());
    }

    fn submit(
        &mut self,
        id: String,
        request: ProviderRequest,
        response: SyncSender<Result<ProviderReply, ProviderError>>,
    ) {
        if request.method == "system.handshake" {
            let _ = response.send(Err(ProviderError::ProtocolViolation("reserved_method")));
            return;
        }
        let timeout = request.timeout.unwrap_or(self.config.request_timeout);
        if timeout.is_zero() {
            let _ = response.send(Err(ProviderError::RequestTimeout));
            return;
        }
        #[cfg(debug_assertions)]
        debug_request(&request);
        let frame =
            match RequestFrame::new(id.clone(), request.method.clone(), request.params.clone()) {
                Ok(frame) => frame,
                Err(error) => {
                    let _ = response.send(Err(protocol_error(&error)));
                    return;
                }
            };
        self.pending.insert(
            id.clone(),
            PendingEntry {
                request,
                response,
                deadline: None,
                replay_count: 0,
            },
        );
        #[cfg(debug_assertions)]
        eprintln!(
            "{{\"level\":\"debug\",\"code\":\"provider_request_queued\",\"requestId\":\"{}\",\"pending\":{}}}",
            id,
            self.pending.len()
        );
        if self.write_frame(&frame).is_err() {
            self.recover_after_failure(ProviderError::Unavailable);
        } else if let Some(entry) = self.pending.get_mut(&id) {
            // Channel time starts only after the complete frame has been flushed to the child.
            entry.deadline = Some(Instant::now() + timeout);
            #[cfg(debug_assertions)]
            eprintln!(
                "{{\"level\":\"debug\",\"code\":\"provider_request_written\",\"requestId\":\"{}\",\"pending\":{}}}",
                id,
                self.pending.len()
            );
        }
    }

    fn cancel(&mut self, id: &str) {
        if let Some(entry) = self.pending.remove(id) {
            self.abandoned_ids.insert(id.to_owned());
            let _ = entry.response.send(Err(ProviderError::Cancelled));
        }
    }

    fn handle_child_frame(&mut self, frame: Result<Option<ProviderFrame>, ProtocolError>) -> bool {
        let frame = match frame {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                self.recover_after_failure(ProviderError::Unavailable);
                return true;
            }
            Err(error) => {
                self.recover_after_failure(protocol_error(&error));
                return true;
            }
        };

        match frame {
            ProviderFrame::Event(frame) => {
                let event = ProviderEvent {
                    name: frame.event,
                    payload: frame.payload,
                };
                self.subscribers
                    .retain(|subscriber| match subscriber.try_send(event.clone()) {
                        Ok(()) | Err(TrySendError::Full(_)) => true,
                        Err(TrySendError::Disconnected(_)) => false,
                    });
            }
            ProviderFrame::Success(frame) => {
                self.complete_response(
                    frame.id,
                    ProviderReply::Success {
                        result: frame.result,
                        warnings: frame.warnings,
                    },
                );
            }
            ProviderFrame::Failure(frame) => {
                crate::file_logging::event("provider_request_failed");
                #[cfg(debug_assertions)]
                eprintln!(
                    "{{\"level\":\"debug\",\"code\":\"provider_failure\",\"requestId\":\"{}\",\"errorCode\":\"{}\",\"retryable\":{}}}",
                    frame.id, frame.error.code, frame.error.retryable
                );
                self.complete_response(frame.id, failure_reply(frame.error));
            }
        }
        true
    }

    fn complete_response(&mut self, id: String, reply: ProviderReply) {
        if let Some(entry) = self.pending.remove(&id) {
            self.completed_ids.insert(id);
            let _ = entry.response.send(Ok(reply));
            return;
        }
        if self.abandoned_ids.remove(&id) {
            self.completed_ids.insert(id);
            return;
        }
        let error = if self.completed_ids.contains(&id) {
            ProtocolError::DuplicateResponseId(id)
        } else {
            ProtocolError::UnknownResponseId(id)
        };
        self.recover_after_failure(protocol_error(&error));
    }

    fn expire_requests(&mut self) {
        let now = Instant::now();
        let expired = self
            .pending
            .iter()
            .any(|(_, entry)| entry.deadline.is_some_and(|deadline| deadline <= now));
        if expired {
            #[cfg(debug_assertions)]
            eprintln!(
                "{{\"level\":\"debug\",\"code\":\"provider_request_expired\",\"pending\":{}}}",
                self.pending.len()
            );
            // A written request without a response means the provider channel is unhealthy.
            // Recover the whole generation so replayable reads get one clean retry and writes
            // report an unknown outcome instead of being duplicated.
            self.recover_after_failure(ProviderError::RequestTimeout);
        }
    }

    fn next_wait(&self) -> Duration {
        self.pending
            .values()
            .filter_map(|entry| entry.deadline)
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .min()
            .unwrap_or(COORDINATOR_POLL)
            .min(COORDINATOR_POLL)
    }

    fn recover_after_failure(&mut self, cause: ProviderError) {
        crate::file_logging::provider_failure(cause.code(), self.generation);
        #[cfg(debug_assertions)]
        eprintln!(
            "{{\"level\":\"debug\",\"code\":\"provider_recovery\",\"cause\":\"{}\",\"detail\":\"{}\",\"generation\":{}}}",
            cause.code(),
            cause,
            self.generation
        );
        self.child.take();
        self.completed_ids.clear();
        self.abandoned_ids.clear();

        let ids = self.pending.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let should_replay = self.pending.get(&id).is_some_and(|entry| {
                entry.request.semantics == RequestSemantics::ReadOnlyReplayable
                    && entry.replay_count == 0
            });
            if should_replay {
                if let Some(entry) = self.pending.get_mut(&id) {
                    entry.replay_count += 1;
                }
            } else if let Some(entry) = self.pending.remove(&id) {
                let error = if entry.request.semantics == RequestSemantics::WriteNeverReplay {
                    ProviderError::OutcomeUnknown
                } else {
                    cause.clone()
                };
                let _ = entry.response.send(Err(error));
            }
        }

        if self.restarts_used >= self.config.max_restarts {
            self.fail_all(ProviderError::Unavailable);
            self.set_snapshot(ProviderSnapshot::failed());
            return;
        }

        while self.restarts_used < self.config.max_restarts {
            self.restarts_used += 1;
            self.set_snapshot(ProviderSnapshot::starting());
            thread::sleep(self.config.restart_backoff);
            match self.spawn_and_handshake() {
                Ok(handshake) => {
                    self.restarts_used = 0;
                    self.set_snapshot(ProviderSnapshot::ready(&handshake));
                    self.replay_pending();
                    return;
                }
                Err(_) => continue,
            }
        }
        self.fail_all(ProviderError::Unavailable);
        self.set_snapshot(ProviderSnapshot::failed());
    }

    fn replay_pending(&mut self) {
        let ids = self.pending.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let frame = {
                let entry = self.pending.get_mut(&id).expect("pending id must exist");
                entry.deadline = None;
                RequestFrame::new(
                    id.clone(),
                    entry.request.method.clone(),
                    entry.request.params.clone(),
                )
            };
            match frame {
                Ok(frame) if self.write_frame(&frame).is_ok() => {
                    if let Some(entry) = self.pending.get_mut(&id) {
                        entry.deadline = Some(
                            Instant::now()
                                + entry.request.timeout.unwrap_or(self.config.request_timeout),
                        );
                    }
                }
                _ => {
                    if let Some(entry) = self.pending.remove(&id) {
                        let _ = entry.response.send(Err(ProviderError::Unavailable));
                    }
                }
            }
        }
    }

    fn fail_all(&mut self, error: ProviderError) {
        for (_, entry) in self.pending.drain() {
            let _ = entry.response.send(Err(error.clone()));
        }
    }

    fn spawn_and_handshake(&mut self) -> Result<HandshakeInfo, ProviderError> {
        self.generation += 1;
        let generation = self.generation;
        let mut process = spawn_process(&self.launch, generation, self.inbound.clone())?;
        let handshake_id = format!("handshake-{generation}");
        let params = Map::from_iter([(
            "protocolVersion".to_owned(),
            Value::from(PROVIDER_PROTOCOL_VERSION),
        )]);
        let request = RequestFrame::new(handshake_id.clone(), "system.handshake", params)
            .map_err(|_| ProviderError::HandshakeFailed)?;
        write_request(&mut process.stdin, &request).map_err(|_| ProviderError::HandshakeFailed)?;
        let deadline = Instant::now() + self.config.handshake_timeout;

        loop {
            let wait = deadline.saturating_duration_since(Instant::now());
            if wait.is_zero() {
                return Err(ProviderError::HandshakeFailed);
            }
            match self.receiver.recv_timeout(wait) {
                Ok(Inbound::ChildFrame {
                    generation: frame_generation,
                    frame,
                }) if frame_generation == generation => match frame {
                    Ok(Some(ProviderFrame::Success(frame))) if frame.id == handshake_id => {
                        let handshake = parse_handshake(frame.result)?;
                        if let Some(recovery) = self.recovery.clone() {
                            let mut port = DirectRecoveryPort {
                                process: &mut process,
                                receiver: &self.receiver,
                                deferred: &mut self.deferred,
                                generation,
                                timeout: self.config.request_timeout,
                                sequence: 0,
                            };
                            if let Err(error) = recovery.recover(generation, &mut port) {
                                let can_defer = self.allow_initial_recovery_failure
                                    && generation == 1
                                    && process.is_running();
                                if !can_defer {
                                    return Err(error);
                                }
                                #[cfg(debug_assertions)]
                                eprintln!(
                                    "{{\"level\":\"debug\",\"code\":\"provider_recovery_deferred\",\"generation\":{generation},\"error\":\"{}\"}}",
                                    error.code()
                                );
                            }
                        }
                        self.child = Some(process);
                        self.completed_ids.clear();
                        self.abandoned_ids.clear();
                        return Ok(handshake);
                    }
                    Ok(Some(ProviderFrame::Failure(frame))) if frame.id == handshake_id => {
                        return Err(ProviderError::HandshakeFailed);
                    }
                    Ok(Some(_)) => return Err(ProviderError::HandshakeFailed),
                    Ok(None) => return Err(ProviderError::HandshakeFailed),
                    Err(error) => return Err(protocol_error(&error)),
                },
                Ok(message @ Inbound::Shutdown) => {
                    // Preserve shutdown for the outer coordinator loop. Consuming it here
                    // while a restart handshake is in flight would leave Drop waiting forever.
                    self.deferred.push_front(message);
                    return Err(ProviderError::SupervisorStopped);
                }
                Ok(message) => self.deferred.push_back(message),
                Err(RecvTimeoutError::Timeout) => return Err(ProviderError::HandshakeFailed),
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(ProviderError::SupervisorStopped)
                }
            }
        }
    }

    fn write_frame(&mut self, frame: &RequestFrame) -> Result<(), ProviderError> {
        let child = self.child.as_mut().ok_or(ProviderError::Unavailable)?;
        write_request(&mut child.stdin, frame).map_err(|_| ProviderError::Unavailable)
    }

    fn set_snapshot(&self, snapshot: ProviderSnapshot) {
        *self
            .snapshot
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = snapshot;
    }
}

struct DirectRecoveryPort<'a> {
    process: &'a mut ChildProcess,
    receiver: &'a Receiver<Inbound>,
    deferred: &'a mut VecDeque<Inbound>,
    generation: u64,
    timeout: Duration,
    sequence: u64,
}

impl ProviderRecoveryPort for DirectRecoveryPort<'_> {
    fn request(&mut self, request: ProviderRequest) -> Result<ProviderReply, ProviderError> {
        self.sequence += 1;
        let id = format!("recovery-{}-{}", self.generation, self.sequence);
        let frame = RequestFrame::new(id.clone(), request.method.clone(), request.params.clone())
            .map_err(|error| protocol_error(&error))?;
        write_request(&mut self.process.stdin, &frame).map_err(|_| ProviderError::Unavailable)?;
        let deadline = Instant::now() + request.timeout.unwrap_or(self.timeout);

        loop {
            let wait = deadline.saturating_duration_since(Instant::now());
            if wait.is_zero() {
                return Err(ProviderError::RequestTimeout);
            }
            match self.receiver.recv_timeout(wait) {
                Ok(Inbound::ChildFrame {
                    generation,
                    frame: _,
                }) if generation != self.generation => continue,
                Ok(Inbound::ChildFrame {
                    generation,
                    frame: Ok(Some(ProviderFrame::Success(frame))),
                }) if generation == self.generation && frame.id == id => {
                    return Ok(ProviderReply::Success {
                        result: frame.result,
                        warnings: frame.warnings,
                    });
                }
                Ok(Inbound::ChildFrame {
                    generation,
                    frame: Ok(Some(ProviderFrame::Failure(frame))),
                }) if generation == self.generation && frame.id == id => {
                    return Ok(failure_reply(frame.error));
                }
                Ok(
                    message @ Inbound::ChildFrame {
                        generation,
                        frame: Ok(Some(ProviderFrame::Event(_))),
                    },
                ) if generation == self.generation => self.deferred.push_back(message),
                Ok(Inbound::ChildFrame {
                    generation,
                    frame: Ok(None),
                }) if generation == self.generation => return Err(ProviderError::Unavailable),
                Ok(Inbound::ChildFrame {
                    generation,
                    frame: Err(error),
                }) if generation == self.generation => return Err(protocol_error(&error)),
                Ok(message @ Inbound::Shutdown) => {
                    self.deferred.push_front(message);
                    return Err(ProviderError::SupervisorStopped);
                }
                Ok(message) => self.deferred.push_back(message),
                Err(RecvTimeoutError::Timeout) => return Err(ProviderError::RequestTimeout),
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(ProviderError::SupervisorStopped)
                }
            }
        }
    }
}

fn spawn_process(
    launch: &ProviderLaunch,
    generation: u64,
    inbound: Sender<Inbound>,
) -> Result<ChildProcess, ProviderError> {
    let mut command = Command::new(&launch.executable);
    command
        .args(&launch.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if cfg!(debug_assertions) {
        // The Python provider already redacts its structured diagnostics. In a
        // debug run, inherit that stream so `tauri dev` captures it for local
        // diagnosis; release builds keep stderr isolated from the renderer.
        command.stderr(Stdio::inherit());
    } else {
        command.stderr(Stdio::piped());
    }
    if let Some(directory) = &launch.current_dir {
        command.current_dir(directory);
    }
    set_no_window(&mut command);
    let mut child = command.spawn().map_err(|_| ProviderError::SpawnFailed)?;
    let stdin = child.stdin.take().ok_or(ProviderError::SpawnFailed)?;
    let stdout = child.stdout.take().ok_or(ProviderError::SpawnFailed)?;
    let stderr = child.stderr.take();

    let reader = thread::Builder::new()
        .name(format!("qqmusic-provider-stdout-{generation}"))
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let frame = read_provider_frame(&mut reader);
                let terminal = !matches!(frame, Ok(Some(_)));
                if inbound
                    .send(Inbound::ChildFrame { generation, frame })
                    .is_err()
                {
                    break;
                }
                if terminal {
                    break;
                }
            }
        })
        .map_err(|_| ProviderError::SpawnFailed)?;

    let stderr = stderr
        .map(|stderr| {
            thread::Builder::new()
                .name(format!("qqmusic-provider-stderr-{generation}"))
                .spawn(move || {
                    let mut stderr = stderr;
                    let mut buffer = [0_u8; 8192];
                    loop {
                        match stderr.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                    }
                })
                .map_err(|_| ProviderError::SpawnFailed)
        })
        .transpose()?;

    Ok(ChildProcess {
        child,
        stdin,
        reader: Some(reader),
        stderr,
    })
}

#[cfg(windows)]
fn set_no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn set_no_window(_command: &mut Command) {
    let _ = CREATE_NO_WINDOW;
}

fn write_request(stdin: &mut ChildStdin, frame: &RequestFrame) -> io::Result<()> {
    let line = Zeroizing::new(
        frame
            .encoded_line()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
    );
    stdin.write_all(&line)?;
    stdin.flush()
}

#[cfg(debug_assertions)]
fn debug_request(request: &ProviderRequest) {
    let mut safe_params = Map::new();
    for key in [
        "id",
        "dirId",
        "page",
        "pageSize",
        "area",
        "generation",
        "kind",
    ] {
        if let Some(value @ (Value::Number(_) | Value::String(_))) = request.params.get(key) {
            safe_params.insert(key.to_owned(), value.clone());
        }
    }
    let params = serde_json::to_string(&safe_params).unwrap_or_else(|_| "{}".to_owned());
    eprintln!(
        "{{\"level\":\"debug\",\"code\":\"provider_request\",\"method\":\"{}\",\"params\":{params}}}",
        request.method
    );
}

fn zeroize_json_map(map: &mut Map<String, Value>) {
    for value in map.values_mut() {
        zeroize_json_value(value);
    }
    map.clear();
}

fn zeroize_json_value(value: &mut Value) {
    match value {
        Value::String(secret) => secret.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_json_value),
        Value::Object(map) => zeroize_json_map(map),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn protocol_error(error: &ProtocolError) -> ProviderError {
    ProviderError::ProtocolViolation(error.code())
}

fn failure_reply(error: ProviderFailure) -> ProviderReply {
    ProviderReply::Failure {
        code: error.code,
        retryable: error.retryable,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HandshakeEnvelope {
    provider: HandshakeProvider,
    protocol: HandshakeProtocol,
    capabilities: HandshakeCapabilities,
    implemented_methods: Vec<String>,
    upstream: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HandshakeProvider {
    name: String,
    version: String,
    mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HandshakeProtocol {
    version: u16,
    max_line_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HandshakeCapabilities {
    auth_methods: Vec<String>,
    search_types: Vec<String>,
    recommend_modules: Vec<String>,
    playlist_writes: Vec<String>,
    playlist_extensions: Value,
    lyric_variants: Vec<String>,
    quality_candidates: Vec<String>,
}

fn parse_handshake(result: Map<String, Value>) -> Result<HandshakeInfo, ProviderError> {
    let handshake: HandshakeEnvelope = serde_json::from_value(Value::Object(result))
        .map_err(|_| ProviderError::HandshakeFailed)?;
    if handshake.protocol.version != PROVIDER_PROTOCOL_VERSION
        || handshake.protocol.max_line_bytes != MAX_LINE_BYTES
        || handshake.provider.name != "qqmusic-provider"
        || !handshake
            .implemented_methods
            .iter()
            .any(|method| method == "system.handshake")
        || !handshake
            .implemented_methods
            .iter()
            .any(|method| method == "system.ping")
    {
        return Err(ProviderError::HandshakeFailed);
    }
    let _ = handshake.upstream;
    let _ = handshake.capabilities.playlist_extensions;
    for values in [
        &handshake.implemented_methods,
        &handshake.capabilities.auth_methods,
        &handshake.capabilities.search_types,
        &handshake.capabilities.recommend_modules,
        &handshake.capabilities.playlist_writes,
        &handshake.capabilities.lyric_variants,
        &handshake.capabilities.quality_candidates,
    ] {
        if values.len() > MAX_HANDSHAKE_ITEMS
            || values
                .iter()
                .any(|value| value.is_empty() || value.chars().count() > 128)
        {
            return Err(ProviderError::HandshakeFailed);
        }
    }
    if handshake.provider.version.is_empty()
        || handshake.provider.version.len() > 64
        || handshake.provider.mode.is_empty()
        || handshake.provider.mode.len() > 32
    {
        return Err(ProviderError::HandshakeFailed);
    }
    Ok(HandshakeInfo {
        provider_name: handshake.provider.name,
        provider_version: handshake.provider.version,
        provider_mode: handshake.provider.mode,
        implemented_methods: handshake.implemented_methods,
        capabilities: ProviderCapabilities {
            auth_methods: handshake.capabilities.auth_methods,
            search_types: handshake.capabilities.search_types,
            recommend_modules: handshake.capabilities.recommend_modules,
            playlist_writes: handshake.capabilities.playlist_writes,
            lyric_variants: handshake.capabilities.lyric_variants,
            quality_candidates: handshake.capabilities.quality_candidates,
        },
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn launch_requires_an_absolute_existing_executable() {
        assert!(matches!(
            ProviderLaunch::new(Path::new("relative-provider.exe")),
            Err(ProviderError::InvalidLaunch)
        ));
    }

    #[test]
    fn public_error_codes_never_include_process_or_path_details() {
        for error in [
            ProviderError::InvalidLaunch,
            ProviderError::SpawnFailed,
            ProviderError::HandshakeFailed,
            ProviderError::ProtocolViolation("invalid_json"),
            ProviderError::RequestTimeout,
            ProviderError::Cancelled,
            ProviderError::Unavailable,
            ProviderError::OutcomeUnknown,
            ProviderError::SupervisorStopped,
        ] {
            assert!(error.code().starts_with("provider_"));
            assert!(!error.code().contains('\\'));
            assert!(!error.code().contains('/'));
        }
    }

    #[test]
    fn request_and_reply_debug_output_redacts_secret_values() {
        let params = Map::from_iter([(
            "credential".to_owned(),
            serde_json::json!({"musickey": "SENTINEL_MUSICKEY"}),
        )]);
        let request = ProviderRequest::write("auth.credential.restore", params.clone());
        let reply = ProviderReply::Success {
            result: params,
            warnings: Vec::new(),
        };

        assert!(!format!("{request:?}").contains("SENTINEL"));
        assert!(!format!("{reply:?}").contains("SENTINEL"));
    }
}
