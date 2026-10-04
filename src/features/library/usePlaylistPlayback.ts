import { useEffect, useRef, useState, type RefObject } from "react";
import { readPlaylistSongs } from "./readPlaylistSongs";
import type { PlaylistSummary } from "../../contracts/library";
import { CatalogQueuePlaybackError, replaceAndPlayCatalogTracks } from "../player/catalogQueue";

/** Owns the lifetime of a playlist read and its subsequent queue replacement. */
export function usePlaylistPlayback(
  playlist: PlaylistSummary | null,
  generation: RefObject<number>,
  blocked: boolean,
) {
  const [queueNotice, setQueueNotice] = useState("");
  const [playlistPlaybackBusy, setPlaylistPlaybackBusy] = useState(false);
  const pending = useRef<number | null>(null);
  useEffect(() => () => { generation.current++; }, [generation]);

  async function handlePlayAll() {
    const requestGeneration = generation.current;
    if (!playlist || blocked || pending.current === requestGeneration) return;
    const isCurrent = () => generation.current === requestGeneration;
    pending.current = requestGeneration;
    setPlaylistPlaybackBusy(true);
    try {
      const songs = await readPlaylistSongs(playlist, requestGeneration, isCurrent, page => setQueueNotice(`正在读取全部歌曲（第 ${page} 页）…`));
      if (!songs?.length || !isCurrent()) return;
      const result = await replaceAndPlayCatalogTracks(songs, "preserve", isCurrent);
      if (!result || !isCurrent()) return;
      setQueueNotice(result.truncated
        ? `歌单超过队列上限，已载入前 ${result.loadedCount} 首并开始播放`
        : `已载入 ${result.loadedCount} 首并开始播放`);
      return result;
    } catch (error) {
      if (isCurrent()) setQueueNotice(error instanceof CatalogQueuePlaybackError && error.queueReplaced
        ? "队列已更新，但播放启动失败；请查看播放器中的提示"
        : "播放全部失败；现有本地队列未改变");
    } finally {
      if (pending.current === requestGeneration) pending.current = null;
      if (isCurrent()) setPlaylistPlaybackBusy(false);
    }
  }

  return { queueNotice, setQueueNotice, playlistPlaybackBusy, setPlaylistPlaybackBusy, handlePlayAll };
}
