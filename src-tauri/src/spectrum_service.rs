use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use tauri::{AppHandle, Emitter};

use crate::{
    process_loopback::ProcessLoopbackCapture,
    spectrum::{AnalyzerWorker, LatestFrameSlot, SpectrumFrame, SpectrumState},
};

const SPECTRUM_EVENT: &str = "spectrum_frame";
const BRIDGE_INTERVAL: Duration = Duration::from_millis(33);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
const STREAM_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_TIMEOUT: Duration = Duration::from_secs(1);

struct EventBridge {
    stop: Arc<AtomicBool>,
    done: mpsc::Receiver<()>,
    worker: Option<JoinHandle<()>>,
}

impl EventBridge {
    fn start(app: AppHandle, epoch: u64, latest: LatestFrameSlot) -> std::io::Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let (done_tx, done) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("qqmusic-spectrum-event".to_owned())
            .spawn(move || {
                let started = Instant::now();
                let mut last_frame = started;
                let mut observed_frame = false;
                let mut unavailable_sent = false;
                let mut wire_sequence = 0_u64;
                #[cfg(debug_assertions)]
                let mut last_report = started;
                while !worker_stop.load(Ordering::Acquire) {
                    if let Some(mut frame) = latest.take() {
                        observed_frame = true;
                        unavailable_sent = false;
                        last_frame = Instant::now();
                        wire_sequence = wire_sequence.saturating_add(1);
                        frame.sequence = wire_sequence;
                        #[cfg(debug_assertions)]
                        if last_report.elapsed() >= Duration::from_secs(2) {
                            let peak = frame.bands.iter().copied().fold(0.0_f32, f32::max);
                            let active_bands =
                                frame.bands.iter().filter(|band| **band > 0.01).count();
                            eprintln!(
                                "[spectrum] state=active epoch={} sequence={} peak={peak:.3} active_bands={active_bands}",
                                frame.epoch, frame.sequence
                            );
                            last_report = Instant::now();
                        }
                        let _ = app.emit(SPECTRUM_EVENT, frame);
                    } else {
                        let elapsed = if observed_frame {
                            last_frame.elapsed()
                        } else {
                            started.elapsed()
                        };
                        let limit = if observed_frame {
                            STREAM_TIMEOUT
                        } else {
                            STARTUP_TIMEOUT
                        };
                        if elapsed >= limit && !unavailable_sent {
                            wire_sequence = wire_sequence.saturating_add(1);
                            let _ = app.emit(
                                SPECTRUM_EVENT,
                                SpectrumFrame::status(
                                    epoch,
                                    wire_sequence,
                                    SpectrumState::Unavailable,
                                ),
                            );
                            unavailable_sent = true;
                        }
                    }
                    thread::sleep(BRIDGE_INTERVAL);
                }
                let _ = done_tx.send(());
            })?;
        Ok(Self {
            stop,
            done,
            worker: Some(worker),
        })
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if self.done.recv_timeout(STOP_TIMEOUT).is_ok() {
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        } else {
            self.worker.take();
        }
    }
}

impl Drop for EventBridge {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Pipeline {
    bridge: EventBridge,
    analyzer: AnalyzerWorker,
}

impl Pipeline {
    fn start(app: AppHandle, epoch: u64, capture: &mut ProcessLoopbackCapture) -> Result<Self, ()> {
        let mut analyzer = AnalyzerWorker::start(epoch).map_err(|_| ())?;
        if capture.start_stream(analyzer.sender()).is_err() {
            analyzer.stop();
            return Err(());
        }
        let bridge = match EventBridge::start(app, epoch, analyzer.latest()) {
            Ok(bridge) => bridge,
            Err(_) => {
                analyzer.stop();
                let _ = capture.stop_stream();
                return Err(());
            }
        };
        Ok(Self { bridge, analyzer })
    }

    fn stop(&mut self, capture: &mut ProcessLoopbackCapture) {
        self.bridge.stop();
        self.analyzer.stop();
        let _ = capture.stop_stream();
    }
}

struct ServiceState {
    enabled: bool,
    stage_active: bool,
    capture: Option<ProcessLoopbackCapture>,
    pipeline: Option<Pipeline>,
}

/// Owns the optional process-loopback pipeline. All failures are isolated from
/// playback and represented as a renderer-safe lifecycle event.
pub(crate) struct SpectrumService {
    app: AppHandle,
    epoch: AtomicU64,
    state: Mutex<ServiceState>,
}

impl SpectrumService {
    pub(crate) fn new(app: AppHandle, enabled: bool) -> Self {
        Self {
            app,
            epoch: AtomicU64::new(0),
            state: Mutex::new(ServiceState {
                enabled,
                stage_active: false,
                capture: None,
                pipeline: None,
            }),
        }
    }

    pub(crate) fn set_enabled(&self, enabled: bool) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.enabled = enabled;
        self.reconcile(&mut state);
    }

    pub(crate) fn set_stage_active(&self, active: bool) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.stage_active = active;
        self.reconcile(&mut state);
    }

    fn reconcile(&self, state: &mut ServiceState) {
        let should_run = state.enabled && state.stage_active;
        if state.enabled && state.capture.is_none() {
            state.capture = ProcessLoopbackCapture::activate().ok();
        }
        if should_run && state.pipeline.is_none() {
            let epoch = self.epoch.fetch_add(1, Ordering::AcqRel).saturating_add(1);
            let started = state
                .capture
                .as_mut()
                .ok_or(())
                .and_then(|capture| Pipeline::start(self.app.clone(), epoch, capture));
            match started {
                Ok(pipeline) => state.pipeline = Some(pipeline),
                Err(()) => {
                    let _ = self.app.emit(
                        SPECTRUM_EVENT,
                        SpectrumFrame::status(epoch, 0, SpectrumState::Unavailable),
                    );
                }
            }
        } else if !should_run {
            if let Some(mut pipeline) = state.pipeline.take() {
                if let Some(capture) = state.capture.as_mut() {
                    pipeline.stop(capture);
                }
            }
        }
    }
}

impl Drop for SpectrumService {
    fn drop(&mut self) {
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(mut pipeline) = state.pipeline.take() {
            if let Some(capture) = state.capture.as_mut() {
                pipeline.stop(capture);
            }
        }
        if let Some(mut capture) = state.capture.take() {
            capture.shutdown();
        }
    }
}
