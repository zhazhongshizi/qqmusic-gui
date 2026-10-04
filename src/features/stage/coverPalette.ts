import { useEffect, useState, type CSSProperties } from "react";

import { getCoverImage } from "../../backend/coverAdapter";

export type CoverTone = "dark" | "light";

export interface SurfaceTokens {
  readonly surfaceBase: string;
  readonly surfaceRaised: string;
  readonly surfaceLowered: string;
  readonly onSurface: string;
  readonly onSurfaceMuted: string;
  readonly lineLight: string;
  readonly accentLight: string;
}

export interface CoverPalette {
  readonly primary: string;
  readonly vibrant: string;
  readonly ambient: string;
  readonly top: string;
  readonly tone: CoverTone;
  readonly surface: SurfaceTokens;
}

export type GlowIntensityLevel = "off" | "subtle" | "standard" | "enhanced";

export const GLOW_INTENSITY_VALUES: Record<GlowIntensityLevel, number> = {
  off: 0,
  subtle: 0.55,
  standard: 1.0,
  enhanced: 1.45,
};

export const GLOW_INTENSITY_LABELS: Record<GlowIntensityLevel, string> = {
  off: "光晕：关闭",
  subtle: "光晕：柔和",
  standard: "光晕：标准",
  enhanced: "光晕：增强",
};

export const COVER_TONE_THRESHOLD = 0.5;
export const COVER_TONE_AVERAGE_WEIGHT = 0.8;
export const COVER_TONE_PRIMARY_WEIGHT = 0.2;

const LIGHT_SURFACE_ON = "#18211f";
const LIGHT_SURFACE_MUTED = "#4e5d58";

export const DEFAULT_PALETTE: CoverPalette = {
  primary: "rgb(120 149 117)",
  vibrant: "rgb(184 199 122)",
  ambient: "rgb(25 54 43)",
  top: "rgb(33 62 51)",
  tone: "dark",
  surface: {
    surfaceBase: "hsl(114 8% 84%)",
    surfaceRaised: "hsl(114 8% 89%)",
    surfaceLowered: "hsl(114 8% 78%)",
    onSurface: LIGHT_SURFACE_ON,
    onSurfaceMuted: LIGHT_SURFACE_MUTED,
    lineLight: "rgb(24 33 31 / 24%)",
    accentLight: "rgb(47 87 72)",
  },
};

export interface PaletteTrack {
  id: string;
  accent: string;
  coverCacheKey?: string;
}

const paletteCache = new Map<string, CoverPalette>();

export function getCachedPalette(key: string): CoverPalette | undefined {
  return paletteCache.get(key);
}

export function setCachedPalette(key: string, palette: CoverPalette): void {
  paletteCache.set(key, palette);
}

export function clearPaletteCache(): void {
  paletteCache.clear();
}

/**
 * Converts 0-255 RGB components into HSL [0-360, 0-1, 0-1].
 */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    switch (max) {
      case rn:
        h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60;
        break;
      case gn:
        h = ((bn - rn) / delta + 2) * 60;
        break;
      case bn:
        h = ((rn - gn) / delta + 4) * 60;
        break;
    }
  }

  return [Math.round(h), s, l];
}

