import { Fragment, useEffect, useState } from "react";
import type { CatalogSong, CatalogSongPage } from "../../contracts/catalog";
import type { CatalogEntity, CatalogEntityPage } from "../../contracts/catalogBrowse";
import type { RecommendationKind } from "../../backend/catalogDiscoveryAdapter";
import { getCoverImage } from "../../backend/coverAdapter";
import { Icon } from "../../components/Icon";
import { AlbumLink } from "../catalog/CatalogDetails";
import { DISCOVERY_TABS } from "../catalog/RecommendationPanel";
import { useRecommendations } from "../catalog/useRecommendations";

type Item = { kind: "song"; song: CatalogSong } | { kind: "playlist"; playlist: Extract<CatalogEntity, { kind: "playlist" }> };
function id(item: Item) { return item.kind === "song" ? item.song.id : item.playlist.id; }
function title(item: Item) { return item.kind === "song" ? item.song.title : item.playlist.title; }
function time(ms: number) { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }

function CoverSticker({ song }: { song: CatalogSong }) {
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    let alive = true; let url: string | undefined;
    setImage(null);
    if (song.coverCacheKey) void getCoverImage(song.coverCacheKey).then(payload => {
      if (!alive) return;
      url = URL.createObjectURL(new Blob([new Uint8Array(payload.bytes).buffer], { type: payload.mimeType }));
      setImage({ key: song.coverCacheKey!, url });
    }).catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [song.coverCacheKey]);
  return <span className="discovery-cover" aria-hidden="true">{image && image.key === song.coverCacheKey
    ? <img src={image.url} alt="" onError={() => setImage(null)} /> : <Icon name="library" size={22} />}</span>;
}

function TapeFace({ item, index }: { item: Item; index: number }) {
  return <span className="discovery-tape" aria-hidden="true">
    <span className="discovery-tape-label">
      <span className="discovery-tape-code">RHINE / {item.kind === "song" ? "SINGLE" : "PLAYLIST"}<span>{String(index + 1).padStart(2, "0")}</span></span>
      <span className="discovery-tape-print">
        {item.kind === "song" && <CoverSticker song={item.song} />}
        <span><strong>{title(item)}</strong><small>{item.kind === "song" ? item.song.artist : `${item.playlist.songCount} 首歌曲`}</small></span>
      </span>
    </span>
    <span className="discovery-tape-window"><i /><span /><i /></span>
    <span className="discovery-tape-foot"><span>A</span><i /><span>{item.kind === "song" && item.song.durationMs > 0 ? time(item.song.durationMs) : "QQ MUSIC"}</span></span>
  </span>;
}

