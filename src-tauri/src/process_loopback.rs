//! Windows process-loopback PCM source for the experimental live spectrum.
//!
//! This module only captures the current GUI process tree. It drains and
//! releases WASAPI packets promptly, then forwards fixed mono blocks through
//! the bounded spectrum channel without waiting for its consumer.

#![cfg(windows)]
#![cfg_attr(test, allow(dead_code))]

use std::{
    mem::ManuallyDrop,
    ptr,
    sync::{mpsc, Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::Duration,
};

use crate::spectrum::{PcmBlock, PcmBlockSender, HOP_SIZE};

use windows::{
    core::{implement, IUnknown, Interface, Ref, Result as WinResult, HSTRING},
    System::Profile::AnalyticsInfo,
    Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
        Media::Audio::{
            ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
            IActivateAudioInterfaceCompletionHandler,
            IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
            AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
            AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVE_FORMAT_PCM,
        },
        System::{
            Com::{
                StructuredStorage::{
                    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
                },
                BLOB,
            },
            Threading::{CreateEventW, SetEvent, WaitForMultipleObjects},
            Variant::VT_BLOB,
            WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        },
    },
};

const PROCESS_LOOPBACK_MIN_BUILD: u32 = 20_348;
const CAPTURE_SAMPLE_RATE: u32 = 44_100;
const CAPTURE_CHANNELS: u16 = 2;
const CAPTURE_BITS_PER_SAMPLE: u16 = 16;
const CAPTURE_BLOCK_ALIGN: u16 = CAPTURE_CHANNELS * (CAPTURE_BITS_PER_SAMPLE / 8);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

/// Owns one initialized process-loopback session while the experiment is enabled.
/// Stage transitions only start and stop its audio stream; asynchronous WASAPI
/// activation is not repeated until the complete session is shut down.
pub(crate) struct ProcessLoopbackCapture {
    control_event: Arc<OwnedEvent>,
    commands: mpsc::SyncSender<WorkerCommand>,
    worker: Option<JoinHandle<()>>,
    streaming: bool,
}

impl ProcessLoopbackCapture {
    /// Activates and initializes process-loopback capture for the current process tree.
    pub(crate) fn activate() -> Result<Self, &'static str> {
        let control_event = match OwnedEvent::new(false) {
            Ok(event) => Arc::new(event),
            Err(_) => {
                log_state("failed", Some("control_event"));
                return Err("control_event");
            }
        };
        let worker_control = Arc::clone(&control_event);
        let (command_tx, command_rx) = mpsc::sync_channel(4);
        let (startup_tx, startup_rx) = mpsc::sync_channel(1);
        let worker = match thread::Builder::new()
            .name("qqmusic-process-loopback".to_owned())
            .spawn(move || worker_main(worker_control, command_rx, startup_tx))
        {
            Ok(worker) => worker,
            Err(_) => {
                log_state("failed", Some("thread_spawn"));
                return Err("thread_spawn");
            }
        };

        let mut capture = Self {
            control_event,
            commands: command_tx,
            worker: Some(worker),
            streaming: false,
        };
        match startup_rx.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(())) => Ok(capture),
            Ok(Err(reason)) => {
                capture.shutdown();
                Err(reason)
            }
            Err(_) => {
                capture.shutdown();
                Err("startup_timeout")
            }
        }
    }

    pub(crate) fn start_stream(&mut self, sender: PcmBlockSender) -> Result<(), &'static str> {
        if self.streaming {
            return Ok(());
        }
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        self.send(WorkerCommand::Start {
            sender,
            ready: ready_tx,
        })?;
        match ready_rx.recv_timeout(STOP_TIMEOUT) {
            Ok(Ok(())) => {
                self.streaming = true;
                Ok(())
            }
            Ok(Err(reason)) => Err(reason),
            Err(_) => Err("stream_start_timeout"),
        }
    }

    pub(crate) fn stop_stream(&mut self) -> Result<(), &'static str> {
        if !self.streaming {
            return Ok(());
        }
        log_state("stopping", None);
        let (stopped_tx, stopped_rx) = mpsc::sync_channel(1);
        self.send(WorkerCommand::Stop {
            stopped: stopped_tx,
        })?;
        match stopped_rx.recv_timeout(STOP_TIMEOUT) {
            Ok(()) => {
                self.streaming = false;
                log_state("idle", None);
                Ok(())
            }
            Err(_) => {
                log_state("failed", Some("stream_stop_timeout"));
                Err("stream_stop_timeout")
            }
        }
    }

    fn send(&self, command: WorkerCommand) -> Result<(), &'static str> {
        self.commands.send(command).map_err(|_| "command_channel")?;
        self.control_event.set();
        Ok(())
    }

    /// Fully releases the session. Unlike the previous implementation, shutdown
    /// never detaches the COM worker: callback and WASAPI objects are dropped on
    /// their owning MTA before it exits.
    pub(crate) fn shutdown(&mut self) {
        let Some(worker) = self.worker.take() else {
            return;
        };
        let _ = self.stop_stream();
        log_state("shutting_down", None);
        let _ = self.send(WorkerCommand::Shutdown);
        let _ = worker.join();
        self.streaming = false;
    }
}

