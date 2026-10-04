import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArchiveScene2D } from "./vendor/scene-2d";
import { setArchiveCount } from "./vendor/data";
import { fullMotion, reducedMotion } from "./vendor/motion-preferences";

let host: HTMLDivElement;
let scene: ArchiveScene2D;
let contexts: string[];
let time: number;
const gradient = { addColorStop: vi.fn() };
const noop = () => {};
const context = new Proxy({ createLinearGradient: () => gradient, createRadialGradient: () => gradient }, {
  get(target, key) { return key in target ? target[key as keyof typeof target] : noop; },
}) as unknown as CanvasRenderingContext2D;
function advance(seconds: number, hz = 60) {
  let continuing = true;
  for (let i = 0; i < Math.ceil(seconds * hz); i++) {
    time += 1 / hz;
    continuing = scene.update(time);
  }
  return continuing;
}
const state = () => JSON.parse(host.dataset.archive2d!) as { renderedFrames: number; visibleCards: number; sleeping: boolean; waveTime: number; prints: number };

beforeEach(() => {
  contexts = []; time = 1; setArchiveCount(8);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) => { contexts.push(kind); return context; }) as unknown as typeof HTMLCanvasElement.prototype.getContext);
  host = document.createElement("div"); document.body.append(host);
  Object.defineProperties(host, { clientWidth: { value: 1280, configurable: true }, clientHeight: { value: 720, configurable: true } });
  scene = new ArchiveScene2D(host, 8, ["A", "B", "C", "D", "E", "F", "G", "H"]);
  scene.revealImmediately();
});
afterEach(() => { scene.dispose(); host.remove(); vi.restoreAllMocks(); });

it("启动期间创建的 2D 场景，恢复更新后自动显示且可以抽取", () => {
  // ArchiveCanvas omits revealImmediately when created under the boot overlay.
  scene.dispose();
  scene = new ArchiveScene2D(host, 8, ["A", "B"]);
  scene.setMotion(fullMotion());
  scene.resumeUpdates(); time = performance.now() / 1000;
  advance(2);
  const canvas = host.querySelector("canvas")!;
  expect(Number(canvas.style.opacity)).toBeGreaterThan(.99);
  const open = vi.fn(); scene.onOpen = open;
  canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(open).toHaveBeenCalledWith(0);
});

it("只创建 2D 上下文，可见阵列和转换坐标均保持有限值", () => {
  scene.setMotion(reducedMotion()); advance(2);
  expect(new Set(contexts)).toEqual(new Set(["2d"]));
  expect(state().visibleCards).toBeGreaterThan(50);
  // Check every submitted affine matrix, rather than mirroring the projection formula.
  const transform = vi.fn();
  const original = context.transform;
  Object.assign(context, { transform });
  scene.resize(); scene.update(time + .1);
  for (const call of transform.mock.calls) expect(call.every(Number.isFinite)).toBe(true);
  Object.assign(context, { transform: original });
});
it("2D 不再另设 60 帧上限，遵从共享循环；暂停休眠，封面到达可唤醒", () => {
  scene.setDeck(true, true); advance(3);
  const before = state().renderedFrames;
  for (const hz of [60, 61, 75, 144, 165]) {
    const start = state().renderedFrames;
    advance(.25, hz);
    expect(state().renderedFrames - start).toBe(Math.ceil(.25 * hz));
  }
  scene.setDeck(true, false); expect(advance(5)).toBe(false);
  expect(state().sleeping).toBe(true);
  const wake = vi.fn(); scene.onInvalidate = wake;
  scene.setTrack("new", "artist", null);
  expect(wake).toHaveBeenCalledOnce();
  scene.update(time + .1); expect(state().renderedFrames).toBeGreaterThan(before);
});
it("浏览歌单的闲置波持续，而歌曲阵列稳定后停止绘制", () => {
  scene.setMotion(fullMotion()); expect(advance(5)).toBe(true);
  scene.setArchiveTracks([{ id: "a", title: "A", artist: "artist" }]);
  expect(advance(5)).toBe(false);
  expect(state().sleeping).toBe(true);
});
it("禁用起伏仍完成入场和切歌；抽取、归位后可以休眠", () => {
  scene.setDisableCassetteMotionWhilePlaying(true); scene.setDeck(true, true);
  scene.setPlaybackTrack("a", 0, 3); expect(advance(5)).toBe(false);
  const before = scene.selectedCell.row;
  scene.setPlaybackTrack("b", 1, 3); expect(scene.selectedCell.row).toBe(before + 1);
  expect(advance(4)).toBe(false);
  scene.setMode("detail"); expect(advance(5)).toBe(false); expect(host.dataset.inspection).toBe("ready");
  scene.setMode("archive"); expect(advance(5)).toBe(false);
  scene.setDeck(false, false); scene.setMotion(reducedMotion()); expect(advance(5)).toBe(false);
  expect(scene.selectedCell.row).toBe(12);
});
it("键盘导航只选择，Enter 明确抽取，释放资源后事件不再触发", () => {
  scene.setMotion(reducedMotion()); advance(2);
  const navigate = vi.fn(), open = vi.fn(); scene.onNavigate = navigate; scene.onOpen = open;
  const canvas = host.querySelector("canvas")!;
  canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  expect(navigate).toHaveBeenCalledWith("row", 1); expect(open).not.toHaveBeenCalled();
  canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); expect(open).toHaveBeenCalledWith(0);
  scene.dispose(); canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  expect(navigate).toHaveBeenCalledTimes(1); expect(host.querySelector("canvas")).toBeNull();
});
