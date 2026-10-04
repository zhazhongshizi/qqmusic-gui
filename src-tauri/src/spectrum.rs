//! Pure Rust primitives for the experimental live-spectrum pipeline.
//!
//! This module intentionally has no Windows, Tauri, player, or persistence
//! dependencies.  Capture code can hand it fixed mono blocks, while the
//! service/event bridge can consume the bounded latest-frame slot.

use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use rustfft::{num_complex::Complex, Fft, FftPlanner};
use serde::{Deserialize, Serialize};

pub(crate) const SAMPLE_RATE: f32 = 44_100.0;
pub(crate) const FFT_SIZE: usize = 2_048;
pub(crate) const HOP_SIZE: usize = 1_024;
pub(crate) const BAND_COUNT: usize = 24;
pub(crate) const LOW_FREQUENCY_HZ: f32 = 45.0;
pub(crate) const HIGH_FREQUENCY_HZ: f32 = 16_000.0;
pub(crate) const CHANNEL_CAPACITY: usize = 2;
const SILENCE_RMS: f32 = 0.0001;
const DB_FLOOR: f32 = -72.0;
const DB_CEILING: f32 = -12.0;
const RELEASE_TIME: Duration = Duration::from_millis(300);
const ATTACK_ALPHA: f32 = 0.8;
const STOP_TIMEOUT: Duration = Duration::from_secs(1);

/// A fixed-size mono PCM block at the capture sample rate.
///
/// The capture side is expected to assemble exactly one hop before sending a
/// block.  Keeping the samples inline makes the queue bounded in both item
/// count and memory, and avoids an allocation for every capture packet.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PcmBlock {
    samples: [f32; HOP_SIZE],
}

impl PcmBlock {
    /// Creates a block from normalized mono samples (`-1.0..=1.0`).
    pub(crate) fn from_mono(samples: &[f32]) -> Option<Self> {
        if samples.len() != HOP_SIZE {
            return None;
        }
        let mut block = [0.0; HOP_SIZE];
        for (destination, source) in block.iter_mut().zip(samples) {
            *destination = finite_audio(*source);
        }
        Some(Self { samples: block })
    }

    /// Creates a block from one interleaved stereo i16 packet.
    #[cfg(test)]
    pub(crate) fn from_stereo_i16(interleaved: &[i16]) -> Option<Self> {
        if interleaved.len() != HOP_SIZE * 2 {
            return None;
        }
        let mut block = [0.0; HOP_SIZE];
        for (destination, pair) in block.iter_mut().zip(interleaved.chunks_exact(2)) {
            // Widen before adding so i16 extrema cannot overflow.
            *destination = finite_audio((pair[0] as f32 + pair[1] as f32) / (2.0 * 32_768.0));
        }
        Some(Self { samples: block })
    }

    /// Creates a block from one mono i16 packet.
    #[cfg(test)]
    pub(crate) fn from_mono_i16(samples: &[i16]) -> Option<Self> {
        if samples.len() != HOP_SIZE {
            return None;
        }
        let mut block = [0.0; HOP_SIZE];
        for (destination, source) in block.iter_mut().zip(samples) {
            *destination = finite_audio(*source as f32 / 32_768.0);
        }
        Some(Self { samples: block })
    }

    #[cfg(test)]
    pub(crate) fn samples(&self) -> &[f32; HOP_SIZE] {
        &self.samples
    }
}

fn finite_audio(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

/// Public spectrum lifecycle states used by the wire DTO.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SpectrumState {
    Active,
    Idle,
    Unavailable,
    Failed,
}

/// Strict, bounded event payload.  The fixed array guarantees exactly 24
/// bands and prevents raw PCM/FFT buffers from crossing the interface.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SpectrumFrame {
    pub(crate) epoch: u64,
    pub(crate) sequence: u64,
    pub(crate) state: SpectrumState,
    pub(crate) bands: [f32; BAND_COUNT],
}

impl SpectrumFrame {
    pub(crate) fn status(epoch: u64, sequence: u64, state: SpectrumState) -> Self {
        Self {
            epoch,
            sequence,
            state,
            bands: [0.0; BAND_COUNT],
        }
    }

    #[cfg(test)]
    pub(crate) fn is_well_formed(&self) -> bool {
        self.bands
            .iter()
            .all(|band| band.is_finite() && (0.0..=1.0).contains(band))
    }
}

