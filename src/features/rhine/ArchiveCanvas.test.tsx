import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ArchiveCanvas } from "./ArchiveCanvas";
const mock = vi.hoisted(() => ({ load: vi.fn(), dispose: vi.fn(), update: vi.fn(), select: vi.fn(), setMode: vi.fn(), setDeck: vi.fn(), setTrack: vi.fn(), setPlaybackTrack: vi.fn(), setQuality: vi.fn(), setSuperPerformance: vi.fn(), setDisableCassetteMotionWhilePlaying: vi.fn(), setReduceCassetteMotionWhilePlaying: vi.fn(), resumeUpdates: vi.fn(), cover: vi.fn(), created: vi.fn() }));
const archiveMock = vi.hoisted(() => ({ tracks: vi.fn(), cover: vi.fn() }));
vi.mock("../../backend/coverAdapter", () => ({ getCoverImage: mock.cover }));
vi.mock("./vendor/scene", () => ({ ArchiveScene: class {
  load = mock.load; dispose = mock.dispose; update = mock.update;
  setArchiveTracks = archiveMock.tracks; setArchiveCover = archiveMock.cover;
  constructor() { mock.created(this); }
  select = mock.select;
  resumeUpdates = mock.resumeUpdates;
  setReduceCassetteMotionWhilePlaying = mock.setReduceCassetteMotionWhilePlaying; setMotion() {} setQuality = mock.setQuality; setSuperPerformance = mock.setSuperPerformance; setSpatialUpscaling = vi.fn(); setDisableCassetteMotionWhilePlaying = mock.setDisableCassetteMotionWhilePlaying; setMode = mock.setMode; setDeck = mock.setDeck; setTrack = mock.setTrack; setPlaybackTrack = mock.setPlaybackTrack; revealImmediately() {} resize() {}
} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); mock.update.mockReset(); mock.setTrack.mockReset(); mock.cover.mockReset(); vi.unstubAllGlobals(); });
it("播放视图沿用档案阵列并更新磁带标签，暂停只停止播放波纹", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mock.load.mockResolvedValueOnce(undefined);
  const props = { count: 2, selected: 0, detail: true, deck: true, playing: true, active: true, track: { id: "song-1", title: "远方的灯", artist: "测试歌手" }, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} />);
  await waitFor(() => expect(mock.setTrack).toHaveBeenCalledWith("远方的灯", "测试歌手", null));
  expect(mock.setMode).toHaveBeenLastCalledWith("archive");
  expect(mock.setDeck).toHaveBeenLastCalledWith(true, true);
  view.rerender(<ArchiveCanvas {...props} playing={false} />);
  expect(mock.setDeck).toHaveBeenLastCalledWith(true, false);
});
it("按歌曲 ID 切换磁带，同名歌曲也切换，暂停和封面更新不重复导航", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mock.load.mockResolvedValueOnce(undefined);
  const track = { id: "song-a", title: "同名歌曲", artist: "歌手" };
  const props = { count: 2, selected: 0, detail: false, deck: true, playing: true, active: true, track, trackIndex: 0, queueLength: 3, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} />);
  await waitFor(() => expect(mock.setPlaybackTrack).toHaveBeenCalledWith("song-a", 0, 3));
  mock.setPlaybackTrack.mockClear();
  view.rerender(<ArchiveCanvas {...props} playing={false} track={{ ...track, artist: "更新后的歌手" }} />);
  expect(mock.setPlaybackTrack).not.toHaveBeenCalled();
  view.rerender(<ArchiveCanvas {...props} track={{ ...track, id: "song-b" }} trackIndex={1} />);
  expect(mock.setPlaybackTrack).toHaveBeenCalledExactlyOnceWith("song-b", 1, 3);
  expect(mock.setPlaybackTrack.mock.invocationCallOrder[0]).toBeLessThan(mock.setTrack.mock.invocationCallOrder.at(-1)!);
  view.rerender(<ArchiveCanvas {...props} deck={false} />);
  expect(mock.setPlaybackTrack).toHaveBeenCalledTimes(1);
});
it("场景选择保留物理格子并同步执行，React 回传不再次打断拖动", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mock.load.mockResolvedValueOnce(undefined);
  const onSelect = vi.fn();
  const props = { count: 6, selected: 0, detail: false, active: true, onSelect };
  const view = render(<ArchiveCanvas {...props} />);
  await waitFor(() => expect(mock.select).toHaveBeenCalledWith(0));
  const instance = mock.created.mock.calls[0]![0] as { onSelect: (index: number, cell: { lane: number; row: number }) => void };
  act(() => instance.onSelect(4, { lane: 2, row: 16 }));
  expect(mock.select).toHaveBeenLastCalledWith(4, { cell: { lane: 2, row: 16 } });
  const calls = mock.select.mock.calls.length;
  view.rerender(<ArchiveCanvas {...props} selected={4} />);
  expect(mock.select).toHaveBeenCalledTimes(calls);
  act(() => instance.onSelect(4, { lane: 2, row: 22 }));
  expect(mock.select).toHaveBeenLastCalledWith(4, { cell: { lane: 2, row: 22 } });
  view.rerender(<ArchiveCanvas {...props} selected={1} />);
  expect(mock.select).toHaveBeenLastCalledWith(1);
});
it("加载失败后恢复可见性不会重新运行已释放的场景", async () => {
  mock.load.mockRejectedValueOnce(new Error("load failed"));
  const raf = vi.fn(() => 1); vi.stubGlobal("requestAnimationFrame", raf);
  const props = { count: 2, selected: 0, detail: false, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} active />);
  await waitFor(() => expect(mock.dispose).toHaveBeenCalledTimes(1));
  view.rerender(<ArchiveCanvas {...props} active={false} />);
  view.rerender(<ArchiveCanvas {...props} active />);
  expect(raf).not.toHaveBeenCalled();
  view.unmount();
  expect(mock.dispose).toHaveBeenCalledTimes(1);
});
it("连续滚轮导航沿相邻物理格子同步选择，React 回传不重置轨道", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mock.load.mockResolvedValueOnce(undefined);
  const onSelect = vi.fn();
  const props = { count: 3, selected: 2, detail: false, active: true, onSelect };
  const view = render(<ArchiveCanvas {...props} />);
  await waitFor(() => expect(mock.select).toHaveBeenCalledWith(2));
  const instance = mock.created.mock.calls[0]![0] as { onNavigate: (axis: string, direction: number) => void };
  act(() => { instance.onNavigate("row", 1); instance.onNavigate("row", 1); });
  expect(onSelect.mock.calls).toEqual([[0], [1]]);
  expect(mock.select).toHaveBeenLastCalledWith(1, { axis: "row", direction: 1 });
  const calls = mock.select.mock.calls.length;
  view.rerender(<ArchiveCanvas {...props} selected={1} />);
  expect(mock.select).toHaveBeenCalledTimes(calls);
});
it("加载中卸载后释放迟到场景，不启动渲染", async () => {
  let finish!: () => void;
  mock.load.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const raf = vi.fn(() => 1); vi.stubGlobal("requestAnimationFrame", raf);
  const view = render(<ArchiveCanvas count={2} selected={0} detail={false} active onSelect={() => {}} />);
  view.unmount();
  await act(async () => finish());
  expect(mock.dispose).toHaveBeenCalledTimes(1);
  expect(raf).not.toHaveBeenCalled();
});
it("画质与超级性能设置即时更新当前场景，不重建阵列", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mock.load.mockResolvedValueOnce(undefined);
  const props = { count: 2, selected: 0, detail: false, active: true, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} />);
  await waitFor(() => expect(mock.setSuperPerformance).toHaveBeenCalledWith(false));
  const quality = { scale: 125, pixelRatio: 2, antialias: "smaa" as const, shadows: 4096, aoSamples: 32, aoResolution: 1, depthOfField: 100, transmission: 1, anisotropy: 16 };
  view.rerender(<ArchiveCanvas {...props} quality={quality} superPerformance />);
  expect(mock.setQuality).toHaveBeenLastCalledWith(quality);
  expect(mock.setSuperPerformance).toHaveBeenLastCalledWith(true);
  view.rerender(<ArchiveCanvas {...props} superPerformance disableCassetteMotionWhilePlaying />);
  expect(mock.setDisableCassetteMotionWhilePlaying).toHaveBeenLastCalledWith(true);
  expect(mock.created).toHaveBeenCalledTimes(1);
});
it("场景加载期间改动的性能设置在加载后以最新值应用", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let finish!: () => void;
  mock.load.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const props = { count: 2, selected: 0, detail: false, active: true, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} />);
  const quality = { scale: 175, pixelRatio: 3, antialias: "off" as const, shadows: 0, aoSamples: 0, aoResolution: 0.5, depthOfField: 0, transmission: 0.25, anisotropy: 2 };
  view.rerender(<ArchiveCanvas {...props} quality={quality} superPerformance />);
  await act(async () => finish());
  await waitFor(() => expect(mock.setSuperPerformance).toHaveBeenLastCalledWith(true));
  expect(mock.setQuality).toHaveBeenLastCalledWith(quality);
  expect(mock.created).toHaveBeenCalledTimes(1);
});
it("超分在异步加载后应用最新开关，后续切换复用同一个场景", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let finish!: () => void;
  mock.load.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const props = { count: 2, selected: 0, detail: false, active: true, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} />);
  view.rerender(<ArchiveCanvas {...props} spatialUpscaling />);
  const scene = mock.created.mock.calls[0]![0] as { setSpatialUpscaling: ReturnType<typeof vi.fn> };
  await act(async () => finish());
  expect(scene.setSpatialUpscaling).toHaveBeenLastCalledWith(true);
  view.rerender(<ArchiveCanvas {...props} spatialUpscaling={false} />);
  expect(scene.setSpatialUpscaling).toHaveBeenLastCalledWith(false);
  expect(mock.created).toHaveBeenCalledTimes(1);
});
it("播放起伏开关在场景加载期间变化后以最新值应用", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let finish!: () => void;
  mock.load.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const props = { count: 2, selected: 0, detail: false, active: true, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} />);
  view.rerender(<ArchiveCanvas {...props} disableCassetteMotionWhilePlaying />);
  await act(async () => finish());
  await waitFor(() => expect(mock.setDisableCassetteMotionWhilePlaying).toHaveBeenLastCalledWith(true));
  view.rerender(<ArchiveCanvas {...props} disableCassetteMotionWhilePlaying={false} />);
  expect(mock.setDisableCassetteMotionWhilePlaying).toHaveBeenLastCalledWith(false);
  view.rerender(<ArchiveCanvas {...props} reduceCassetteMotionWhilePlaying />);
  expect(mock.setReduceCassetteMotionWhilePlaying).toHaveBeenLastCalledWith(true);
  view.rerender(<ArchiveCanvas {...props} reduceCassetteMotionWhilePlaying={false} />);
  expect(mock.setReduceCassetteMotionWhilePlaying).toHaveBeenLastCalledWith(false);
  expect(mock.created).toHaveBeenCalledTimes(1);
});
it("隐藏停止帧循环，退出释放场景和尺寸监听", async () => {
  mock.load.mockResolvedValueOnce(undefined);
  const raf = vi.fn(() => 9), cancel = vi.fn(), disconnect = vi.fn();
  vi.stubGlobal("requestAnimationFrame", raf); vi.stubGlobal("cancelAnimationFrame", cancel);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect = disconnect; });
  const props = { count: 2, selected: 0, detail: false, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} active />);
  await waitFor(() => expect(raf).toHaveBeenCalled());
  const count = raf.mock.calls.length;
  view.rerender(<ArchiveCanvas {...props} active={false} />);
  expect(cancel).toHaveBeenCalledWith(9);
  expect(raf).toHaveBeenCalledTimes(count);
  view.unmount();
  expect(mock.dispose).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(1);
});

