import { useEffect, useRef, useState } from "react";
import { removeSongsFromPlaylist } from "../../backend/libraryAdapter";
import { catalogCacheRevision } from "../../backend/catalogCacheScope";
import type { CatalogSong } from "../../contracts/catalog";
import type { PlaylistSummary } from "../../contracts/library";
import { invalidatePlaylistSongs } from "./readPlaylistSongs";

type RemovalTarget = {
  playlist: PlaylistSummary;
  songs: readonly Pick<CatalogSong, "id" | "title">[];
  scope: string;
  revision: number;
};

export function usePlaylistRemoval(
  playlist: PlaylistSummary, disabled: boolean, onRemoved: (ids: readonly string[]) => void,
  scopeKey = "",
) {
  const [target, setTarget] = useState<RemovalTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const scope = JSON.stringify([scopeKey, playlist.id, playlist.editableId]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const alive = useRef(true);
  const writing = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  function request(songs: readonly CatalogSong[]) {
    if (disabled || writing.current || !playlist.editableId || songs.length === 0) return;
    const unique = [...new Map(songs.map(song => [song.id, { id: song.id, title: song.title }])).values()];
    if (unique.length > 100) { setNotice("每次最多移出 100 首歌曲，请减少选择"); return; }
    setNotice("");
    setTarget({ playlist: { ...playlist }, songs: unique, scope, revision: catalogCacheRevision() });
  }

  async function confirm() {
    if (!target?.playlist.editableId || disabled || writing.current) return;
    const selected = target;
    const isCurrent = () => alive.current && currentScope.current === selected.scope
      && catalogCacheRevision() === selected.revision;
    if (!isCurrent()) { setTarget(null); return; }
    const ids = selected.songs.map(song => song.id);
    writing.current = true;
    setBusy(true);
    try {
      await removeSongsFromPlaylist(selected.playlist.id, selected.playlist.editableId!, ids);
      if (catalogCacheRevision() === selected.revision) invalidatePlaylistSongs(selected.playlist);
      if (!isCurrent()) return;
      setNotice(`已从“${selected.playlist.title}”移出 ${ids.length} 首歌曲`);
      onRemoved(ids);
    } catch {
      if (catalogCacheRevision() === selected.revision) invalidatePlaylistSongs(selected.playlist);
      if (isCurrent()) {
        setNotice("移出结果未确认，请刷新歌单核对；应用没有自动重复提交");
      }
    } finally {
      writing.current = false;
      if (alive.current && currentScope.current === selected.scope) { setBusy(false); setTarget(null); }
    }
  }

  return {
    target: target?.scope === scope ? target : null,
    busy, notice, request, confirm,
    cancel: () => { if (!writing.current) setTarget(null); },
  };
}