struct QueueState {
    blocks: VecDeque<PcmBlock>,
    closed: bool,
    dropped: u64,
}

struct BlockQueue {
    state: Mutex<QueueState>,
    wake: Condvar,
}

impl BlockQueue {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(QueueState {
                blocks: VecDeque::with_capacity(CHANNEL_CAPACITY),
                closed: false,
                dropped: 0,
            }),
            wake: Condvar::new(),
        })
    }

    fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            state.blocks.clear();
            self.wake.notify_all();
        }
    }
}

/// Error returned when a block queue has been stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PcmSendError;

/// Non-blocking producer for the fixed-capacity PCM queue.
#[derive(Clone)]
pub(crate) struct PcmBlockSender {
    queue: Arc<BlockQueue>,
}

impl PcmBlockSender {
    /// Enqueues a block without waiting.  If the queue is full, the oldest
    /// block is discarded so the analyzer always converges toward fresh audio.
    pub(crate) fn try_send(&self, block: PcmBlock) -> Result<(), PcmSendError> {
        let mut state = self.queue.state.lock().map_err(|_| PcmSendError)?;
        if state.closed {
            return Err(PcmSendError);
        }
        if state.blocks.len() == CHANNEL_CAPACITY {
            state.blocks.pop_front();
            state.dropped = state.dropped.saturating_add(1);
        }
        state.blocks.push_back(block);
        self.queue.wake.notify_one();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn dropped_blocks(&self) -> u64 {
        self.queue
            .state
            .lock()
            .map(|state| state.dropped)
            .unwrap_or_default()
    }
}

pub(crate) struct PcmBlockReceiver {
    queue: Arc<BlockQueue>,
}

impl PcmBlockReceiver {
    fn recv_timeout(&self, timeout: Duration) -> Option<PcmBlock> {
        let deadline = Instant::now() + timeout;
        let mut state = self.queue.state.lock().ok()?;
        loop {
            if let Some(block) = state.blocks.pop_front() {
                return Some(block);
            }
            if state.closed {
                return None;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let (next_state, result) = self.queue.wake.wait_timeout(state, remaining).ok()?;
            state = next_state;
            if result.timed_out() {
                return state.blocks.pop_front();
            }
        }
    }
}

pub(crate) fn pcm_channel() -> (PcmBlockSender, PcmBlockReceiver) {
    let queue = BlockQueue::new();
    (
        PcmBlockSender {
            queue: Arc::clone(&queue),
        },
        PcmBlockReceiver { queue },
    )
}

/// A single latest-value slot.  Storing a frame replaces any previous frame;
/// there is deliberately no frame queue to build up behind a slow bridge.
#[derive(Clone)]
pub(crate) struct LatestFrameSlot {
    frame: Arc<Mutex<Option<SpectrumFrame>>>,
}

impl LatestFrameSlot {
    pub(crate) fn new() -> Self {
        Self {
            frame: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn store(&self, frame: SpectrumFrame) {
        if let Ok(mut latest) = self.frame.lock() {
            *latest = Some(frame);
        }
    }

    pub(crate) fn take(&self) -> Option<SpectrumFrame> {
        self.frame.lock().ok()?.take()
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut latest) = self.frame.lock() {
            *latest = None;
        }
    }
}

/// Pure analyzer state.  One input block advances one 50%-overlapped FFT.
pub(crate) struct SpectrumAnalyzer {
    fft: Arc<dyn Fft<f32>>,
    scratch: Vec<Complex<f32>>,
    bin_ranges: [std::ops::Range<usize>; BAND_COUNT],
    window: [f32; FFT_SIZE],
    overlap: [f32; HOP_SIZE],
    smoothed: [f32; BAND_COUNT],
    epoch: u64,
    sequence: u64,
}

impl SpectrumAnalyzer {
    pub(crate) fn new(epoch: u64) -> Self {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let scratch = vec![Complex::new(0.0, 0.0); fft.get_inplace_scratch_len()];
        Self {
            fft,
            scratch,
            bin_ranges: band_bin_ranges(),
            window: hann_window(),
            overlap: [0.0; HOP_SIZE],
            smoothed: [0.0; BAND_COUNT],
            epoch,
            sequence: 0,
        }
    }

