import { useEffect, useRef } from "react";

/** Rasterize only on palette/size changes; CSS retains the original slow motion. */
export function CachedGlow({ kind, paletteKey }: {
  kind: "field" | "artwork-core";
  paletteKey: string;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    let lastSize = "";
    const paint = () => {
      // Layout sizes exclude the parent's animated transform.
      const width = root.offsetWidth;
      const height = root.offsetHeight;
      if (!width || !height) return;
      const size = `${width}:${height}`;
      if (size === lastSize) return;
      const target = canvas.getContext("2d");
      if (!target || !("filter" in target)) return;
      lastSize = size;
      const blur = kind === "field" ? 54 : 46;
      const padding = blur * 3;
      const scale = Math.min(1, 320 / Math.max(width + padding * 2, height + padding * 2));
      canvas.width = Math.max(1, Math.round((width + padding * 2) * scale));
      canvas.height = Math.max(1, Math.round((height + padding * 2) * scale));
      canvas.style.cssText = `left:-${padding}px;top:-${padding}px;width:calc(100% + ${padding * 2}px);height:calc(100% + ${padding * 2}px)`;
      const source = document.createElement("canvas");
      source.width = canvas.width;
      source.height = canvas.height;
      const context = source.getContext("2d");
      if (!context) return;
      const paintWidth = width * scale;
      const paintHeight = height * scale;
      context.translate(padding * scale, padding * scale);
      context.beginPath();
      if (kind === "artwork-core") context.ellipse(paintWidth / 2, paintHeight / 2, paintWidth / 2, paintHeight / 2, 0, 0, Math.PI * 2);
      else context.rect(0, 0, paintWidth, paintHeight);
      context.clip();
      const styles = getComputedStyle(root);
      const number = (key: string, fallback: number) => {
        const value = Number.parseFloat(styles.getPropertyValue(key));
        return Number.isFinite(value) ? value : fallback;
      };
      const color = (key: string) => styles.getPropertyValue(key).trim();
      const intensity = number("--cover-glow-intensity", 1);
      const mix = (key: string) => Math.min(number("--cover-blend-cap", 1), intensity * number(key, 0.5));
      const primary = color("--cover-primary") || "#789575";
      const vibrant = color("--cover-vibrant") || "#b8c77a";
      const core = mix("--cover-glow-core-alpha");
      const side = mix("--cover-glow-side-alpha");
      const ellipse = (x: number, y: number, stops: readonly [number, string][]) => {
        // CSS radial-gradient's default farthest-corner ellipse.
        const rx = Math.max(x, 1 - x) * paintWidth * Math.SQRT2;
        const ry = Math.max(y, 1 - y) * paintHeight * Math.SQRT2;
        context.save();
        context.translate(x * paintWidth, y * paintHeight);
        context.scale(rx, ry);
        const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
        for (const [stop, shade] of stops) gradient.addColorStop(stop, shade);
        context.fillStyle = gradient;
        context.fillRect(-2, -2, 4, 4);
        context.restore();
      };
      const tint = (shade: string, alpha: number) => `color-mix(in srgb, ${shade} ${alpha * 100}%, transparent)`;
      if (kind === "field") {
        // Viewport corners inside the oversized field (inset: -24% -18%).
        // Bake soft edge light into this same surface so it shares the slow drift.
        const cornerX = 0.18 / 1.36;
        const cornerY = 0.24 / 1.48;
        ellipse(cornerX, cornerY, [[0, tint(vibrant, side * 0.45)], [0.4, "transparent"]]);
        ellipse(1 - cornerX, cornerY, [[0, tint(primary, core * 0.65)], [0.4, "transparent"]]);
        ellipse(cornerX, 1 - cornerY, [[0, tint(primary, core * 0.65)], [0.4, "transparent"]]);
        ellipse(1 - cornerX, 1 - cornerY, [[0, tint(vibrant, side * 0.45)], [0.4, "transparent"]]);
        ellipse(0.8, 0.65, [[0, tint(vibrant, side)], [0.65, "transparent"]]);
        ellipse(0.2, 0.3, [[0, tint(primary, core)], [0.65, "transparent"]]);
      } else {
        ellipse(0.5, 0.5, [[0, tint(vibrant, core)], [0.42, tint(primary, core)], [0.82, "transparent"]]);
      }
      // Blur the composed layer in pixel coordinates, not each transformed ellipse.
      target.filter = `blur(${blur * scale}px)`;
      target.drawImage(source, 0, 0);
      root.dataset.cached = "true";
    };
    paint();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
    observer?.observe(root);
    return () => observer?.disconnect();
  }, [kind, paletteKey]);
  return <span aria-hidden="true" className={`stage__glow stage__glow--${kind} stage__glow--cached`} ref={rootRef}>
    <canvas aria-hidden="true" ref={canvasRef} />
  </span>;
}
