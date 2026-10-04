import { afterEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.hoisted(() => vi.fn());
const stageActiveMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../backend/spectrumAdapter", () => ({
  listenSpectrumFrames: listenMock,
  spectrumSetStageActive: stageActiveMock,
}));

import {
  SPECTRUM_BAND_COUNT,
} from "../../contracts/spectrum";
import {
  acceptSpectrumFrame,
  clearLatestSpectrumFrame,
  getLatestSpectrumFrame,
  getSpectrumCursor,
  getSpectrumSnapshot,
  resetSpectrumStore,
  setSpectrumStageActive,
  subscribeSpectrum,
} from "./spectrumStore";

const frame = (epoch: number, sequence: number, state = "active") => ({
  epoch,
  sequence,
  state,
  bands: Array(SPECTRUM_BAND_COUNT).fill(0.4),
});

describe("spectrumStore", () => {
  afterEach(() => {
    resetSpectrumStore();
    listenMock.mockReset();
    stageActiveMock.mockReset().mockResolvedValue(undefined);
  });

  it("keeps the latest frame in a ref and filters stale cursors", () => {
    expect(acceptSpectrumFrame(frame(1, 1))).toBe(true);
    const first = getLatestSpectrumFrame();
    expect(acceptSpectrumFrame(frame(1, 1))).toBe(false);
    expect(acceptSpectrumFrame(frame(1, 0))).toBe(false);
    expect(acceptSpectrumFrame(frame(0, 99))).toBe(false);
    expect(acceptSpectrumFrame(frame(1, 2))).toBe(true);
    expect(getLatestSpectrumFrame()).not.toBe(first);
    expect(getSpectrumCursor()).toEqual({ epoch: 1, sequence: 2 });
  });

  it("resets sequence when a newer epoch arrives", () => {
    expect(acceptSpectrumFrame(frame(5, 999))).toBe(true);
    expect(acceptSpectrumFrame(frame(6, 0))).toBe(true);
    expect(getSpectrumCursor()).toEqual({ epoch: 6, sequence: 0 });
  });

  it("drops malformed frames without notifying subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSpectrum(listener);
    expect(acceptSpectrumFrame({ ...frame(1, 1), bands: [0] })).toBe(false);
    expect(acceptSpectrumFrame(frame(1, 1))).toBe(true);
    expect(acceptSpectrumFrame(frame(1, 2))).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("only emits when low-frequency frame status changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSpectrum(listener);
    acceptSpectrumFrame(frame(1, 1, "active"));
    acceptSpectrumFrame(frame(1, 2, "active"));
    acceptSpectrumFrame(frame(1, 3, "idle"));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getSpectrumSnapshot().status).toBe("idle");
    unsubscribe();
  });

  it("clears transient frame data on reset", () => {
    acceptSpectrumFrame(frame(1, 1));
    resetSpectrumStore();
    expect(getLatestSpectrumFrame()).toBeNull();
    expect(getSpectrumCursor()).toEqual({ epoch: null, sequence: null });
    expect(getSpectrumSnapshot()).toEqual({ status: "idle", stageActive: false, subscribed: false });
  });

  it("retains the cursor watermark when clearing a transient frame", () => {
    acceptSpectrumFrame(frame(4, 8));
    // Clearing must not allow a late frame from the same epoch to be replayed.
    clearLatestSpectrumFrame();
    expect(getLatestSpectrumFrame()).toBeNull();
    expect(acceptSpectrumFrame(frame(4, 8))).toBe(false);
    expect(acceptSpectrumFrame(frame(3, 99))).toBe(false);
    expect(acceptSpectrumFrame(frame(5, 0))).toBe(true);
  });

  it("starts and stops the listener/command lifecycle idempotently", async () => {
    const cleanup = vi.fn();
    let receive: ((value: unknown) => void) | undefined;
    listenMock.mockImplementation(async (handler: (value: unknown) => void) => {
      receive = handler;
      return cleanup;
    });
    await setSpectrumStageActive(true);
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(stageActiveMock).toHaveBeenCalledWith(true);
    expect(getSpectrumSnapshot()).toEqual({ status: "starting", stageActive: true, subscribed: true });
    receive!(frame(1, 1));
    expect(getLatestSpectrumFrame()).not.toBeNull();

    await setSpectrumStageActive(false);
    await setSpectrumStageActive(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(stageActiveMock).toHaveBeenNthCalledWith(2, false);
    expect(getSpectrumSnapshot()).toEqual({ status: "idle", stageActive: false, subscribed: false });
    receive!(frame(1, 2));
    expect(getLatestSpectrumFrame()).toBeNull();
  });
});
