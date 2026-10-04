import { useEffect, useRef, useState } from "react";
import { searchCatalogSongs } from "../../backend/catalogAdapter";
import type { CatalogSong, CatalogSongPage } from "../../contracts/catalog";
import { enqueueCatalogTrack, enqueueNextCatalogTrack } from "../player/catalogQueue";
import { getCurrentTrack, playerActions, usePlayerSelector } from "../player/playerStore";
import { SongCover } from "./SongCover";
import { CatalogDetails, albumFromSong } from "../catalog/CatalogDetails";
import { CatalogEntityResults, SearchTypeTabs } from "../catalog/CatalogEntityResults";
import type { CatalogEntity, CatalogSearchType } from "../../contracts/catalogBrowse";
import { Icon } from "../../components/Icon";
import { SearchHistory, rememberSearch } from "../library/searchHistory";

export function ArchiveSearch({ active, onClose }: { active: boolean; onClose: () => void }) {
  const [type, setType] = useState<CatalogSearchType>("songs");
  const [entity, setEntity] = useState<CatalogEntity | null>(null);
  const [input, setInput] = useState("");
  const [request, setRequest] = useState({ query: "", page: 1, retry: 0 });
  const [results, setResults] = useState<CatalogSongPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const actionVersion = useRef(0);
  const visible = useRef(active);
  visible.current = active;
  const currentId = usePlayerSelector(s => getCurrentTrack(s)?.id);
  useEffect(() => {
    const epoch = ++generation.current;
    setResults(null); setError(false); setNotice("");
    if (!request.query || type !== "songs") { setLoading(false); return; }
    setLoading(true);
    void searchCatalogSongs(request.query, epoch, request.page).then(result => { if (epoch === generation.current) setResults(result); })
      .catch(() => { if (epoch === generation.current) setError(true); })
      .finally(() => { if (epoch === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [request, type]);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => () => { actionVersion.current++; }, [active]);
  function search(value: string, category: CatalogSearchType = type) {
    const query = value.trim();
    if (!query) return;
    setInput(query); setType(category); rememberSearch(query, category);
    generation.current++;
    setRequest({ query, page: 1, retry: request.retry + 1 });
  }
  async function act(song: CatalogSong, play: boolean, next = false) {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    const epoch = generation.current;
    const action = actionVersion.current;
    try {
      if (next) await enqueueNextCatalogTrack(song); else await enqueueCatalogTrack(song);
      if (epoch !== generation.current || action !== actionVersion.current || !visible.current) return;
      if (play && await playerActions.playTrack(song.id) === false) throw new Error("playback_failed");
      if (epoch !== generation.current || action !== actionVersion.current || !visible.current) return;
      setNotice(play ? `正在播放：${song.title}` : next ? `下一首播放：${song.title}` : `已加入队列：${song.title}`);
    } catch { if (epoch === generation.current) setNotice("操作失败，请重试"); }
    finally { pending.current = false; setBusy(false); }
  }
  if (entity) return <section className="rhine-search rhine-search--detail" aria-label="音乐档案详情" hidden={!active}><CatalogDetails entity={entity} key={`${entity.kind}:${entity.id}`} onBack={() => setEntity(null)} /></section>;
  return <section className="rhine-search" aria-label="音乐档案搜索" hidden={!active} onKeyDown={e => { if (e.key === "Escape" && !e.nativeEvent.isComposing) { e.stopPropagation(); onClose(); } }}>
    <header className="rhine-search-heading"><button onClick={onClose}>← 返回档案</button><span className="rhine-eyebrow">ARCHIVE / 音乐检索</span></header>
    <form className="rhine-search-form" onSubmit={e => { e.preventDefault(); search(input); }}>
      <input autoFocus aria-label="搜索歌曲" placeholder="搜索歌曲、歌手或专辑名" maxLength={100} value={input} onChange={e => setInput(e.target.value)} />
      <button disabled={!input.trim()} type="submit">搜索 ↗</button>
    </form>
    <SearchTypeTabs value={type} onChange={next => { generation.current++; setType(next); if(request.query)rememberSearch(request.query,next); setRequest(r => ({ ...r, page: 1 })); }} />
    <div className="rhine-search-body"><aside className="rhine-search-history"><SearchHistory onSelect={entry=>search(entry.query,entry.type)} /></aside>
      <div className="rhine-search-results rhine-playlist-document">
        {type !== "songs" ? <CatalogEntityResults kind={type} keyword={request.query} page={request.page} onPageChange={page => setRequest(r => ({ ...r, page }))} onOpen={setEntity} /> : <>
        <div className="rhine-search-summary"><h2>歌曲</h2>{request.query && <span>{`“${request.query}”${results?.total !== undefined ? ` · ${results.total} 首` : ""}`}</span>}</div>
        <p className="rhine-notice" role="status">{notice}</p>
        {loading ? <p role="status">正在检索…</p> : error ? <p role="alert">搜索失败 <button onClick={() => setRequest(r => ({ ...r, retry: r.retry + 1 }))}>重试</button></p> : !request.query ? <p className="rhine-search-empty">输入歌名、歌手或专辑名，寻找想听的音乐。</p> : !results?.items.length ? <p className="rhine-search-empty">没有找到歌曲，换个关键词试试。</p> : <>
          <ol className="rhine-songs" start={(request.page - 1) * 20 + 1}>{results.items.map(song => <li key={song.id} data-playing={song.id === currentId}>
            <div className="rhine-song-info"><SongCover cacheKey={song.coverCacheKey} title={song.title} /><span className="rhine-song-text"><strong>{song.title}</strong><small>{song.artists.map((artist, i) => <span key={`${artist.id}:${i}`}>{i > 0 && " / "}<button type="button" onClick={() => setEntity({ kind: "artist", ...artist })}>{artist.name}</button></span>)} · {song.albumId ? <button type="button" onClick={() => { const album = albumFromSong(song); if (album) setEntity(album); }}>{song.album}</button> : song.album}</small></span></div>
            <span className="rhine-song-actions">
              <button className="play-next-button" disabled={busy} aria-label={`下一首播放 ${song.title}`} title="下一首播放" onClick={() => void act(song, false, true)}><Icon name="play-next" size={20} /></button>
              <button disabled={busy} aria-label={`播放 ${song.title}`} onClick={() => void act(song, true)}>播放</button><button disabled={busy} aria-label={`加入队列 ${song.title}`} onClick={() => void act(song, false)}>＋</button>
            </span>
          </li>)}</ol>
          <nav className="rhine-pages" aria-label="搜索分页"><button disabled={request.page === 1} onClick={() => { generation.current++; setRequest(r => ({ ...r, page: r.page - 1 })); }}>上一页</button><span>第 {request.page} 页</span><button disabled={!results.hasMore || request.page >= 100} onClick={() => { generation.current++; setRequest(r => ({ ...r, page: r.page + 1 })); }}>下一页</button></nav>
        </>}
        </>}
      </div>
    </div>
  </section>;
}
