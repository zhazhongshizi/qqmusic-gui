use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use qqmusic_gui_lib::provider::{
    ProviderError, ProviderLaunch, ProviderRecoveryHook, ProviderRecoveryPort, ProviderReply,
    ProviderRequest, ProviderSupervisor, SupervisorConfig,
};
use serde_json::{Map, Value};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn config() -> SupervisorConfig {
    SupervisorConfig {
        handshake_timeout: Duration::from_secs(2),
        request_timeout: Duration::from_millis(500),
        restart_backoff: Duration::from_millis(10),
        max_restarts: 1,
    }
}

fn launch(scenario: &str) -> ProviderLaunch {
    ProviderLaunch::new(PathBuf::from(env!("CARGO_BIN_EXE_qqmusic-fake-provider")))
        .expect("Cargo must build the absolute fake provider")
        .args(["--scenario", scenario])
}

fn launch_with_marker(scenario: &str, marker: &Path) -> ProviderLaunch {
    ProviderLaunch::new(PathBuf::from(env!("CARGO_BIN_EXE_qqmusic-fake-provider")))
        .expect("Cargo must build the absolute fake provider")
        .args([
            "--scenario".into(),
            scenario.into(),
            "--marker".into(),
            marker.as_os_str().to_owned(),
        ])
}

fn ping() -> ProviderRequest {
    ProviderRequest::read_only("system.ping", Map::new())
}

fn search(keyword: &str) -> ProviderRequest {
    ProviderRequest::read_only(
        "search.songs",
        Map::from_iter([("keyword".to_owned(), Value::String(keyword.to_owned()))]),
    )
}

fn success_result(reply: ProviderReply) -> Map<String, Value> {
    match reply {
        ProviderReply::Success { result, warnings } => {
            assert!(warnings.is_empty());
            result
        }
        ProviderReply::Failure { code, .. } => panic!("unexpected provider failure: {code}"),
    }
}

struct PingRecoveryHook {
    calls: AtomicU64,
}

impl ProviderRecoveryHook for PingRecoveryHook {
    fn recover(
        &self,
        _generation: u64,
        provider: &mut dyn ProviderRecoveryPort,
    ) -> Result<(), ProviderError> {
        let reply = provider.request(ping())?;
        assert_eq!(success_result(reply)["pong"], true);
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct FailingRecoveryHook {
    calls: AtomicU64,
}

impl ProviderRecoveryHook for FailingRecoveryHook {
    fn recover(
        &self,
        _generation: u64,
        _provider: &mut dyn ProviderRecoveryPort,
    ) -> Result<(), ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::Unavailable)
    }
}

#[test]
fn handshake_ping_event_and_bounded_stderr_are_supported() {
    let supervisor = ProviderSupervisor::start(launch("event"), config()).expect("handshake");
    let events = supervisor.subscribe_events().expect("event subscription");
    let reply = success_result(supervisor.request(ping()).expect("ping response"));
    assert_eq!(reply["pong"], true);
    let event = events
        .recv_timeout(Duration::from_secs(1))
        .expect("fixture event");
    assert_eq!(event.name, "fixture.ready");
    assert_eq!(event.payload["safe"], true);
    assert_eq!(
        serde_json::to_value(supervisor.snapshot()).expect("snapshot")["state"],
        "ready"
    );
    drop(supervisor);

    let supervisor =
        ProviderSupervisor::start(launch("stderr-flood"), config()).expect("handshake");
    let reply = success_result(supervisor.request(ping()).expect("stderr must be drained"));
    assert_eq!(reply["pong"], true);
}

#[test]
fn ready_is_not_exposed_until_the_direct_recovery_hook_finishes() {
    let recovery = Arc::new(PingRecoveryHook {
        calls: AtomicU64::new(0),
    });
    let supervisor =
        ProviderSupervisor::start_with_recovery(launch("normal"), config(), recovery.clone())
            .expect("handshake and ready recovery");

    assert_eq!(recovery.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        serde_json::to_value(supervisor.snapshot()).expect("snapshot")["state"],
        "ready"
    );
}

#[test]
fn initial_recovery_failure_can_be_deferred_without_disabling_the_provider() {
    let recovery = Arc::new(FailingRecoveryHook {
        calls: AtomicU64::new(0),
    });
    let supervisor = ProviderSupervisor::start_with_recovery_allow_initial_failure(
        launch("normal"),
        config(),
        recovery.clone(),
    )
    .expect("transport stays ready when initial recovery is deferred");

    assert_eq!(recovery.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        serde_json::to_value(supervisor.snapshot()).expect("snapshot")["state"],
        "ready"
    );
    assert_eq!(
        success_result(supervisor.request(ping()).expect("ping"))["pong"],
        true
    );
}

