import { useEffect, useRef, useState } from "react";
import { BookmarkButton } from "../library/PersonalLibrary";
import { getAlbumDetail, getAlbumSongs } from "../../backend/catalogBrowseAdapter";
import { getPlaylistSongs } from "../../backend/catalogAdapter";
import type { CatalogEntity } from "../../contracts/catalogBrowse";
import type { CatalogSong, CatalogSongPage } from "../../contracts/catalog";
import { ArtistPage } from "../artist/ArtistPage";
import { Icon } from "../../components/Icon";
import { enqueueAndPlayCatalogTrack, enqueueCatalogTrack, enqueueNextCatalogTrack, replaceAndPlayCatalogTracks } from "../player/catalogQueue";
import { AlbumArtwork } from "../stage/AlbumArtwork";

export function albumFromSong(song: Pick<CatalogSong, "album" | "albumId" | "albumPublishDate" | "coverCacheKey">): CatalogEntity | null {
  return song.albumId ? { kind: "album", id: song.albumId, title: song.album, publishDate: song.albumPublishDate ?? "", description: "", coverCacheKey: song.coverCacheKey } : null;
}
export function AlbumLink({ track, onOpen }: { track: Pick<CatalogSong, "album" | "albumId" | "albumPublishDate" | "coverCacheKey">; onOpen: (entity: CatalogEntity) => void }) {
  const album = albumFromSong(track);
  return album ? <button className="catalog-table__artist" type="button" aria-label={`查看专辑 ${track.album}`} onClick={() => onOpen(album)}>{track.album}</button> : <>{track.album}</>;
}
export function CatalogDetails({ entity, onBack }: { entity: CatalogEntity; onBack: () => void }) {
  const [history, setHistory] = useState<readonly CatalogEntity[]>([entity]);
  const [artistTabs, setArtistTabs] = useState<Record<string, "songs" | "albums">>({});
  const current = history.at(-1)!;
  function open(next: CatalogEntity) { setHistory(h => h.at(-1)?.kind === next.kind && h.at(-1)?.id === next.id ? h : [...h, next]); }
  function back() { if (history.length > 1) setHistory(h => h.slice(0, -1)); else onBack(); }
  return current.kind === "artist" ? <ArtistPage key={`artist:${current.id}`} artist={current} onBack={back}
    initialTab={artistTabs[current.id] ?? "songs"} onTabChange={tab => setArtistTabs(t => ({ ...t, [current.id]: tab }))}
    onOpenArtist={artist => open({ kind: "artist", ...artist })} onOpenAlbum={open} /> :
    <CollectionPage key={`${current.kind}:${current.id}`} entity={current} onBack={back} onOpen={open} />;
}

