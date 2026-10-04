import { useEffect, useState } from "react";
import { readPlaylistSongs, invalidatePlaylistSongs } from "../library/readPlaylistSongs";
import type { CatalogSong } from "../../contracts/catalog";
import type { PlaylistSummary } from "../../contracts/library";

/** Mounted with one playlist detail; fetch the whole playlist only on first search. */
export function usePlaylistSongSearch(playlist: PlaylistSummary, searching: boolean) {
  const [allSongs, setAllSongs] = useState<readonly CatalogSong[] | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!searching || allSongs) return;
    let alive = true;
    setError(false);
    void (async () => {
      const songs = await readPlaylistSongs(playlist, retry, () => alive);
      if (songs) setAllSongs(songs);
    })().catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [playlist.id, playlist.editableId, searching, allSongs, retry]);
  return { allSongs, error, loading: searching && !allSongs && !error, retry: () => { invalidatePlaylistSongs(playlist); setAllSongs(null); setRetry(value => value + 1); } };
}
