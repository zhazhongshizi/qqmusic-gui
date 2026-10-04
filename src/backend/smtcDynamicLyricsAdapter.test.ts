import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseSmtcDynamicLyricsState,
  setSmtcDynamicLyricsEnabled,
  SMTC_DYNAMIC_LYRICS_COMMAND,
  SmtcDynamicLyricsAdapterError,
} from "./smtcDynamicLyricsAdapter";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function setTauriRuntime(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  } else {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
}

describe("Windows 动态歌词 IPC 适配器", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriRuntime(true);
  });

  afterEach(() => setTauriRuntime(false));

  it("发送固定命令并只接受精确的布尔响应", async () => {
    invokeMock.mockResolvedValue({ enabled: true });

    await expect(setSmtcDynamicLyricsEnabled(true)).resolves.toEqual({ enabled: true });
    expect(invokeMock).toHaveBeenCalledWith(SMTC_DYNAMIC_LYRICS_COMMAND, { enabled: true });

    expect(parseSmtcDynamicLyricsState({ enabled: false })).toEqual({ enabled: false });
    expect(() => parseSmtcDynamicLyricsState({ enabled: true, extra: "sentinel" })).toThrow(
      SmtcDynamicLyricsAdapterError,
    );
    expect(() => parseSmtcDynamicLyricsState({ enabled: "true" })).toThrow(
      SmtcDynamicLyricsAdapterError,
    );
  });

  it("浏览器 fixture 不调用 Tauri 且保持关闭态", async () => {
    setTauriRuntime(false);

    await expect(setSmtcDynamicLyricsEnabled(true)).resolves.toEqual({ enabled: false });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("将底层 IPC 错误收敛为稳定错误码", async () => {
    invokeMock.mockRejectedValue(new Error("lyric text; C:\\private\\path"));

    await expect(setSmtcDynamicLyricsEnabled(true)).rejects.toEqual(
      new SmtcDynamicLyricsAdapterError("QMG-SMTC-DYNAMIC-LYRICS-001"),
    );
  });
});
