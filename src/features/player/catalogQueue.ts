import {
  nativeQueueEnqueue,
  nativeQueueEnqueueMany,
  nativeQueueEnqueueNext,
  nativeQueueNext,
  nativeQueueReplace,
  nativeSetPlaybackMode,
} from "../../backend/nativeQueueAdapter";
import type { CatalogSong } from "../../contracts/catalog";
import type { QueueTrack } from "../../contracts/queue";
import type { QueueSnapshot } from "../../contracts/queue";
import { playbackSessionIdentity } from "../../backend/playbackTransport";
import { playerActions } from "./playerStore";

export const MAX_CATALOG_QUEUE_ITEMS = 1_000;

export type CatalogCollectionPlaybackMode = "preserve" | "shuffle";

export interface CatalogQueueResult {
  readonly loadedCount: number;
  readonly truncated: boolean;
}

export class CatalogQueuePlaybackError extends Error {
  readonly queueReplaced: boolean;

  constructor(queueReplaced: boolean) {
    super("catalog_queue_playback_failed");
    this.name = "CatalogQueuePlaybackError";
    this.queueReplaced = queueReplaced;
  }
}

export function queueTrackFromCatalog(track: CatalogSong): QueueTrack {
  return {
    id: track.id,
    ...(track.mediaMid ? { mediaMid: track.mediaMid } : {}),
    ...(track.coverCacheKey ? { coverCacheKey: track.coverCacheKey } : {}),
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationMs: track.durationMs,
  };
}

/** The player has already recorded the source failure or cancellation. */
export class CatalogPlaybackStartError extends Error {}

export async function enqueueAndPlayCatalogTrack(track: CatalogSong): Promise<void> {
  await enqueueCatalogTrack(track);
  if (await playerActions.playTrack(track.id) === false) throw new CatalogPlaybackStartError("catalog_playback_failed");
}

export async function enqueueCatalogTracks(tracks: readonly CatalogSong[]): Promise<void> {
  const identity = playbackSessionIdentity();
  const unique = [...new Map(tracks.map(track => [track.id, track])).values()];
  const queue = await nativeQueueEnqueueMany(unique.map(queueTrackFromCatalog));
  if (identity !== playbackSessionIdentity()) throw new Error("连接已变化");
  if (unique.some(track => !queue.items.some(item => item.id === track.id))) throw new Error("批量入队未完成");
  await playerActions.hydrateNative(queue);
}

export async function enqueueCatalogTrack(track: CatalogSong): Promise<QueueSnapshot> {
  const queue = await nativeQueueEnqueue(queueTrackFromCatalog(track));
  if (!queue.items.some((item) => item.id === track.id)) {
    throw new Error("catalog_queue_item_missing");
  }
  await playerActions.hydrateNative(queue);
  return queue;
}

export async function enqueueNextCatalogTrack(track: CatalogSong): Promise<void> {
  const queue = await nativeQueueEnqueueNext(queueTrackFromCatalog(track));
  await playerActions.hydrateNative(queue);
}

export function replaceAndPlayCatalogTracks(
  tracks: readonly CatalogSong[],
  mode: CatalogCollectionPlaybackMode,
): Promise<CatalogQueueResult>;
export function replaceAndPlayCatalogTracks(
  tracks: readonly CatalogSong[],
  mode: CatalogCollectionPlaybackMode,
  isCurrent: () => boolean,
): Promise<CatalogQueueResult | null>;
export async function replaceAndPlayCatalogTracks(
  tracks: readonly CatalogSong[],
  mode: CatalogCollectionPlaybackMode,
  isCurrent: () => boolean = () => true,
): Promise<CatalogQueueResult | null> {
  const seen = new Set<string>();
  const unique: CatalogSong[] = [];
  for (const track of tracks) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    unique.push(track);
  }
  const limited = unique.slice(0, MAX_CATALOG_QUEUE_ITEMS);
  const first = limited[0];
  if (!first) throw new Error("catalog_queue_empty");

  let queueReplaced = false;
  try {
    if (!isCurrent()) return null;
    const queue = await nativeQueueReplace(limited.map(queueTrackFromCatalog));
    queueReplaced = true;
    if (!isCurrent()) return null;
    await playerActions.hydrateNative(queue);
    if (!isCurrent()) return null;

    if (mode === "preserve") {
      if (await playerActions.playTrack(first.id) === false) {
        if (!isCurrent()) return null;
        throw new Error("catalog_playback_failed");
      }
    } else {
      const session = await nativeSetPlaybackMode("shuffle");
      if (!isCurrent()) return null;
      await playerActions.hydrateNativeSession(session);
      if (!isCurrent()) return null;
      if (limited.length === 1) {
        if (await playerActions.playTrack(first.id) === false) {
          if (!isCurrent()) return null;
          throw new Error("catalog_playback_failed");
        }
      } else {
        const playback = await nativeQueueNext();
        if (!playback) throw new Error("catalog_shuffle_start_missing");
        await playerActions.hydrateNative(
          playback.queue,
          playback.playback.player,
          playback.playback.quality,
        );
      }
    }
  } catch {
    throw new CatalogQueuePlaybackError(queueReplaced);
  }

  return {
    loadedCount: limited.length,
    truncated: unique.length > limited.length,
  };
}
