import { lazy, Suspense, useRef, useState } from "react";
import { changeCollections, type Bookmark } from "../../backend/personalAdapter";
import { AlbumArtwork } from "../stage/AlbumArtwork";
import { ArtistAvatar } from "../artist/ArtistAvatar";
import { SavedQueues } from "./SavedQueues";
import { useCollections } from "./useCollections";
import type { CatalogEntity } from "../../contracts/catalogBrowse";
const CatalogDetails = lazy(() => import("../catalog/CatalogDetails").then(module => ({ default: module.CatalogDetails })));

export function PersonalLibrary() {
  const { data, error, refresh } = useCollections();
  const [entity, setEntity] = useState<CatalogEntity | null>(null);
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"all" | "album" | "artist">("all");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const rows = (data?.bookmarks ?? []).filter(b => (kind === "all" || kind === b.kind) && b.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())).slice().sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (sort === "name" ? a.title.localeCompare(b.title, "zh-CN") : (sort === "oldest" ? 1 : -1) * ((a.addedMs ?? 0) - (b.addedMs ?? 0))));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(rows.length / 30)));
  async function mutate(args: Record<string, unknown>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setNotice("");
    try { await changeCollections(args); } catch { setNotice("操作失败，请重试"); }
    finally { pending.current = false; setBusy(false); }
  }
  function open(b: Bookmark) { setEntity(b.kind === "artist" ? { kind: "artist", id: b.id, name: b.title, ...(b.coverCacheKey ? { avatarCacheKey: b.coverCacheKey } : {}) } : { kind: "album", id: b.id, title: b.title, description: "", publishDate: "", ...(b.coverCacheKey ? { coverCacheKey: b.coverCacheKey } : {}) }); }
  if (entity) return <Suspense fallback={<p role="status">正在打开详情…</p>}><CatalogDetails key={`${entity.kind}:${entity.id}`} entity={entity} onBack={() => setEntity(null)} /></Suspense>;
  return <section className="personal-library catalog-pane" aria-label="我的资料库"><header><span className="section-label">MY COLLECTION</span><h1>我的资料库</h1><p>保存在这台电脑的专辑、歌手和播放队列</p></header><SavedQueues />
    <h2>专辑与歌手书签</h2><div className="personal-actions"><input type="search" aria-label="搜索资料库" placeholder="搜索书签" value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }} />
      <select aria-label="资料库排序" value={sort} onChange={e => { setSort(e.target.value); setPage(1); }}><option value="newest">最近收藏</option><option value="oldest">最早收藏</option><option value="name">名称排序</option></select></div>
    <nav className="personal-actions" aria-label="书签分类">{([['all', '全部'], ['album', '专辑'], ['artist', '歌手']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={kind === id} onClick={() => { setKind(id); setPage(1); }}>{label}</button>)}</nav>
    {error ? <p role="alert">资料库读取失败 <button type="button" onClick={refresh}>重试</button></p> : !data ? <p role="status">正在读取资料库…</p> : <>
      {!rows.length && <p>{data.bookmarks.length ? "没有匹配的书签，试试其他分类或关键词。" : "在专辑或歌手详情点击“加入我的资料库”，即可在这里找到。"}</p>}
      <ul className="personal-list bookmark-list">{rows.slice((currentPage - 1) * 30, currentPage * 30).map(b => <li key={`${b.kind}:${b.id}`}>
        <button type="button" className="bookmark-open" onClick={() => open(b)}>{b.kind === "album" ? <AlbumArtwork compact track={{ id: b.id, title: b.title, artist: "", coverCacheKey: b.coverCacheKey ?? undefined, accent: "#789575", artworkVariant: "fern" }} /> : <ArtistAvatar size="compact" artist={{ id: b.id, name: b.title, avatarCacheKey: b.coverCacheKey ?? undefined }} />}<span><strong>{b.title}</strong><small>{b.pinned ? "置顶 · " : ""}{b.kind === "album" ? "专辑" : "歌手"}</small></span></button>
        <div className="personal-actions"><button type="button" disabled={busy} aria-label={`${b.pinned ? "取消置顶" : "置顶"} ${b.title}`} onClick={() => void mutate({ action: "pinBookmark", kind: b.kind, id: b.id, pinned: !b.pinned })}>{b.pinned ? "取消置顶" : "置顶"}</button><button type="button" disabled={busy} aria-label={`移除书签 ${b.title}`} onClick={() => void mutate({ action: "bookmark", kind: b.kind, id: b.id, title: b.title, saved: false })}>移除</button></div>
      </li>)}</ul>
      {rows.length > 30 && <nav className="personal-actions" aria-label="资料库分页"><button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage} / {Math.ceil(rows.length / 30)}</span><button type="button" disabled={currentPage * 30 >= rows.length} onClick={() => setPage(currentPage + 1)}>下一页</button></nav>}
    </>}
    <p role="status">{notice}</p>
  </section>;
}
