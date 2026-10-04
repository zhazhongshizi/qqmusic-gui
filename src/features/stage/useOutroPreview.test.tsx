import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FIXTURE_TRACKS } from "../player/fixtures";
import type { PlayerSnapshot } from "../player/playerStore";
import { isOutroPosition, useOutroPreview } from "./useOutroPreview";

const mock = vi.hoisted(() => ({ snapshot: {} as PlayerSnapshot, preview: vi.fn() }));
vi.mock("../player/playerStore", () => ({
  getCurrentTrack: (s: PlayerSnapshot) => s.queue[s.currentIndex] ?? null,
  usePlayerSelector: (selector: (s: PlayerSnapshot) => unknown) => selector(mock.snapshot),
}));
vi.mock("../../backend/nativeQueueAdapter", () => ({ nativeQueuePreviewNext: mock.preview }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const baseSnapshot: PlayerSnapshot = {
  nativeMode: true, nativeLoaded: true, lyricsReady: true, generation: 1,
  queue: FIXTURE_TRACKS, currentIndex: 0, isPlaying: true, positionMs: 0,
  volume: .5, muted: false, mode: "sequence", defaultQuality: "320k",
  requestedQuality: "320k", likedIds: [], playbackError: null,
};

it.each([
  { positionMs: 244999, durationMs: 248000, expected: false },
  { positionMs: 245000, durationMs: 248000, expected: true },
  { positionMs: 247999, durationMs: 248000, expected: true },
  { positionMs: 248000, durationMs: 248000, expected: false },
  { positionMs: 0, durationMs: 0, expected: false },
  { positionMs: 0, durationMs: 2000, expected: true },
])("无歌词使用实际时长的最后三秒窗口 %#", ({ positionMs, durationMs, expected }) => {
  const snapshot = { ...baseSnapshot, queue: [{ ...FIXTURE_TRACKS[0]!, lyrics: [], durationMs }], positionMs };
  expect(isOutroPosition(snapshot)).toBe(expected);
});

it("空白歌词视为无歌词，加载中与播放失败不提前触发", () => {
  const snapshot = { ...baseSnapshot, queue: [{ ...FIXTURE_TRACKS[0]!, lyrics: [{ atMs: 0, original: "  " }] }],
    positionMs: 245000, lyricsReady: false };
  expect(isOutroPosition(snapshot)).toBe(false);
  expect(isOutroPosition({ ...snapshot, lyricsReady: true })).toBe(true);
  expect(isOutroPosition({ ...snapshot, lyricsReady: true, playbackError: { reason: "network", message: "播放失败" } })).toBe(false);
});

it("keeps an open preview stable across native metadata refreshes but invalidates reordered queues", async () => {
  mock.snapshot = {
    nativeMode: true, generation: 8, queue: FIXTURE_TRACKS,
    currentIndex: 0, isPlaying: true, positionMs: 220_000, mode: "sequence", playbackError: null,
  } as PlayerSnapshot;
  mock.preview.mockResolvedValue(FIXTURE_TRACKS[1]!.id);
  const { result, rerender } = renderHook(() => useOutroPreview());
  await act(async () => {});
  expect(result.current.active).toBe(true);
  for (let i = 0; i < 4; i += 1) {
    mock.snapshot = { ...mock.snapshot, queue: mock.snapshot.queue.map(t => ({ ...t, durationMs: t.durationMs + 1 })) };
    rerender();
    expect(result.current.active).toBe(true);
    expect(result.current.nextId).toBe(FIXTURE_TRACKS[1]!.id);
  }
  expect(mock.preview).toHaveBeenCalledTimes(1);
  mock.preview.mockResolvedValue(FIXTURE_TRACKS[2]!.id);
  mock.snapshot = { ...mock.snapshot, queue: [FIXTURE_TRACKS[0]!, FIXTURE_TRACKS[2]!, FIXTURE_TRACKS[1]!] };
  rerender();
  await act(async () => {});
  expect(result.current.nextId).toBe(FIXTURE_TRACKS[2]!.id);
  expect(mock.preview).toHaveBeenCalledTimes(2);
});