    pub(crate) fn process_block(&mut self, block: &PcmBlock) -> SpectrumFrame {
        let mut input = [Complex::new(0.0_f32, 0.0_f32); FFT_SIZE];
        input[..HOP_SIZE]
            .iter_mut()
            .zip(self.overlap)
            .for_each(|(slot, sample)| {
                slot.re = sample;
            });
        input[HOP_SIZE..]
            .iter_mut()
            .zip(block.samples)
            .for_each(|(slot, sample)| slot.re = sample);
        self.overlap.copy_from_slice(&block.samples);

        let rms = (input
            .iter()
            .map(|sample| sample.re * sample.re)
            .sum::<f32>()
            / FFT_SIZE as f32)
            .sqrt();
        for (sample, weight) in input.iter_mut().zip(self.window) {
            sample.re *= weight;
        }
        self.fft.process_with_scratch(&mut input, &mut self.scratch);

        let mut target = [0.0; BAND_COUNT];
        if rms > SILENCE_RMS {
            target = map_bands(&input, &self.bin_ranges);
        }
        let release_alpha =
            1.0 - (-(HOP_SIZE as f32 / SAMPLE_RATE) / RELEASE_TIME.as_secs_f32()).exp();
        for (smoothed, target) in self.smoothed.iter_mut().zip(target) {
            let alpha = if target > *smoothed {
                ATTACK_ALPHA
            } else {
                release_alpha
            };
            *smoothed = finite_unit(*smoothed + alpha * (target - *smoothed));
        }
        self.sequence = self.sequence.saturating_add(1);
        SpectrumFrame {
            epoch: self.epoch,
            sequence: self.sequence,
            state: SpectrumState::Active,
            bands: self.smoothed,
        }
    }
}

pub(crate) fn hann_window() -> [f32; FFT_SIZE] {
    std::array::from_fn(|index| {
        0.5 * (1.0 - (2.0 * std::f32::consts::PI * index as f32 / (FFT_SIZE - 1) as f32).cos())
    })
}

fn band_bin_ranges() -> [std::ops::Range<usize>; BAND_COUNT] {
    let frequencies: [f32; FFT_SIZE / 2 + 1] =
        std::array::from_fn(|bin| bin as f32 * SAMPLE_RATE / FFT_SIZE as f32);
    let ratio = HIGH_FREQUENCY_HZ / LOW_FREQUENCY_HZ;
    std::array::from_fn(|index| {
        let low = LOW_FREQUENCY_HZ * ratio.powf(index as f32 / BAND_COUNT as f32);
        let high = LOW_FREQUENCY_HZ * ratio.powf((index + 1) as f32 / BAND_COUNT as f32);
        let start = frequencies.partition_point(|frequency| *frequency < low);
        let end = frequencies.partition_point(|frequency| {
            *frequency < high || (index + 1 == BAND_COUNT && *frequency <= high)
        });
        start..end
    })
}

fn map_bands(
    input: &[Complex<f32>; FFT_SIZE],
    ranges: &[std::ops::Range<usize>; BAND_COUNT],
) -> [f32; BAND_COUNT] {
    std::array::from_fn(|index| {
        let range = ranges[index].clone();
        if range.is_empty() {
            return 0.0;
        }
        let count = range.len();
        let mut sum = 0.0;
        for bin in range {
            let normalization = if bin == 0 { 1.0 } else { 2.0 };
            let amplitude = input[bin].norm() * normalization / FFT_SIZE as f32;
            sum += amplitude * amplitude;
        }
        let amplitude_rms = (sum / count as f32).sqrt();
        db_to_unit(if amplitude_rms > 0.0 {
            20.0 * amplitude_rms.log10()
        } else {
            DB_FLOOR
        })
    })
}

// Original full-bin scan retained as an independent numerical regression oracle.
#[cfg(test)]
fn map_bands_reference(input: &[Complex<f32>; FFT_SIZE]) -> [f32; BAND_COUNT] {
    let mut bands = [0.0; BAND_COUNT];
    let ratio = HIGH_FREQUENCY_HZ / LOW_FREQUENCY_HZ;
    for (band_index, band) in bands.iter_mut().enumerate() {
        let low = LOW_FREQUENCY_HZ * ratio.powf(band_index as f32 / BAND_COUNT as f32);
        let high = LOW_FREQUENCY_HZ * ratio.powf((band_index + 1) as f32 / BAND_COUNT as f32);
        let mut sum = 0.0;
        let mut count = 0_u32;
        for (bin, value) in input[..=FFT_SIZE / 2].iter().enumerate() {
            let frequency = bin as f32 * SAMPLE_RATE / FFT_SIZE as f32;
            let in_band = frequency >= low
                && (frequency < high || (band_index + 1 == BAND_COUNT && frequency <= high));
            if in_band {
                let normalization = if bin == 0 { 1.0 } else { 2.0 };
                let amplitude = value.norm() * normalization / FFT_SIZE as f32;
                sum += amplitude * amplitude;
                count += 1;
            }
        }
        if count > 0 {
            let amplitude_rms = (sum / count as f32).sqrt();
            let db = if amplitude_rms > 0.0 {
                20.0 * amplitude_rms.log10()
            } else {
                DB_FLOOR
            };
            *band = db_to_unit(db);
        }
    }
    bands
}

fn db_to_unit(db: f32) -> f32 {
    finite_unit((db - DB_FLOOR) / (DB_CEILING - DB_FLOOR))
}

fn finite_unit(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

struct WorkerDone {
    state: Mutex<bool>,
    wake: Condvar,
}

impl WorkerDone {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(false),
            wake: Condvar::new(),
        })
    }

