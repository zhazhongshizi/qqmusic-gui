import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { getPlaylistSongs } from "../../backend/catalogAdapter";
import { readPlaylistSongs, invalidatePlaylistSongs } from "./readPlaylistSongs";
import { Icon } from "../../components/Icon";
import type { CatalogSong, CatalogSongPage } from "../../contracts/catalog";
import type { PlaylistSummary } from "../../contracts/library";
import { enqueueCatalogTracks } from "../player/catalogQueue";

const PAGE_SIZE = 20;
type SelectedSong = { track: CatalogSong; position: number };

interface PlaylistSongListProps {
  playlist: PlaylistSummary;
  initialPage: CatalogSongPage;
  currentTrackId?: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  renderCells: (track: CatalogSong) => ReactNode;
}

export default function PlaylistSongList({
  playlist, initialPage, currentTrackId, disabled, onBusyChange, renderCells,
}: PlaylistSongListProps) {
  const [query, setQuery] = useState("");
  const [browsePage, setBrowsePage] = useState(initialPage.page);
  const [resultPage, setResultPage] = useState(1);
  const [page, setPage] = useState(initialPage);
  const [allSongs, setAllSongs] = useState<readonly CatalogSong[] | null>(
    initialPage.page === 1 && !initialPage.hasMore ? initialPage.items : null,
  );
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [checked, setChecked] = useState<Map<string, SelectedSong>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pages = useRef(new Map([[initialPage.page, initialPage]]));
  const alive = useRef(true);
  const adding = useRef(false);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const searching = normalizedQuery.length > 0;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; onBusyChange(false); };
  }, [onBusyChange]);

  useEffect(() => {
    let active = true;
    setReadError(false);
    if (allSongs !== null) {
      setLoading(false);
      return;
    }
    const cached = pages.current.get(browsePage);
    if (!searching && cached) {
      setPage(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (searching) {
            const songs = await readPlaylistSongs(playlist, initialPage.generation, () => active);
            if (songs) setAllSongs(songs);
            return;
          }
          const next = await getPlaylistSongs(playlist.id, initialPage.generation, browsePage, PAGE_SIZE, playlist.editableId);
          if (!active) return;
          pages.current.set(browsePage, next);
          setPage(next);
        } catch {
          if (active) setReadError(true);
        } finally {
          if (active) setLoading(false);
        }
      })();
    }, searching ? 250 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [allSongs, browsePage, initialPage.generation, playlist.id, playlist.editableId, retry, searching]);

  const matches = useMemo(() => allSongs?.map((track, position) => ({ track, position }))
    .filter(({ track }) => !normalizedQuery ||
      `${track.title} ${track.subtitle} ${track.artist} ${track.album}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)) ?? [],
  [allSongs, normalizedQuery]);
  const number = searching ? resultPage : browsePage;
  const offset = (number - 1) * PAGE_SIZE;
  const rows = allSongs !== null ? matches.slice(offset, offset + PAGE_SIZE)
    : page.items.map((track, index) => ({ track, position: (page.page - 1) * PAGE_SIZE + index }));
  const rowsReady = !readError && !loading && (!searching || allSongs !== null) && (allSongs !== null || page.page === browsePage);
  const hasMore = allSongs !== null ? offset + PAGE_SIZE < matches.length : page.hasMore;
  // Search selection includes every match, even when results span several display pages.
  const selectable = rowsReady ? (searching ? matches : rows) : [];
  const selectedCount = selectable.filter(({ track }) => checked.has(track.id)).length;
  const allSelected = selectable.length > 0 && selectedCount === selectable.length;
  const locked = disabled || busy;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected;
  }, [allSelected, selectedCount]);

  function toggle(song: SelectedSong) {
    setChecked((previous) => {
      const next = new Map(previous);
      if (next.has(song.track.id)) next.delete(song.track.id);
      else next.set(song.track.id, song);
      return next;
    });
    setNotice("");
  }

  async function addSelected() {
    if (adding.current || disabled || checked.size === 0) return;
    adding.current = true;
    setBusy(true);
    onBusyChange(true);
    const songs = [...checked.values()].sort((left, right) => left.position - right.position);
    try {
      await enqueueCatalogTracks(songs.map(song => song.track));
      if (alive.current) { setChecked(new Map()); setNotice(`已将 ${songs.length} 首歌曲加入播放队列`); }
    } catch {
      if (alive.current) setNotice("批量入队未确认，请检查队列容量与连接后重试；当前选择已保留");
    } finally {
      adding.current = false;
      if (alive.current) { setBusy(false); onBusyChange(false); }
    }
  }

  return (
    <div className="playlist-songs">
      <label className="catalog-search">
        <Icon name="search" size={18} />
        <span className="sr-only">歌单内搜索</span>
        <input type="search" placeholder="在此歌单中搜索歌曲、歌手或专辑" value={query}
          onChange={(event) => { setQuery(event.currentTarget.value); setResultPage(1); }} />
        {query ? <button aria-label="清空歌单搜索" type="button" onClick={() => { setQuery(""); setResultPage(1); }}><Icon name="close" size={16} /></button> : null}
      </label>
      <div className="playlist-songs__toolbar" role="group" aria-label="批量选择歌曲">
        <label className="playlist-songs__select-all">
          <input type="checkbox" ref={selectAllRef} checked={allSelected} disabled={locked || selectable.length === 0}
            onChange={() => setChecked((previous) => {
              const next = new Map(previous);
              for (const song of selectable) {
                if (allSelected) next.delete(song.track.id);
                else next.set(song.track.id, song);
              }
              return next;
            })} />
          {searching ? "全选搜索结果" : "全选本页"}
        </label>
        <button type="button" className="text-button" disabled={locked} onClick={()=>{invalidatePlaylistSongs(playlist);pages.current.clear();setAllSongs(null);setBrowsePage(1);setResultPage(1);setChecked(new Map());setRetry(r=>r+1);}}>刷新歌单</button>
        <span className="playlist-songs__count">已选 {checked.size} 首</span>
        <button className="text-button" type="button" disabled={locked || checked.size === 0} onClick={() => setChecked(new Map())}>清空选择</button>
        <button className="text-button text-button--primary" type="button" disabled={locked || checked.size === 0} onClick={() => void addSelected()}>
          <Icon name="queue" size={16} />{busy ? "正在加入…" : "加入播放队列"}
        </button>
      </div>
      {notice ? <p role="status" className="playlist-songs__notice">{notice}</p> : null}
      {!rowsReady ? (
        readError ? <div className="catalog-empty" role="alert"><p>{searching ? "未能读取完整歌单，搜索尚未完成" : "歌曲暂时无法读取"}</p>
          <button className="text-button" type="button" onClick={() => setRetry((value) => value + 1)}>重新读取歌曲</button></div>
          : <div className="catalog-empty" role="status"><p>{searching ? "正在读取整张歌单以搜索…" : "正在读取歌曲…"}</p></div>
      ) : rows.length === 0 ? <div className="catalog-empty"><p>歌单内没有匹配的歌曲</p><span>换一个歌名、歌手或专辑试试。</span></div> : (
        <div className="catalog-table-wrap playlist-detail__table">
          <table className="catalog-table playlist-songs__table">
            <thead><tr><th scope="col"><span className="sr-only">选择歌曲</span>#</th><th scope="col">封面</th><th scope="col">曲目</th><th scope="col">歌手</th><th scope="col">专辑</th><th scope="col">音质</th><th scope="col">时长</th></tr></thead>
            <tbody>{rows.map((song) => (
              <tr key={`${song.track.id}-${song.position}`} className={[currentTrackId === song.track.id ? "catalog-table__active" : "", checked.has(song.track.id) ? "playlist-songs__selected" : ""].join(" ")}>
                <td><label className="playlist-songs__check"><input type="checkbox" aria-label={`选择 ${song.track.title}`} checked={checked.has(song.track.id)} disabled={locked} onChange={() => toggle(song)} /><span>{String(song.position + 1).padStart(2, "0")}</span></label></td>
                {renderCells(song.track)}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {rowsReady ? <nav aria-label="歌单分页" className="playlist-detail__pagination">
        <button className="text-button" disabled={number <= 1} type="button" onClick={() => searching ? setResultPage(number - 1) : setBrowsePage(number - 1)}>上一页</button>
        <span>{searching ? `${matches.length} 首匹配 · ` : ""}第 {number} 页</span>
        <button className="text-button" disabled={!hasMore} type="button" onClick={() => searching ? setResultPage(number + 1) : setBrowsePage(number + 1)}>下一页</button>
      </nav> : null}
    </div>
  );
}