/**
 * Converts HSL [0-360, 0-1, 0-1] back to RGB [0-255, 0-255, 0-255].
 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let rn = 0;
  let gn = 0;
  let bn = 0;

  if (h >= 0 && h < 60) {
    rn = c; gn = x; bn = 0;
  } else if (h >= 60 && h < 120) {
    rn = x; gn = c; bn = 0;
  } else if (h >= 120 && h < 180) {
    rn = 0; gn = c; bn = x;
  } else if (h >= 180 && h < 240) {
    rn = 0; gn = x; bn = c;
  } else if (h >= 240 && h < 300) {
    rn = x; gn = 0; bn = c;
  } else if (h >= 300 && h < 360) {
    rn = c; gn = 0; bn = x;
  }

  return [
    Math.round((rn + m) * 255),
    Math.round((gn + m) * 255),
    Math.round((bn + m) * 255),
  ];
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.trim().replace(/^#/, "");
  if (clean.length === 3) {
    const c0 = clean[0];
    const c1 = clean[1];
    const c2 = clean[2];
    if (!c0 || !c1 || !c2) return null;
    const r = Number.parseInt(c0 + c0, 16);
    const g = Number.parseInt(c1 + c1, 16);
    const b = Number.parseInt(c2 + c2, 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return [r, g, b];
  }
  if (clean.length === 6) {
    const r = Number.parseInt(clean.slice(0, 2), 16);
    const g = Number.parseInt(clean.slice(2, 4), 16);
    const b = Number.parseInt(clean.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return [r, g, b];
  }
  return null;
}

export function formatRgb(rgb: [number, number, number]): string {
  return "rgb(" + rgb[0] + " " + rgb[1] + " " + rgb[2] + ")";
}

function srgbToLinear(component: number): number {
  const normalized = Math.max(0, Math.min(255, component)) / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function coverToneFromLuminance(averageLuminance: number, primaryLuminance: number): CoverTone {
  const score =
    COVER_TONE_AVERAGE_WEIGHT * averageLuminance +
    COVER_TONE_PRIMARY_WEIGHT * primaryLuminance;
  return Number.isFinite(score) && score >= COVER_TONE_THRESHOLD ? "light" : "dark";
}

function parseRgbFunction(color: string): [number, number, number] | null {
  const match = color.trim().match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (!match) return null;
  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);
  return [r, g, b].every(Number.isFinite) ? [r, g, b] : null;
}

function parseHslFunction(color: string): [number, number, number] | null {
  const match = color.trim().match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i);
  if (!match) return null;
  const h = Number(match[1]);
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  if (![h, s, l].every(Number.isFinite)) return null;
  return hslToRgb((h % 360 + 360) % 360, s, l);
}

function parseColor(color: string): [number, number, number] | null {
  return hexToRgb(color) ?? parseRgbFunction(color) ?? parseHslFunction(color);
}

export function colorRelativeLuminance(color: string): number {
  const rgb = parseColor(color);
  return rgb ? relativeLuminance(...rgb) : 0;
}

export function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = colorRelativeLuminance(foreground);
  const backgroundLuminance = colorRelativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function formatHsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function deriveSurfaceTokens(primary: string, vibrant = primary): SurfaceTokens {
  const primaryRgb = parseColor(primary) ?? [120, 149, 117];
  const vibrantRgb = parseColor(vibrant) ?? primaryRgb;
  const sourceRgb = relativeLuminance(...vibrantRgb) > relativeLuminance(...primaryRgb)
    ? vibrantRgb
    : primaryRgb;
  const [h, sourceSaturation] = rgbToHsl(...primaryRgb);
  const [, accentSaturation] = rgbToHsl(...sourceRgb);
  const surfaceSaturation = clamp(sourceSaturation || 0.08, 0.08, 0.16);
  const accentRgb = hslToRgb(
    rgbToHsl(...sourceRgb)[0],
    clamp(Math.max(0.35, accentSaturation * 1.1), 0.35, 0.72),
    0.36,
  );

  return {
    surfaceBase: formatHsl(h, surfaceSaturation, 0.84),
    surfaceRaised: formatHsl(h, surfaceSaturation, 0.89),
    surfaceLowered: formatHsl(h, surfaceSaturation, 0.78),
    onSurface: LIGHT_SURFACE_ON,
    onSurfaceMuted: LIGHT_SURFACE_MUTED,
    lineLight: "rgb(24 33 31 / 24%)",
    accentLight: formatRgb(accentRgb),
  };
}

function buildPalette(
  primary: string,
  vibrant: string,
  ambient: string,
  top: string,
  averageLuminance: number,
): CoverPalette {
  const primaryLuminance = colorRelativeLuminance(primary);
  return {
    primary,
    vibrant,
    ambient,
    top,
    tone: coverToneFromLuminance(averageLuminance, primaryLuminance),
    surface: deriveSurfaceTokens(primary, vibrant),
  };
}

/**
 * Derives a harmonious 4-color palette from a single accent color (e.g. #789575).
 */
export function derivePaletteFromAccent(accentHex: string): CoverPalette {
  const rgb = hexToRgb(accentHex);
  if (!rgb) return DEFAULT_PALETTE;

  const [h, s, l] = rgbToHsl(...rgb);

  // Primary: calibrated accent
  const primaryRgb = hslToRgb(h, Math.min(1, s * 1.05), Math.max(0.25, Math.min(0.65, l)));

  // Vibrant: boosted saturation, comfortable luminance for highlights
  const vibrantRgb = hslToRgb(h, Math.min(1, Math.max(0.45, s * 1.35)), Math.max(0.42, Math.min(0.72, l * 1.15)));

  // Ambient: deeper tone suited for background radial glow (won't blow out dark bg)
  const ambientRgb = hslToRgb(h, Math.min(0.85, Math.max(0.3, s * 0.9)), Math.max(0.14, Math.min(0.32, l * 0.55)));

  // Top: smooth atmospheric ceiling tone
  const topRgb = hslToRgb((h + 12) % 360, Math.min(0.65, Math.max(0.2, s * 0.75)), Math.max(0.18, Math.min(0.35, l * 0.65)));

  const primary = formatRgb(primaryRgb);
  const vibrant = formatRgb(vibrantRgb);
  return buildPalette(
    primary,
    vibrant,
    formatRgb(ambientRgb),
    formatRgb(topRgb),
    colorRelativeLuminance(primary),
  );
}