function CollectionPage({ entity, onBack, onOpen }: {
  entity: Exclude<CatalogEntity, { kind: "artist" }>; onBack: () => void; onOpen: (entity: CatalogEntity) => void;
}) {
  const [detail, setDetail] = useState(entity);
  const [pageNumber, setPageNumber] = useState(1);
  const [page, setPage] = useState<CatalogSongPage | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  function load(number: number, epoch: number) {
    return entity.kind === "album" ? getAlbumSongs(entity.id, epoch, number, 20) : getPlaylistSongs(entity.id, epoch, number, 20);
  }
  useEffect(() => {
    if (entity.kind !== "album") return;
    let active = true;
    void getAlbumDetail(entity.id).then(album => { if (active) setDetail({ kind: "album", ...album }); })
      .catch(() => { if (active) setNotice("专辑资料暂未能读取，仍可浏览歌曲。"); });
    return () => { active = false; };
  }, [entity.kind, entity.id, retry]);
  useEffect(() => {
    const epoch = ++generation.current;
    setPage(null); setError(false);
    let active = true;
    void load(pageNumber, epoch).then(result => { if (active && epoch === generation.current && result.generation === epoch) setPage(result); })
      .catch(() => { if (active && epoch === generation.current) setError(true); });
    return () => { active = false; };
  }, [entity.kind, entity.id, pageNumber, retry]);
  async function act(song: CatalogSong, action: "play" | "next" | "enqueue") {
    if (pending.current) return;
    pending.current = true; setBusy(true); setNotice("");
    const epoch = generation.current;
    try {
      if (action === "play") await enqueueAndPlayCatalogTrack(song);
      else if (action === "next") await enqueueNextCatalogTrack(song);
      else await enqueueCatalogTrack(song);
      if (alive.current && epoch === generation.current) setNotice(action === "play" ? `正在播放：${song.title}` : action === "next" ? `下一首播放：${song.title}` : `已加入队列：${song.title}`);
    } catch { if (alive.current && epoch === generation.current) setNotice(action === "play" ? "播放失败，原因显示在播放器" : "加入队列失败，请重试"); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function playAll() {
    if (pending.current || !page?.items.length) return;
    const epoch = generation.current;
    const isCurrent = () => alive.current && generation.current === epoch;
    pending.current = true; setBusy(true); setNotice("正在准备播放…");
    const songs: CatalogSong[] = []; const seen = new Set<string>();
    let hasMore = true;
    try {
      for (let n = 1; n <= 100 && hasMore && songs.length < 1000; n++) {
        if (!isCurrent()) return;
        const result = n === 1 && page.page === 1 ? page : await load(n, epoch);
        if (!isCurrent()) return;
        for (const song of result.items) { if (!seen.has(song.id)) { seen.add(song.id); songs.push(song); if (songs.length === 1000) break; } }
        hasMore = result.hasMore || result.items.some(song => !seen.has(song.id));
      }
      if (!isCurrent()) return;
      if (!songs.length) { setNotice("没有可播放的歌曲"); return; }
      const result = await replaceAndPlayCatalogTracks(songs, "preserve", isCurrent);
      if (isCurrent()) setNotice(hasMore || result?.truncated ? `已载入前 ${songs.length} 首并开始播放` : `已载入 ${songs.length} 首并开始播放`);
    } catch { if (isCurrent()) setNotice("播放全部失败，请检查播放器与队列"); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="catalog-detail-page" aria-label={entity.kind === "album" ? "专辑详情" : "歌单详情"}>
    <header className="catalog-detail-hero"><button type="button" className="text-button" onClick={onBack}>← 返回上一页</button>
      {detail.kind === "album" && <AlbumArtwork track={{ id: detail.id, title: detail.title, artist: "", coverCacheKey: detail.coverCacheKey, accent: "#789575", artworkVariant: "fern" }} />}
      <div><span className="section-label">{entity.kind === "album" ? "ALBUM RECORD" : "PLAYLIST RECORD"}</span><h1>{detail.title}</h1>
        <p>{detail.kind === "album" ? detail.publishDate || "发行日期未知" : `${detail.songCount} 首歌曲`}</p>
        {detail.kind === "album" && <BookmarkButton kind="album" id={detail.id} title={detail.title} coverCacheKey={detail.coverCacheKey} />}
        <button type="button" className="text-button text-button--primary" disabled={busy || !page?.items.length} onClick={() => void playAll()}><Icon name="play" size={16} />播放全部</button>
      </div>
    </header>
    {detail.description && <details className="catalog-biography"><summary>{entity.kind === "album" ? "专辑简介" : "歌单简介"}</summary><p>{detail.description}</p></details>}
    <p className="catalog-detail-notice" role="status">{notice}</p>
    {error ? <p role="alert">歌曲读取失败 <button type="button" onClick={() => setRetry(r => r + 1)}>重试</button></p> : !page ? <p role="status">正在读取歌曲…</p> : <>
      {!!page.warningCount && <p>已显示可用内容，{page.warningCount} 项歌曲暂未能读取。</p>}
      {!page.items.length && <p>暂时没有歌曲</p>}
      <ol className="catalog-detail-songs" start={(pageNumber - 1) * 20 + 1}>{page.items.map(song => <li key={song.id}>
        <div><strong>{song.title}</strong><small>{song.artists.map((artist, i) => <span key={`${artist.id}:${i}`}>
          {i > 0 && " / "}<button type="button" onClick={() => onOpen({ kind: "artist", ...artist })}>{artist.name}</button>
        </span>)} · {song.albumId ? <button type="button" onClick={() => { const album = albumFromSong(song); if (album) onOpen(album); }}>{song.album}</button> : song.album}</small></div>
        <span className="catalog-detail-song-actions"><button className="play-next-button" type="button" title="下一首播放" aria-label={`下一首播放 ${song.title}`} disabled={busy} onClick={() => void act(song, "next")}><Icon name="play-next" size={20} /></button>
          <button type="button" disabled={busy} aria-label={`播放 ${song.title}`} onClick={() => void act(song, "play")}>播放</button><button type="button" disabled={busy} aria-label={`加入队列 ${song.title}`} onClick={() => void act(song, "enqueue")}>＋</button></span>
      </li>)}</ol>
      <nav className="catalog-browse-pages" aria-label="详情歌曲分页"><button type="button" disabled={busy || pageNumber === 1} onClick={() => setPageNumber(p => p - 1)}>上一页</button><span>第 {pageNumber} 页{page.total !== undefined ? ` · ${page.total} 首` : ""}</span><button type="button" disabled={busy || !page.hasMore || pageNumber >= 100} onClick={() => setPageNumber(p => p + 1)}>下一页</button></nav>
    </>}
  </section>;
}
