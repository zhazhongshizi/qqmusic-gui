import { describe, expect, it } from "vitest";

import {
  advanceVinylAngle,
  NEEDLE_FRAMES,
  renderNeedleFrame,
  renderVinylFrame,
  VINYL_ANGLE_INCREMENT,
  VINYL_HEIGHT,
  VINYL_HOLE_RADIUS_RATIO,
  VINYL_HORIZONTAL_DISTANCE_SCALE,
  VINYL_LABEL_RADIUS_RATIO,
  VINYL_RADIUS,
  VINYL_RADIUS_SCALE,
  VINYL_TICK_MS,
  VINYL_WIDTH,
} from "./vinylFrames";
import type { NeedlePixel, NeedleState, VinylCell, VinylPixel } from "./vinylFrames";

function indexesOf(frame: readonly VinylCell[], pixel: VinylPixel) {
  return frame.flatMap((value, index) => value.material === pixel ? [index] : []);
}

function surfaceIndexes(frame: readonly VinylCell[]) {
  return frame.flatMap((value, index) => value.material === "transparent" ? [] : [index]);
}

function needleMarks(frame: readonly NeedlePixel[]) {
  return frame.flatMap((value, index) => value === "transparent" ? [] : [index]);
}

describe("terminal elliptical vinyl algorithm", () => {
  it("uses the approved 62x18 elliptical material constants", () => {
    expect(VINYL_WIDTH).toBe(62);
    expect(VINYL_HEIGHT).toBe(18);
    expect(VINYL_HORIZONTAL_DISTANCE_SCALE).toBe(0.4);
    expect(VINYL_RADIUS_SCALE).toBe(0.92);
    expect(VINYL_RADIUS).toBeCloseTo(8.28, 8);
    expect(VINYL_LABEL_RADIUS_RATIO).toBe(0.32);
    expect(VINYL_HOLE_RADIUS_RATIO).toBe(0.055);
    expect(VINYL_TICK_MS).toBe(50);
    expect(VINYL_ANGLE_INCREMENT).toBe(0.05);
  });

  it("returns a stable 62x18 raster and keeps the ellipse, label and hole fixed", () => {
    const first = renderVinylFrame(0);
    const second = renderVinylFrame(Math.PI / 3);
    const firstSurface = surfaceIndexes(first);
    const firstLabel = indexesOf(first, "label").concat(indexesOf(first, "label-detail"));
    const firstHole = indexesOf(first, "hole");

    expect(first).toHaveLength(VINYL_WIDTH * VINYL_HEIGHT);
    expect(second).toHaveLength(VINYL_WIDTH * VINYL_HEIGHT);
    expect(firstSurface).toEqual(surfaceIndexes(second));
    expect(firstLabel).toHaveLength(indexesOf(second, "label").length + indexesOf(second, "label-detail").length);
    expect(firstHole).toEqual(indexesOf(second, "hole"));
    expect(firstHole.length).toBeGreaterThan(0);
    expect(first[0]?.material).toBe("transparent");
  });

  it("has four low-contrast groove levels and moving dual-sided highlights", () => {
    const frameAtZero = renderVinylFrame(0);
    const frameAtQuarterTurn = renderVinylFrame(Math.PI / 2);
    const groovePixels = new Set(["deep", "groove-dark", "groove-mid", "groove-light"]);

    const materials = frameAtZero.map((cell) => cell.material);
    expect([...groovePixels].every((pixel) => materials.includes(pixel as VinylPixel))).toBe(true);
    expect(materials).toContain("glint-low");
    expect(materials).toContain("glint-mid");
    expect(materials).toContain("glint-high");
    expect(frameAtZero).not.toEqual(frameAtQuarterTurn);
    expect(indexesOf(frameAtZero, "label").length + indexesOf(frameAtZero, "label-detail").length)
      .toBe(indexesOf(frameAtQuarterTurn, "label").length + indexesOf(frameAtQuarterTurn, "label-detail").length);
  });

  it("advances exactly one 50ms tick by 0.05rad and wraps safely", () => {
    expect(advanceVinylAngle(0)).toBeCloseTo(VINYL_ANGLE_INCREMENT, 10);
    expect(advanceVinylAngle(-0.05)).toBeCloseTo(0, 10);
    expect(advanceVinylAngle(Number.NaN)).toBeCloseTo(VINYL_ANGLE_INCREMENT, 10);
    expect(advanceVinylAngle(Math.PI * 2 - VINYL_ANGLE_INCREMENT)).toBeCloseTo(0, 10);
  });

  it("preserves continuous true-color material instead of collapsing to three glint colors", () => {
    const frame = renderVinylFrame(0.73);
    const outerColors = frame.flatMap((cell) => (
      cell.material === "transparent" || cell.material === "label" || cell.material === "label-detail"
        ? []
        : [cell.color]
    ));
    expect(new Set(outerColors).size).toBeGreaterThan(30);
    expect(outerColors.every((color) => color === "transparent" || color.startsWith("rgb("))).toBe(true);
  });

  it("rasterizes distinct engaged, resting and parked warm-copper needle states", () => {
    const states: NeedleState[] = ["engaged", "resting", "parked"];
    const palette: NeedlePixel[] = [
      "transparent",
      "needle-metal",
      "needle-shadow",
      "cartridge",
      "stylus",
    ];

    expect(NEEDLE_FRAMES.engaged).not.toEqual(NEEDLE_FRAMES.resting);
    expect(NEEDLE_FRAMES.resting).not.toEqual(NEEDLE_FRAMES.parked);
    for (const state of states) {
      const frame = renderNeedleFrame(state);
      expect(frame).toEqual(NEEDLE_FRAMES[state]);
      expect(frame).toHaveLength(VINYL_WIDTH * VINYL_HEIGHT);
      expect(new Set(frame)).toEqual(new Set(palette));
      expect(needleMarks(frame).every((index) => index >= 0 && index < VINYL_WIDTH * VINYL_HEIGHT)).toBe(true);
      expect(frame).toContain("needle-metal");
      expect(frame).toContain("needle-shadow");
      expect(frame).toContain("cartridge");
      expect(frame).toContain("stylus");
    }
  });
});