interface ColorBucket {
  count: number;
  rSum: number;
  gSum: number;
  bSum: number;
  h: number;
  s: number;
  l: number;
}

/**
 * Extracts representative colors from pixel data (RGBA Array or ImageData).
 */
export function extractPaletteFromPixels(
  data: Uint8ClampedArray | Uint8Array,
  length: number,
  width = 32,
  height = 32
): CoverPalette {
  const buckets = new Map<string, ColorBucket>();
  const topBuckets = new Map<string, ColorBucket>();
  let validPixelCount = 0;
  let topPixelCount = 0;
  let tonePixelCount = 0;
  let toneRSum = 0;
  let toneGSum = 0;
  let toneBSum = 0;

  const topThreshold = Math.floor(height * 0.38);

  for (let i = 0; i < length; i += 4) {
    const a = data[i + 3] ?? 255;
    if (a < 128) continue;

    const pixelIndex = i / 4;
    const y = Math.floor(pixelIndex / width);

    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;

    tonePixelCount += 1;
    toneRSum += r;
    toneGSum += g;
    toneBSum += b;

    const [h, s, l] = rgbToHsl(r, g, b);

    if (l < 0.05 || l > 0.96) continue;

    validPixelCount += 1;

    const hBucket = Math.floor(h / 22.5);
    const sBucket = Math.floor(s * 3);
    const lBucket = Math.floor(l * 3);
    const key = hBucket + "_" + sBucket + "_" + lBucket;

    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      existing.rSum += r;
      existing.gSum += g;
      existing.bSum += b;
    } else {
      buckets.set(key, { count: 1, rSum: r, gSum: g, bSum: b, h, s, l });
    }

    if (y < topThreshold) {
      topPixelCount += 1;
      const topExisting = topBuckets.get(key);
      if (topExisting) {
        topExisting.count += 1;
        topExisting.rSum += r;
        topExisting.gSum += g;
        topExisting.bSum += b;
      } else {
        topBuckets.set(key, { count: 1, rSum: r, gSum: g, bSum: b, h, s, l });
      }
    }
  }

  if (tonePixelCount === 0) {
    return DEFAULT_PALETTE;
  }

  const averageRgb: [number, number, number] = [
    Math.round(toneRSum / tonePixelCount),
    Math.round(toneGSum / tonePixelCount),
    Math.round(toneBSum / tonePixelCount),
  ];
  const averageLuminance = relativeLuminance(...averageRgb);

  if (validPixelCount === 0 || buckets.size === 0) {
    const average = formatRgb(averageRgb);
    const tone = coverToneFromLuminance(averageLuminance, averageLuminance);
    return tone === "light"
      ? {
          ...DEFAULT_PALETTE,
          tone,
          surface: deriveSurfaceTokens(average),
        }
      : DEFAULT_PALETTE;
  }

  const bucketList = Array.from(buckets.values());
  bucketList.sort((a, b) => b.count - a.count);
  const dominant = bucketList[0]!;
  const primaryRgb: [number, number, number] = [
    Math.round(dominant.rSum / dominant.count),
    Math.round(dominant.gSum / dominant.count),
    Math.round(dominant.bSum / dominant.count),
  ];

  const vibrantScored = [...bucketList].sort((a, b) => {
    const scoreA = a.s * (1 - Math.abs(a.l - 0.55)) * Math.sqrt(a.count);
    const scoreB = b.s * (1 - Math.abs(b.l - 0.55)) * Math.sqrt(b.count);
    return scoreB - scoreA;
  });

  const vibrantBucket = vibrantScored[0] ?? dominant;
  let vibrantRgb: [number, number, number] = [
    Math.round(vibrantBucket.rSum / vibrantBucket.count),
    Math.round(vibrantBucket.gSum / vibrantBucket.count),
    Math.round(vibrantBucket.bSum / vibrantBucket.count),
  ];

  const [, vs, vl] = rgbToHsl(...vibrantRgb);
  if (vs < 0.18) {
    const [ph, ps] = rgbToHsl(...primaryRgb);
    vibrantRgb = hslToRgb(ph, Math.max(0.4, ps * 1.5), Math.max(0.48, Math.min(0.72, vl)));
  }

  const [ah, as] = rgbToHsl(...primaryRgb);
  const ambientRgb = hslToRgb(ah, Math.min(0.7, Math.max(0.25, as * 0.9)), 0.22);

  // Top color extraction: dominant top bucket or derived from top average
  let topRgb: [number, number, number];
  if (topBuckets.size > 0) {
    const topList = Array.from(topBuckets.values()).sort((a, b) => b.count - a.count);
    const topDominant = topList[0]!;
    topRgb = [
      Math.round(topDominant.rSum / topDominant.count),
      Math.round(topDominant.gSum / topDominant.count),
      Math.round(topDominant.bSum / topDominant.count),
    ];
  } else {
    topRgb = hslToRgb((ah + 15) % 360, Math.min(0.6, as * 0.8), 0.26);
  }

  return buildPalette(
    formatRgb(primaryRgb),
    formatRgb(vibrantRgb),
    formatRgb(ambientRgb),
    formatRgb(topRgb),
    averageLuminance,
  );
}

