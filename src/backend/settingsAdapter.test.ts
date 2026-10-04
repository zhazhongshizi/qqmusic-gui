import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SETTINGS_COMMANDS,
  SettingsAdapterError,
  nativeSetLiveSpectrumEnabled,
  nativeSetPreferredQuality,
  nativeSettingsSnapshot,
  parseSettingsSnapshot,
} from "./settingsAdapter";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function setTauriRuntime(enabled: boolean) {
  if (enabled) Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

describe("settings adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriRuntime(true);
  });

  afterEach(() => setTauriRuntime(false));

  it("严格解析三档默认音质且拒绝缺失、额外字段和非法值", () => {
    expect(parseSettingsSnapshot({ preferredQuality: "320k", liveSpectrumEnabled: false })).toEqual({
      preferredQuality: "320k",
      liveSpectrumEnabled: false,
    });
    expect(() => parseSettingsSnapshot({})).toThrow(SettingsAdapterError);
    expect(() => parseSettingsSnapshot({ preferredQuality: "auto", liveSpectrumEnabled: false })).toThrow(SettingsAdapterError);
    expect(() => parseSettingsSnapshot({ preferredQuality: "flac", liveSpectrumEnabled: "yes" })).toThrow(SettingsAdapterError);
    expect(() => parseSettingsSnapshot({ preferredQuality: "flac", liveSpectrumEnabled: false, sentinel: "secret" })).toThrow(SettingsAdapterError);
  });

  it("使用固定命令读写并在调用前拒绝非法质量", async () => {
    invokeMock.mockResolvedValue({ preferredQuality: "128k", liveSpectrumEnabled: true });
    await expect(nativeSettingsSnapshot()).resolves.toEqual({ preferredQuality: "128k", liveSpectrumEnabled: true });
    await expect(nativeSetPreferredQuality("128k")).resolves.toEqual({ preferredQuality: "128k", liveSpectrumEnabled: true });
    await expect(nativeSetLiveSpectrumEnabled(false)).resolves.toEqual({ preferredQuality: "128k", liveSpectrumEnabled: true });
    expect(invokeMock.mock.calls).toEqual([
      [SETTINGS_COMMANDS.snapshot, undefined],
      [SETTINGS_COMMANDS.setPreferredQuality, { preferredQuality: "128k" }],
      [SETTINGS_COMMANDS.setLiveSpectrumEnabled, { enabled: false }],
    ]);
    await expect(nativeSetPreferredQuality("auto" as never)).rejects.toEqual(
      new SettingsAdapterError("QMG-SETTINGS-002"),
    );
  });
});