    fn signal(&self) {
        if let Ok(mut done) = self.state.lock() {
            *done = true;
            self.wake.notify_all();
        }
    }

    fn wait_for(&self, timeout: Duration) -> bool {
        let Ok(done) = self.state.lock() else {
            return true;
        };
        if *done {
            return true;
        }
        self.wake
            .wait_timeout_while(done, timeout, |done| !*done)
            .map(|(done, _)| *done)
            .unwrap_or(true)
    }
}

/// Analyzer worker with explicit, bounded shutdown.
pub(crate) struct AnalyzerWorker {
    sender: PcmBlockSender,
    queue: Arc<BlockQueue>,
    latest: LatestFrameSlot,
    stop: Arc<AtomicBool>,
    done: Arc<WorkerDone>,
    worker: Option<JoinHandle<()>>,
}

impl AnalyzerWorker {
    pub(crate) fn start(epoch: u64) -> Result<Self, std::io::Error> {
        let (sender, receiver) = pcm_channel();
        let queue = Arc::clone(&sender.queue);
        let latest = LatestFrameSlot::new();
        let worker_latest = latest.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let done = WorkerDone::new();
        let worker_done = Arc::clone(&done);
        let worker = thread::Builder::new()
            .name("qqmusic-spectrum-analyzer".to_owned())
            .spawn(move || {
                let mut analyzer = SpectrumAnalyzer::new(epoch);
                while !worker_stop.load(Ordering::Acquire) {
                    let Some(block) = receiver.recv_timeout(Duration::from_millis(50)) else {
                        continue;
                    };
                    let frame = analyzer.process_block(&block);
                    worker_latest.store(frame);
                }
                worker_done.signal();
            })?;
        Ok(Self {
            sender,
            queue,
            latest,
            stop,
            done,
            worker: Some(worker),
        })
    }

    pub(crate) fn sender(&self) -> PcmBlockSender {
        self.sender.clone()
    }

    pub(crate) fn latest(&self) -> LatestFrameSlot {
        self.latest.clone()
    }

    pub(crate) fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.queue.close();
        if self.done.wait_for(STOP_TIMEOUT) {
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        } else {
            // Dropping JoinHandle detaches a worker that failed to honor the
            // bound; it no longer owns a live producer or application handle.
            self.worker.take();
        }
        self.latest.clear();
    }
}

impl Drop for AnalyzerWorker {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine_block(frequency: f32, amplitude: f32, phase: f32) -> PcmBlock {
        let mut samples = [0.0; HOP_SIZE];
        for (index, sample) in samples.iter_mut().enumerate() {
            *sample = amplitude
                * (2.0 * std::f32::consts::PI * frequency * index as f32 / SAMPLE_RATE + phase)
                    .sin();
        }
        PcmBlock { samples }
    }

    fn continuous_sine_block(frequency: f32, amplitude: f32, block_index: usize) -> PcmBlock {
        let phase =
            2.0 * std::f32::consts::PI * frequency * (block_index * HOP_SIZE) as f32 / SAMPLE_RATE;
        sine_block(frequency, amplitude, phase)
    }

