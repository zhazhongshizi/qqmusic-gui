import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaybackSessionSnapshot } from "../../contracts/queue";
import { beginPlaybackSession } from "../../backend/playbackTransport";
import { CommitRange } from "./CommitRange";
import { playerActions, resetPlayerFixture, usePlayerSnapshot } from "./playerStore";

const mocks = vi.hoisted(() => ({ seek: vi.fn(), volume: vi.fn(), muted: vi.fn(), session: vi.fn(), liked: vi.fn(), setLiked: vi.fn() }));
vi.mock("../../backend/nativePlayerAdapter", async importOriginal => ({
  ...await importOriginal<typeof import("../../backend/nativePlayerAdapter")>(),
  nativeSeek: mocks.seek, nativeSetVolume: mocks.volume, nativeSetMuted: mocks.muted,
}));
vi.mock("../../backend/nativeQueueAdapter", async importOriginal => ({
  ...await importOriginal<typeof import("../../backend/nativeQueueAdapter")>(), nativePlaybackSessionSnapshot: mocks.session,
}));
vi.mock("../../backend/libraryAdapter", () => ({ getLikedSongs: mocks.liked, setSongsLiked: mocks.setLiked }));
const session = (id = "song", generation = 1): PlaybackSessionSnapshot => ({
  mode: "sequence", requestedQuality: "320k", actualQuality: "320k",
  queue: { generation, selectedIndex: 0, items: [{ id, title: id, artist: "Artist", album: "Album", durationMs: 100000 }] },
  player: { state: "playing", generation, positionMs: 1000, durationMs: 100000, volume: .5, muted: false,
    currentTrack: { id, title: id, artist: "Artist" }, failure: null },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => { resetPlayerFixture(); vi.resetAllMocks(); });
afterEach(() => { cleanup(); resetPlayerFixture(); });

it("previews many pointer changes locally despite polling and commits once on release", () => {
  const commit = vi.fn();
  const view = render(<CommitRange aria-label="progress" min={0} max={100} value={10} onCommit={commit} />);
  const slider = screen.getByRole("slider");
  fireEvent.pointerDown(slider);
  for (const value of [20, 30, 50, 65]) fireEvent.change(slider, { target: { value } });
  view.rerender(<CommitRange aria-label="progress" min={0} max={100} value={12} onCommit={commit} />);
  expect(slider).toHaveValue("65");
  expect(commit).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider); fireEvent.blur(slider);
  expect(commit).toHaveBeenCalledExactlyOnceWith(65);
});
it("commits keyboard and accessible changes but cancels an interrupted pointer gesture", () => {
  const commit = vi.fn();
  render(<CommitRange min={0} max={100} value={10} onCommit={commit} />);
  const slider = screen.getByRole("slider");
  fireEvent.keyDown(slider, { key: "End" }); fireEvent.change(slider, { target: { value: 100 } });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.keyUp(slider, { key: "End" });
  expect(commit).toHaveBeenLastCalledWith(100);
  fireEvent.pointerDown(slider); fireEvent.change(slider, { target: { value: 50 } });
  fireEvent.pointerCancel(slider); fireEvent.pointerUp(slider);
  expect(commit).toHaveBeenCalledTimes(1);
  fireEvent.change(slider, { target: { value: 40 } });
  expect(commit).toHaveBeenLastCalledWith(40);
});
it("polls started before a seek cannot override the optimistic or confirmed position", async () => {
  const probe = renderHook(usePlayerSnapshot);
  act(() => playerActions.applyAuthoritativeSession(session()));
  const poll = deferred<PlaybackSessionSnapshot>();
  const seek = deferred<PlaybackSessionSnapshot["player"]>();
  mocks.session.mockReturnValue(poll.promise); mocks.seek.mockReturnValue(seek.promise);
  const reading = playerActions.hydrateNativeSession();
  act(() => playerActions.seek(65000));
  expect(probe.result.current.positionMs).toBe(65000);
  act(() => playerActions.applyAuthoritativeSession(session()));
  expect(probe.result.current.positionMs).toBe(65000);
  await act(async () => { seek.resolve({ ...session().player, positionMs: 65000 }); });
  await act(async () => { poll.resolve(session()); await reading; });
  expect(probe.result.current.positionMs).toBe(65000);
  act(() => playerActions.applyAuthoritativeSession(session("next", 2)));
  expect(probe.result.current.positionMs).toBe(1000);
});
it("volume drag unmutes once and old polling cannot restore mute after confirmation", async () => {
  const probe = renderHook(usePlayerSnapshot);
  const muted = { ...session(), player: { ...session().player, muted: true } };
  act(() => playerActions.applyAuthoritativeSession(muted));
  const poll = deferred<PlaybackSessionSnapshot>(); mocks.session.mockReturnValue(poll.promise);
  const reading = playerActions.hydrateNativeSession();
  mocks.muted.mockResolvedValue(session().player);
  mocks.volume.mockImplementation(async (volume: number) => ({ ...session().player, volume }));
  render(<CommitRange min={0} max={1} step={.01} value={0} onCommit={playerActions.setVolume} />);
  const slider = screen.getByRole("slider");
  fireEvent.pointerDown(slider);
  for (const value of [.2, .4, .8]) fireEvent.change(slider, { target: { value } });
  expect(mocks.volume).not.toHaveBeenCalled();
  await act(async () => fireEvent.pointerUp(slider));
  expect(mocks.muted).toHaveBeenCalledExactlyOnceWith(false);
  expect(mocks.volume).toHaveBeenCalledExactlyOnceWith(.8);
  await act(async () => { poll.resolve(muted); await reading; });
  expect(probe.result.current.volume).toBe(.8);
  expect(probe.result.current.muted).toBe(false);
});
it("failed seeking restores the prior confirmed position and reports the failure", async () => {
  const probe = renderHook(usePlayerSnapshot);
  act(() => playerActions.applyAuthoritativeSession(session()));
  mocks.seek.mockRejectedValue(new Error("failed"));
  await act(async () => playerActions.seek(65000));
  expect(probe.result.current.positionMs).toBe(1000);
  expect(probe.result.current.playbackError).not.toBeNull();
});
it("loads every liked page and waits for confirmation while preventing duplicate writes", async () => {
  const probe = renderHook(usePlayerSnapshot);
  act(() => playerActions.applyAuthoritativeSession(session()));
  mocks.liked.mockImplementation(async (page: number) => ({ items: [{ id: page === 1 ? "other" : "song" }], hasMore: page === 1 }));
  await act(async () => playerActions.syncAccountLikes());
  expect(mocks.liked).toHaveBeenCalledTimes(2);
  expect(probe.result.current.likedIds).toEqual(["other", "song"]);
  const write = deferred<{ status: string }>(); mocks.setLiked.mockReturnValue(write.promise);
  act(() => { playerActions.toggleLike("song"); playerActions.toggleLike("song"); });
  expect(mocks.setLiked).toHaveBeenCalledExactlyOnceWith(["song"], false);
  expect(probe.result.current.likedIds).toContain("song");
  await act(async () => write.resolve({ status: "applied" }));
  expect(probe.result.current.likedIds).not.toContain("song");
});
it("account/session changes retire late like replies and an incomplete read never enables toggling", async () => {
  const probe = renderHook(usePlayerSnapshot);
  act(() => playerActions.applyAuthoritativeSession(session()));
  const write = deferred<{ status: string }>(); mocks.setLiked.mockReturnValue(write.promise);
  let writing!: Promise<boolean>;
  act(() => { writing = playerActions.setSongLiked("song", true); playerActions.clearAccountLikes(); beginPlaybackSession(); });
  await act(async () => { write.resolve({ status: "applied" }); expect(await writing).toBe(false); });
  expect(probe.result.current.likedIds).toEqual([]);
  mocks.liked.mockResolvedValue({ items: [], hasMore: true });
  await act(async () => playerActions.syncAccountLikes());
  expect(probe.result.current.likesReady).toBe(false);
  expect(mocks.liked).toHaveBeenCalledTimes(100);
});