impl Drop for ProcessLoopbackCapture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

enum WorkerCommand {
    Start {
        sender: PcmBlockSender,
        ready: mpsc::SyncSender<Result<(), &'static str>>,
    },
    Stop {
        stopped: mpsc::SyncSender<()>,
    },
    Shutdown,
}

struct OwnedEvent(HANDLE);

impl OwnedEvent {
    fn new(manual_reset: bool) -> WinResult<Self> {
        // An unnamed kernel event is process-local and cannot expose audio data.
        let event = unsafe { CreateEventW(None, manual_reset, false, None)? };
        Ok(Self(event))
    }

    fn set(&self) {
        let _ = unsafe { SetEvent(self.0) };
    }
}

// Kernel event handles are safe to signal and wait from another thread.
unsafe impl Send for OwnedEvent {}
unsafe impl Sync for OwnedEvent {}

impl Drop for OwnedEvent {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn worker_main(
    control_event: Arc<OwnedEvent>,
    commands: mpsc::Receiver<WorkerCommand>,
    startup: mpsc::SyncSender<Result<(), &'static str>>,
) {
    log_state("starting", None);
    let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    if initialized.is_err() {
        let _ = startup.try_send(Err("com_init"));
        log_state("failed", Some("com_init"));
        return;
    }

    let build = analytics_build();
    if build.is_none() {
        let _ = startup.try_send(Err("analytics_version"));
        log_state("unavailable", Some("analytics_version"));
        unsafe { RoUninitialize() };
        return;
    }
    if build.is_some_and(|build| build < PROCESS_LOOPBACK_MIN_BUILD) {
        let _ = startup.try_send(Err("unsupported_build"));
        log_state("unavailable", Some("unsupported_build"));
        unsafe { RoUninitialize() };
        return;
    }
    let outcome = run_session(&control_event, &commands, &startup);
    match outcome {
        Ok(()) => {
            log_state("stopped", None);
        }
        Err(reason) => {
            let _ = startup.try_send(Err(reason));
            log_state("failed", Some(reason));
        }
    }
    unsafe { RoUninitialize() };
}

fn run_session(
    control_event: &OwnedEvent,
    commands: &mpsc::Receiver<WorkerCommand>,
    startup: &mpsc::SyncSender<Result<(), &'static str>>,
) -> Result<(), &'static str> {
    let completion = Arc::new(ActivationShared::default());
    let handler = ActivationHandler {
        shared: Arc::clone(&completion),
    };
    let handler: IActivateAudioInterfaceCompletionHandler = handler.into();
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: std::process::id(),
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    // ActivateAudioInterfaceAsync requires a VT_BLOB whose data is the
    // AUDIOCLIENT_ACTIVATION_PARAMS structure. The structure stays alive until
    // this synchronous API call returns; the async operation copies the blob.
    // `pBlobData` borrows the stack-backed activation params for this
    // synchronous call. Wrapping the complete PROPVARIANT is essential:
    // `PROPVARIANT::drop` calls PropVariantClear, which would otherwise try to
    // free that borrowed stack pointer and corrupt the process heap.
    let prop_variant = ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: &params as *const _ as *mut u8,
                    },
                },
            }),
        },
    });

    let activation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some((&*prop_variant) as *const PROPVARIANT),
            &handler,
        )
    };
    let activation = activation.map_err(|_| "activation_start")?;
    let client = wait_for_activation(&completion)?;
    // Keep the async operation for the complete capture session. The callback
    // wakes `wait_for_activation` before its COM call frame has necessarily
    // returned, so dropping the operation immediately after the wake can race
    // the callback epilogue and corrupt the COM heap.
    let mut session = initialize_session(client, activation, handler, completion)?;
    startup.try_send(Ok(())).map_err(|_| "startup_receiver")?;
    let result = session.command_loop(control_event, commands);
    let _ = params;
    result
}