    #[test]
    fn pcm_blocks_are_fixed_and_stereo_is_downmixed() {
        let interleaved = [i16::MAX, i16::MIN].repeat(HOP_SIZE);
        let block = PcmBlock::from_stereo_i16(&interleaved).expect("fixed stereo block");
        assert!(block.samples().iter().all(|sample| sample.abs() < 0.0001));
        assert!(PcmBlock::from_stereo_i16(&interleaved[..2]).is_none());
        assert!(PcmBlock::from_mono_i16(&[i16::MIN; HOP_SIZE]).is_some());
        assert!(PcmBlock::from_mono(&[f32::NAN; HOP_SIZE])
            .expect("fixed mono block")
            .samples()
            .iter()
            .all(|sample| *sample == 0.0));
    }

    #[test]
    fn hann_window_has_zero_edges_and_unit_center() {
        let window = hann_window();
        assert!(window[0].abs() < f32::EPSILON);
        assert!(window[FFT_SIZE - 1].abs() < f32::EPSILON);
        assert!((window[FFT_SIZE / 2] - 1.0).abs() < 0.001);
    }

    #[test]
    fn cached_band_ranges_match_original_full_scan() {
        let ranges = band_bin_ranges();
        for scale in [0.0, 0.001, 0.1, 1.0, 10.0] {
            let input = std::array::from_fn(|bin| {
                Complex::new(
                    (bin as f32 * 0.37).sin() * scale,
                    (bin as f32 * 0.13).cos() * scale,
                )
            });
            assert_eq!(map_bands(&input, &ranges), map_bands_reference(&input));
        }
        // Exercise every frequency bin, including both edges of every band.
        for bin in 0..=FFT_SIZE / 2 {
            let mut input = [Complex::new(0.0, 0.0); FFT_SIZE];
            input[bin] = Complex::new(12.0, 3.0);
            assert_eq!(map_bands(&input, &ranges), map_bands_reference(&input));
        }
    }