export function RecommendationShelf({ kind, accountKey, active, hidden, onOpen }: {
  kind: RecommendationKind; accountKey: string; active: boolean; hidden: boolean; onOpen: (entity: CatalogEntity) => void;
}) {
  const { page, error, pageNumber, busy, notice, act, refresh, goToPage } = useRecommendations({ kind, accountKey, active });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [columns, setColumns] = useState(() => typeof matchMedia === "function" && matchMedia("(max-width: 639px)").matches ? 1 : 2);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(max-width: 639px)");
    const update = () => setColumns(query.matches ? 1 : 2);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const items: Item[] = !page ? [] : kind === "playlists"
    ? (page as CatalogEntityPage).items.filter((entity): entity is Extract<CatalogEntity, { kind: "playlist" }> => entity.kind === "playlist").map(playlist => ({ kind: "playlist", playlist }))
    : (page as CatalogSongPage).items.map(song => ({ kind: "song", song }));
  const selected = items.find(item => id(item) === selectedId) ?? items[0];
  const selectedKey = selected ? id(selected) : null;
  useEffect(() => { if (selectedKey !== null) setSelectedId(selectedKey); }, [selectedKey]);
  const selectedIndex = selected ? items.indexOf(selected) : -1;
  const inlineAfter = Math.min(items.length - 1, Math.floor(selectedIndex / columns) * columns + columns - 1);
  const label = DISCOVERY_TABS.find(([tab]) => tab === kind)![1];
  function dossier() {
    if (!selected) return null;
    return <>
      <p className="rhine-eyebrow">{selected.kind === "song" ? "TRACK" : "PLAYLIST"} / {String(selectedIndex + 1).padStart(2, "0")}</p>
      <h2>{title(selected)}</h2>
      {selected.kind === "song" ? <>
        <dl><div><dt>歌手</dt><dd>{selected.song.artists.length ? selected.song.artists.map((artist, index) => <Fragment key={`${artist.id}:${index}`}>
          {index > 0 && " / "}<button type="button" onClick={() => onOpen({ kind: "artist", ...artist })}>{artist.name}</button>
        </Fragment>) : selected.song.artist}</dd></div>
          <div><dt>专辑</dt><dd><AlbumLink track={selected.song} onOpen={onOpen} /></dd></div>
          <div><dt>时长</dt><dd>{selected.song.durationMs > 0 ? time(selected.song.durationMs) : "时长未知"}</dd></div></dl>
        <div className="discovery-dossier-actions">
          <button className="discovery-primary" type="button" disabled={busy || !active} onClick={() => void act(selected.song, "play")}><Icon name="play" size={16} />播放</button>
          <div><button type="button" disabled={busy || !active} onClick={() => void act(selected.song, "next")}><Icon name="play-next" size={18} />下一首播放</button>
            <button type="button" disabled={busy || !active} onClick={() => void act(selected.song, "enqueue")}><span aria-hidden="true">＋</span>加入队列</button></div>
        </div>
      </> : <>
        <dl><div><dt>曲目</dt><dd>{selected.playlist.songCount} 首</dd></div><div><dt>播放</dt><dd>{selected.playlist.listenCount.toLocaleString()} 次</dd></div></dl>
        {selected.playlist.description && <p className="discovery-description">{selected.playlist.description}</p>}
        <button className="discovery-primary" type="button" onClick={() => onOpen(selected.playlist)}>查看歌单 ↗</button>
      </>}
    </>;
  }
  return <section className="discovery-recommendations" aria-label={label} hidden={hidden}>
    <div className="discovery-toolbar"><p>{accountKey.startsWith("authenticated:") ? "当前账号" : "登录后可获得个人推荐"}{page && ` · 本页 ${items.length} ${kind === "playlists" ? "张歌单" : "首"}`}</p>
      <button type="button" disabled={busy || !active} onClick={refresh}><span aria-hidden="true">↻</span> 刷新推荐</button></div>
    {error ? <p className="discovery-state" role="alert">推荐暂时不可用，检查网络后可刷新重试。</p> : !page ? <p className="discovery-state" role="status">正在读取推荐…</p> : <>
      {!!page.warningCount && <p className="discovery-warning" role="status">部分内容暂时不可用，已显示可用推荐。</p>}
      {!items.length ? <p className="discovery-state">暂时没有推荐内容，稍后刷新试试。</p> : <div className="discovery-layout">
        <div className="discovery-shelf" role="group" aria-label={`${label}磁带架`}>
          {items.map((item, index) => <Fragment key={id(item)}>
            <article className="discovery-shelf-item" data-selected={selectedKey === id(item)}>
              <button type="button" className="discovery-tape-select" aria-label={`选择${item.kind === "song" ? "歌曲" : "歌单"} ${title(item)}`} aria-pressed={selectedKey === id(item)} onClick={() => setSelectedId(id(item))}>
                <TapeFace item={item} index={index} />
              </button>
              <div className="discovery-card-caption"><span><strong title={title(item)}>{title(item)}</strong><small>{item.kind === "song" ? item.song.artist : `${item.playlist.songCount} 首 · ${item.playlist.listenCount.toLocaleString()} 次播放`}</small></span>
                <button type="button" className="discovery-card-action" disabled={busy || !active} aria-label={`${item.kind === "song" ? "播放" : "打开歌单"} ${title(item)}`} onClick={() => {
                  setSelectedId(id(item)); if (item.kind === "song") void act(item.song, "play"); else onOpen(item.playlist);
                }}>{item.kind === "song" ? <Icon name="play" size={16} /> : <span aria-hidden="true">↗</span>}</button>
              </div>
            </article>
            {index === inlineAfter && <aside className="discovery-dossier discovery-dossier-inline" aria-label="选中磁带档案">{dossier()}</aside>}
          </Fragment>)}
        </div>
        <aside className="discovery-dossier discovery-dossier-desktop" aria-label="选中磁带档案">{dossier()}</aside>
      </div>}
      {kind !== "guess" && <nav className="discovery-pages" aria-label="推荐分页">
        <button type="button" disabled={busy || pageNumber === 1} onClick={() => goToPage(pageNumber - 1)}>上一页</button><span>第 {pageNumber} 页</span>
        <button type="button" disabled={busy || !page.hasMore || pageNumber >= 100} onClick={() => goToPage(pageNumber + 1)}>下一页</button>
      </nav>}
    </>}
    <p className="discovery-notice" role="status" aria-live="polite">{notice}</p>
  </section>;
}