#[test]
fn strict_recovery_start_still_rejects_initial_recovery_failure() {
    let recovery = Arc::new(FailingRecoveryHook {
        calls: AtomicU64::new(0),
    });
    let result = ProviderSupervisor::start_with_recovery(launch("normal"), config(), recovery);

    assert!(matches!(result, Err(ProviderError::Unavailable)));
}

#[test]
fn provider_restart_runs_the_ready_recovery_hook_for_the_new_generation() {
    let marker = unique_temp_file("recovery-hook-restart");
    let recovery = Arc::new(PingRecoveryHook {
        calls: AtomicU64::new(0),
    });
    let supervisor = ProviderSupervisor::start_with_recovery(
        launch_with_marker("crash-after-recovery-once", &marker),
        config(),
        recovery.clone(),
    )
    .expect("initial ready recovery");

    assert_eq!(
        success_result(supervisor.request(ping()).expect("replayed ping"))["pong"],
        true
    );
    assert_eq!(recovery.calls.load(Ordering::SeqCst), 2);
    let _ = fs::remove_file(marker);
}

#[test]
fn concurrent_requests_are_correlated_when_responses_are_out_of_order() {
    let supervisor =
        ProviderSupervisor::start(launch("out-of-order"), config()).expect("handshake");
    let first = supervisor
        .begin_request(search("first"))
        .expect("first request");
    let second = supervisor
        .begin_request(search("second"))
        .expect("second request");
    let first_result = success_result(first.wait().expect("first response"));
    let second_result = success_result(second.wait().expect("second response"));
    assert_eq!(first_result["echo"], "first");
    assert_eq!(second_result["echo"], "second");
}

#[test]
fn timeout_and_explicit_cancellation_are_stable() {
    let supervisor = ProviderSupervisor::start(launch("timeout"), config()).expect("handshake");
    let error = supervisor
        .request(ping().with_timeout(Duration::from_millis(50)))
        .expect_err("request must time out");
    assert_eq!(error, ProviderError::RequestTimeout);
    drop(supervisor);

    let supervisor = ProviderSupervisor::start(launch("delayed"), config()).expect("handshake");
    let request = supervisor.begin_request(ping()).expect("request");
    let started = Instant::now();
    request.cancel().expect("cancel request");
    assert!(started.elapsed() < Duration::from_millis(200));
}

#[test]
fn a_channel_timeout_restarts_the_provider_and_replays_a_read_once() {
    let marker = unique_temp_file("timeout-replay");
    let supervisor =
        ProviderSupervisor::start(launch_with_marker("timeout-once", &marker), config())
            .expect("handshake");
    let result = success_result(
        supervisor
            .request(ping().with_timeout(Duration::from_millis(50)))
            .expect("read must replay after the timed-out provider is replaced"),
    );
    assert_eq!(result["pong"], true);
    let _ = fs::remove_file(&marker);
}

#[test]
fn two_independent_channel_timeouts_each_recover_cleanly() {
    let marker = unique_temp_file("two-independent-timeouts");
    let supervisor = ProviderSupervisor::start(
        launch_with_marker("timeout-two-independent", &marker),
        config(),
    )
    .expect("handshake");

    for label in ["first", "second"] {
        let result = success_result(
            supervisor
                .request(search(label).with_timeout(Duration::from_millis(50)))
                .expect("each independent timed-out read must recover"),
        );
        assert_eq!(result["echo"], label);
    }
    assert_eq!(fs::read_to_string(&marker).expect("timeout count"), "2");
    let _ = fs::remove_file(marker);
}

#[test]
fn provider_exit_during_ready_recovery_consumes_budget_and_recovers_again() {
    let marker = unique_temp_file("crash-during-recovery");
    let recovery = Arc::new(PingRecoveryHook {
        calls: AtomicU64::new(0),
    });
    let mut recovery_config = config();
    recovery_config.max_restarts = 2;
    let supervisor = ProviderSupervisor::start_with_recovery(
        launch_with_marker("crash-during-recovery-once", &marker),
        recovery_config,
        recovery.clone(),
    )
    .expect("initial recovery");

    assert_eq!(
        success_result(supervisor.request(ping()).expect("replayed request"))["pong"],
        true
    );
    assert_eq!(recovery.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        fs::read_to_string(&marker).expect("recovery stage"),
        "recovery-crashed"
    );
    let _ = fs::remove_file(marker);
}