function scheduler() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  return { frames, flush(time: number) { const pending = [...frames.values()]; frames.clear(); act(() => pending.forEach(callback => callback(time))); } };
}

it.each([30, 60, 0] as const)("帧数限制 %s 在不同刷新率下按预算更新", async frameLimit => {
  for (const hz of [60, 61, 75, 144, 165]) {
    const clock = scheduler(); mock.load.mockResolvedValueOnce(undefined); mock.update.mockReturnValue(true);
    const view = render(<ArchiveCanvas count={2} selected={0} detail={false} active frameLimit={frameLimit} onSelect={() => {}} />);
    await waitFor(() => expect(clock.frames.size).toBe(1));
    mock.update.mockClear();
    for (let i = 0; i <= 2 * hz; i++) clock.flush(i * 1000 / hz);
    const expected = Math.min(hz, frameLimit || hz) * 2 + 1;
    expect(mock.update.mock.calls.length).toBeGreaterThanOrEqual(expected - 1);
    expect(mock.update.mock.calls.length).toBeLessThanOrEqual(expected + 1);
    expect(mock.update.mock.calls.at(-1)![0]).toBeGreaterThan(1.9);
    expect(clock.frames.size).toBe(1);
    view.unmount(); expect(clock.frames.size).toBe(0);
  }
});

