import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalVinyl } from "./TerminalVinyl";
import {
  NEEDLE_FRAMES,
  VINYL_ANGLE_INCREMENT,
  VINYL_HEIGHT,
  VINYL_TICK_MS,
  VINYL_WIDTH,
  type NeedleState,
} from "./vinylFrames";

function mockReducedMotion(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function visibleNeedlePixels(state: NeedleState) {
  return NEEDLE_FRAMES[state].filter((pixel) => pixel !== "transparent").length;
}

function setDocumentVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
}

describe("TerminalVinyl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockReducedMotion(false);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setDocumentVisibility("visible");
    vi.unstubAllGlobals();
  });

  it("播放时以50ms推进0.05rad并在暂停后冻结当前角度", () => {
    const { rerender } = render(<TerminalVinyl hasTrack isPlaying={false} />);
    const vinyl = screen.getByTestId("terminal-vinyl");
    expect(vinyl).toHaveAttribute("data-angle", "0.00");

    rerender(<TerminalVinyl hasTrack isPlaying />);
    act(() => vi.advanceTimersByTime(VINYL_TICK_MS));
    expect(vinyl).toHaveAttribute("data-angle", VINYL_ANGLE_INCREMENT.toFixed(2));

    rerender(<TerminalVinyl hasTrack isPlaying={false} />);
    act(() => vi.advanceTimersByTime(VINYL_TICK_MS * 3));
    expect(vinyl).toHaveAttribute("data-angle", VINYL_ANGLE_INCREMENT.toFixed(2));
  });

  it("按62×18契约复用同一组DOM像素并原位更新真彩颜色", () => {
    render(<TerminalVinyl hasTrack isPlaying />);
    const grid = screen.getByTestId("terminal-vinyl").querySelector(".terminal-vinyl__grid");
    const pixels = grid?.querySelectorAll<HTMLElement>(".terminal-vinyl__pixel") ?? [];
    const firstNodes = Array.from(pixels);
    const firstColors = firstNodes.map((pixel) => pixel.style.backgroundColor);

    expect(VINYL_WIDTH).toBe(62);
    expect(VINYL_HEIGHT).toBe(18);
    expect(firstNodes).toHaveLength(VINYL_WIDTH * VINYL_HEIGHT);

    act(() => vi.advanceTimersByTime(VINYL_TICK_MS));
    const nextNodes = Array.from(grid?.querySelectorAll<HTMLElement>(".terminal-vinyl__pixel") ?? []);
    const nextColors = nextNodes.map((pixel) => pixel.style.backgroundColor);
    expect(nextNodes.every((node, index) => node === firstNodes[index])).toBe(true);
    expect(nextColors).not.toEqual(firstColors);
  });

  it("reduced motion固定零角度且不创建动画定时器", () => {
    vi.useRealTimers();
    mockReducedMotion(true);
    const timer = vi.spyOn(window, "setInterval");
    render(<TerminalVinyl hasTrack isPlaying />);
    expect(screen.getByTestId("terminal-vinyl")).toHaveAttribute("data-angle", "0.00");
    expect(timer).not.toHaveBeenCalled();
  });

  it("页面隐藏时冻结角度，恢复可见后从冻结角度继续", () => {
    setDocumentVisibility("hidden");
    render(<TerminalVinyl hasTrack isPlaying />);
    const vinyl = screen.getByTestId("terminal-vinyl");

    act(() => vi.advanceTimersByTime(VINYL_TICK_MS * 3));
    expect(vinyl).toHaveAttribute("data-angle", "0.00");

    setDocumentVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(VINYL_TICK_MS));
    expect(vinyl).toHaveAttribute("data-angle", VINYL_ANGLE_INCREMENT.toFixed(2));

    setDocumentVisibility("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(VINYL_TICK_MS * 2));
    expect(vinyl).toHaveAttribute("data-angle", VINYL_ANGLE_INCREMENT.toFixed(2));
  });

  it("按无歌曲、暂停和播放切换三态暖铜像素唱针", () => {
    const { rerender } = render(<TerminalVinyl hasTrack={false} isPlaying={false} />);
    const needle = screen.getByTestId("terminal-vinyl-needle");
    expect(needle).toHaveAttribute("data-state", "parked");
    expect(needle.querySelectorAll(".terminal-vinyl__needle-pixel")).toHaveLength(
      visibleNeedlePixels("parked"),
    );

    rerender(<TerminalVinyl hasTrack isPlaying={false} />);
    expect(needle).toHaveAttribute("data-state", "resting");
    expect(needle.querySelectorAll(".terminal-vinyl__needle-pixel")).toHaveLength(
      visibleNeedlePixels("resting"),
    );

    rerender(<TerminalVinyl hasTrack isPlaying />);
    expect(needle).toHaveAttribute("data-state", "engaged");
    expect(needle.querySelector(".terminal-vinyl__needle-pixel--needle-metal")).toBeInTheDocument();
    expect(needle.querySelector(".terminal-vinyl__needle-pixel--cartridge")).toBeInTheDocument();
    expect(needle.querySelector(".terminal-vinyl__needle-pixel--stylus")).toBeInTheDocument();
    expect(needle.querySelector(".terminal-vinyl__needle-arm")).not.toBeInTheDocument();

    for (const pixel of needle.querySelectorAll<HTMLElement>(".terminal-vinyl__needle-pixel")) {
      const column = Number(pixel.style.gridColumnStart);
      const row = Number(pixel.style.gridRowStart);
      expect(column).toBeGreaterThanOrEqual(1);
      expect(column).toBeLessThanOrEqual(VINYL_WIDTH);
      expect(row).toBeGreaterThanOrEqual(1);
      expect(row).toBeLessThanOrEqual(VINYL_HEIGHT);
    }
  });
});
