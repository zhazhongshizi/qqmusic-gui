import { useSyncExternalStore } from "react";

import {
  parseSpectrumFrame,
  type SpectrumFrame,
  type SpectrumState,
} from "../../contracts/spectrum";
import {
  listenSpectrumFrames,
  spectrumSetStageActive,
} from "../../backend/spectrumAdapter";

export type SpectrumServiceStatus =
  | "idle"
  | "starting"
  | "active"
  | "unavailable"
  | "failed";

export interface SpectrumStoreSnapshot {
  readonly status: SpectrumServiceStatus;
  readonly stageActive: boolean;
  readonly subscribed: boolean;
}

const IDLE_SNAPSHOT: SpectrumStoreSnapshot = Object.freeze({
  status: "idle",
  stageActive: false,
  subscribed: false,
});

let snapshot: SpectrumStoreSnapshot = IDLE_SNAPSHOT;
let latestFrame: SpectrumFrame | null = null;
let currentEpoch: number | null = null;
let currentSequence: number | null = null;
let unlisten: (() => void) | null = null;
let lifecycleToken = 0;
const listeners = new Set<() => void>();

function emit(next: SpectrumStoreSnapshot): void {
  if (
    next.status === snapshot.status &&
    next.stageActive === snapshot.stageActive &&
    next.subscribed === snapshot.subscribed
  ) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function setStatus(status: SpectrumServiceStatus): void {
  emit({ ...snapshot, status });
}

function frameStatus(state: SpectrumState): SpectrumServiceStatus {
  return state === "active" ? "active" : state;
}

function clearFrame(): void {
  latestFrame = null;
  // Keep the cursor as a high-water mark. A late event from a just-disabled
  // listener must not become the first frame of a subsequent stage mount.
}

function cleanupListener(): void {
  const cleanup = unlisten;
  unlisten = null;
  if (cleanup) cleanup();
}

/** Subscribe to low-frequency lifecycle changes; frame arrivals never notify this set. */
export function subscribeSpectrum(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSpectrumSnapshot(): SpectrumStoreSnapshot {
  return snapshot;
}

/** Read the latest frame from the transient ref used by the Canvas renderer. */
export function getLatestSpectrumFrame(): SpectrumFrame | null {
  return latestFrame;
}

export function getSpectrumCursor(): {
  readonly epoch: number | null;
  readonly sequence: number | null;
} {
  return { epoch: currentEpoch, sequence: currentSequence };
}

/**
 * Store-side defense in depth for callers that bypass the Tauri adapter. Returns whether
 * the frame advanced the cursor. No listener is called for ordinary high-frequency frames.
 */
export function acceptSpectrumFrame(value: unknown): boolean {
  let frame: SpectrumFrame;
  try {
    frame = parseSpectrumFrame(value);
  } catch {
    return false;
  }

  if (currentEpoch !== null) {
    if (frame.epoch < currentEpoch) return false;
    if (frame.epoch === currentEpoch && currentSequence !== null && frame.sequence <= currentSequence) {
      return false;
    }
  }

  latestFrame = frame;
  currentEpoch = frame.epoch;
  currentSequence = frame.sequence;
  setStatus(frameStatus(frame.state));
  return true;
}

export function clearLatestSpectrumFrame(): void {
  clearFrame();
}

/**
 * Start one stage subscription. A concurrent stop invalidates this attempt and cleans up
 * any listener that resolves after unmount.
 */
export async function setSpectrumStageActive(active: boolean): Promise<void> {
  if (typeof active !== "boolean") throw new TypeError("active must be boolean");

  if (!active) {
    lifecycleToken += 1;
    if (snapshot.stageActive || snapshot.subscribed || snapshot.status !== "idle") {
      emit({ ...snapshot, stageActive: false, subscribed: false, status: "idle" });
    }
    clearFrame();
    cleanupListener();
    try {
      await spectrumSetStageActive(false);
    } catch {
      // Stopping is best effort and must not affect playback or teardown.
    }
    return;
  }

  if (snapshot.stageActive) return;
  const token = ++lifecycleToken;
  clearFrame();
  emit({ ...snapshot, stageActive: true, subscribed: false, status: "starting" });

  let pendingCleanup: (() => void) | null = null;
  try {
    // Subscribe before starting capture so the first frame cannot race the listener.
    pendingCleanup = await listenSpectrumFrames((frame) => {
      // Native unlisten is best effort; the lifecycle token is the final guard
      // against queued events arriving after unmount/inactivation.
      if (token !== lifecycleToken || !snapshot.stageActive) return;
      acceptSpectrumFrame(frame);
    });
    if (token !== lifecycleToken || !snapshot.stageActive) {
      pendingCleanup();
      return;
    }
    unlisten = pendingCleanup;
    pendingCleanup = null;
    await spectrumSetStageActive(true);
    if (token !== lifecycleToken || !snapshot.stageActive) {
      cleanupListener();
      return;
    }
    // A frame can arrive while the command is in flight. Preserve that observed
    // state instead of replacing it with the transient starting status.
    emit({ ...snapshot, subscribed: true });
  } catch {
    pendingCleanup?.();
    if (token !== lifecycleToken) return;
    cleanupListener();
    clearFrame();
    emit({ ...snapshot, stageActive: false, subscribed: false, status: "unavailable" });
    try {
      await spectrumSetStageActive(false);
    } catch {
      // Best effort cleanup after an activation failure.
    }
  }
}

export function useSpectrumSnapshot(): SpectrumStoreSnapshot {
  return useSyncExternalStore(subscribeSpectrum, getSpectrumSnapshot, getSpectrumSnapshot);
}

/** Test and teardown helper; it does not issue an IPC command. */
export function resetSpectrumStore(): void {
  lifecycleToken += 1;
  cleanupListener();
  clearFrame();
  currentEpoch = null;
  currentSequence = null;
  snapshot = IDLE_SNAPSHOT;
  listeners.clear();
}

export const spectrumStore = {
  subscribe: subscribeSpectrum,
  getSnapshot: getSpectrumSnapshot,
  getLatestFrame: getLatestSpectrumFrame,
  getCursor: getSpectrumCursor,
  acceptFrame: acceptSpectrumFrame,
  clearFrame: clearLatestSpectrumFrame,
  setStageActive: setSpectrumStageActive,
  reset: resetSpectrumStore,
} as const;
