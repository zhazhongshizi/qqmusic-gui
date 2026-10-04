import { expect, it } from "vitest";
import { mergePlaybackSession } from "./sessionSnapshots";
import type { PlaybackSessionSnapshot } from "../contracts/queue";

const session: PlaybackSessionSnapshot = {
  requestedQuality: "320k", mode: "sequence",
  queue: { generation: 8, selectedIndex: null, items: [] },
  player: { state: "idle", generation: 4, currentTrack: null, positionMs: 0, durationMs: null, volume: .5, muted: false, failure: null },
};
it("merges queue and source generations independently", () => {
  const value = mergePlaybackSession(session, {
    ...session, queue: { ...session.queue, generation: 7 },
    player: { ...session.player, generation: 5 },
  });
  expect(value.queue).toBe(session.queue);
  expect(value.player.generation).toBe(5);
});
it("keeps a new source and its quality while accepting a later queue", () => {
  const value = mergePlaybackSession(session, {
    ...session, requestedQuality: "128k", queue: { ...session.queue, generation: 9 },
    player: { ...session.player, generation: 3 },
  });
  expect(value.player).toBe(session.player);
  expect(value.requestedQuality).toBe("320k");
  expect(value.queue.generation).toBe(9);
});
