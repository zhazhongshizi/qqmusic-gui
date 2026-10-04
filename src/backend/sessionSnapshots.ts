import type { PlaybackSessionSnapshot, QueueSnapshot } from "../contracts/queue";

/** Generations are comparable only within the same playback connection. */
export function newestQueue(current: QueueSnapshot | undefined, incoming: QueueSnapshot): QueueSnapshot {
  return current && current.generation > incoming.generation ? current : incoming;
}

export function mergePlaybackSession(
  current: PlaybackSessionSnapshot | undefined,
  incoming: PlaybackSessionSnapshot,
): PlaybackSessionSnapshot {
  if (!current) return incoming;
  const playback = current.player.generation > incoming.player.generation ? current : incoming;
  return { ...playback, queue: newestQueue(current.queue, incoming.queue) };
}
