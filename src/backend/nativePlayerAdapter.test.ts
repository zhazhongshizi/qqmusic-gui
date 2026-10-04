import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLAYER_COMMANDS,
  PlayerAdapterError,
  nativePause,
  nativeSeek,
  nativeSetMuted,
  nativeSetVolume,
  parsePlaybackLoadResult,
  parsePlayerSnapshot,
  playerErrorFromInvoke,
} from "./nativePlayerAdapter";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const PLAYER = {
  state: "playing",
  generation: 1,
  positionMs: 0,
  durationMs: null,
  volume: 1,
  muted: false,
  currentTrack: { id: "trackMid", title: "晴天", artist: "周杰伦" },
  failure: null,
} as const;

function setTauriRuntime(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  } else {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
}

describe("native player adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriRuntime(true);
  });

  afterEach(() => setTauriRuntime(false));

  it("解析播放快照但拒绝任何 URL 或凭据字段", () => {
    const result = parsePlayerSnapshot(PLAYER);
    expect(JSON.stringify(result)).not.toContain("url");
    expect(() => parsePlayerSnapshot({ ...PLAYER, url: "https://SENTINEL" })).toThrow();
    expect(() => parsePlayerSnapshot({ ...PLAYER, credential: "SENTINEL" })).toThrow();
  });

  it("所有控制命令都使用固定名称和规范化 payload", async () => {
    invokeMock.mockResolvedValue(PLAYER);
    await nativePause();
    await nativeSeek(1_234);
    await nativeSetVolume(0.4);
    await nativeSetMuted(true);
    expect(invokeMock.mock.calls).toEqual([
      [PLAYER_COMMANDS.pause, undefined],
      [PLAYER_COMMANDS.seek, { positionMs: 1_234 }],
      [PLAYER_COMMANDS.setVolume, { volume: 0.4 }],
      [PLAYER_COMMANDS.setMuted, { muted: true }],
    ]);
  });

  it("严格拒绝非有限数、未知状态和错配结构", () => {
    for (const value of [
      { ...PLAYER, volume: Number.NaN },
      { ...PLAYER, state: "buffering" },
      { ...PLAYER, currentTrack: { ...PLAYER.currentTrack, url: "SENTINEL" } },
      { ...PLAYER, failure: { code: "network", recoverable: true, generation: 0 } },
      { ...PLAYER, failure: { code: "network", recoverable: true, generation: 1, url: "SENTINEL" } },
      { ...PLAYER, positionMs: -1 },
    ]) {
      expect(() => parsePlayerSnapshot(value)).toThrow(PlayerAdapterError);
    }
  });

  it("接受本地播放结果但仍严格拒绝未知音质", () => {
    expect(parsePlaybackLoadResult({ quality: "local", expiresInSeconds: 0, player: PLAYER }).quality)
      .toBe("local");
    expect(() => parsePlaybackLoadResult({ quality: "ogg", expiresInSeconds: 0, player: PLAYER }))
      .toThrow(PlayerAdapterError);
  });

  it("保留 MV 音源标识但拒绝未定义来源和敏感字段", () => {
    const player = { ...PLAYER, currentTrack: { ...PLAYER.currentTrack, source: "qq-mv" } };
    expect(parsePlaybackLoadResult({ quality: "qq-mv", expiresInSeconds: 86400, player })
      .player.currentTrack?.source).toBe("qq-mv");
    expect(() => parsePlayerSnapshot({ ...player, currentTrack: { ...player.currentTrack, url: "SENTINEL" } })).toThrow();
    expect(() => parsePlayerSnapshot({ ...player, currentTrack: { ...player.currentTrack, source: "bilibili" } })).toThrow();
  });

  it("把本地文件缺失和 OGG 解码缺失映射为稳定播放原因", () => {
    const base = {
      retryable: false,
      operation: "playback",
      correlationId: "123e4567-e89b-12d3-a456-426614174000",
      userMessage: "本地播放失败。",
    } as const;
    expect(playerErrorFromInvoke({ ...base, code: "local_music_file_missing" }).reason)
      .toBe("unavailable");
    expect(playerErrorFromInvoke({ ...base, code: "local_music_codec_unavailable" }).reason)
      .toBe("unsupported");
  });

  it("IPC 原始错误只暴露稳定编号", async () => {
    invokeMock.mockRejectedValue(new Error("vkey=SENTINEL; native stack"));
    await expect(nativePause()).rejects.toEqual(new PlayerAdapterError("QMG-PLAYER-001"));
  });

  it("严格映射 Rust 公开播放错误但不保留原始消息", async () => {
    invokeMock.mockRejectedValue({
      code: "playback_unsafe_media_url",
      retryable: false,
      operation: "playback",
      correlationId: "123e4567-e89b-12d3-a456-426614174000",
      userMessage: "媒体地址未通过本地安全检查。",
    });
    await expect(nativePause()).rejects.toMatchObject({
      code: "QMG-PLAYER-001",
      reason: "unsafe-media",
    });
    await expect(nativePause()).rejects.not.toHaveProperty("userMessage");
  });
});