struct CaptureSession {
    capture: IAudioCaptureClient,
    client: IAudioClient,
    capture_event: OwnedEvent,
    _activation: IActivateAudioInterfaceAsyncOperation,
    _handler: IActivateAudioInterfaceCompletionHandler,
    _completion: Arc<ActivationShared>,
}

impl CaptureSession {
    fn command_loop(
        &mut self,
        control_event: &OwnedEvent,
        commands: &mpsc::Receiver<WorkerCommand>,
    ) -> Result<(), &'static str> {
        let mut sender: Option<PcmBlockSender> = None;
        let mut assembler = MonoPcmAssembler::default();
        loop {
            let wait = unsafe {
                WaitForMultipleObjects(&[self.capture_event.0, control_event.0], false, 100)
            };
            if wait == WAIT_OBJECT_0 {
                if let Some(current_sender) = sender.as_ref() {
                    match drain_packets(&self.capture, &mut assembler, current_sender) {
                        Ok(DrainResult::Continue) => {}
                        Ok(DrainResult::QueueClosed) => {
                            let _ = unsafe { self.client.Stop() };
                            sender = None;
                            assembler = MonoPcmAssembler::default();
                        }
                        Err(reason) => {
                            let _ = unsafe { self.client.Stop() };
                            sender = None;
                            assembler = MonoPcmAssembler::default();
                            log_state("failed", Some(reason));
                        }
                    }
                }
            } else if wait.0 == WAIT_OBJECT_0.0 + 1 {
                while let Ok(command) = commands.try_recv() {
                    match command {
                        WorkerCommand::Start {
                            sender: next_sender,
                            ready,
                        } => {
                            if sender.is_some() {
                                let _ = ready.try_send(Ok(()));
                                continue;
                            }
                            assembler = MonoPcmAssembler::default();
                            match unsafe { self.client.Start() } {
                                Ok(()) => {
                                    sender = Some(next_sender);
                                    if ready.try_send(Ok(())).is_err() {
                                        let _ = unsafe { self.client.Stop() };
                                        sender = None;
                                    }
                                }
                                Err(_) => {
                                    let _ = ready.try_send(Err("capture_start"));
                                }
                            }
                        }
                        WorkerCommand::Stop { stopped } => {
                            if sender.take().is_some() {
                                let _ = unsafe { self.client.Stop() };
                            }
                            assembler = MonoPcmAssembler::default();
                            let _ = stopped.try_send(());
                        }
                        WorkerCommand::Shutdown => {
                            if sender.take().is_some() {
                                let _ = unsafe { self.client.Stop() };
                            }
                            return Ok(());
                        }
                    }
                }
            } else if wait == WAIT_TIMEOUT || wait.0 == WAIT_TIMEOUT.0 {
                continue;
            } else {
                return Err("capture_wait");
            }
        }
    }
}

#[derive(Default)]
struct ActivationShared {
    outcome: Mutex<Option<ActivationOutcome>>,
    signal: Condvar,
}

enum ActivationOutcome {
    Success(MtaAudioClient),
    Failed(&'static str),
}

/// Transfers one owned `IAudioClient` reference between threads in the same COM MTA.
///
/// Windows invokes the activation callback on an MTA thread, and the receiving
/// capture worker has already entered the process MTA. The pointer is stored as an
/// integer so this wrapper does not claim that arbitrary `IAudioClient` values are
/// generally `Send`. Drop reconstructs and releases an unconsumed owned reference.
struct MtaAudioClient(usize);

impl MtaAudioClient {
    fn new(client: IAudioClient) -> Self {
        Self(client.into_raw() as usize)
    }