it("限帧可以即时切换，休眠后仍由交互立即唤醒，隐藏时停止", async () => {
  const clock = scheduler(); mock.load.mockResolvedValueOnce(undefined); mock.update.mockReturnValue(true);
  const props = { count: 2, selected: 0, detail: false, active: true, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} frameLimit={30} />);
  await waitFor(() => expect(clock.frames.size).toBe(1));
  mock.update.mockClear(); clock.flush(100); clock.flush(116);
  expect(mock.update).toHaveBeenCalledOnce();
  view.rerender(<ArchiveCanvas {...props} frameLimit={0} />); clock.flush(117);
  expect(mock.update).toHaveBeenCalledTimes(2); expect(mock.created).toHaveBeenCalledOnce();
  mock.update.mockReturnValue(false); clock.flush(118); expect(clock.frames.size).toBe(0);
  view.rerender(<ArchiveCanvas {...props} frameLimit={60} />); clock.flush(119);
  expect(mock.update).toHaveBeenCalledTimes(4); expect(clock.frames.size).toBe(0);
  const instance = mock.created.mock.calls[0]![0] as { onInvalidate: () => void };
  act(() => instance.onInvalidate()); clock.flush(120);
  expect(mock.update).toHaveBeenCalledTimes(5);
  view.rerender(<ArchiveCanvas {...props} active={false} frameLimit={60} />);
  act(() => instance.onInvalidate()); expect(clock.frames.size).toBe(0);
});

