import { beforeEach, expect, it, vi } from "vitest";
import { actOnStatisticsTrack } from "./statisticsPlayback";
import { beginPlaybackSession } from "../../backend/playbackTransport";
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), batch: vi.fn(), next: vi.fn(), hydrate: vi.fn(), play: vi.fn() }));
vi.mock("../../backend/nativeQueueAdapter", () => ({ nativeQueueSnapshot: mocks.snapshot, nativeQueueEnqueueMany: mocks.batch, nativeQueueEnqueueNext: mocks.next }));
vi.mock("./playerStore", () => ({ playerActions: { hydrateNative: mocks.hydrate, playTrack: mocks.play } }));
const track = { id: "a", title: "A", artist: "Artist", album: "Album", durationMs: 1000, mediaMid: "media", coverCacheKey: "cover" };
const queue = { items: [track], selectedIndex: 0, generation: 2 };
beforeEach(() => { Object.values(mocks).forEach(mock => mock.mockReset()); mocks.snapshot.mockResolvedValue(queue); mocks.batch.mockResolvedValue(queue); mocks.next.mockResolvedValue(queue); mocks.play.mockResolvedValue(true); });
it("retains full existing metadata and enqueues without starting playback", async () => {
  await actOnStatisticsTrack({ id: "a", title: "old", artist: "old" }, "enqueue");
  expect(mocks.batch).toHaveBeenCalledExactlyOnceWith([track]); expect(mocks.play).not.toHaveBeenCalled();
});
it("plays only after acknowledged enqueue and surfaces failure", async () => {
  await actOnStatisticsTrack(track, "play"); expect(mocks.play).toHaveBeenCalledExactlyOnceWith("a");
  mocks.play.mockResolvedValue(false); await expect(actOnStatisticsTrack(track, "play")).rejects.toThrow("播放未启动");
});
it("routes next-up through the existing next command without playing", async () => {
  await actOnStatisticsTrack(track, "next"); expect(mocks.next).toHaveBeenCalledExactlyOnceWith(track); expect(mocks.play).not.toHaveBeenCalled();
});
it("does not apply a late batch response to a new connection", async () => {
  mocks.batch.mockImplementation(async () => { beginPlaybackSession(); return queue; });
  await expect(actOnStatisticsTrack(track, "play")).rejects.toThrow("连接已变化"); expect(mocks.hydrate).not.toHaveBeenCalled(); expect(mocks.play).not.toHaveBeenCalled();
});