    fn into_client(mut self) -> IAudioClient {
        let raw = self.0;
        self.0 = 0;
        // SAFETY: `new` stored exactly one owned reference and this consumes it
        // exactly once on another thread in the same process MTA.
        unsafe { IAudioClient::from_raw(raw as *mut _) }
    }
}

impl Drop for MtaAudioClient {
    fn drop(&mut self) {
        if self.0 == 0 {
            return;
        }
        // SAFETY: the non-zero value is the still-owned reference from `new`;
        // callback and worker threads are both members of the process MTA.
        unsafe { drop(IAudioClient::from_raw(self.0 as *mut _)) };
        self.0 = 0;
    }
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler {
    shared: Arc<ActivationShared>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        activateoperation: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> WinResult<()> {
        let outcome = match activateoperation.as_ref() {
            Some(operation) => activation_result(operation),
            None => ActivationOutcome::Failed("activation_operation"),
        };
        if let Ok(mut slot) = self.shared.outcome.lock() {
            if slot.is_none() {
                *slot = Some(outcome);
                self.shared.signal.notify_all();
            }
        }
        // Completion errors are represented by the stable outcome above; returning
        // success prevents the callback infrastructure from turning a best-effort
        // probe failure into a player failure.
        Ok(())
    }
}

fn activation_result(operation: &IActivateAudioInterfaceAsyncOperation) -> ActivationOutcome {
    let mut activation_result = windows::core::HRESULT(0);
    let mut activated: Option<IUnknown> = None;
    if unsafe { operation.GetActivateResult(&mut activation_result, &mut activated) }.is_err() {
        return ActivationOutcome::Failed("activation_result");
    }
    if activation_result.is_err() {
        return ActivationOutcome::Failed("activation_hresult");
    }
    let Some(unknown) = activated else {
        return ActivationOutcome::Failed("activation_interface");
    };
    let Ok(client) = unknown.cast::<IAudioClient>() else {
        return ActivationOutcome::Failed("audio_client_cast");
    };
    ActivationOutcome::Success(MtaAudioClient::new(client))
}

fn wait_for_activation(shared: &ActivationShared) -> Result<IAudioClient, &'static str> {
    let mut outcome = shared.outcome.lock().map_err(|_| "activation_lock")?;
    loop {
        if let Some(outcome) = outcome.take() {
            return match outcome {
                ActivationOutcome::Success(client) => Ok(client.into_client()),
                ActivationOutcome::Failed(reason) => Err(reason),
            };
        }
        outcome = shared.signal.wait(outcome).map_err(|_| "activation_wait")?;
    }
}

fn initialize_session(
    client: IAudioClient,
    activation: IActivateAudioInterfaceAsyncOperation,
    handler: IActivateAudioInterfaceCompletionHandler,
    completion: Arc<ActivationShared>,
) -> Result<CaptureSession, &'static str> {
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: CAPTURE_CHANNELS,
        nSamplesPerSec: CAPTURE_SAMPLE_RATE,
        nAvgBytesPerSec: CAPTURE_SAMPLE_RATE * CAPTURE_BLOCK_ALIGN as u32,
        nBlockAlign: CAPTURE_BLOCK_ALIGN,
        wBitsPerSample: CAPTURE_BITS_PER_SAMPLE,
        cbSize: 0,
    };
    let flags = AUDCLNT_STREAMFLAGS_LOOPBACK
        | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
    unsafe {
        client
            .Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, &format, None)
            .map_err(|_| "audio_client_initialize")?;
    }
    let _buffer_frames = unsafe { client.GetBufferSize() }.map_err(|_| "buffer_size")?;

    let capture_event = OwnedEvent::new(false).map_err(|_| "capture_event")?;
    unsafe { client.SetEventHandle(capture_event.0) }.map_err(|_| "capture_event_handle")?;
    let capture: IAudioCaptureClient =
        unsafe { client.GetService() }.map_err(|_| "capture_client")?;
    Ok(CaptureSession {
        capture,
        client,
        capture_event,
        _activation: activation,
        _handler: handler,
        _completion: completion,
    })
}