it("settled scenes stop scheduling, invalidate once and never duplicate the loop", async () => {
  const clock = scheduler(); mock.load.mockResolvedValueOnce(undefined); mock.update.mockReturnValue(false);
  const props = { count: 2, selected: 0, detail: false, active: true, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} />);
  await waitFor(() => expect(clock.frames.size).toBe(1));
  clock.flush(100); expect(mock.update).toHaveBeenCalledOnce(); expect(clock.frames.size).toBe(0);
  const instance = mock.created.mock.calls[0]![0] as { onInvalidate: () => void };
  act(() => { instance.onInvalidate(); instance.onInvalidate(); });
  expect(clock.frames.size).toBe(1);
  expect(mock.resumeUpdates).toHaveBeenCalledTimes(2);
  clock.flush(200); expect(clock.frames.size).toBe(0);
  view.rerender(<ArchiveCanvas {...props} active={false} />);
  act(() => instance.onInvalidate()); expect(clock.frames.size).toBe(0);
  view.rerender(<ArchiveCanvas {...props} active />); expect(clock.frames.size).toBe(1);
  clock.flush(300); expect(clock.frames.size).toBe(0);
  view.unmount(); act(() => instance.onInvalidate()); expect(clock.frames.size).toBe(0);
});

it("an invalidation during update stays in the current loop and inactive opening never starts it", async () => {
  const clock = scheduler(); mock.load.mockResolvedValueOnce(undefined);
  const props = { count: 2, selected: 0, detail: false, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} booting active={false} />);
  await waitFor(() => expect(mock.created).toHaveBeenCalledOnce());
  await waitFor(() => expect(mock.setSuperPerformance).toHaveBeenCalled());
  expect(clock.frames.size).toBe(0);
  const instance = mock.created.mock.calls[0]![0] as { onInvalidate: () => void };
  mock.update.mockImplementation(() => { instance.onInvalidate(); return true; });
  view.rerender(<ArchiveCanvas {...props} booting={false} active />);
  clock.flush(100); expect(clock.frames.size).toBe(1);
  clock.flush(116); expect(clock.frames.size).toBe(1);
});

