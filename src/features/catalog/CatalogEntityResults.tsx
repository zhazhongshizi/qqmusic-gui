import { useEffect, useRef, useState } from "react";
import { getArtistAlbums, searchCatalogEntities } from "../../backend/catalogBrowseAdapter";
import type { CatalogEntity, CatalogEntityPage, CatalogSearchType } from "../../contracts/catalogBrowse";
import { ArtistAvatar } from "../artist/ArtistAvatar";
import { AlbumArtwork } from "../stage/AlbumArtwork";

export const SEARCH_TYPES: readonly [CatalogSearchType, string][] = [["songs", "歌曲"], ["artists", "歌手"], ["albums", "专辑"], ["playlists", "歌单"]];
export function SearchTypeTabs({ value, onChange }: { value: CatalogSearchType; onChange: (type: CatalogSearchType) => void }) {
  return <div className="catalog-type-tabs" aria-label="搜索类型">{SEARCH_TYPES.map(([type, label]) =>
    <button type="button" key={type} aria-pressed={value === type} onClick={() => onChange(type)}>{label}</button>)}</div>;
}
export function CatalogEntityResults({ kind, keyword = "", artistId, onOpen, page: controlledPage, onPageChange }: {
  kind: Exclude<CatalogSearchType, "songs">; keyword?: string; artistId?: string; onOpen: (entity: CatalogEntity) => void;
  page?: number; onPageChange?: (page: number) => void;
}) {
  const [localPage, setLocalPage] = useState(1);
  const page = controlledPage ?? localPage;
  function setPage(next: number) { if (onPageChange) onPageChange(next); else setLocalPage(next); }
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ key: string; result?: CatalogEntityPage; error?: boolean }>({ key: "" });
  const generation = useRef(0);
  const key = `${kind}:${keyword.trim()}:${artistId ?? ""}:${page}:${retry}`;
  useEffect(() => { setLocalPage(1); }, [kind, keyword, artistId]);
  useEffect(() => {
    const epoch = ++generation.current;
    if (!artistId && !keyword.trim()) return;
    let active = true;
    const timer = setTimeout(() => {
      const request = artistId ? getArtistAlbums(artistId, epoch, page) : searchCatalogEntities(kind, keyword, epoch, page);
      void request.then(result => {
        if (active && epoch === generation.current && result.generation === epoch) setState({ key, result });
      }).catch(() => { if (active && epoch === generation.current) setState({ key, error: true }); });
    }, artistId ? 0 : 300);
    return () => { active = false; clearTimeout(timer); };
  }, [key, kind, keyword, artistId, page]);
  const result = state.key === key ? state.result : undefined;
  return <section className="catalog-entity-results" aria-label={artistId ? "歌手专辑" : `${SEARCH_TYPES.find(([type]) => type === kind)?.[1]}搜索结果`}>
    {!artistId && !keyword.trim() ? <p>输入关键词开始搜索</p> : state.key === key && state.error ?
      <p role="alert">读取失败 <button type="button" onClick={() => setRetry(r => r + 1)}>重试</button></p> : !result ? <p role="status">正在读取…</p> : <>
      {!!result.warningCount && <p role="status">已显示可用内容，{result.warningCount} 项暂未能读取。</p>}
      {result.items.length ? <ul className="catalog-entity-list">{result.items.map(item => <li key={`${item.kind}:${item.id}`}>
        <button className="catalog-entity-card" type="button" onClick={() => onOpen(item)}>
          {item.kind === "artist" ? <ArtistAvatar artist={item} /> : item.kind === "album" ?
            <AlbumArtwork compact track={{ id: item.id, title: item.title, artist: "", coverCacheKey: item.coverCacheKey, accent: "#789575", artworkVariant: "fern" }} /> : <span className="catalog-entity-monogram" aria-hidden="true">♫</span>}
          <span><strong>{item.kind === "artist" ? item.name : item.title}</strong><small>{item.kind === "artist" ? "歌手 · 查看歌曲与专辑" : item.kind === "album" ? item.publishDate || "专辑" : `${item.songCount} 首歌曲`}</small></span>
          <span aria-hidden="true">↗</span>
        </button>
      </li>)}</ul> : <p>没有找到匹配内容</p>}
      <nav className="catalog-browse-pages" aria-label={artistId ? "歌手专辑分页" : "分类搜索分页"}>
        <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span>第 {page} 页{result.total !== undefined ? ` · 共 ${result.total} 项` : ""}</span>
        <button type="button" disabled={!result.hasMore || page >= 100} onClick={() => setPage(page + 1)}>下一页</button>
      </nav>
    </>}
  </section>;
}
