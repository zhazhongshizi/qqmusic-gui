import { afterEach, expect, it, vi } from "vitest";
import { resizeQuality } from "./vendor/quality-renderer";
import { Fsr1Pass } from "./vendor/fsr1-pass";
import { defaultRhineSettings, parseRhineSettings, readRhineSettings, writeRhineSettings } from "./rhineSettings";

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
it("old settings stay off; opted-in settings persist independently of renderer and quality", () => {
  const old = { version: 1, ...defaultRhineSettings(), spatialUpscaling: undefined };
  expect(parseRhineSettings(old).spatialUpscaling).toBe(false);
  writeRhineSettings({ ...defaultRhineSettings(), spatialUpscaling: true, renderer: "canvas2d" });
  expect(readRhineSettings()).toEqual({ ...defaultRhineSettings(), spatialUpscaling: true, renderer: "canvas2d" });
  expect(parseRhineSettings({ ...old, spatialUpscaling: "true" }).spatialUpscaling).toBe(false);
});
it("separates the scene and presentation dimensions and restores the existing pipeline", () => {
  vi.stubGlobal("devicePixelRatio", 1);
  const host = document.createElement("div");
  Object.defineProperties(host, { clientWidth: { value: 1280 }, clientHeight: { value: 720 } });
  host.getBoundingClientRect = () => ({ width: 1280 }) as DOMRect;
  const renderer = { capabilities: { maxTextureSize: 8192, getMaxAnisotropy: () => 16 }, setPixelRatio: vi.fn(), setSize: vi.fn() };
  const composer = { setPixelRatio: vi.fn(), setSize: vi.fn() };
  const fsr = new Fsr1Pass();
  const resize = (enabled: boolean, superMode = false) => resizeQuality(renderer as never, composer as never, host, defaultRhineSettings().quality, superMode, fsr, enabled);
  expect(resize(true)).toMatchObject({ width: 853, height: 480 });
  expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1);
  expect(composer.setPixelRatio).toHaveBeenLastCalledWith(2 / 3);
  expect(JSON.parse(host.dataset.renderQuality!)).toMatchObject({ upscaling: "fsr1", outputWidth: 1280, outputHeight: 720 });
  expect(fsr.enabled).toBe(true);
  expect(resize(false)).toMatchObject({ width: 1024, height: 576 });
  expect(fsr.enabled).toBe(false);
  expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(0.8);
  resize(true, true);
  expect(fsr.enabled).toBe(false);
  fsr.dispose();
});
