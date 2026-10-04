import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { beginPlaybackSession } from "../../backend/playbackTransport";
import { getCurrentTrack, playerActions, resetPlayerFixture, usePlayerSnapshot } from "./playerStore";
import type { PlaybackSessionSnapshot } from "../../contracts/queue";

const mocks = vi.hoisted(() => ({ play: vi.fn(), quality: vi.fn(), offset: vi.fn() }));
vi.mock("../../backend/nativeQueueAdapter", () => ({ nativeQueuePlay: mocks.play, nativePlaybackChangeQuality: mocks.quality, nativeSetMvLyricOffset: mocks.offset }));
const session = (id: string, generation = 1): PlaybackSessionSnapshot => ({
  mode: "sequence", requestedQuality: "flac", actualQuality: "flac",
  queue: { generation, selectedIndex: 0, items: [{ id, title: id, artist: "Artist", album: "Album", durationMs: 10000 }] },
  player: { state: "playing", generation, positionMs: 1000, durationMs: 10000, volume: .5, muted: false,
    currentTrack: { id, title: id, artist: "Artist" }, failure: null },
});
afterEach(() => { cleanup(); resetPlayerFixture(); vi.resetAllMocks(); });

it("a lyric offset reply cannot restore a track that was already skipped", async () => {
  let resolve!: (value: PlaybackSessionSnapshot) => void;
  mocks.offset.mockImplementation(() => new Promise(done => { resolve = done; }));
  const mv = { ...session("mv"), actualQuality: "qq-mv" as const };
  playerActions.applyAuthoritativeSession(mv);
  const pending = playerActions.setMvLyricOffset(500);
  playerActions.applyAuthoritativeSession(session("next", 2));
  resolve({ ...mv, lyricOffsetMs: 500 });
  await pending;
  expect(getCurrentTrack()?.id).toBe("next");
});

it("automatic next and a fresh remote snapshot expose the confirmed quality", () => {
  playerActions.applyAuthoritativeSession(session("one"));
  expect(getCurrentTrack()?.actualQuality).toBe("FLAC");
  playerActions.applyAuthoritativeSession({ ...session("two", 2), actualQuality: "320k" });
  expect(getCurrentTrack()?.actualQuality).toBe("MP3 320k");
});

it("does not invent 128k when actual quality is absent", () => {
  playerActions.applyAuthoritativeSession({ ...session("unknown"), actualQuality: null });
  expect(getCurrentTrack()?.actualQuality).toBe("未知音质");
});

it("an old connection quality failure cannot mark the new session failed", async () => {
  let reject!: (error: Error) => void;
  mocks.quality.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  const probe = renderHook(usePlayerSnapshot);
  act(() => playerActions.applyAuthoritativeSession(session("old")));
  const pending = playerActions.changeQuality("320k");
  act(() => { beginPlaybackSession(); playerActions.applyAuthoritativeSession(session("new")); });
  await act(async () => { reject(new Error("connection changed")); await pending; });
  expect(probe.result.current.playbackError).toBeNull();
  expect(getCurrentTrack()?.id).toBe("new");
});

it("playTrack waits for source confirmation and returns false on source failure", async () => {
  let reject!: (error: Error) => void;
  mocks.play.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  playerActions.applyAuthoritativeSession(session("one"));
  let settled = false;
  const pending = playerActions.playTrack("one").then(value => { settled = true; return value; });
  await Promise.resolve();
  expect(settled).toBe(false);
  reject(new Error("source unavailable"));
  await expect(pending).resolves.toBe(false);
});
