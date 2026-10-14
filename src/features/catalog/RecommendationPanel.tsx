import { type RecommendationKind } from "../../backend/catalogDiscoveryAdapter";
import type { CatalogSong, CatalogSongPage } from "../../contracts/catalog";
import type { CatalogEntity, CatalogEntityPage } from "../../contracts/catalogBrowse";
import { Icon } from "../../components/Icon";
import { AlbumArtwork } from "../stage/AlbumArtwork";
import { useRecommendations } from "./useRecommendations";
import { AlbumLink } from "./CatalogDetails";

export type DiscoveryTab = "newSongs" | RecommendationKind;
export const DISCOVERY_TABS: readonly [DiscoveryTab, string][] = [
  ["newSongs", "新歌"], ["guess", "猜你喜欢"], ["radar", "雷达推荐"], ["playlists", "推荐歌单"],
];
export function DiscoveryTabs({ value, onChange, includeNewSongs = true }: {
  value: DiscoveryTab; onChange: (value: DiscoveryTab) => void; includeNewSongs?: boolean;
}) {
  return <div className="catalog-type-tabs discovery-tabs" aria-label="发现分类">
    {DISCOVERY_TABS.filter(([key]) => includeNewSongs || key !== "newSongs").map(([key, label]) =>
      <button type="button" key={key} aria-pressed={value === key} onClick={() => onChange(key)}>{label}</button>)}
  </div>;
}

export function RecommendationPanel({ kind, accountKey, active = true, onOpen }: {
  kind: RecommendationKind; accountKey: string; active?: boolean; onOpen: (entity: CatalogEntity) => void;
}) {
  const { page, error, pageNumber, busy, notice, act, refresh, goToPage } = useRecommendations({ kind, accountKey, active });
  const label = DISCOVERY_TABS.find(([tab]) => tab === kind)![1];
  return <section className="catalog-recommendations" aria-label={label}>
    <header className="recommendation-heading"><div><h2>{label}</h2><p>QQ 音乐实时推荐{accountKey.startsWith("authenticated:") ? " · 当前账号" : " · 登录后可获得个人推荐"}</p></div>
      <button type="button" className="text-button" disabled={busy || !active}
        onClick={refresh}>刷新推荐</button></header>
    {error ? <p role="alert">推荐暂时不可用，检查网络后可刷新重试。</p> :
      !page ? <p role="status">正在读取推荐…</p> : <>
      {!!page.warningCount && <p role="status">部分内容暂时不可用，已显示可用推荐。</p>}
      {!page.items.length ? <p>暂时没有推荐内容，稍后刷新试试。</p> : kind === "playlists" ?
        <ul className="catalog-entity-list recommendation-playlists">{(page as CatalogEntityPage).items.map(entity => {
          if (entity.kind !== "playlist") return null;
          return <li key={entity.id}><button type="button" className="catalog-entity-card" onClick={() => onOpen(entity)}>
            <span className="catalog-entity-monogram" aria-hidden="true"><Icon name="library" size={25} /></span>
            <span><strong>{entity.title}</strong><small>{entity.songCount} 首 · {entity.listenCount.toLocaleString()} 次播放</small>
              {!!entity.description && <small className="recommendation-description">{entity.description}</small>}</span><span aria-hidden="true">↗</span>
          </button></li>;
        })}</ul> : <ol className="catalog-detail-songs recommendation-songs">{(page as CatalogSongPage).items.map(song =>
          <li key={song.id}><AlbumArtwork compact track={{ ...song, accent: "#789575", artworkVariant: "fern" }} />
            <div><strong>{song.title}</strong><small>{song.artists.map((artist, index) =>
              <span key={`${artist.id}:${index}`}>{index > 0 && " / "}<button type="button" onClick={() => onOpen({ kind: "artist", ...artist })}>{artist.name}</button></span>)}
              {" · "}<AlbumLink track={song} onOpen={onOpen} /></small></div>
            <span className="catalog-detail-song-actions"><button type="button" className="play-next-button"
              disabled={busy} aria-label={`下一首播放 ${song.title}`} title="下一首播放" onClick={() => void act(song, "next")}><Icon name="play-next" size={20} /></button>
              <button type="button" disabled={busy} aria-label={`播放 ${song.title}`} onClick={() => void act(song, "play")}>播放</button>
              <button type="button" disabled={busy} aria-label={`加入队列 ${song.title}`} onClick={() => void act(song, "enqueue")}>＋</button></span>
          </li>)}</ol>}
      {kind !== "guess" && <nav className="catalog-browse-pages" aria-label="推荐分页">
        <button type="button" disabled={busy || pageNumber === 1} onClick={() => goToPage(pageNumber - 1)}>上一页</button>
        <span>第 {pageNumber} 页</span><button type="button" disabled={busy || !page.hasMore || pageNumber >= 100}
          onClick={() => goToPage(pageNumber + 1)}>下一页</button></nav>}
    </>}
    {!!notice && <p role="status" className="recommendation-notice">{notice}</p>}
  </section>;
}
