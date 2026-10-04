import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acceptSpectrumFrame, resetSpectrumStore } from "./spectrumStore";
import { StageSpectrum } from "./StageSpectrum";

const frame = (sequence: number, value: number) => ({
  epoch: 1,
  sequence,
  state: "active" as const,
  bands: new Array(24).fill(value),
});
function installCanvas() {
  const context = {
    clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), setTransform: vi.fn(),
    lineCap: "butt", lineWidth: 1, globalAlpha: 1, strokeStyle: "",
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
  return context;
}

describe("StageSpectrum", () => {
  let context: CanvasRenderingContext2D;

  beforeEach(() => {
    resetSpectrumStore();
    context = installCanvas();
    vi.stubGlobal("ResizeObserver", class {
      observe() { /* jsdom helper */ }
      disconnect() { /* jsdom helper */ }
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    resetSpectrumStore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders one decorative canvas plus a low-frequency status text", () => {
    render(<StageSpectrum status="active" data-testid="stage-spectrum" />);
    const root = screen.getByTestId("stage-spectrum");
    expect(root.querySelectorAll("canvas")).toHaveLength(1);
    expect(root.querySelector("canvas")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status")).toHaveTextContent("频谱运行中");
    expect(root).toHaveAttribute("data-spectrum-state", "active");
  });

  it("uses the narrow horizontal layout when requested", () => {
    render(<StageSpectrum status="active" orientation="horizontal" data-testid="stage-spectrum" />);
    expect(screen.getByTestId("stage-spectrum")).toHaveAttribute("data-spectrum-layout", "horizontal");
  });

  it("draws unavailable as a static state and does not schedule RAF", () => {
    const raf = vi.mocked(window.requestAnimationFrame);
    render(<StageSpectrum status="unavailable" />);
    expect(screen.getByRole("status")).toHaveTextContent("频谱不可用");
    expect(raf).not.toHaveBeenCalled();
  });

  it("reads high-frequency frames without causing a React render per frame", () => {
    const raf = vi.mocked(window.requestAnimationFrame);
    const view = render(<StageSpectrum status="active" />);
    const callsAfterMount = raf.mock.calls.length;
    for (let sequence = 1; sequence <= 100; sequence += 1) acceptSpectrumFrame(frame(sequence, 0.7));
    expect(raf.mock.calls.length).toBe(callsAfterMount);
    view.unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
  });

  it("caches computed colors across animation frames and refreshes them on a palette change", () => {
    const computed = vi.spyOn(window, "getComputedStyle");
    const raf = vi.mocked(window.requestAnimationFrame);
    const view = render(<StageSpectrum status="active" paletteKey="green" />);
    const initialReads = computed.mock.calls.length;
    expect(initialReads).toBeGreaterThan(0);
    for (let index = 1; index <= 10; index += 1) {
      act(() => raf.mock.calls.at(-1)![0](index * 16));
    }
    expect(computed.mock.calls.length).toBe(initialReads);
    view.rerender(<StageSpectrum status="active" paletteKey="blue" />);
    expect(computed.mock.calls.length).toBe(initialReads + 1);
  });

  it("does not keep an animation loop in reduced motion mode", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(),
    }));
    const raf = vi.mocked(window.requestAnimationFrame);
    render(<StageSpectrum status="active" />);
    expect(raf).not.toHaveBeenCalled();
  });

  it("immediately clears and stops RAF while the window is not renderable", () => {
    const raf = vi.mocked(window.requestAnimationFrame);
    const view = render(<StageSpectrum status="active" renderable data-testid="stage-spectrum" />);
    expect(raf).toHaveBeenCalled();
    const clearCallsBeforeStop = vi.mocked(context.clearRect).mock.calls.length;

    act(() => view.rerender(
      <StageSpectrum status="active" renderable={false} data-testid="stage-spectrum" />,
    ));
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    expect(vi.mocked(context.clearRect).mock.calls.length).toBeGreaterThan(clearCallsBeforeStop);
    expect(screen.getByTestId("stage-spectrum")).toHaveAttribute(
      "data-spectrum-renderable",
      "false",
    );
    const rafCallsWhileStopped = raf.mock.calls.length;

    act(() => view.rerender(
      <StageSpectrum status="active" renderable data-testid="stage-spectrum" />,
    ));
    expect(raf.mock.calls.length).toBeGreaterThan(rafCallsWhileStopped);
  });
});