enum DrainResult {
    Continue,
    QueueClosed,
}

fn drain_packets(
    capture: &IAudioCaptureClient,
    assembler: &mut MonoPcmAssembler,
    sender: &PcmBlockSender,
) -> Result<DrainResult, &'static str> {
    loop {
        let packet_frames = unsafe { capture.GetNextPacketSize() }.map_err(|_| "packet_size")?;
        if packet_frames == 0 {
            return Ok(DrainResult::Continue);
        }
        let mut data: *mut u8 = ptr::null_mut();
        let mut frames = 0u32;
        let mut flags = 0u32;
        unsafe {
            capture
                .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                .map_err(|_| "get_buffer")?;
        }
        let packet_result = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
            assembler.push_silence(frames as usize, sender)
        } else if data.is_null() {
            Err("null_buffer")
        } else {
            let samples = (frames as usize)
                .checked_mul(CAPTURE_CHANNELS as usize)
                .ok_or("packet_size_overflow")?;
            let values = unsafe { std::slice::from_raw_parts(data.cast::<i16>(), samples) };
            assembler.push_stereo_i16(values, sender)
        };
        let release_error = unsafe { capture.ReleaseBuffer(frames) }.err();
        if release_error.is_some() {
            return Err("release_buffer");
        }
        match packet_result {
            Ok(()) => {}
            Err("sender_closed") => return Ok(DrainResult::QueueClosed),
            Err(reason) => return Err(reason),
        }
    }
}

struct MonoPcmAssembler {
    samples: [f32; HOP_SIZE],
    len: usize,
    emitted_blocks: u64,
}

impl Default for MonoPcmAssembler {
    fn default() -> Self {
        Self {
            samples: [0.0; HOP_SIZE],
            len: 0,
            emitted_blocks: 0,
        }
    }
}

impl MonoPcmAssembler {
    fn push_stereo_i16(
        &mut self,
        interleaved: &[i16],
        sender: &PcmBlockSender,
    ) -> Result<(), &'static str> {
        if !interleaved.len().is_multiple_of(CAPTURE_CHANNELS as usize) {
            return Err("odd_stereo_packet");
        }
        for pair in interleaved.chunks_exact(CAPTURE_CHANNELS as usize) {
            let sample = (pair[0] as f32 + pair[1] as f32) / (2.0 * 32_768.0);
            self.push_mono(sample, sender)?;
        }
        Ok(())
    }

    fn push_silence(&mut self, frames: usize, sender: &PcmBlockSender) -> Result<(), &'static str> {
        for _ in 0..frames {
            self.push_mono(0.0, sender)?;
        }
        Ok(())
    }

    fn push_mono(&mut self, sample: f32, sender: &PcmBlockSender) -> Result<(), &'static str> {
        self.samples[self.len] = if sample.is_finite() {
            sample.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        self.len += 1;
        if self.len < HOP_SIZE {
            return Ok(());
        }
        let block = PcmBlock::from_mono(&self.samples).ok_or("block_assembly")?;
        if sender.try_send(block).is_err() {
            return Err("sender_closed");
        }
        self.samples = [0.0; HOP_SIZE];
        self.len = 0;
        self.emitted_blocks = self.emitted_blocks.saturating_add(1);
        Ok(())
    }

    #[cfg(test)]
    fn pending_frames(&self) -> usize {
        self.len
    }
}

fn parse_windows_build(value: &str) -> Option<u32> {
    let value = value.trim();
    if value.contains('.') {
        return value.split('.').nth(2)?.parse().ok();
    }
    let packed = value.parse::<u64>().ok()?;
    Some(((packed >> 16) & 0xffff) as u32)
}

fn analytics_build() -> Option<u32> {
    let version = AnalyticsInfo::VersionInfo()
        .ok()?
        .DeviceFamilyVersion()
        .ok()?;
    parse_windows_build(&hstring_to_string(&version))
}