    #[test]
    fn analyzer_emits_24_finite_clamped_bands_and_sequences() {
        let mut analyzer = SpectrumAnalyzer::new(7);
        let block = sine_block(440.0, 0.8, 0.0);
        let first = analyzer.process_block(&block);
        let second = analyzer.process_block(&block);
        assert_eq!(first.epoch, 7);
        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);
        assert_eq!(first.bands.len(), BAND_COUNT);
        assert!(second.is_well_formed());
        assert!(second.bands.iter().any(|band| *band > 0.0));
    }

    #[test]
    fn known_frequency_is_in_expected_log_band_with_limited_leakage() {
        let frequency = 440.0;
        let ratio = HIGH_FREQUENCY_HZ / LOW_FREQUENCY_HZ;
        let expected =
            (BAND_COUNT as f32 * (frequency / LOW_FREQUENCY_HZ).ln() / ratio.ln()).floor() as usize;
        let mut analyzer = SpectrumAnalyzer::new(3);
        let mut frame = SpectrumFrame::status(3, 0, SpectrumState::Idle);
        for _ in 0..8 {
            frame = analyzer.process_block(&sine_block(frequency, 0.8, 0.0));
        }
        let strongest = frame
            .bands
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| left.total_cmp(right))
            .map(|(index, _)| index)
            .unwrap();
        assert_eq!(strongest, expected);
        assert!(frame.bands[strongest] > 0.1);
        if strongest > 0 {
            assert!(frame.bands[strongest - 1] < frame.bands[strongest]);
        }
        if strongest + 1 < BAND_COUNT {
            assert!(frame.bands[strongest + 1] < frame.bands[strongest]);
        }
    }

    #[test]
    fn frequency_above_ui_range_does_not_create_a_band() {
        let mut analyzer = SpectrumAnalyzer::new(5);
        let mut frame = SpectrumFrame::status(5, 0, SpectrumState::Idle);
        // Use an FFT-bin-centred, phase-continuous tone so this checks the
        // explicit high-frequency bin exclusion rather than window leakage.
        let frequency = 900.0 * SAMPLE_RATE / FFT_SIZE as f32;
        analyzer.overlap = continuous_sine_block(frequency, 0.8, 0).samples;
        for block_index in 0..8 {
            frame = analyzer.process_block(&continuous_sine_block(frequency, 0.8, block_index));
        }
        assert!(frame.bands.iter().all(|band| *band < 0.001));
    }

    #[test]
    fn db_mapping_has_clamped_finite_endpoints() {
        assert_eq!(db_to_unit(DB_FLOOR), 0.0);
        assert_eq!(db_to_unit(DB_CEILING), 1.0);
        assert_eq!(db_to_unit(-100.0), 0.0);
        assert_eq!(db_to_unit(0.0), 1.0);
        assert_eq!(db_to_unit(f32::NAN), 0.0);
        assert_eq!(db_to_unit(f32::INFINITY), 0.0);
    }

    #[test]
    fn overlap_keeps_the_previous_hop_for_the_next_window() {
        let block = sine_block(440.0, 0.8, 0.0);
        let mut analyzer = SpectrumAnalyzer::new(2);
        analyzer.process_block(&block);
        assert_eq!(analyzer.overlap, block.samples);
    }

    #[test]
    fn silence_gate_and_release_converge_to_zero() {
        let mut analyzer = SpectrumAnalyzer::new(1);
        let loud = sine_block(1_000.0, 0.8, 0.0);
        for _ in 0..5 {
            analyzer.process_block(&loud);
        }
        let before = analyzer.process_block(&loud);
        let silence = PcmBlock {
            samples: [0.0; HOP_SIZE],
        };
        let after = analyzer.process_block(&silence);
        assert!(before.bands.iter().any(|band| *band > 0.1));
        assert!(after
            .bands
            .iter()
            .zip(before.bands)
            .all(|(next, previous)| next <= &previous));
        for _ in 0..300 {
            analyzer.process_block(&silence);
        }
        let settled = analyzer.process_block(&silence);
        assert!(settled.bands.iter().all(|band| *band < 0.001));
    }

    #[test]
    fn queue_is_capacity_two_and_drops_oldest_without_blocking() {
        let (sender, receiver) = pcm_channel();
        let first = PcmBlock {
            samples: [1.0; HOP_SIZE],
        };
        let second = PcmBlock {
            samples: [2.0; HOP_SIZE],
        };
        let third = PcmBlock {
            samples: [3.0; HOP_SIZE],
        };
        sender.try_send(first).unwrap();
        sender.try_send(second).unwrap();
        sender.try_send(third).unwrap();
        assert_eq!(sender.dropped_blocks(), 1);
        assert_eq!(
            receiver.recv_timeout(Duration::ZERO).unwrap().samples[0],
            2.0
        );
        assert_eq!(
            receiver.recv_timeout(Duration::ZERO).unwrap().samples[0],
            3.0
        );
        assert!(receiver.recv_timeout(Duration::ZERO).is_none());
    }

    #[test]
    fn latest_slot_replaces_old_frame_and_clears() {
        let slot = LatestFrameSlot::new();
        slot.store(SpectrumFrame::status(1, 1, SpectrumState::Idle));
        slot.store(SpectrumFrame::status(1, 2, SpectrumState::Active));
        assert_eq!(slot.take().unwrap().sequence, 2);
        assert!(slot.take().is_none());
        slot.store(SpectrumFrame::status(1, 3, SpectrumState::Failed));
        slot.clear();
        assert!(slot.take().is_none());
    }

    #[test]
    fn analyzer_worker_stops_idempotently_and_clears_latest() {
        let mut worker = AnalyzerWorker::start(9).expect("worker");
        let sender = worker.sender();
        sender
            .try_send(sine_block(440.0, 0.8, 0.0))
            .expect("send block");
        let deadline = Instant::now() + Duration::from_secs(1);
        while worker.latest().take().is_none() && Instant::now() < deadline {
            thread::yield_now();
        }
        worker.stop();
        worker.stop();
        assert!(worker.latest().take().is_none());
        assert!(sender.try_send(sine_block(440.0, 0.8, 0.0)).is_err());
    }

    #[test]
    fn strict_frame_serialization_uses_camel_case_and_rejects_extra_fields() {
        let frame = SpectrumFrame::status(4, 2, SpectrumState::Unavailable);
        let json = serde_json::to_value(&frame).unwrap();
        assert!(json.get("epoch").is_some());
        assert!(json.get("sequence").is_some());
        assert!(json.get("bands").is_some());
        assert_eq!(json["bands"].as_array().unwrap().len(), BAND_COUNT);
        let mut object = json.as_object().unwrap().clone();
        object.insert("extra".to_owned(), serde_json::json!(true));
        assert!(
            serde_json::from_value::<SpectrumFrame>(serde_json::Value::Object(object)).is_err()
        );
    }
}
