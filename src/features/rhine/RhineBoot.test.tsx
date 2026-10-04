import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RhineBoot } from "./RhineBoot";

vi.mock("../../components/WindowControls", () => ({ WindowControls: () => null }));
let frames: Map<number, FrameRequestCallback>;
let next: number;
let reduced: boolean;
let motionChange: () => void;
beforeEach(() => {
  frames = new Map(); next = 0; reduced = false;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; }, addEventListener: (_: string, cb: () => void) => { motionChange = cb; }, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const frame = (time: number) => act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)); });

it("按原始时间轴完成所有阶段并只结束一次", () => {
  const done = vi.fn();
  const view = render(<StrictMode><RhineBoot active onComplete={done} /></StrictMode>);
  const stage = view.container.querySelector(".rhine-boot-stage")!;
  frame(0); frame(3000); expect(stage.getAttribute("data-boot")).toBe("logo");
  frame(6000); expect(stage.getAttribute("data-boot")).toBe("auth");
  frame(14000); expect(stage.getAttribute("data-boot")).toBe("scan");
  frame(18000); expect(stage.getAttribute("data-boot")).toBe("welcome");
  frame(20200); expect(done).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /跳过动画/ }));
  expect(done).toHaveBeenCalledTimes(1);
  expect(frames.size).toBe(0);
});
it("暂停不累计隐藏时间，卸载清除动画帧", () => {
  const done = vi.fn(); const view = render(<RhineBoot active onComplete={done} />);
  frame(0); frame(3000);
  view.rerender(<RhineBoot active={false} onComplete={done} />);
  expect(frames.size).toBe(0);
  view.rerender(<RhineBoot active onComplete={done} />);
  frame(60000); expect(done).not.toHaveBeenCalled();
  expect(view.container.querySelector(".rhine-boot-stage")).toHaveAttribute("data-boot", "logo");
  view.unmount(); expect(frames.size).toBe(0);
});
it("减少动画与中途启用减少动画均立即进入界面", () => {
  reduced = true; const done = vi.fn();
  const view = render(<RhineBoot active onComplete={done} />);
  expect(done).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0);
  view.unmount(); reduced = false;
  render(<RhineBoot active onComplete={done} />);
  reduced = true; act(() => motionChange());
  expect(done).toHaveBeenCalledTimes(2); expect(frames.size).toBe(0);
});
it("Escape 跳过后停止更新", () => {
  const done = vi.fn(); render(<RhineBoot active onComplete={done} />);
  fireEvent.keyDown(screen.getByRole("button", { name: /跳过动画/ }), { key: "Escape" });
  frame(100); expect(done).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0);
});
