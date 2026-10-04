import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LYRICS_COMMAND,
  LyricsAdapterError,
  getTimedLyrics,
  parseLyricTimeline,
} from "./lyricsAdapter";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const TIMELINE = {
  generation: 8,
  trackId: "0039MnYb0qxYhV",
  lines: [
    { atMs: 1_000, original: "第一句", translation: "First line" },
    { atMs: 2_500, original: "第二句", romanization: "di er ju" },
  ],
} as const;

function setTauriRuntime(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  } else {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
}

describe("timed lyrics adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriRuntime(true);
  });
  afterEach(() => setTauriRuntime(false));

  it("只接收严格递增的有界时间轴且不接受原始 LRC/URL", () => {
    expect(parseLyricTimeline(TIMELINE)).toEqual(TIMELINE);
    expect(() => parseLyricTimeline({ ...TIMELINE, lyric: "[00:01]SENTINEL" })).toThrow();
    expect(() => parseLyricTimeline({ ...TIMELINE, lines: [{ ...TIMELINE.lines[0], url: "x" }] }))
      .toThrow();
    expect(() => parseLyricTimeline({
      ...TIMELINE,
      lines: [TIMELINE.lines[1], TIMELINE.lines[0]],
    })).toThrow(LyricsAdapterError);
  });

  it("使用固定命令并回传 generation 防止旧歌词写回", async () => {
    invokeMock.mockResolvedValue(TIMELINE);
    await expect(getTimedLyrics(TIMELINE.trackId, 8)).resolves.toEqual(TIMELINE);
    expect(invokeMock).toHaveBeenCalledWith(LYRICS_COMMAND, {
      trackId: TIMELINE.trackId,
      generation: 8,
    });
  });

  it("发送前拒绝非法 ID，原始 IPC 错误只映射稳定编号", async () => {
    await expect(getTimedLyrics("bad/id", 1)).rejects.toEqual(
      new LyricsAdapterError("QMG-LYRICS-002"),
    );
    invokeMock.mockRejectedValue(new Error("lyric=[00:01]SENTINEL; path"));
    await expect(getTimedLyrics(TIMELINE.trackId, 8)).rejects.toEqual(
      new LyricsAdapterError("QMG-LYRICS-001"),
    );
  });
});
