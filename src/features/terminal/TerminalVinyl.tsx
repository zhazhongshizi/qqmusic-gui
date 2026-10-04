import { memo, useEffect, useRef, useState } from "react";

import {
  advanceVinylAngle,
  NEEDLE_FRAMES,
  renderVinylFrame,
  VINYL_BASE_FRAME,
  VINYL_TICK_MS,
  VINYL_WIDTH,
  type NeedleState,
  type VinylCell,
} from "./vinylFrames";

function useReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false
  ));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(media.matches);
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);

  return reducedMotion;
}

function usePageVisible() {
  const [pageVisible, setPageVisible] = useState(() => (
    typeof document === "undefined" || document.visibilityState === "visible"
  ));

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  return pageVisible;
}

interface TerminalVinylProps {
  isPlaying: boolean;
  hasTrack: boolean;
}

interface TerminalNeedleProps {
  state: NeedleState;
}

function applyFrame(grid: HTMLDivElement | null, frame: readonly VinylCell[]) {
  if (!grid) return;
  const pixels = grid.children;
  for (let index = 0; index < pixels.length; index += 1) {
    const pixel = pixels.item(index);
    const next = frame[index];
    if (!(pixel instanceof HTMLElement) || !next) continue;
    if (pixel.style.backgroundColor !== next.color) pixel.style.backgroundColor = next.color;
    if (pixel.dataset.material !== next.material) pixel.dataset.material = next.material;
  }
}

const TerminalNeedle = memo(function TerminalNeedle({ state }: TerminalNeedleProps) {
  const pixels = NEEDLE_FRAMES[state];
  return (
    <span
      aria-hidden="true"
      className={`terminal-vinyl__needle terminal-vinyl__needle--${state}`}
      data-state={state}
      data-testid="terminal-vinyl-needle"
    >
      {pixels.map((pixel, index) => (
        pixel === "transparent" ? null : (
          <i
            className={`terminal-vinyl__needle-pixel terminal-vinyl__needle-pixel--${pixel}`}
            key={index}
            style={{
              gridColumnStart: index % VINYL_WIDTH + 1,
              gridRowStart: Math.floor(index / VINYL_WIDTH) + 1,
            }}
          />
        )
      ))}
    </span>
  );
});

export const TerminalVinyl = memo(function TerminalVinyl({
  isPlaying,
  hasTrack,
}: TerminalVinylProps) {
  const reducedMotion = useReducedMotion();
  const pageVisible = usePageVisible();
  const angleRef = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const vinylRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reducedMotion) {
      angleRef.current = 0;
      applyFrame(gridRef.current, VINYL_BASE_FRAME);
      if (vinylRef.current) vinylRef.current.dataset.angle = "0.00";
      return;
    }
    if (!isPlaying || !pageVisible) return;

    const timer = window.setInterval(() => {
      angleRef.current = advanceVinylAngle(angleRef.current);
      applyFrame(gridRef.current, renderVinylFrame(angleRef.current));
      if (vinylRef.current) vinylRef.current.dataset.angle = angleRef.current.toFixed(2);
    }, VINYL_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isPlaying, pageVisible, reducedMotion]);

  const className = isPlaying
    ? "terminal-vinyl terminal-vinyl--playing"
    : "terminal-vinyl";
  const needleState: NeedleState = !hasTrack
    ? "parked"
    : isPlaying
      ? "engaged"
      : "resting";

  return (
    <div
      aria-label={isPlaying ? "正在旋转的像素黑胶" : "暂停的像素黑胶"}
      className={className}
      data-angle={angleRef.current.toFixed(2)}
      data-testid="terminal-vinyl"
      ref={vinylRef}
      role="img"
    >
      <div className="terminal-vinyl__grid" ref={gridRef}>
        {VINYL_BASE_FRAME.map((pixel, index) => (
          <i
            aria-hidden="true"
            className="terminal-vinyl__pixel"
            data-material={pixel.material}
            key={index}
            style={{ backgroundColor: pixel.color }}
          />
        ))}
      </div>
      <TerminalNeedle state={needleState} />
    </div>
  );
});
