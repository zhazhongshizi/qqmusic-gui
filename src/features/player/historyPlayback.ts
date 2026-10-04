import type { HistoryEntry } from "../../backend/historyAdapter";
import { nativeQueueEnqueue, nativeQueuePlay } from "../../backend/nativeQueueAdapter";
import { playerActions } from "./playerStore";

export async function playHistoryEntry(entry: HistoryEntry): Promise<void> {
  // Missing metadata remains compatible with history recorded by older versions.
  const queue = await nativeQueueEnqueue({ id: entry.id, title: entry.title, artist: entry.artist,
    album: entry.album ?? "", durationMs: entry.durationMs ?? 0,
    ...(entry.coverCacheKey ? { coverCacheKey: entry.coverCacheKey } : {}),
    ...(entry.mediaMid ? { mediaMid: entry.mediaMid } : {}),
  });
  await playerActions.hydrateNative(queue);
  const index = queue.items.findIndex((track) => track.id === entry.id);
  if (index < 0) throw new Error("历史歌曲未能入队");
  const result = await nativeQueuePlay(index);
  if (result) await playerActions.hydrateNative(result.queue, result.playback.player, result.playback.quality);
}
