import { nativeQueueEnqueue } from "../../backend/nativeQueueAdapter";
import type { LocalMusicTrack } from "../../contracts/localMusic";
import type { QueueSnapshot, QueueTrack } from "../../contracts/queue";
import { playerActions } from "./playerStore";

export function queueTrackFromLocal(track: LocalMusicTrack): QueueTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationMs: track.durationMs,
    ...(track.coverCacheKey ? { coverCacheKey: track.coverCacheKey } : {}),
  };
}

export async function enqueueLocalTrack(track: LocalMusicTrack): Promise<QueueSnapshot> {
  const queue = await nativeQueueEnqueue(queueTrackFromLocal(track));
  if (!queue.items.some((item) => item.id === track.id)) {
    throw new Error("local_music_queue_item_missing");
  }
  await playerActions.hydrateNative(queue);
  return queue;
}

export async function enqueueAndPlayLocalTrack(track: LocalMusicTrack): Promise<void> {
  await enqueueLocalTrack(track);
  if (await playerActions.playTrack(track.id) === false) throw new Error("local_playback_failed");
}
