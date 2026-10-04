import { describe, expect, it } from "vitest";

import {
  advanceSpectrumBands,
  buildSpectrumSegments,
  drawSpectrum,
  resizeSpectrumCanvas,
  sanitizeSpectrumBands,
} from "./spectrumDrawing";

describe("spectrumDrawing", () => {
  it("keeps a fixed 24-band shape and places low frequencies at the bottom/left", () => {
    const vertical = buildSpectrumSegments(76, 330, [1, ...new Array(23).fill(0)], "vertical");
    const horizontal = buildSpectrumSegments(620, 56, [1, ...new Array(23).fill(0)], "horizontal");

    expect(vertical).toHaveLength(24);
    expect(vertical[0]?.y1).toBeGreaterThan(vertical[23]?.y1 ?? 0);
    expect(vertical[0]?.x1).toBeLessThan(vertical[0]?.x2 ?? 0);
    expect(horizontal[0]?.x1).toBeLessThan(horizontal[23]?.x1 ?? 0);
    expect(horizontal[0]?.y1).toBeLessThan(horizontal[0]?.y2 ?? 0);
    expect((vertical[0]?.x2 ?? 0) - (vertical[0]?.x1 ?? 0)).toBeGreaterThan(
      (vertical[23]?.x2 ?? 0) - (vertical[23]?.x1 ?? 0),
    );
  });

  it("sanitizes malformed amplitudes without emitting NaN or out-of-range values", () => {
    const bands = sanitizeSpectrumBands([Number.NaN, Number.POSITIVE_INFINITY, -1, 2]);
    expect(bands).toHaveLength(24);
    expect(bands.slice(0, 4)).toEqual([0, 0, 0, 1]);
    expect(bands.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
  });

  it("attacks quickly and releases toward silence", () => {
    const rising = advanceSpectrumBands(new Array(24).fill(0), [1, ...new Array(23).fill(0)], 65);
    const falling = advanceSpectrumBands(rising, new Array(24).fill(0), 300);
    expect(rising[0]).toBeGreaterThan(0.5);
    expect(falling[0]).toBeLessThan(rising[0] ?? 1);
    expect(falling[0]).toBeGreaterThan(0);
  });

  it("draws the quiet axis and dashed unavailable state using supplied semantic colors", () => {
    const context = {
      clearRect: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      stroke: () => undefined,
      setLineDash: () => undefined,
      lineCap: "butt",
      lineWidth: 1,
      globalAlpha: 1,
      strokeStyle: "",
    } as unknown as CanvasRenderingContext2D;
    drawSpectrum(context, 76, 330, new Array(24).fill(0.7), {
      accent: "rgb(1 2 3)",
      spine: "rgb(4 5 6)",
      state: "unavailable",
    });
    expect(context.strokeStyle).toBe("rgb(4 5 6)");
  });

  it.each([330, 640])("keeps rounded bands restrained and separated at height %s", (height) => {
    const widths: number[] = [];
    const context = {
      clearRect() {}, save() {}, restore() {}, beginPath() {},
      moveTo() {}, lineTo() {}, setLineDash() {},
      lineWidth: 1,
      stroke(this: { lineWidth: number }) { widths.push(this.lineWidth); },
    } as unknown as CanvasRenderingContext2D;
    drawSpectrum(context, 60, height, new Array(24).fill(0.7));
    const segments = buildSpectrumSegments(60, height, new Array(24).fill(0.7));
    const spacing = Math.abs(segments[0]!.y1 - segments[1]!.y1);
    expect(widths).toHaveLength(25);
    for (const width of widths.slice(1)) {
      expect(width).toBeGreaterThan(0);
      expect(width).toBeLessThanOrEqual(3);
      expect(width).toBeLessThan(spacing);
    }
  });

  it("softens isolated peaks locally without filling silent frequency regions", () => {
    const bands = new Array(24).fill(0);
    bands[10] = 1;
    const segments = buildSpectrumSegments(60, 400, bands);
    expect(segments[10]!.intensity).toBeLessThan(1);
    expect(segments[9]!.intensity).toBeGreaterThan(0);
    expect(segments[11]!.intensity).toBeGreaterThan(0);
    expect(segments[0]!.intensity).toBe(0);
    expect(segments[23]!.intensity).toBe(0);
  });

  it("leaves only the quiet axis when the frame is silent", () => {
    let strokes = 0;
    const context = {
      clearRect() {}, save() {}, restore() {}, beginPath() {},
      moveTo() {}, lineTo() {}, setLineDash() {},
      stroke() { strokes += 1; },
    } as unknown as CanvasRenderingContext2D;
    drawSpectrum(context, 60, 400, new Array(24).fill(0));
    expect(strokes).toBe(1);
  });

  it("resizes the backing store by the device pixel ratio", () => {
    const canvas = document.createElement("canvas");
    const context = { setTransform: () => undefined } as unknown as CanvasRenderingContext2D;
    Object.defineProperty(canvas, "getContext", { configurable: true, value: () => context });
    expect(resizeSpectrumCanvas(canvas, 76, 330, 2)).toEqual({ width: 76, height: 330, dpr: 2 });
    expect(canvas.width).toBe(152);
    expect(canvas.height).toBe(660);
  });
});
