import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  QUEUE_COMMANDS,
  QueueAdapterError,
  nativePlaybackChangeQuality,
  nativeQueueMove,
  nativeQueuePreviewNext,
  nativePlaybackSessionSnapshot,
  nativeQueuePlay,
  nativeQueueReplace,
  nativeSetPlaybackMode,
  parsePlaybackSessionSnapshot,
  parseQueueSnapshot,
} from "./nativeQueueAdapter";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const TRACK = {
  id: "0039MnYb0qxYhV",
  mediaMid: "C4000039MnYb0qxYhV",
  title: "晴天",
  artist: "周杰伦",
  album: "叶惠美",
  durationMs: 269_000,
} as const;
const SNAPSHOT = { generation: 3, selectedIndex: 0, items: [TRACK] } as const;
const PLAYER = {
  state: "playing",
  generation: 2,
  positionMs: 0,
  durationMs: null,
  volume: 1,
  muted: false,
  currentTrack: { id: TRACK.id, title: TRACK.title, artist: TRACK.artist },
  failure: null,
} as const;

function setTauriRuntime(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  } else {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
}

describe("native queue adapter", () => {
  it("reuses only the queue supplied with the incremental request and validates changed queues", async () => {
    const session = { mode: "sequence", queue: null, player: PLAYER, requestedQuality: "320k" };
    invokeMock.mockResolvedValueOnce(session);
    const update = await nativePlaybackSessionSnapshot(SNAPSHOT);
    expect(update.queue).toBe(SNAPSHOT);
    expect(invokeMock).toHaveBeenCalledWith(QUEUE_COMMANDS.sessionSnapshot, { knownQueueGeneration: 3 });
    expect(() => parsePlaybackSessionSnapshot(session)).toThrow(QueueAdapterError);
    const changed = { ...SNAPSHOT, generation: 4, items: [] as unknown[], selectedIndex: null };
    invokeMock.mockResolvedValueOnce({ ...session, queue: changed });
    expect((await nativePlaybackSessionSnapshot(SNAPSHOT)).queue).toEqual(changed);
    expect(() => parsePlaybackSessionSnapshot({ ...session, queue: { ...changed, items: [TRACK, TRACK] } }, SNAPSHOT)).toThrow();
  });
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriRuntime(true);
  });

  afterEach(() => setTauriRuntime(false));

  it("validates the read-only next preview as a stable ID or null", async () => {
    invokeMock.mockResolvedValueOnce(TRACK.id).mockResolvedValueOnce(null).mockResolvedValueOnce("https://invalid");
    expect(await nativeQueuePreviewNext()).toBe(TRACK.id);
    expect(invokeMock).toHaveBeenCalledWith("queue_preview_next", undefined);
    expect(await nativeQueuePreviewNext()).toBeNull();
    await expect(nativeQueuePreviewNext()).rejects.toBeInstanceOf(QueueAdapterError);
  });

  it("只接受有界、无重复且不含远程 URL 的队列快照", () => {
    expect(parseQueueSnapshot(SNAPSHOT)).toEqual(SNAPSHOT);
    expect(() => parseQueueSnapshot({ ...SNAPSHOT, items: [TRACK, TRACK] })).toThrow();
    expect(() => parseQueueSnapshot({ ...SNAPSHOT, selectedIndex: 1 })).toThrow();
    expect(() => parseQueueSnapshot({ ...SNAPSHOT, selectedIndex: null })).toThrow();
    expect(() => parseQueueSnapshot({ ...SNAPSHOT, url: "https://SENTINEL" })).toThrow();
    expect(() => parseQueueSnapshot({ ...SNAPSHOT, items: [{ ...TRACK, cookie: "SENTINEL" }] }))
      .toThrow(QueueAdapterError);
  });

  it("替换和重排使用固定命令与规范化 payload", async () => {
    invokeMock.mockResolvedValue(SNAPSHOT);
    await nativeQueueReplace([TRACK]);
    await nativeQueueMove(0, 0);
    expect(invokeMock.mock.calls).toEqual([
      [QUEUE_COMMANDS.replace, { items: [TRACK] }],
      [QUEUE_COMMANDS.move, { fromIndex: 0, toIndex: 0 }],
    ]);
  });

  it("播放结果严格复用原生播放器契约且不暴露媒体地址", async () => {
    invokeMock.mockResolvedValue({
      requestedQuality: "320k",
      queue: SNAPSHOT,
      playback: { quality: "320k", expiresInSeconds: 7_200, player: PLAYER },
    });
    const result = await nativeQueuePlay(0);
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected queue play result");
    expect(result.playback.quality).toBe("320k");
    expect(JSON.stringify(result)).not.toContain("url");
    expect(invokeMock).toHaveBeenCalledWith(QUEUE_COMMANDS.play, {
      index: 0,
      preferredQuality: "auto",
    });
  });

  it("当前音质切换接受确认结果，也把被更新请求淘汰为 null", async () => {
    const result = {
      requestedQuality: "flac",
      queue: SNAPSHOT,
      playback: { quality: "320k", expiresInSeconds: 7_200, player: PLAYER },
    } as const;
    invokeMock.mockResolvedValueOnce(result).mockResolvedValueOnce(null);

    await expect(nativePlaybackChangeQuality("flac")).resolves.toEqual(result);
    await expect(nativePlaybackChangeQuality("128k")).resolves.toBeNull();
    expect(invokeMock.mock.calls).toEqual([
      [QUEUE_COMMANDS.changeQuality, { preferredQuality: "flac" }],
      [QUEUE_COMMANDS.changeQuality, { preferredQuality: "128k" }],
    ]);
  });

  it("会话快照原子绑定模式、队列与播放器且模式命令为固定枚举", async () => {
    const session = { mode: "repeat-all", queue: SNAPSHOT, player: PLAYER, requestedQuality: "320k" } as const;
    expect(parsePlaybackSessionSnapshot(session)).toEqual(session);
    expect(parsePlaybackSessionSnapshot({ ...session, actualQuality: "qq-mv", lyricOffsetMs: -500 })).toMatchObject({ actualQuality: "qq-mv", lyricOffsetMs: -500 });
    expect(() => parsePlaybackSessionSnapshot({ ...session, actualQuality: ["flac"] })).toThrow();
    expect(() => parsePlaybackSessionSnapshot({ ...session, lyricOffsetMs: 60001 })).toThrow();
    expect(() => parsePlaybackSessionSnapshot({ ...session, mode: "sentinel" })).toThrow();
    expect(() => parsePlaybackSessionSnapshot({ ...session, credential: "SENTINEL" })).toThrow();
    invokeMock.mockResolvedValue(session);
    await expect(nativePlaybackSessionSnapshot()).resolves.toEqual(session);
    await expect(nativeSetPlaybackMode("repeat-all")).resolves.toEqual(session);
    expect(invokeMock.mock.calls).toEqual([
      [QUEUE_COMMANDS.sessionSnapshot, undefined],
      [QUEUE_COMMANDS.setMode, { mode: "repeat-all" }],
    ]);
  });

  it("发送前拒绝非法字段，IPC 原因仅映射为稳定编号", async () => {
    await expect(nativeQueueReplace([{ ...TRACK, id: "bad/id" }])).rejects.toEqual(
      new QueueAdapterError("QMG-QUEUE-002"),
    );
    invokeMock.mockRejectedValue(new Error("Cookie=SENTINEL; sqlite path"));
    await expect(nativeQueueMove(0, 0)).rejects.toEqual(new QueueAdapterError("QMG-QUEUE-001"));
  });
});
