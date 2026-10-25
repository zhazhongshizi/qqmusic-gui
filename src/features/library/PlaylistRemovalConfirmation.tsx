import { useEffect, useRef } from "react";
import type { usePlaylistRemoval } from "./usePlaylistRemoval";

export function PlaylistRemovalConfirmation({ removal, rhine = false }: {
  removal: ReturnType<typeof usePlaylistRemoval>; rhine?: boolean;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const target = removal.target;
  useEffect(() => { if (target) cancel.current?.focus(); }, [target]);
  if (!target) return null;
  return <div className={rhine ? "rhine-playlist-removal" : "playlist-removal"} role="group" aria-label="确认移出歌单">
    <p>将{target.songs.length === 1 ? `《${target.songs[0]!.title}》` : `所选 ${target.songs.length} 首歌曲`}从“{target.playlist.title}”移出？</p>
    <div>
      <button className={rhine ? undefined : "text-button"} type="button" ref={cancel} disabled={removal.busy} onClick={removal.cancel}>取消</button>
      <button className={rhine ? undefined : "text-button text-button--primary"} type="button" disabled={removal.busy} onClick={() => void removal.confirm()}>{removal.busy ? "正在移出…" : "确认移出"}</button>
    </div>
  </div>;
}
