import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_COMMANDS } from "../contracts/auth";
import {
  AUTH_ERROR_CODES,
  AuthAdapterError,
  authLogout,
  authQrPoll,
  authQrStart,
  authStatus,
  parseAuthSnapshot,
  parseQrStart,
  parseQrState,
} from "./authAdapter";

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

const VALID_START = {
  sessionId: "session-1",
  loginMethod: "qq",
  mimeType: "image/png",
  imageBase64: "cXItZml4dHVyZQ==",
  expiresAtMs: 1_900_000_000_000,
  pollAfterMs: 1_500,
} as const;

describe("typed authentication adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriRuntime(false);
  });

  afterEach(() => setTauriRuntime(false));

  it("只调用固定扫码命令和精确参数", async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue(VALID_START);

    await expect(authQrStart("qq")).resolves.toEqual(VALID_START);
    expect(invokeMock).toHaveBeenCalledWith(AUTH_COMMANDS.qrStart, { loginMethod: "qq" });
  });

  it("严格解析公开状态并拒绝 credential 或未知字段", () => {
    expect(parseAuthSnapshot({ state: "authenticated" })).toEqual({ state: "authenticated" });
    expect(parseAuthSnapshot({
      state: "authenticated",
      account: { musicId: "123456", loginMethod: "wx" },
    })).toEqual({
      state: "authenticated",
      account: { musicId: "123456", loginMethod: "wx" },
    });
    expect(() => parseAuthSnapshot({ state: "signedOut", account: undefined })).toThrow();
    expect(() => parseQrStart({ ...VALID_START, credential: "SENTINEL" })).toThrow();
    expect(() => parseQrState({
      state: "authenticated",
      sessionId: "session-1",
      account: { musicId: "123456", loginMethod: "qq" },
      credential: "SENTINEL",
    })).toThrow();
  });

  it("解析全部公开轮询状态且不接受错配结构", () => {
    expect(parseQrState({ state: "waitingScan", sessionId: "session-1" })).toEqual({
      state: "waitingScan",
      sessionId: "session-1",
    });
    expect(parseQrState({
      state: "authenticated",
      sessionId: "session-1",
      account: { musicId: "123456", loginMethod: "qq" },
    })).toEqual({
      state: "authenticated",
      sessionId: "session-1",
      account: { musicId: "123456", loginMethod: "qq" },
    });
    expect(() => parseQrState({
      state: "waitingScan",
      sessionId: "session-1",
      account: { musicId: "123456", loginMethod: "qq" },
    })).toThrow();
  });

  it("收敛 IPC 原始错误并在浏览器预览中保持登出", async () => {
    await expect(authStatus()).resolves.toEqual({ state: "signedOut" });
    expect(invokeMock).not.toHaveBeenCalled();

    setTauriRuntime(true);
    invokeMock.mockRejectedValue(new Error("Cookie=SENTINEL; upstream stack"));
    await expect(authQrPoll("session-1")).rejects.toMatchObject({
      code: AUTH_ERROR_CODES.failed,
    } satisfies Partial<AuthAdapterError>);
    try {
      await authQrPoll("session-1");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("SENTINEL");
    }
  });

  it("只保留 Tauri 公共错误类别，不泄露原始错误内容", async () => {
    setTauriRuntime(true);
    invokeMock.mockRejectedValue({ code: "network_unavailable", userMessage: "safe" });
    await expect(authQrPoll("session-1")).rejects.toMatchObject({
      code: AUTH_ERROR_CODES.failed,
      detail: "network_unavailable",
    });

    invokeMock.mockRejectedValue({ code: "Cookie=SECRET" });
    await expect(authQrPoll("session-1")).rejects.toMatchObject({
      code: AUTH_ERROR_CODES.failed,
      detail: undefined,
    });
  });

  it("严格解析注销后的封面缓存清理结果", async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue({ upstreamRevoked: true, coverCacheCleared: true });

    await expect(authLogout()).resolves.toEqual({
      upstreamRevoked: true,
      coverCacheCleared: true,
    });
    expect(invokeMock).toHaveBeenCalledWith("auth_logout", undefined);
    invokeMock.mockResolvedValue({ upstreamRevoked: true });
    await expect(authLogout()).rejects.toMatchObject({ code: AUTH_ERROR_CODES.invalid });
  });
});
