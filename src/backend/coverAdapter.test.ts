import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COVER_COMMAND,
  CoverAdapterError,
  getArtistImage,
  getCoverImage,
  parseCoverPayload,
} from "./coverAdapter";

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

describe("封面 IPC 适配器", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriRuntime(false);
  });

  afterEach(() => setTauriRuntime(false));

  it("在桌面端只调用 cover_get 并解码受限的图片字节", async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue({ mimeType: "image/jpeg", bytes: [255, 216, 255, 217] });

    await expect(getCoverImage("album-mid-1")).resolves.toMatchObject({
      mimeType: "image/jpeg",
      bytes: new Uint8Array([255, 216, 255, 217]),
    });
    expect(invokeMock).toHaveBeenCalledWith(COVER_COMMAND, { cacheKey: "album-mid-1" });
  });

  it("浏览器预览不访问 Tauri，且拒绝未知 MIME、越界字节和路径键", async () => {
    await expect(getCoverImage("album/mid")).rejects.toMatchObject({ code: "QMG-COVER-002" });
    await expect(getCoverImage("album-mid-1")).rejects.toMatchObject({ code: "QMG-COVER-001" });
    expect(invokeMock).not.toHaveBeenCalled();

    expect(() => parseCoverPayload({ mimeType: "image/gif", bytes: [1] })).toThrow(CoverAdapterError);
    expect(() => parseCoverPayload({ mimeType: "image/png", bytes: [256] })).toThrow(CoverAdapterError);
    expect(() => parseCoverPayload({ mimeType: "image/png", bytes: [] })).toThrow(CoverAdapterError);
  });

  it("歌手头像使用独立的受控 kind，不改变专辑封面 payload", async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue({ mimeType: "image/png", bytes: [137, 80, 78, 71] });

    await expect(getArtistImage("artist-mid-1")).resolves.toMatchObject({
      mimeType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71]),
    });
    expect(invokeMock).toHaveBeenCalledWith(COVER_COMMAND, {
      cacheKey: "artist-mid-1",
      kind: "artist",
    });
  });

  it("拒绝无效歌手头像缓存键且不触发 IPC", async () => {
    setTauriRuntime(true);
    await expect(getArtistImage("artist/mid")).rejects.toMatchObject({ code: "QMG-COVER-002" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("收敛底层 IPC 错误，不把原始错误文本交给渲染层", async () => {
    setTauriRuntime(true);
    invokeMock.mockRejectedValue(new Error("Cookie=SENTINEL; filesystem path"));

    await expect(getCoverImage("album-mid-1")).rejects.toMatchObject({ code: "QMG-COVER-001" });
    try {
      await getCoverImage("album-mid-1");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("SENTINEL");
    }
  });
});
