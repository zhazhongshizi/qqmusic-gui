import { useEffect, useMemo, useRef, useState } from "react";
import { getRecommendedPlaylists, getRecommendedSongs, type RecommendationKind } from "../../backend/catalogDiscoveryAdapter";
import type { CatalogSong, CatalogSongPage } from "../../contracts/catalog";
import type { CatalogEntityPage } from "../../contracts/catalogBrowse";
import { MAX_CATALOG_QUEUE_ITEMS, enqueueAndPlayCatalogTrack, enqueueCatalogTrack, enqueueCatalogTracks, enqueueNextCatalogTrack } from "../player/catalogQueue";
import { nativeStartRadar } from "../../backend/nativeQueueAdapter";
import { playerActions } from "../player/playerStore";
import { recommendationPages } from "./recommendationPages";

export type RecommendationAction = "play" | "next" | "enqueue";

/** Shared requests and queue semantics; presentation belongs to each mode. */
export function useRecommendations({ kind, accountKey, active = true, pageSize }: {
  kind: RecommendationKind; accountKey: string; active?: boolean; pageSize?: number;
}) {
  const context = `${accountKey}:${kind}:${pageSize ?? "upstream"}`;
  const [pagination, setPagination] = useState({ context, number: 1 });
  const pageNumber = pagination.context === context ? pagination.number : 1;
  const [retry, setRetry] = useState(0);
  const paged = useMemo(() => pageSize ? recommendationPages(async (generation, page) => {
    const result = kind === "playlists" ? await getRecommendedPlaylists(generation, page) : await getRecommendedSongs(kind, generation, page);
    return kind === "guess" ? { ...result, hasMore: false } : result;
  }, pageSize) : null, [kind, accountKey, retry, pageSize]);
  const key = `${context}:${pageNumber}:${retry}`;
  const [state, setState] = useState<{ key: string; page?: CatalogSongPage | CatalogEntityPage; error?: boolean }>({ key: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ key: "", text: "" });
  const generation = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(false);
  const current = useRef({ key, active, state });
  current.current = { key, active, state };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    const epoch = ++generation.current;
    // A hidden shelf remains mounted so details/back preserve its loaded page.
    if (!active || current.current.state.key === key) return;
    let alive = true;
    const request = paged ? paged(pageNumber, epoch) : kind === "playlists" ? getRecommendedPlaylists(epoch, pageNumber) : getRecommendedSongs(kind, epoch, pageNumber);
    void request.then(page => {
      if (alive && epoch === generation.current && page.generation === epoch) setState({ key, page });
    }).catch(() => { if (alive && epoch === generation.current) setState({ key, error: true }); });
    return () => { alive = false; generation.current++; };
  }, [key, kind, pageNumber, active, paged]);
  async function act(song: CatalogSong, action: RecommendationAction) {
    if (pending.current || !current.current.active) return false;
    pending.current = true; setBusy(true); setMessage({ key, text: "" });
    const epoch = generation.current;
    const isCurrent = () => mounted.current && current.current.active && current.current.key === key && epoch === generation.current;
    try {
      if (action === "play") await enqueueAndPlayCatalogTrack(song);
      else if (action === "next") await enqueueNextCatalogTrack(song);
      else await enqueueCatalogTrack(song);
      if (isCurrent()) { setMessage({ key, text: action === "play" ? `正在播放：${song.title}` : action === "next" ? `下一首播放：${song.title}` : `已加入队列：${song.title}` }); return true; }
      return false;
    } catch { if (isCurrent()) setMessage({ key, text: "操作失败，请重试" }); return false; }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function actAll() {
    const loaded = current.current.state;
    if (pending.current || !current.current.active || kind === "playlists" ||
        loaded.key !== key || !loaded.page?.items.length) return false;
    pending.current = true; setBusy(true);
    setMessage({ key, text: kind === "radar" ? "正在读取首批雷达推荐…" : "正在读取全部推荐…" });
    const epoch = generation.current;
    const isCurrent = () => mounted.current && current.current.active && current.current.key === key && epoch === generation.current;
    const songs: CatalogSong[] = [], seen = new Set<string>();
    let hasMore = true, queueAttempted = false;
    try {
      if (kind === "radar") {
        queueAttempted = true;
        const session = await nativeStartRadar();
        if (!isCurrent()) return false;
        await playerActions.hydrateNativeSession(session);
        if (!isCurrent()) return false;
        setMessage({ key, text: `已载入 ${session.queue.items.length} 首雷达推荐并开始播放` });
        return true;
      }
      // Read from the shelf cache, including overflow beyond its nine visible tapes.
      // Finish reading before changing the queue so a failed page cannot clear it.
      for (let number = 1; hasMore && songs.length < MAX_CATALOG_QUEUE_ITEMS; number++) {
        if (!isCurrent()) return false;
        const result = (paged ? await paged(number, epoch) : number === pageNumber ? loaded.page :
          await getRecommendedSongs(kind, epoch, number)) as CatalogSongPage;
        if (!isCurrent()) return false;
        if (paged && result.generation !== epoch) throw new Error("stale_recommendations");
        for (const song of result.items) {
          if (!seen.has(song.id) && songs.length < MAX_CATALOG_QUEUE_ITEMS) {
            seen.add(song.id); songs.push(song);
          }
        }
        hasMore = result.hasMore && paged !== null;
      }
      if (!isCurrent()) return false;
      if (!songs.length) { setMessage({ key, text: "没有可加入的推荐歌曲" }); return false; }
      queueAttempted = true;
      await enqueueCatalogTracks(songs);
      if (!isCurrent()) return false;
      setMessage({ key, text: `已将${hasMore ? "前" : "全部"} ${songs.length} 首推荐加入播放列表` });
      return true;
    } catch {
      if (isCurrent()) setMessage({ key, text: kind === "radar" ? "雷达播放未能启动，请检查播放器后重试" : !queueAttempted ? "读取全部推荐失败，播放列表未改动，请重试" :
        "操作失败，请检查播放列表后重试" });
      return false;
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return {
    page: state.key === key ? state.page : undefined,
    error: state.key === key && !!state.error,
    pageNumber, busy, notice: message.key === key ? message.text : "", act, actAll,
    refresh: () => { if (active && !pending.current) { setMessage({ key, text: "" }); setRetry(value => value + 1); } },
    goToPage: (number: number) => { if (active && !pending.current) setPagination({ context, number }); },
  };
}