/**
 * Extracts colors from an image element or Object URL.
 */
export async function extractPaletteFromImageUrl(url: string, fallbackAccent?: string): Promise<CoverPalette> {
  if (typeof document === "undefined") {
    return fallbackAccent ? derivePaletteFromAccent(fallbackAccent) : DEFAULT_PALETTE;
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    const timeout = setTimeout(() => {
      resolve(fallbackAccent ? derivePaletteFromAccent(fallbackAccent) : DEFAULT_PALETTE);
    }, 2500);

    img.onload = () => {
      clearTimeout(timeout);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve(fallbackAccent ? derivePaletteFromAccent(fallbackAccent) : DEFAULT_PALETTE);
          return;
        }

        ctx.drawImage(img, 0, 0, 32, 32);
        const imageData = ctx.getImageData(0, 0, 32, 32);
        const palette = extractPaletteFromPixels(imageData.data, imageData.data.length, 32, 32);
        resolve(palette);
      } catch {
        resolve(fallbackAccent ? derivePaletteFromAccent(fallbackAccent) : DEFAULT_PALETTE);
      }
    };

    img.onerror = () => {
      clearTimeout(timeout);
      resolve(fallbackAccent ? derivePaletteFromAccent(fallbackAccent) : DEFAULT_PALETTE);
    };

    img.src = url;
  });
}

export function getCoverPaletteStyle(palette: CoverPalette, intensityValue: number): CSSProperties {
  return {
    "--cover-primary": palette.primary,
    "--cover-vibrant": palette.vibrant,
    "--cover-ambient": palette.ambient,
    "--cover-top": palette.top,
    "--cover-surface-base": palette.surface.surfaceBase,
    "--cover-surface-raised": palette.surface.surfaceRaised,
    "--cover-surface-lowered": palette.surface.surfaceLowered,
    "--cover-on-surface": palette.surface.onSurface,
    "--cover-on-surface-muted": palette.surface.onSurfaceMuted,
    "--cover-line-light": palette.surface.lineLight,
    "--cover-accent-light": palette.surface.accentLight,
    "--cover-glow-intensity": intensityValue.toString(),
  } as CSSProperties;
}

/**
 * React hook to observe and resolve the cover palette for the active track.
 */
export function useCoverPalette(
  track: PaletteTrack | null,
  intensityLevel: GlowIntensityLevel = "standard"
) {
  const [palette, setPalette] = useState<CoverPalette>(() => {
    if (!track) return DEFAULT_PALETTE;
    const cacheKey = track.coverCacheKey || track.id;
    return paletteCache.get(cacheKey) || derivePaletteFromAccent(track.accent);
  });

  useEffect(() => {
    if (!track) {
      setPalette(DEFAULT_PALETTE);
      return;
    }

    const cacheKey = track.coverCacheKey || track.id;
    const cached = paletteCache.get(cacheKey);
    if (cached) {
      setPalette(cached);
      return;
    }

    const fallback = derivePaletteFromAccent(track.accent);
    setPalette(fallback);

    let active = true;
    let objectUrl: string | null = null;

    if (track.coverCacheKey) {
      void getCoverImage(track.coverCacheKey).then(
        (payload) => {
          if (!active) return;
          try {
            const blobBytes = new ArrayBuffer(payload.bytes.byteLength);
            new Uint8Array(blobBytes).set(payload.bytes);
            objectUrl = URL.createObjectURL(new Blob([blobBytes], { type: payload.mimeType }));
            void extractPaletteFromImageUrl(objectUrl, track.accent).then((extracted) => {
              if (!active) return;
              paletteCache.set(cacheKey, extracted);
              setPalette(extracted);
            });
          } catch {
            paletteCache.set(cacheKey, fallback);
          }
        },
        () => {
          if (active) {
            paletteCache.set(cacheKey, fallback);
          }
        }
      ).finally(() => {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
      });
    } else {
      paletteCache.set(cacheKey, fallback);
    }

    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [track?.id, track?.coverCacheKey, track?.accent]);

  const intensityValue = GLOW_INTENSITY_VALUES[intensityLevel];

  return {
    palette,
    intensityValue,
    intensityLevel,
    style: getCoverPaletteStyle(palette, intensityValue),
  };
}