it("document visibility cancels the pending frame and restores exactly one frame", async () => {
  const clock = scheduler(); mock.load.mockResolvedValueOnce(undefined);
  const view = render(<ArchiveCanvas count={2} selected={0} detail={false} active onSelect={() => {}} />);
  await waitFor(() => expect(clock.frames.size).toBe(1));
  const hidden = vi.spyOn(document, "hidden", "get");
  hidden.mockReturnValue(true); act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(clock.frames.size).toBe(0);
  hidden.mockReturnValue(false); act(() => { document.dispatchEvent(new Event("visibilitychange")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(clock.frames.size).toBe(1);
  view.unmount(); expect(clock.frames.size).toBe(0);
});

it("unchanged history polling retains its archive scene and cover atlas", async () => {
  scheduler(); mock.load.mockResolvedValueOnce(undefined); mock.cover.mockResolvedValue({ mimeType: "image/png", bytes: [1] });
  vi.stubGlobal("URL", class extends URL { static createObjectURL() { return "blob:cover"; } static revokeObjectURL() {} });
  vi.stubGlobal("Image", class { src = ""; decode() { return Promise.resolve(); } });
  const tracks = [{ id: "song", title: "Song", artist: "A", coverCacheKey: "cover" }];
  const props = { count: 1, selected: 0, detail: false, active: true, onSelect: () => {}, archiveTracks: tracks };
  const view = render(<ArchiveCanvas {...props} />);
  await waitFor(() => expect(archiveMock.cover).toHaveBeenCalledTimes(1));
  const writes = archiveMock.tracks.mock.calls.length;
  view.rerender(<ArchiveCanvas {...props} archiveTracks={tracks.map(track => ({ ...track }))} />);
  expect(mock.created).toHaveBeenCalledTimes(1);
  expect(archiveMock.tracks).toHaveBeenCalledTimes(writes);
  expect(mock.cover).toHaveBeenCalledTimes(1);
});

it("history page changes reject late artwork and preserve the existing archive selection scene", async () => {
  scheduler(); mock.load.mockResolvedValueOnce(undefined);
  let resolve!: (payload: { mimeType: string; bytes: number[] }) => void;
  mock.cover.mockReturnValueOnce(new Promise(value => { resolve = value; }));
  const revoked = vi.fn();
  vi.stubGlobal("URL", class extends URL { static createObjectURL() { return "blob:cover"; } static revokeObjectURL = revoked; });
  vi.stubGlobal("Image", class { src = ""; decode() { return Promise.resolve(); } });
  const props = { count: 1, selected: 0, detail: false, active: true, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} archiveTracks={[{ id: "old", title: "Old", artist: "A", coverCacheKey: "old-cover" }]} />);
  await waitFor(() => expect(mock.cover).toHaveBeenCalledTimes(1));
  view.rerender(<ArchiveCanvas {...props} archiveTracks={[{ id: "new", title: "New", artist: "B" }]} />);
  await act(async () => resolve({ mimeType: "image/png", bytes: [1] }));
  expect(revoked).toHaveBeenCalledTimes(1);
  expect(archiveMock.cover).not.toHaveBeenCalled();
  expect(mock.created).toHaveBeenCalledTimes(1);
  expect(archiveMock.tracks).toHaveBeenLastCalledWith([{ id: "new", title: "New", artist: "B" }]);
});

it("late covers wake a sleeping scene and an obsolete track cannot overwrite the new artwork", async () => {
  const clock = scheduler(); mock.load.mockResolvedValueOnce(undefined); mock.update.mockReturnValue(false);
  const completions = new Map<string, (payload: { mimeType: string; bytes: number[] }) => void>();
  mock.cover.mockImplementation((key: string) => new Promise(resolve => completions.set(key, resolve)));
  const createObjectURL = vi.fn(() => "blob:cover"); const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
  vi.stubGlobal("Image", class { src = ""; decode() { return Promise.resolve(); } });
  mock.setTrack.mockImplementation(() => { const instance = mock.created.mock.calls.at(-1)?.[0] as { onInvalidate?: () => void } | undefined; instance?.onInvalidate?.(); });
  const props = { count: 2, selected: 0, detail: false, deck: true, playing: true, active: true, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} track={{ id: "old", title: "Old", artist: "A", coverCacheKey: "old-cover" }} />);
  await waitFor(() => expect(completions.has("old-cover")).toBe(true)); clock.flush(100);
  expect(clock.frames.size).toBe(0);
  view.rerender(<ArchiveCanvas {...props} track={{ id: "new", title: "New", artist: "B", coverCacheKey: "new-cover" }} />);
  clock.flush(200); expect(clock.frames.size).toBe(0);
  const payload = { mimeType: "image/png", bytes: [1, 2, 3] };
  await act(async () => completions.get("new-cover")!(payload));
  expect(clock.frames.size).toBe(1); expect(mock.setTrack).toHaveBeenLastCalledWith("New", "B", expect.anything());
  clock.flush(300); const calls = mock.setTrack.mock.calls.length;
  await act(async () => completions.get("old-cover")!(payload));
  expect(mock.setTrack).toHaveBeenCalledTimes(calls); expect(clock.frames.size).toBe(0);
  expect(revokeObjectURL).toHaveBeenCalledTimes(2);
});
