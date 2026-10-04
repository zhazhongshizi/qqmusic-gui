import {
  normalizeQuality,
  qualityPresets,
  type RenderQuality,
} from "./vendor/render-quality";

export const RHINE_SETTINGS_STORAGE_KEY = "qqmusic_rhine_render_settings";
export type ArchiveRenderer = "webgl" | "canvas2d";
export type RhineFrameLimit = 30 | 60 | 0;

export type RhineSettings = {
  renderer: ArchiveRenderer;
  frameLimit: RhineFrameLimit;
  spatialUpscaling: boolean;
  quality: RenderQuality;
  superPerformance: boolean;
  disableCassetteMotionWhilePlaying: boolean;
  reduceCassetteMotionWhilePlaying: boolean;
};

export function defaultRhineSettings(): RhineSettings {
  return {
    renderer: "webgl",
    frameLimit: 60,
    spatialUpscaling: false,
    quality: { ...qualityPresets.performance },
    superPerformance: false,
    disableCassetteMotionWhilePlaying: false,
    reduceCassetteMotionWhilePlaying: false,
  };
}

const qualityFields = [
  "scale",
  "pixelRatio",
  "antialias",
  "shadows",
  "aoSamples",
  "aoResolution",
  "depthOfField",
  "transmission",
  "anisotropy",
] as const satisfies readonly (keyof RenderQuality)[];

export function parseRhineSettings(value: unknown): RhineSettings {
  if (!value || typeof value !== "object") return defaultRhineSettings();
  const settings = value as Record<string, unknown>;
  if (settings.version !== 1 || typeof settings.superPerformance !== "boolean")
    return defaultRhineSettings();
  if (!settings.quality || typeof settings.quality !== "object")
    return defaultRhineSettings();

  const source = settings.quality as Record<string, unknown>;
  const quality = normalizeQuality(source, false);
  const completeAndValid = qualityFields.every(
    field => Object.hasOwn(source, field) && source[field] === quality[field],
  );
  if (!completeAndValid) return defaultRhineSettings();
  return {
    renderer: settings.renderer === "canvas2d" ? "canvas2d" : "webgl",
    frameLimit: settings.frameLimit === 30 || settings.frameLimit === 0 ? settings.frameLimit : 60,
    spatialUpscaling: settings.spatialUpscaling === true,
    quality,
    superPerformance: settings.superPerformance,
    // Version 1 settings written before this field was introduced keep their
    // existing quality and super-performance values with legacy motion enabled.
    disableCassetteMotionWhilePlaying: settings.disableCassetteMotionWhilePlaying === true,
    reduceCassetteMotionWhilePlaying: settings.disableCassetteMotionWhilePlaying !== true && settings.reduceCassetteMotionWhilePlaying === true,
  };
}

export function readRhineSettings(): RhineSettings {
  try {
    const stored = window.localStorage.getItem(RHINE_SETTINGS_STORAGE_KEY);
    return stored ? parseRhineSettings(JSON.parse(stored) as unknown) : defaultRhineSettings();
  } catch {
    return defaultRhineSettings();
  }
}

export function writeRhineSettings(settings: RhineSettings): void {
  try {
    window.localStorage.setItem(
      RHINE_SETTINGS_STORAGE_KEY,
      JSON.stringify({ version: 1, ...settings }),
    );
  } catch {
    // Settings remain usable for this session when browser storage is unavailable.
  }
}
