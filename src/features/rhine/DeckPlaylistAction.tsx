import { useEffect, useId, useRef, useState } from "react";
import { addSongsToPlaylist, getLibraryPlaylists, LibraryAdapterError } from "../../backend/libraryAdapter";
import type { PlaylistSummary } from "../../contracts/library";
import { localMusicFormatFromId } from "../../contracts/localMusic";
import PlaylistPicker from "../library/PlaylistPicker";

type Song = { id: string; title: string };

function PlaylistForm({ song, onClose }: { song: Song; onClose: () => void }) {
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [targetId, setTargetId] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const writing = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    void getLibraryPlaylists("created", page, 50).then(result => {
      if (!active) return;
      const editable = result.items.filter(item => item.editableId);
      setPlaylists(previous => {
        const combined = page === 1 ? editable : [...previous, ...editable];
        return [...new Map(combined.map(item => [item.id, item])).values()];
      });
      setTargetId(previous => previous || editable[0]?.id || "");
      setHasMore(result.hasMore && page < 100);
    }).catch(error => {
      if (!active) return;
      setLoadError(error instanceof LibraryAdapterError && error.code === "QMG-LIBRARY-AUTH"
        ? "请先登录账号，再添加到歌单。" : "歌单读取失败，请重试。");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, retry]);

  async function add() {
    const target = playlists.find(item => item.id === targetId);
    if (!target?.editableId || writing.current) return;
    writing.current = true;
    setSubmitted(true);
    setNotice(`正在将“${song.title}”加入“${target.title}”…`);
    try {
      await addSongsToPlaylist(target.id, target.editableId, [song.id]);
      setNotice(`已将“${song.title}”加入“${target.title}”。`);
    } catch (error) {
      setNotice(error instanceof LibraryAdapterError && error.code === "QMG-LIBRARY-AUTH"
        ? "请先登录账号，再添加到歌单。"
        : "加入结果待核对，请查看目标歌单；应用没有自动重复提交。");
    }
  }

  return <div className="rhine-deck-playlist-panel">
    <div className="rhine-deck-playlist-heading"><strong>将歌曲添加进歌单</strong><button type="button" onClick={onClose} aria-label="关闭添加歌单">关闭</button></div>
    <p className="rhine-deck-playlist-song" title={song.title}>{song.title}</p>
    <PlaylistPicker variant="rhine" options={playlists} value={targetId} onChange={setTargetId} label="目标歌单" />
    <div className="rhine-deck-playlist-actions">
      {loadError
        ? <button type="button" onClick={() => setRetry(value => value + 1)}>重新读取歌单</button>
        : hasMore && <button type="button" disabled={loading} onClick={() => setPage(value => value + 1)}>更多歌单</button>}
      <button type="button" disabled={!targetId || submitted} onClick={() => void add()}>确认添加</button>
    </div>
    <p role="status">{notice || loadError || (loading ? "正在读取歌单…" : playlists.length ? "选择目标歌单后确认添加。" : "还没有可添加的歌单，请先在音乐档案中创建歌单。")}</p>
  </div>;
}

export function DeckPlaylistAction({ track, authenticated = true }: { track: Song | null | undefined; authenticated?: boolean }) {
  const [song, setSong] = useState<Song | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const available = Boolean(track && !localMusicFormatFromId(track.id) && authenticated);
  function close() {
    setSong(null);
    trigger.current?.focus();
  }
  return <div className="rhine-deck-playlist" onKeyDown={event => {
    if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); close(); }
  }}>
    <button ref={trigger} type="button" disabled={!available} aria-expanded={Boolean(song)} aria-controls={song ? panelId : undefined}
      title={!authenticated ? "登录后可添加到歌单" : !available ? "请选择在线歌曲" : undefined}
      onClick={() => { if (song) close(); else if (track) setSong({ id: track.id, title: track.title }); }}>将歌曲添加进歌单</button>
    {song && <section id={panelId} aria-label="添加歌曲到歌单"><PlaylistForm song={song} onClose={close} /></section>}
  </div>;
}
