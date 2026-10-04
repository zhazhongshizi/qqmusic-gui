import { getPlaylistSongs } from "../../backend/catalogAdapter";
import type { CatalogSong } from "../../contracts/catalog";
import type { PlaylistSummary } from "../../contracts/library";
import { playbackSessionIdentity, playbackConnectionRevision } from "../../backend/playbackTransport";
import { catalogCacheRevision } from "../../backend/catalogCacheScope";

// Full reads are shared across views, but never across connections. Keep at most 8 playlists for 5 minutes.
const cache = new Map<string, { songs: CatalogSong[]; expires: number }>();
let cacheSession = "";
let revision = 0;
const sessionKey = () => `${playbackSessionIdentity()}:${playbackConnectionRevision()}:${catalogCacheRevision()}`;
function keyFor(playlist: Pick<PlaylistSummary, "id" | "editableId">) {
  const session = sessionKey();
  if (cacheSession !== session) { cache.clear(); revision++; cacheSession = session; }
  return JSON.stringify([playlist.id, playlist.editableId ?? null]);
}
export function invalidatePlaylistSongs(playlist?: Pick<PlaylistSummary, "id" | "editableId">) {
  revision++;
  if (playlist) cache.delete(keyFor(playlist)); else cache.clear();
}

/** Bounded complete read, shared by search and playback; cancelled reads return null. */
export async function readPlaylistSongs(
  playlist: Pick<PlaylistSummary, "id" | "editableId">,
  generation: number,
  isCurrent: () => boolean,
  onPage?: (page: number) => void,
): Promise<CatalogSong[] | null> {
  const key = keyFor(playlist);
  const session = cacheSession;
  const epoch = revision;
  const current = () => isCurrent() && session === sessionKey() && epoch === revision;
  if (!current()) return null;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.songs.slice();
  const songs: CatalogSong[] = [];
  for (let page = 1; page <= 100; page++) {
    if (!current()) return null;
    onPage?.(page);
    const result = await getPlaylistSongs(playlist.id, generation, page, 50, playlist.editableId);
    if (!current()) return null;
    songs.push(...result.items);
    if (!result.hasMore) {
      cache.delete(key);
      if (cache.size >= 8) cache.delete(cache.keys().next().value!);
      cache.set(key, { songs: songs.slice(), expires: Date.now() + 300_000 });
      return songs;
    }
  }
  throw new Error("playlist_page_limit");
}
