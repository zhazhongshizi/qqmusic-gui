import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  snapshot: vi.fn(),
  setLiveSpectrum: vi.fn(),
  setPreferredQuality: vi.fn(),
}));
const windowLifecycle = vi.hoisted(() => ({
  listen: vi.fn(),
  publish: undefined as ((renderable: boolean) => void) | undefined,
  unlisten: vi.fn(),
}));
const spectrumBridge = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock("../backend/settingsAdapter", () => ({
  nativeSettingsSnapshot: settings.snapshot,
  nativeSetLiveSpectrumEnabled: settings.setLiveSpectrum,
  nativeSetPreferredQuality: settings.setPreferredQuality,
}));

vi.mock("../backend/windowAdapter", async () => {
  const actual = await vi.importActual<typeof import("../backend/windowAdapter")>("../backend/windowAdapter");
  return { ...actual, listenWindowRenderable: windowLifecycle.listen };
});

vi.mock("../features/spectrum/SpectrumBridge", () => ({
  SpectrumBridge: ({ active }: { active: boolean }) => {
    spectrumBridge.render(active);
    return null;
  },
}));

import { playerActions, resetPlayerFixture } from "../features/player/playerStore";
import { App } from "./App";

const NATIVE_QUEUE = {
  generation: 4,
  selectedIndex: 0,
  items: [{
    id: "0039MnYb0qxYhV",
    title: "晴天",
    artist: "周杰伦",
    album: "叶惠美",
    durationMs: 269_000,
  }],
} as const;
const NATIVE_PLAYER = {
  state: "playing",
  generation: 7,
  positionMs: 1_200,
  durationMs: 269_000,
  volume: 0.72,
  muted: false,
  currentTrack: { id: "0039MnYb0qxYhV", title: "晴天", artist: "周杰伦" },
  failure: null,
} as const;

describe("Live Spectrum experimental setting", () => {
  beforeEach(() => {
    resetPlayerFixture();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    settings.snapshot.mockReset().mockResolvedValue({
      preferredQuality: "flac",
      liveSpectrumEnabled: false,
    });
    settings.setPreferredQuality.mockReset().mockResolvedValue({
      preferredQuality: "flac",
      liveSpectrumEnabled: false,
    });
    settings.setLiveSpectrum.mockReset().mockResolvedValue({
      preferredQuality: "flac",
      liveSpectrumEnabled: true,
    });
    windowLifecycle.publish = undefined;
    windowLifecycle.unlisten.mockReset();
    windowLifecycle.listen.mockReset().mockImplementation(async (listener) => {
      windowLifecycle.publish = listener;
      listener(true);
      return windowLifecycle.unlisten;
    });
    spectrumBridge.render.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("confirms the native setting before closing the menu", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(settings.snapshot).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "实时频谱·实验" }));

    await waitFor(() => expect(settings.setLiveSpectrum).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    expect(screen.getByRole("menuitemcheckbox", { name: "实时频谱·实验" }))
      .toHaveAttribute("aria-checked", "true");
  });

  it("keeps the menu open and exposes a save error when native persistence fails", async () => {
    settings.setLiveSpectrum.mockRejectedValueOnce(new Error("ipc unavailable"));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(settings.snapshot).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "实时频谱·实验" }));

    expect(await screen.findByText("实时频谱设置保存失败")).toHaveAttribute("role", "status");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("stops the native bridge for a hidden window and resumes after restore", async () => {
    settings.snapshot.mockResolvedValueOnce({
      preferredQuality: "flac",
      liveSpectrumEnabled: true,
    });
    await playerActions.hydrateNative(NATIVE_QUEUE, NATIVE_PLAYER);

    render(<App />);
    await waitFor(() => expect(spectrumBridge.render).toHaveBeenLastCalledWith(true));

    act(() => windowLifecycle.publish?.(false));
    await waitFor(() => expect(spectrumBridge.render).toHaveBeenLastCalledWith(false));

    act(() => windowLifecycle.publish?.(true));
    await waitFor(() => expect(spectrumBridge.render).toHaveBeenLastCalledWith(true));
  });
});
