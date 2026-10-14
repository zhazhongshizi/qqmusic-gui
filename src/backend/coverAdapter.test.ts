import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginPlaybackSession } from "./playbackTransport";

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
    beginPlaybackSession();
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
  it("合并并发读取，复用已解码字节，区分头像且失败可重新读取", async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue({ mimeType: "image/png", bytes: [1, 2, 3] });
    const images = await Promise.all(Array.from({ length: 20 }, () => getCoverImage("shared")));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(images.every(image => image === images[0])).toBe(true);
    expect(await getCoverImage("shared")).toBe(images[0]);
    await getArtistImage("shared");
    expect(invokeMock).toHaveBeenCalledTimes(2);
    invokeMock.mockRejectedValueOnce(new Error("temporary"));
    await expect(getCoverImage("retry")).rejects.toBeInstanceOf(CoverAdapterError);
    await expect(getCoverImage("retry")).resolves.toMatchObject({ bytes: new Uint8Array([1, 2, 3]) });
  });
  it("会话切换不会把迟到封面装入新会话缓存", async () => {
    setTauriRuntime(true);
    let finish!: (value: unknown) => void;
    invokeMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = getCoverImage("shared");
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    beginPlaybackSession();
    invokeMock.mockResolvedValue({ mimeType: "image/png", bytes: [2] });
    const current = await getCoverImage("shared");
    finish({ mimeType: "image/png", bytes: [1] }); await old;
    expect(await getCoverImage("shared")).toBe(current);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
  it("二进制快速路径保留受限视图且仍拒绝空字节、超限与未知字段", () => {
    const bytes = new Uint8Array([1, 2, 3]).subarray(1);
    expect(parseCoverPayload({ mimeType: "image/png", bytes }).bytes).toBe(bytes);
    expect(parseCoverPayload({ mimeType: "image/png", bytes: bytes.buffer }).bytes.byteLength).toBe(3);
    for (const bytes of [new Uint8Array(), new ArrayBuffer(2 * 1024 * 1024 + 1)]) {
      expect(() => parseCoverPayload({ mimeType: "image/png", bytes })).toThrow(CoverAdapterError);
    }
    expect(() => parseCoverPayload({ mimeType: "image/png", bytes, cookie: "private" })).toThrow(CoverAdapterError);
  });
  it("LRU 保留最近访问封面并淘汰最早未使用封面", async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue({ mimeType: "image/png", bytes: [1] });
    for (let i = 0; i < 128; i++) await getCoverImage(`cover-${i}`);
    await getCoverImage("cover-0");
    await getCoverImage("cover-128");
    await getCoverImage("cover-0");
    expect(invokeMock).toHaveBeenCalledTimes(129);
    await getCoverImage("cover-1");
    expect(invokeMock).toHaveBeenCalledTimes(130);
  });
});
