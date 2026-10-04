import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ArchiveCanvas } from "./ArchiveCanvas";
const mocks = vi.hoisted(() => ({ three: vi.fn(), two: vi.fn(), load3: vi.fn(), load2: vi.fn(), dispose3: vi.fn(), dispose2: vi.fn(), mode: vi.fn(), track: vi.fn() }));
vi.mock("../../backend/coverAdapter", () => ({ getCoverImage: vi.fn() }));
vi.mock("./vendor/scene", () => ({ ArchiveScene: class {
  constructor(host: HTMLElement) { mocks.three(); host.appendChild(document.createElement("canvas")); }
  load = mocks.load3; dispose = mocks.dispose3; setMode = mocks.mode; setPlaybackTrack = mocks.track;
  update() { return false; } resumeUpdates() {} select() {} setDeck() {} setTrack() {} setQuality() {} setMotion() {} setSuperPerformance() {} setSpatialUpscaling() {} setDisableCassetteMotionWhilePlaying() {} setReduceCassetteMotionWhilePlaying() {} revealImmediately() {} resize() {}
} }));
vi.mock("./vendor/scene-2d", () => ({ ArchiveScene2D: class {
  constructor(host: HTMLElement) { mocks.two(); host.appendChild(document.createElement("canvas")); }
  load = mocks.load2; dispose = mocks.dispose2; setMode = mocks.mode; setPlaybackTrack = mocks.track;
  update() { return false; } resumeUpdates() {} select() {} setDeck() {} setTrack() {} setQuality() {} setMotion() {} setSuperPerformance() {} setDisableCassetteMotionWhilePlaying() {} setReduceCassetteMotionWhilePlaying() {} revealImmediately() {} resize() {}
} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  mocks.load2.mockResolvedValue(undefined); mocks.load3.mockResolvedValue(undefined);
}
it("2D 首次打开不创建 3D 场景，切换时释放旧画布并保留播放和详情", async () => {
  setup();
  const props = { count: 2, selected: 1, detail: true, deck: true, playing: true, active: true, track: { id: "a", title: "A", artist: "B" }, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} renderer="canvas2d" />);
  await waitFor(() => expect(mocks.track).toHaveBeenCalledWith("a", 0, 0));
  expect(mocks.three).not.toHaveBeenCalled(); expect(mocks.two).toHaveBeenCalledOnce();
  view.rerender(<ArchiveCanvas {...props} renderer="webgl" />);
  await waitFor(() => expect(mocks.three).toHaveBeenCalledOnce()); expect(mocks.dispose2).toHaveBeenCalledOnce();
  view.rerender(<ArchiveCanvas {...props} renderer="canvas2d" />);
  await waitFor(() => expect(mocks.two).toHaveBeenCalledTimes(2)); expect(mocks.dispose3).toHaveBeenCalledOnce();
  view.unmount(); expect(mocks.dispose2).toHaveBeenCalledTimes(2);
});
it("3D 加载未完成时切到 2D，迟到的旧场景只释放而不重新挂载", async () => {
  setup(); let finish!: () => void;
  mocks.load3.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const props = { count: 2, selected: 0, detail: true, active: true, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} />);
  view.rerender(<ArchiveCanvas {...props} renderer="canvas2d" />);
  await waitFor(() => expect(mocks.mode).toHaveBeenCalledWith("detail"));
  expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
  const calls = mocks.mode.mock.calls.length;
  await act(async () => finish());
  expect(mocks.dispose3).toHaveBeenCalledOnce(); expect(mocks.mode).toHaveBeenCalledTimes(calls);
  expect(view.container.querySelector(".rhine-scene")).toHaveAttribute("data-renderer", "canvas2d");
});
it("旧 3D 迟到加载失败不会清空新的 2D 场景引用", async () => {
  setup(); let reject!: (error: Error) => void;
  mocks.load3.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const props = { count: 2, selected: 0, detail: false, active: true, onSelect: () => {} };
  const view = render(<ArchiveCanvas {...props} />);
  view.rerender(<ArchiveCanvas {...props} renderer="canvas2d" />);
  await waitFor(() => expect(view.container.querySelector(".rhine-scene")).toHaveAttribute("data-ready", "true"));
  await act(async () => reject(new Error("retired GLB failed")));
  const writes = mocks.mode.mock.calls.length;
  view.rerender(<ArchiveCanvas {...props} renderer="canvas2d" detail />);
  expect(mocks.mode).toHaveBeenCalledTimes(writes + 1);
  expect(mocks.mode).toHaveBeenLastCalledWith("detail");
  expect(mocks.dispose3).toHaveBeenCalledOnce();
});
