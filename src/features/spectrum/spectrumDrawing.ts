import { SPECTRUM_BAND_COUNT } from "../../contracts/spectrum";

export type SpectrumDrawingState =
  | "idle"
  | "starting"
  | "active"
  | "unavailable"
  | "failed";

export type SpectrumLayout = "vertical" | "horizontal";

export interface SpectrumSegment {
  readonly index: number;
  readonly intensity: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface SpectrumDrawingColors {
  /** Existing cover palette token, resolved to a CSS color by the component. */
  readonly accent?: string;
  /** Existing cover palette token used for the quiet spine. */
  readonly spine?: string;
}

export interface DrawSpectrumOptions extends SpectrumDrawingColors {
  readonly layout?: SpectrumLayout;
  readonly state?: SpectrumDrawingState;
}

export const DEFAULT_SPECTRUM_LAYOUT: SpectrumLayout = "vertical";

const MIN_SEGMENT_SPAN = 1;
const AXIS_INSET = 0.1;

function boundedBand(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Return exactly 24 safe amplitudes for the Canvas boundary. */
export function sanitizeSpectrumBands(bands: readonly number[] | null | undefined): number[] {
  const result = new Array<number>(SPECTRUM_BAND_COUNT);
  for (let index = 0; index < SPECTRUM_BAND_COUNT; index += 1) {
    result[index] = boundedBand(bands?.[index] ?? 0);
  }
  return result;
}

/**
 * Build the symmetric segments used by the renderer. Band 0 is low frequency:
 * it is nearest the bottom on the vertical spine and nearest the left on the
 * horizontal spine.
 */
export function buildSpectrumSegments(
  width: number,
  height: number,
  bands: readonly number[] | null | undefined,
  layout: SpectrumLayout = DEFAULT_SPECTRUM_LAYOUT,
): SpectrumSegment[] {
  const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  const sourceBands = sanitizeSpectrumBands(bands);
  // Smooth only the display contour; the measured frame and frequency order stay intact.
  const safeBands = sourceBands.map((value, index) => (
    sourceBands[Math.max(0, index - 1)]! * 0.2
    + value * 0.6
    + sourceBands[Math.min(SPECTRUM_BAND_COUNT - 1, index + 1)]! * 0.2
  ));
  const segments: SpectrumSegment[] = [];

  if (layout === "horizontal") {
    const centerY = safeHeight / 2;
    const left = safeWidth * AXIS_INSET;
    const usableWidth = safeWidth * (1 - AXIS_INSET * 2);
    const maxSpan = Math.max(MIN_SEGMENT_SPAN, safeHeight * 0.42);
    for (let index = 0; index < SPECTRUM_BAND_COUNT; index += 1) {
      const normalized = index / (SPECTRUM_BAND_COUNT - 1);
      const x = left + normalized * usableWidth;
      const intensity = safeBands[index] ?? 0;
      const span = Math.max(MIN_SEGMENT_SPAN, intensity * maxSpan * (1 - normalized * 0.3));
      segments.push({ index, intensity, x1: x, y1: centerY - span, x2: x, y2: centerY + span });
    }
    return segments;
  }

  const centerX = safeWidth / 2;
  const bottom = safeHeight * (1 - AXIS_INSET);
  const usableHeight = safeHeight * (1 - AXIS_INSET * 2);
  const maxSpan = Math.max(MIN_SEGMENT_SPAN, safeWidth * 0.42);
  for (let index = 0; index < SPECTRUM_BAND_COUNT; index += 1) {
    const normalized = index / (SPECTRUM_BAND_COUNT - 1);
    const y = bottom - normalized * usableHeight;
    const intensity = safeBands[index] ?? 0;
    const span = Math.max(MIN_SEGMENT_SPAN, intensity * maxSpan * (1 - normalized * 0.3));
    segments.push({ index, intensity, x1: centerX - span, y1: y, x2: centerX + span, y2: y });
  }
  return segments;
}

/**
 * Move displayed amplitudes toward a real frame. Release is deliberately
 * slower than attack to retain the verified 300ms visual decay without ever
 * inventing energy when no frame is available.
 */
export function advanceSpectrumBands(
  displayed: readonly number[],
  target: readonly number[],
  elapsedMs: number,
): number[] {
  const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const next = new Array<number>(SPECTRUM_BAND_COUNT);
  const attack = 1 - Math.exp(-elapsed / 65);
  const release = 1 - Math.exp(-elapsed / 300);
  for (let index = 0; index < SPECTRUM_BAND_COUNT; index += 1) {
    const previous = boundedBand(displayed[index] ?? 0);
    const goal = boundedBand(target[index] ?? 0);
    const amount = goal >= previous ? attack : release;
    next[index] = previous + (goal - previous) * amount;
  }
  return next;
}

function drawAxis(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  layout: SpectrumLayout,
  dashed: boolean,
): void {
  const center = layout === "horizontal" ? height / 2 : width / 2;
  context.beginPath();
  if (layout === "horizontal") {
    context.moveTo(width * AXIS_INSET, center);
    context.lineTo(width * (1 - AXIS_INSET), center);
  } else {
    context.moveTo(center, height * AXIS_INSET);
    context.lineTo(center, height * (1 - AXIS_INSET));
  }
  if (typeof context.setLineDash === "function") context.setLineDash(dashed ? [2, 4] : []);
  context.stroke();
  if (typeof context.setLineDash === "function") context.setLineDash([]);
}

/** Draw one complete frame; this function never owns an animation loop. */
export function drawSpectrum(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  bands: readonly number[] | null | undefined,
  options: DrawSpectrumOptions = {},
): void {
  const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  const state = options.state ?? "active";
  const layout = options.layout ?? DEFAULT_SPECTRUM_LAYOUT;
  const unavailable = state === "unavailable" || state === "failed";

  context.clearRect(0, 0, safeWidth, safeHeight);
  context.save();
  context.lineCap = "round";
  context.strokeStyle = options.spine ?? "currentColor";
  context.lineWidth = 1;
  context.globalAlpha = unavailable ? 0.3 : 0.12;
  drawAxis(context, safeWidth, safeHeight, layout, unavailable);

  if (!unavailable) {
    context.strokeStyle = options.accent ?? "currentColor";
    // Slender rounded bands form a quiet contour behind the independent needle scale.
    const axisLength = layout === "horizontal" ? safeWidth : safeHeight;
    const bandSpacing = axisLength * (1 - AXIS_INSET * 2) / (SPECTRUM_BAND_COUNT - 1);
    context.lineCap = "round";
    context.lineWidth = Math.min(3, bandSpacing * 0.3);
    context.shadowColor = options.accent ?? "transparent";
    const segments = buildSpectrumSegments(safeWidth, safeHeight, bands, layout);
    for (const segment of segments) {
      if (segment.intensity < 0.008) continue;
      // Silence fades away; only stronger real energy earns a small halo.
      context.globalAlpha = Math.min(1, segment.intensity / 0.12)
        * (state === "starting" ? 0.2 : 0.28 + segment.intensity * 0.28);
      context.shadowBlur = Math.max(0, segment.intensity - 0.65) * 12;
      context.beginPath();
      context.moveTo(segment.x1, segment.y1);
      context.lineTo(segment.x2, segment.y2);
      context.stroke();
    }
  }
  context.restore();
}

/** Keep the backing store aligned with CSS pixels while respecting device DPR. */
export function resizeSpectrumCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  devicePixelRatio = 1,
): { readonly width: number; readonly height: number; readonly dpr: number } {
  const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  const dpr = Math.max(1, Math.min(4, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1));
  const pixelWidth = Math.max(1, Math.round(safeWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(safeHeight * dpr));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const context = canvas.getContext("2d");
  context?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: safeWidth, height: safeHeight, dpr };
}

/** Resolve existing semantic cover tokens for Canvas, without introducing a new palette. */
export function readSpectrumColors(element: Element): SpectrumDrawingColors {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
    return { accent: "currentColor", spine: "currentColor" };
  }
  const styles = window.getComputedStyle(element);
  const accent = styles.getPropertyValue("--cover-primary").trim()
    || styles.getPropertyValue("--cover-vibrant").trim()
    || "currentColor";
  const spine = styles.getPropertyValue("--cover-on-surface").trim()
    || styles.color.trim()
    || "currentColor";
  return { accent: `color-mix(in srgb, ${accent} 85%, white)`, spine };
}
