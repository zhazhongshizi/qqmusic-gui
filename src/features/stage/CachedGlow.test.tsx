import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CachedGlow } from "./CachedGlow";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("rasterizes only for a new palette or layout size, with a bounded backing surface", () => {
  let width = 1920;
  let resize = () => {};
  const disconnect = vi.fn();
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(1080);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const draw = vi.fn();
  const context = {
    filter: "none", save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, ellipse() {}, rect() {}, clip() {},
    createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, drawImage: draw,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
  const view = render(<CachedGlow kind="field" paletteKey="warm" />);
  expect(view.container.firstChild).toHaveAttribute("data-cached", "true");
  const canvas = view.container.querySelector("canvas")!;
  expect(Math.max(canvas.width, canvas.height)).toBe(320);
  expect(draw).toHaveBeenCalledTimes(1);
  view.rerender(<CachedGlow kind="field" paletteKey="warm" />);
  resize();
  expect(draw).toHaveBeenCalledTimes(1);
  width = 1280;
  resize();
  expect(draw).toHaveBeenCalledTimes(2);
  view.rerender(<CachedGlow kind="field" paletteKey="cool" />);
  expect(draw).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(disconnect).toHaveBeenCalled();
});
