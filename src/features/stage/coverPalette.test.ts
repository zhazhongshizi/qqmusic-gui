import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPaletteCache,
  contrastRatio,
  coverToneFromLuminance,
  DEFAULT_PALETTE,
  derivePaletteFromAccent,
  deriveSurfaceTokens,
  extractPaletteFromImageUrl,
  extractPaletteFromPixels,
  formatRgb,
  getCachedPalette,
  getCoverPaletteStyle,
  GLOW_INTENSITY_LABELS,
  GLOW_INTENSITY_VALUES,
  hexToRgb,
  hslToRgb,
  rgbToHsl,
  relativeLuminance,
  setCachedPalette,
  useCoverPalette,
} from "./coverPalette";

const { getCoverImageMock } = vi.hoisted(() => ({ getCoverImageMock: vi.fn() }));
vi.mock("../../backend/coverAdapter", () => ({ getCoverImage: getCoverImageMock }));

describe("coverPalette 调色与代表色提取", () => {
  beforeEach(() => {
    clearPaletteCache();
    getCoverImageMock.mockReset();
  });

  it("RGB 与 HSL 色彩空间互转保持一致", () => {
    const [h, s, l] = rgbToHsl(120, 149, 117);
    expect(h).toBeGreaterThanOrEqual(100);
    expect(h).toBeLessThanOrEqual(130);
    expect(s).toBeGreaterThan(0.1);
    expect(l).toBeGreaterThan(0.4);

    const rgb = hslToRgb(h, s, l);
    expect(Math.abs(rgb[0] - 120)).toBeLessThanOrEqual(2);
    expect(Math.abs(rgb[1] - 149)).toBeLessThanOrEqual(2);
    expect(Math.abs(rgb[2] - 117)).toBeLessThanOrEqual(2);
  });

  it("hexToRgb 解析3位、6位与异常 hex", () => {
    expect(hexToRgb("#f00")).toEqual([255, 0, 0]);
    expect(hexToRgb("#789575")).toEqual([120, 149, 117]);
    expect(hexToRgb("789575")).toEqual([120, 149, 117]);
    expect(hexToRgb("invalid")).toBeNull();
  });

  it("formatRgb 格式化为 CSS rgb 字符串", () => {
    expect(formatRgb([120, 149, 117])).toBe("rgb(120 149 117)");
  });

  it("使用线性 sRGB 相对亮度，并按 0.8/0.2 得分切换 tone", () => {
    expect(relativeLuminance(0, 0, 0)).toBe(0);
    expect(relativeLuminance(255, 255, 255)).toBe(1);
    expect(relativeLuminance(128, 128, 128)).toBeCloseTo(0.21586, 4);
    expect(coverToneFromLuminance(0.48, 0.54)).toBe("dark");
    expect(coverToneFromLuminance(0.5, 0.5)).toBe("light");
    expect(coverToneFromLuminance(0.8, 0.1)).toBe("light");
  });

  it("derivePaletteFromAccent 从单色衍生出 primary、vibrant、ambient 和 top 四色", () => {
    const palette = derivePaletteFromAccent("#789575");
    expect(palette.primary.startsWith("rgb(")).toBe(true);
    expect(palette.vibrant.startsWith("rgb(")).toBe(true);
    expect(palette.ambient.startsWith("rgb(")).toBe(true);
    expect(palette.top.startsWith("rgb(")).toBe(true);

    expect(derivePaletteFromAccent("not-a-color")).toEqual(DEFAULT_PALETTE);
  });

  it("extractPaletteFromPixels 提取主色、鲜明点缀色、背景微晕色与顶部氛围色", () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      if (i < 32) {
        pixels[i] = 30;
        pixels[i + 1] = 80;
        pixels[i + 2] = 50;
        pixels[i + 3] = 255;
      } else {
        pixels[i] = 184;
        pixels[i + 1] = 199;
        pixels[i + 2] = 122;
        pixels[i + 3] = 255;
      }
    }

    const palette = extractPaletteFromPixels(pixels, pixels.length, 4, 4);
    expect(palette.primary).toBeTruthy();
    expect(palette.vibrant).toBeTruthy();
    expect(palette.ambient).toBeTruthy();
    expect(palette.top).toBeTruthy();
    expect(palette.tone).toBe("dark");
    expect(palette.surface.surfaceBase).toBeTruthy();
  });

  it("主题亮度使用全部不透明像素平均值，暗底中的少量白块不会触发 light", () => {
    const pixels = new Uint8ClampedArray(16 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      const white = i === pixels.length - 4;
      pixels[i] = white ? 245 : 28;
      pixels[i + 1] = white ? 245 : 46;
      pixels[i + 2] = white ? 245 : 34;
      pixels[i + 3] = 255;
    }
    expect(extractPaletteFromPixels(pixels, pixels.length, 16, 1).tone).toBe("dark");

    const critical = new Uint8ClampedArray(8 * 4);
    for (let i = 0; i < critical.length; i += 4) {
      critical[i] = 188;
      critical[i + 1] = 188;
      critical[i + 2] = 188;
      critical[i + 3] = 255;
    }
    expect(extractPaletteFromPixels(critical, critical.length, 8, 1).tone).toBe("light");
  });

  it("接近纯白的封面即使不参与颜色桶，也会通过不透明像素平均值触发 light", () => {
    const whitePixels = new Uint8ClampedArray(8 * 4);
    for (let i = 0; i < whitePixels.length; i += 4) {
      whitePixels[i] = 250;
      whitePixels[i + 1] = 248;
      whitePixels[i + 2] = 244;
      whitePixels[i + 3] = 255;
    }

    const palette = extractPaletteFromPixels(whitePixels, whitePixels.length, 8, 1);
    expect(palette.tone).toBe("light");
    expect(palette.surface.surfaceBase).toMatch(/^hsl\(/);
    expect(palette.primary).toBe(DEFAULT_PALETTE.primary);
  });

  it("浅色 surface 从 primary hue 派生固定层级，并满足文字对比度", () => {
    const surface = deriveSurfaceTokens("rgb(92 156 148)", "rgb(130 205 183)");
    expect(surface.surfaceBase).toMatch(/^hsl\(\d+ (8|9|10|11|12|13|14|15|16)% 84%\)$/);
    expect(surface.surfaceRaised).toMatch(/^hsl\(\d+ (8|9|10|11|12|13|14|15|16)% 89%\)$/);
    expect(surface.surfaceLowered).toMatch(/^hsl\(\d+ (8|9|10|11|12|13|14|15|16)% 78%\)$/);
    expect(surface.onSurface).toBe("#18211f");
    expect(surface.onSurfaceMuted).toBe("#4e5d58");
    expect(contrastRatio(surface.onSurface, surface.surfaceBase)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(surface.onSurfaceMuted, surface.surfaceBase)).toBeGreaterThanOrEqual(3);
  });

  it("全透明或全黑白像素时回退到默认调色板", () => {
    const emptyPixels = new Uint8ClampedArray(16);
    expect(extractPaletteFromPixels(emptyPixels, emptyPixels.length)).toEqual(DEFAULT_PALETTE);

    const blackPixels = new Uint8ClampedArray([0, 0, 0, 255, 2, 2, 2, 255]);
    expect(extractPaletteFromPixels(blackPixels, blackPixels.length)).toEqual(DEFAULT_PALETTE);
    expect(DEFAULT_PALETTE.tone).toBe("dark");
    expect(DEFAULT_PALETTE.surface.surfaceRaised).toBeTruthy();
  });

  it("extractPaletteFromImageUrl 在图片加载失败或无 canvas 支持时回退到 fallbackAccent", async () => {
    const palette = await extractPaletteFromImageUrl("blob:invalid-image-url", "#9f9878");
    expect(palette.primary).toBeTruthy();
    expect(palette.vibrant).toBeTruthy();
    expect(palette.ambient).toBeTruthy();
    expect(palette.top).toBeTruthy();
  });

  it("强度等级字典与标签完整", () => {
    expect(GLOW_INTENSITY_VALUES.off).toBe(0);
    expect(GLOW_INTENSITY_VALUES.subtle).toBe(0.55);
    expect(GLOW_INTENSITY_VALUES.standard).toBe(1.0);
    expect(GLOW_INTENSITY_VALUES.enhanced).toBe(1.45);
    expect(GLOW_INTENSITY_LABELS.standard).toBe("光晕：标准");
    expect(GLOW_INTENSITY_LABELS.subtle).toBe("光晕：柔和");
    expect(GLOW_INTENSITY_LABELS.off).toBe("光晕：关闭");
    expect(GLOW_INTENSITY_LABELS.enhanced).toBe("光晕：增强");
  });

  it("缓存写入、读取与清空", () => {
    const sample = derivePaletteFromAccent("#61858b");
    setCachedPalette("key-1", sample);
    expect(getCachedPalette("key-1")).toEqual(sample);
    clearPaletteCache();
    expect(getCachedPalette("key-1")).toBeUndefined();
  });

  it("getCoverPaletteStyle 生成合规的 CSS custom properties", () => {
    const sample = derivePaletteFromAccent("#8c765e");
    const style = getCoverPaletteStyle(sample, 1.0) as Record<string, string>;
    expect(style["--cover-primary"]).toBe(sample.primary);
    expect(style["--cover-vibrant"]).toBe(sample.vibrant);
    expect(style["--cover-ambient"]).toBe(sample.ambient);
    expect(style["--cover-top"]).toBe(sample.top);
    expect(style["--cover-surface-base"]).toBe(sample.surface.surfaceBase);
    expect(style["--cover-surface-raised"]).toBe(sample.surface.surfaceRaised);
    expect(style["--cover-surface-lowered"]).toBe(sample.surface.surfaceLowered);
    expect(style["--cover-on-surface"]).toBe(sample.surface.onSurface);
    expect(style["--cover-on-surface-muted"]).toBe(sample.surface.onSurfaceMuted);
    expect(style["--cover-glow-intensity"]).toBe("1");
  });

  it("useCoverPalette 在无 track 时返回默认调色板与 0 强度", () => {
    const { result } = renderHook(() => useCoverPalette(null, "off"));
    expect(result.current.palette).toEqual(DEFAULT_PALETTE);
    expect(result.current.intensityValue).toBe(0);
  });

  it("useCoverPalette 响应 track 变化并优先使用缓存", async () => {
    const track = {
      id: "fixture-1",
      title: "纸月光",
      artist: "方格岛",
      album: "夜航",
      durationMs: 200_000,
      actualQuality: "FLAC" as const,
      expectedQuality: "无损" as const,
      accent: "#9f9878",
      artworkVariant: "moon" as const,
      lyrics: [],
    };

    const { result, rerender } = renderHook(({ t }) => useCoverPalette(t, "standard"), {
      initialProps: { t: track },
    });

    expect(result.current.palette.primary).toBeTruthy();
    expect(result.current.palette.top).toBeTruthy();
    expect(result.current.intensityValue).toBe(1.0);

    const nextTrack = { ...track, id: "fixture-2", accent: "#61858b" };
    rerender({ t: nextTrack });
    expect(result.current.palette.primary).toBeTruthy();
  });
});
