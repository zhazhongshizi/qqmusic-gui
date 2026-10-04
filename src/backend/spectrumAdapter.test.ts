import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  listenSpectrumFrames,
  spectrumSetStageActive,
  SpectrumAdapterError,
  SPECTRUM_COMMANDS,
  SPECTRUM_EVENT,
} from "./spectrumAdapter";

const validPayload = () => ({
  epoch: 1,
  sequence: 2,
  state: "active",
  bands: Array(24).fill(0.25),
});
describe("spectrumAdapter", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.doUnmock("@tauri-apps/api/core");
    vi.doUnmock("@tauri-apps/api/event");
  });

  it("fails safely when invoke is requested outside Tauri", async () => {
    await expect(spectrumSetStageActive(true)).rejects.toEqual(
      new SpectrumAdapterError("QMG-SPECTRUM-001"),
    );
  });

  it("dynamically invokes the stage command", async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));

    await spectrumSetStageActive(true);
    expect(invoke).toHaveBeenCalledWith(SPECTRUM_COMMANDS.setStageActive, { active: true });
  });

  it("parses valid events, drops malformed events, and cleans up idempotently", async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    let callback: ((event: { payload: unknown }) => void) | undefined;
    const nativeUnlisten = vi.fn();
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: vi.fn(async (event: string, listener: (event: { payload: unknown }) => void) => {
        expect(event).toBe(SPECTRUM_EVENT);
        callback = listener;
        return nativeUnlisten;
      }),
    }));

    const frames: unknown[] = [];
    const unlisten = await listenSpectrumFrames((frame) => frames.push(frame));
    callback!({ payload: validPayload() });
    callback!({ payload: { ...validPayload(), bands: [0] } });
    callback!({ payload: { ...validPayload(), extra: true } });

    expect(frames).toHaveLength(1);
    expect((frames[0] as { bands: number[] }).bands).toHaveLength(24);
    unlisten();
    unlisten();
    expect(nativeUnlisten).toHaveBeenCalledTimes(1);
  });

  it("returns a safe no-op cleanup outside Tauri", async () => {
    const unlisten = await listenSpectrumFrames(vi.fn());
    unlisten();
    unlisten();
  });
});
