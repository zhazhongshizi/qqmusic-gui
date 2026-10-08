import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RhineSettingsPanel } from "./RhineSettingsPanel";
import { defaultRhineSettings } from "./rhineSettings";
import { playerActions, resetPlayerFixture, usePlayerSnapshot } from "../player/playerStore";
import type { PlaybackQuality } from "../../contracts/settings";

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock("../../backend/settingsAdapter", () => ({ nativeSettingsSnapshot: mocks.read, nativeSetPreferredQuality: mocks.save }));
vi.mock("../player/SmartShuffleToggle", () => ({ SmartShuffleToggle: () => null }));

const props = {
  settings: defaultRhineSettings(), backLabel: "返回档案", onQualityChange: vi.fn(),
  onRendererChange: vi.fn(), onFrameLimitChange: vi.fn(), onSpatialUpscalingChange: vi.fn(),
  onSuperPerformanceChange: vi.fn(), onCassetteMotionChange: vi.fn(), onReset: vi.fn(),
  onClose: vi.fn(), onAccount: vi.fn(), onExit: vi.fn(),
};

function openPlayback() {
  const view = render(<RhineSettingsPanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /播放设置/ }));
  return { view, select: screen.getByRole("combobox", { name: "默认音质" }) };
}

beforeEach(() => {
  resetPlayerFixture();
  mocks.read.mockReset();
  mocks.save.mockReset().mockImplementation(async (preferredQuality: PlaybackQuality) => ({ preferredQuality }));
});
afterEach(() => { cleanup(); resetPlayerFixture(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

it("播放设置提供三档默认音质，并同步普通界面使用的播放器偏好", async () => {
  const { view, select } = openPlayback();
  expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["无损优先", "高品质 320k", "标准 128k"]);
  expect(select).toHaveValue("320k");
  await act(async () => { await playerActions.setDefaultQuality("flac"); });
  expect(select).toHaveValue("flac");
  fireEvent.change(select, { target: { value: "128k" } });
  await waitFor(() => expect(select).toHaveValue("128k"));
  view.unmount();
  expect(openPlayback().select).toHaveValue("128k");
  expect(screen.getByText(/从下次加载歌曲生效/)).toBeInTheDocument();
});

it("等待原生保存确认且不切换当前正在播放的歌曲音质", async () => {
  playerActions.applyAuthoritativeSession({
    mode: "sequence", requestedQuality: "320k", actualQuality: "320k",
    queue: { generation: 1, selectedIndex: 0, items: [{ id: "demo", title: "演示歌曲", artist: "演示歌手", album: "演示专辑", durationMs: 10000 }] },
    player: { state: "playing", generation: 1, positionMs: 1000, durationMs: 10000, volume: .5, muted: false,
      currentTrack: { id: "demo", title: "演示歌曲", artist: "演示歌手" }, failure: null },
  });
  const state = renderHook(usePlayerSnapshot);
  const before = state.result.current;
  let confirm!: (value: { preferredQuality: PlaybackQuality }) => void;
  mocks.save.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  const { select } = openPlayback();
  fireEvent.change(select, { target: { value: "flac" } });
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith("flac");
  expect(select).toBeDisabled();
  expect(select).toHaveValue("320k");
  expect(screen.getByText("正在保存默认音质…")).toBeInTheDocument();
  await act(async () => { confirm({ preferredQuality: "flac" }); });
  expect(select).toHaveValue("flac");
  expect(select).toBeEnabled();
  expect(state.result.current).toEqual({ ...before, defaultQuality: "flac" });
});

it("保存失败保留原偏好，可重试，并恢复启动时读取的已保存音质", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  await playerActions.hydrateNative(
    { generation: 0, selectedIndex: null, items: [] },
    { state: "idle", generation: 0, positionMs: 0, durationMs: null, volume: .5, muted: false, currentTrack: null, failure: null },
  );
  mocks.read.mockResolvedValue({ preferredQuality: "128k" });
  await playerActions.hydrateDefaultQuality();
  mocks.save.mockRejectedValueOnce(new Error("private storage path"));
  const { select } = openPlayback();
  expect(select).toHaveValue("128k");
  fireEvent.change(select, { target: { value: "flac" } });
  expect(await screen.findByRole("alert")).toHaveTextContent("默认音质保存失败，请重试");
  expect(select).toHaveValue("128k");
  expect(select).toBeEnabled();
  fireEvent.change(select, { target: { value: "flac" } });
  await waitFor(() => expect(select).toHaveValue("flac"));
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
