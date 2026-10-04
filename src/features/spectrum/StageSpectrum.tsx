import { memo, useEffect, useRef, useState } from "react";

import { SPECTRUM_BAND_COUNT, type SpectrumFrame } from "../../contracts/spectrum";
import {
  advanceSpectrumBands,
  drawSpectrum,
  readSpectrumColors,
  resizeSpectrumCanvas,
  type SpectrumLayout,
  type SpectrumDrawingState,
} from "./spectrumDrawing";
import {
  getLatestSpectrumFrame,
  useSpectrumSnapshot,
  type SpectrumServiceStatus,
} from "./spectrumStore";

export interface StageSpectrumProps {
  readonly className?: string;
  readonly orientation?: SpectrumLayout;
  readonly renderable?: boolean;
  readonly status?: SpectrumServiceStatus;
  /** Invalidates cached CSS colors when the inherited cover palette changes. */
  readonly paletteKey?: string | undefined;
  readonly [key: `data-${string}`]: string | undefined;
}

const ZERO_BANDS = Object.freeze(new Array<number>(SPECTRUM_BAND_COUNT).fill(0));

const STATUS_LABELS: Record<SpectrumServiceStatus, string> = {
  idle: "频谱待机",
  starting: "频谱准备中",
  active: "频谱运行中",
  unavailable: "频谱不可用",
  failed: "频谱不可用",
};

function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false
  ));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(media.matches);
    if (typeof media.addEventListener === "function") media.addEventListener("change", onChange);
    else media.addListener?.(onChange);
    return () => {
      if (typeof media.removeEventListener === "function") media.removeEventListener("change", onChange);
      else media.removeListener?.(onChange);
    };
  }, []);

  return reducedMotion;
}

function measureSurface(element: HTMLElement, canvas: HTMLCanvasElement): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  const width = rect.width || element.clientWidth || canvas.clientWidth || 76;
  const height = rect.height || element.clientHeight || canvas.clientHeight || 330;
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

function effectiveLayout(
  requested: SpectrumLayout | undefined,
  width: number,
  height: number,
): SpectrumLayout {
  if (requested) return requested;
  return width > height ? "horizontal" : "vertical";
}

function spectrumState(status: SpectrumServiceStatus): SpectrumDrawingState {
  return status;
}

function shouldAnimate(status: SpectrumServiceStatus, bands: readonly number[], reducedMotion: boolean): boolean {
  if (reducedMotion || status === "unavailable" || status === "failed") return false;
  if (status === "active" || status === "starting") return true;
  return bands.some((band) => band > 0.005);
}

/**
 * Decorative central spectrum spine. Frame events never enter React state:
 * only the service's low-frequency status is subscribed here.
 */
export const StageSpectrum = memo(function StageSpectrum({
  className,
  orientation,
  renderable = true,
  status: statusOverride,
  paletteKey,
  ...dataAttributes
}: StageSpectrumProps) {
  const snapshot = useSpectrumSnapshot();
  const reducedMotion = useReducedMotion();
  const status = statusOverride ?? snapshot.status;
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const displayedBandsRef = useRef<number[]>([...ZERO_BANDS]);
  const lastTimestampRef = useRef<number | null>(null);
  const metricsRef = useRef({ width: 76, height: 330, layout: "vertical" as SpectrumLayout });
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;

    const getContext = () => canvas.getContext("2d");
    if (!renderable) {
      displayedBandsRef.current = [...ZERO_BANDS];
      lastTimestampRef.current = null;
      const context = getContext();
      context?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const resize = () => {
      const surface = measureSurface(root, canvas);
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const dimensions = resizeSpectrumCanvas(canvas, surface.width, surface.height, dpr);
      metricsRef.current = {
        width: dimensions.width,
        height: dimensions.height,
        layout: effectiveLayout(orientation, dimensions.width, dimensions.height),
      };
    };
    const colors = readSpectrumColors(root);
    const drawCurrent = (timestamp?: number) => {
      const context = getContext();
      if (!context) return;
      const currentTime = timestamp ?? (typeof performance !== "undefined" ? performance.now() : 0);
      const previousTime = lastTimestampRef.current;
      const elapsed = previousTime === null ? 16 : Math.min(120, Math.max(0, currentTime - previousTime));
      lastTimestampRef.current = currentTime;
      const frame: SpectrumFrame | null = getLatestSpectrumFrame();
      const target = frame?.bands ?? ZERO_BANDS;
      displayedBandsRef.current = advanceSpectrumBands(displayedBandsRef.current, target, elapsed);
      drawSpectrum(context, metricsRef.current.width, metricsRef.current.height, displayedBandsRef.current, {
        accent: colors.accent,
        spine: colors.spine,
        layout: metricsRef.current.layout,
        state: spectrumState(statusRef.current),
      });
    };
    const stopAnimation = () => {
      if (animationRef.current !== null) {
        window.cancelAnimationFrame?.(animationRef.current);
        animationRef.current = null;
      }
    };
    const tick = (timestamp: number) => {
      animationRef.current = null;
      drawCurrent(timestamp);
      if (shouldAnimate(statusRef.current, displayedBandsRef.current, reducedMotion)) {
        if (typeof window.requestAnimationFrame === "function") {
          animationRef.current = window.requestAnimationFrame(tick);
        }
      }
    };
    const scheduleAnimation = () => {
      if (reducedMotion || animationRef.current !== null) return;
      if (!shouldAnimate(statusRef.current, displayedBandsRef.current, reducedMotion)) return;
      if (typeof window.requestAnimationFrame !== "function") return;
      animationRef.current = window.requestAnimationFrame(tick);
    };
    const onResize = () => {
      resize();
      drawCurrent();
      scheduleAnimation();
    };

    resize();
    drawCurrent();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(root);
    } else if (typeof window !== "undefined") {
      window.addEventListener("resize", onResize);
    }
    scheduleAnimation();

    return () => {
      stopAnimation();
      resizeObserver?.disconnect();
      if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
      lastTimestampRef.current = null;
    };
  }, [orientation, reducedMotion, renderable, status, paletteKey]);

  const classes = ["stage__spectrum", className].filter(Boolean).join(" ");
  return (
    <div
      {...dataAttributes}
      className={classes}
      data-layout={orientation ?? "auto"}
      data-spectrum-layout={orientation ?? "auto"}
      data-spectrum-state={status}
      data-spectrum-renderable={renderable ? "true" : "false"}
      data-spectrum-subscribed={snapshot.subscribed ? "true" : "false"}
      data-state={status}
      ref={rootRef}
    >
      <canvas
        aria-hidden="true"
        className="stage__spectrum-canvas"
        ref={canvasRef}
      />
      <span className="stage__spectrum-status" role="status">{STATUS_LABELS[status]}</span>
    </div>
  );
});