fn hstring_to_string(value: &HSTRING) -> String {
    value.to_string_lossy()
}

fn log_state(state: &str, reason: Option<&str>) {
    if let Some(reason) = reason {
        eprintln!("[spectrum] state={state} reason={reason}");
    } else {
        eprintln!("[spectrum] state={state}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_build_parsing_handles_dotted_and_packed_versions() {
        assert_eq!(parse_windows_build("10.0.20348.1"), Some(20_348));
        assert_eq!(parse_windows_build("10.0.20347.0"), Some(20_347));
        assert_eq!(parse_windows_build("281474976710656"), Some(0));
        assert_eq!(parse_windows_build("not-a-version"), None);
    }

    #[test]
    fn minimum_build_boundary_is_explicit() {
        assert!(
            parse_windows_build("10.0.20348.0").is_some_and(|b| b >= PROCESS_LOOPBACK_MIN_BUILD)
        );
        assert!(parse_windows_build("10.0.20347.0").is_none_or(|b| b < PROCESS_LOOPBACK_MIN_BUILD));
    }

    fn stereo_frames(frames: usize, left: i16, right: i16) -> Vec<i16> {
        (0..frames).flat_map(|_| [left, right]).collect()
    }

    #[test]
    fn assembler_emits_only_complete_fixed_blocks_across_packets() {
        let (sender, _receiver) = crate::spectrum::pcm_channel();
        let mut assembler = MonoPcmAssembler::default();
        assembler
            .push_stereo_i16(&stereo_frames(600, 1_000, -1_000), &sender)
            .unwrap();
        assert_eq!(assembler.pending_frames(), 600);
        assembler
            .push_stereo_i16(&stereo_frames(424, 2_000, -2_000), &sender)
            .unwrap();
        assert_eq!(assembler.pending_frames(), 0);
        assert_eq!(assembler.emitted_blocks, 1);
    }

    #[test]
    fn assembler_carries_remainder_and_downmixes_extrema_safely() {
        let (sender, _receiver) = crate::spectrum::pcm_channel();
        let mut assembler = MonoPcmAssembler::default();
        assembler
            .push_stereo_i16(&stereo_frames(1_023, i16::MIN, i16::MAX), &sender)
            .unwrap();
        assembler
            .push_stereo_i16(&stereo_frames(2, i16::MIN, i16::MAX), &sender)
            .unwrap();
        assert_eq!(assembler.emitted_blocks, 1);
        assert_eq!(assembler.pending_frames(), 1);
        assert!(assembler.samples[0].is_finite());
        assert!(assembler.push_stereo_i16(&[1], &sender).is_err());
    }

    #[test]
    fn silent_packets_fill_zeroes_without_reading_the_buffer() {
        let (sender, _receiver) = crate::spectrum::pcm_channel();
        let mut assembler = MonoPcmAssembler::default();
        assembler.push_silence(HOP_SIZE, &sender).unwrap();
        assert_eq!(assembler.emitted_blocks, 1);
        assert_eq!(assembler.pending_frames(), 0);
    }

    #[test]
    fn closed_spectrum_queue_stops_capture_assembly_gracefully() {
        let mut worker = crate::spectrum::AnalyzerWorker::start(1).unwrap();
        let sender = worker.sender();
        worker.stop();
        let mut assembler = MonoPcmAssembler::default();
        assert_eq!(
            assembler.push_silence(HOP_SIZE, &sender),
            Err("sender_closed")
        );
    }

    #[test]
    #[ignore = "uses the live Windows process-loopback device"]
    fn live_capture_can_start_and_stop_without_a_gui() {
        let mut capture = ProcessLoopbackCapture::activate().expect("capture activation");
        for epoch in 1..=6 {
            let mut analyzer = crate::spectrum::AnalyzerWorker::start(epoch).expect("analyzer");
            capture
                .start_stream(analyzer.sender())
                .expect("capture stream");
            std::thread::sleep(Duration::from_secs(1));
            analyzer.stop();
            capture.stop_stream().expect("capture stream stop");
        }
        capture.shutdown();
    }
}