#[test]
fn late_frame_from_old_generation_is_ignored() {
    let marker = unique_temp_file("late-old-generation");
    let recovery = Arc::new(PingRecoveryHook {
        calls: AtomicU64::new(0),
    });
    let supervisor = ProviderSupervisor::start_with_recovery(
        launch_with_marker("late-old-generation-once", &marker),
        config(),
        recovery.clone(),
    )
    .expect("initial recovery");

    assert_eq!(
        success_result(supervisor.request(ping()).expect("replayed ping"))["pong"],
        true
    );
    std::thread::sleep(Duration::from_millis(450));
    assert_eq!(
        success_result(supervisor.request(ping()).expect("still ready"))["pong"],
        true
    );
    assert_eq!(recovery.calls.load(Ordering::SeqCst), 2);
    let _ = fs::remove_file(marker);
}

#[test]
fn a_timed_out_write_reports_unknown_outcome_and_is_never_replayed() {
    let supervisor = ProviderSupervisor::start(launch("timeout"), config()).expect("handshake");
    let error = supervisor
        .request(
            ProviderRequest::write("playlist.add", Map::new())
                .with_timeout(Duration::from_millis(50)),
        )
        .expect_err("timed-out writes must not be replayed");
    assert_eq!(error, ProviderError::OutcomeUnknown);
}

#[test]
fn timed_out_write_is_observed_exactly_once_by_all_generations() {
    let marker = unique_temp_file("write-timeout-count");
    let supervisor =
        ProviderSupervisor::start(launch_with_marker("write-timeout-count", &marker), config())
            .expect("handshake");
    let error = supervisor
        .request(
            ProviderRequest::write("playlist.add", Map::new())
                .with_timeout(Duration::from_millis(50)),
        )
        .expect_err("write response is unknown");

    assert_eq!(error, ProviderError::OutcomeUnknown);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(fs::read_to_string(&marker).expect("write count"), "1");
    let _ = fs::remove_file(marker);
}

#[test]
fn read_only_request_replays_once_but_write_outcome_is_unknown() {
    let marker = unique_temp_file("read-replay");
    let supervisor = ProviderSupervisor::start(launch_with_marker("crash-once", &marker), config())
        .expect("handshake");
    let result = success_result(
        supervisor
            .request(ping())
            .expect("read request must replay"),
    );
    assert_eq!(result["pong"], true);
    let _ = fs::remove_file(&marker);
    drop(supervisor);

    let supervisor = ProviderSupervisor::start(launch("write-crash"), config()).expect("handshake");
    let error = supervisor
        .request(ProviderRequest::write("playlist.add", Map::new()))
        .expect_err("write must never replay");
    assert_eq!(error, ProviderError::OutcomeUnknown);
}

#[test]
fn malformed_and_unknown_frames_are_fatal_to_the_instance() {
    for (scenario, expected_code) in [
        ("unknown", "unknown_response_id"),
        ("invalid-utf8", "invalid_utf8"),
        ("oversized", "line_too_long"),
    ] {
        let supervisor = ProviderSupervisor::start(launch(scenario), config()).expect("handshake");
        let error = supervisor
            .request(ping())
            .expect_err("malformed provider must fail");
        assert_eq!(error, ProviderError::ProtocolViolation(expected_code));
    }
}

#[test]
fn duplicate_terminal_response_forces_a_clean_restart() {
    let supervisor = ProviderSupervisor::start(launch("duplicate"), config()).expect("handshake");
    let result = success_result(supervisor.request(ping()).expect("first terminal response"));
    assert_eq!(result["pong"], true);
    let second = success_result(
        supervisor
            .request(ping())
            .expect("supervisor must remain usable through one clean restart"),
    );
    assert_eq!(second["pong"], true);
}

#[test]
fn handshake_version_mismatch_is_rejected_before_supervisor_is_exposed() {
    let result = ProviderSupervisor::start(launch("version-mismatch"), config());
    assert!(matches!(
        result,
        Err(ProviderError::ProtocolViolation(
            "protocol_version_mismatch"
        )) | Err(ProviderError::HandshakeFailed)
    ));
}

fn unique_temp_file(label: &str) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "qqmusic-gui-{label}-{}-{sequence}.marker",
        std::process::id()
    ))
}
