import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_SNAPSHOT_ERROR_CODES,
  loadAppSnapshot,
  parseAppSnapshot,
} from "./appSnapshotAdapter";
import {
  APP_SNAPSHOT_COMMAND,
  type AppSnapshot,
} from "../contracts/appSnapshot";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

const VALID_SNAPSHOT: AppSnapshot = {
  schemaVersion: 1,
  appVersion: "0.1.1",
  target: { os: "windows", architecture: "x86_64" },
  provider: { protocolVersion: 1, state: "notStarted" },
  player: {
    state: "idle",
    generation: 0,
    positionMs: 0,
    durationMs: null,
    volume: 1,
    muted: false,
    currentTrack: null,
    failure: null,
  },
  extensions: {
    playlistRename: false,
    playlistDescriptionEdit: false,
  },
};

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

describe("typed app snapshot adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriRuntime(false);
  });

  afterEach(() => {
    setTauriRuntime(false);
  });

  it("只调用固定 app_snapshot 命令并返回校验后的 Tauri DTO", async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue(VALID_SNAPSHOT);

    const result = await loadAppSnapshot();

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith(APP_SNAPSHOT_COMMAND);
    expect(result).toEqual({ ok: true, source: "tauri", snapshot: VALID_SNAPSHOT });
    if (result.ok) expect(result.snapshot).not.toBe(VALID_SNAPSHOT);
  });

  it("严格拒绝未知字段和不安全结构", async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue({
      ...VALID_SNAPSHOT,
      credentials: "must-never-cross-renderer",
    });

    const result = await loadAppSnapshot();

    expect(result).toEqual({ ok: false, code: APP_SNAPSHOT_ERROR_CODES.invalid });
    expect(() => parseAppSnapshot({ ...VALID_SNAPSHOT, unexpected: true })).toThrow();
  });

  it("把原始 IPC 异常收敛为稳定公开 code", async () => {
    setTauriRuntime(true);
    invokeMock.mockRejectedValue(new Error("cookie=SECRET; upstream stack trace"));

    const result = await loadAppSnapshot();

    expect(result).toEqual({ ok: false, code: APP_SNAPSHOT_ERROR_CODES.unavailable });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("stack trace");
  });

  it("在纯浏览器中返回安全 fixture 且不加载 IPC", async () => {
    const result = await loadAppSnapshot();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("browserFixture");
      expect(result.snapshot.appVersion).toBe("browser-fixture");
      expect(result.snapshot.provider.state).toBe("notStarted");
      expect(result.snapshot.player.currentTrack).toBeNull();
    }
  });
});
