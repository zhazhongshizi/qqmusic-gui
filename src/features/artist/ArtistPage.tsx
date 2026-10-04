import { useEffect, useRef, useState } from "react";

import { getArtistDetail, getArtistSongs } from "../../backend/artistAdapter";
import { Icon } from "../../components/Icon";
import type { ArtistDetail, ArtistRef } from "../../contracts/artist";
import type { CatalogSong, CatalogSongPage } from "../../contracts/catalog";
import {
  CatalogQueuePlaybackError,
  enqueueAndPlayCatalogTrack,
  replaceAndPlayCatalogTracks,
} from "../player/catalogQueue";
import { getCurrentTrack, usePlayerSelector } from "../player/playerStore";
import { AlbumArtwork, type ArtworkTrack } from "../stage/AlbumArtwork";
import { CatalogEntityResults } from "../catalog/CatalogEntityResults";
import type { CatalogEntity } from "../../contracts/catalogBrowse";
import { ArtistAvatar } from "./ArtistAvatar";
import { BookmarkButton } from "../library/PersonalLibrary";

const ARTIST_PAGE_SIZE = 30;
const MAX_BATCH_SONGS = 1_000;
const MAX_BATCH_PAGES = Math.ceil(MAX_BATCH_SONGS / ARTIST_PAGE_SIZE);
const ARTWORK_VARIANTS: readonly ArtworkTrack["artworkVariant"][] = ["fern", "moon", "tide", "train", "mist"];
const ARTWORK_ACCENTS = ["#789575", "#9f9878", "#61858b", "#8c765e", "#72847c"] as const;

type ArtistPageState =
  | { readonly kind: "loading" }
  | { readonly kind: "notFound" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly page: CatalogSongPage };

interface ArtistPageProps {
  readonly artist: ArtistRef;
  readonly onBack: () => void;
  readonly onOpenArtist: (artist: ArtistRef) => void;
  readonly initialTab?: "songs" | "albums";
  readonly onTabChange?: (tab: "songs" | "albums") => void;
  readonly onOpenAlbum?: (album: CatalogEntity) => void;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds === 0) return "--:--";
  const totalSeconds = Math.floor(milliseconds / 1_000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function qualityLabel(track: CatalogSong): string {
  const quality = track.qualityCandidates.find((candidate) => candidate.available)?.quality;
  if (quality === "flac") return "FLAC";
  if (quality === "320k") return "MP3 320k";
  if (quality === "128k") return "MP3 128k";
  return "不可播放";
}

function artworkFor(track: CatalogSong): ArtworkTrack {
  const seed = [...track.id].reduce((value, character) => value + character.codePointAt(0)!, 0);
  const index = seed % ARTWORK_VARIANTS.length;
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    accent: ARTWORK_ACCENTS[index] ?? ARTWORK_ACCENTS[0],
    artworkVariant: ARTWORK_VARIANTS[index] ?? "fern",
    ...(track.coverCacheKey ? { coverCacheKey: track.coverCacheKey } : {}),
  };
}

function artistRefsFor(track: CatalogSong): readonly ArtistRef[] {
  return Array.isArray(track.artists) && track.artists.length > 0
    ? track.artists
    : [{ id: "", name: track.artist }];
}

export function ArtistPage({ artist, onBack, onOpenArtist, onOpenAlbum, initialTab = "songs", onTabChange }: ArtistPageProps) {
  const currentTrack = usePlayerSelector(getCurrentTrack);
  const [tab, setTab] = useState<"songs" | "albums">(initialTab);
  const [detail, setDetail] = useState<ArtistDetail>(artist);
  const [state, setState] = useState<ArtistPageState>({ kind: "loading" });
  const [retryToken, setRetryToken] = useState(0);
  const [batchMode, setBatchMode] = useState<"all" | "shuffle" | null>(null);
  const [notice, setNotice] = useState("");
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let active = true;
    setDetail(artist);
    setState({ kind: "loading" });
    setBatchMode(null);
    setNotice("");

    const detailRequest = getArtistDetail(artist.id);
    const songsRequest = getArtistSongs(artist.id, generation, 1, ARTIST_PAGE_SIZE);
    void Promise.allSettled([detailRequest, songsRequest]).then(([detailResult, songsResult]) => {
      if (!active || generation !== generationRef.current) return;
      if (detailResult.status === "rejected") {
        setState({ kind: "error" });
        return;
      }
      if (detailResult.value === null) {
        setState({ kind: "notFound" });
        return;
      }
      if (songsResult.status === "rejected") {
        setDetail(detailResult.value);
        setState({ kind: "error" });
        return;
      }
      setDetail(detailResult.value);
      setState({ kind: "ready", page: songsResult.value });
    });

    return () => { active = false; generationRef.current++; };
  }, [artist.id, artist.name, retryToken]);

  async function openPage(pageNumber: number) {
    if (pageNumber < 1 || state.kind !== "ready") return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setState({ kind: "loading" });
    setNotice("");
    try {
      const page = await getArtistSongs(artist.id, generation, pageNumber, ARTIST_PAGE_SIZE);
      if (generation !== generationRef.current) return;
      setState({ kind: "ready", page });
    } catch {
      if (generation === generationRef.current) setState({ kind: "error" });
    }
  }

  async function playOne(track: CatalogSong) {
    setNotice("");
    try {
      await enqueueAndPlayCatalogTrack(track);
    } catch {
      setNotice("播放失败，原因显示在底部播放器");
    }
  }

  async function playCollection(mode: "preserve" | "shuffle") {
    if (batchMode || state.kind !== "ready") return;
    const generation = generationRef.current;
    const firstPage = state.page.page === 1 ? state.page : null;
    const songs: CatalogSong[] = [];
    const seen = new Set<string>();
    let pageNumber = 1;
    let hasMore = true;
    setBatchMode(mode === "shuffle" ? "shuffle" : "all");
    setNotice("正在读取歌手歌曲…");
    try {
      while (hasMore && pageNumber <= MAX_BATCH_PAGES && songs.length < MAX_BATCH_SONGS) {
        if (generation !== generationRef.current) return;
        const page = pageNumber === 1 && firstPage
          ? firstPage
          : await getArtistSongs(artist.id, generation, pageNumber, ARTIST_PAGE_SIZE);
        if (generation !== generationRef.current) return;
        for (const song of page.items) {
          if (!seen.has(song.id)) {
            seen.add(song.id);
            songs.push(song);
            if (songs.length >= MAX_BATCH_SONGS) break;
          }
        }
        hasMore = page.hasMore;
        pageNumber += 1;
      }
      if (songs.length === 0) {
        setNotice("这个歌手暂时没有可播放的歌曲");
        return;
      }
      if (generation !== generationRef.current) return;
      const result = await replaceAndPlayCatalogTracks(songs, mode, () => generation === generationRef.current);
      if (!result || generation !== generationRef.current) return;
      setNotice(hasMore || result.truncated
        ? `已按队列上限载入前 ${songs.length} 首并开始播放`
        : `已载入 ${songs.length} 首并开始播放`);
    } catch (error) {
      setNotice(error instanceof CatalogQueuePlaybackError && error.queueReplaced
        ? "队列已更新，但播放启动失败；原因显示在底部播放器"
        : "批量播放失败；现有本地队列未改变");
    } finally {
      if (generation === generationRef.current) setBatchMode(null);
    }
  }

  const page = state.kind === "ready" ? state.page : null;
  const countLabel = page?.total ?? page?.items.length ?? 0;
  const canBatchPlay = tab === "songs" && state.kind === "ready" && Boolean(page?.items.length) && !batchMode;

  return (
    <section aria-labelledby="artist-page-title" className="artist-page">
      <header className="artist-page__hero">
        <button className="text-button artist-page__back" onClick={onBack} type="button"><Icon name="back" size={16} />返回上一页</button>
        <ArtistAvatar artist={detail} />
        <div className="artist-page__identity">
          <span className="section-label">ARTIST RECORD</span>
          <h1 id="artist-page-title">{detail.name}</h1>
          <BookmarkButton kind="artist" id={detail.id} title={detail.name} coverCacheKey={detail.avatarCacheKey} />
          <p>{state.kind === "loading" ? "正在读取歌曲…" : `共 ${countLabel} 首歌曲`}</p>
        </div>
        <div className="artist-page__actions">
          <button className="text-button text-button--primary" disabled={!canBatchPlay} onClick={() => void playCollection("preserve")} type="button">
            <Icon name="play" size={16} />{batchMode === "all" ? "正在准备…" : "播放全部"}
          </button>
          <button className="text-button" disabled={!canBatchPlay} onClick={() => void playCollection("shuffle")} type="button">
            <Icon name="shuffle" size={16} />{batchMode === "shuffle" ? "正在准备…" : "随机播放"}
          </button>
        </div>
      </header>

      {detail.description && <details className="catalog-biography"><summary>歌手简介</summary><p>{detail.description}</p></details>}
      {onOpenAlbum && <div className="catalog-type-tabs" aria-label="歌手内容"><button type="button" disabled={Boolean(batchMode)} aria-pressed={tab === "songs"} onClick={() => { setTab("songs"); onTabChange?.("songs"); }}>歌曲</button><button type="button" disabled={Boolean(batchMode)} aria-pressed={tab === "albums"} onClick={() => { setTab("albums"); onTabChange?.("albums"); }}>专辑</button></div>}
      {notice ? <p aria-live="polite" className="artist-page__notice">{notice}</p> : null}
      {tab === "albums" && onOpenAlbum ? <CatalogEntityResults key={artist.id} kind="albums" artistId={artist.id} onOpen={onOpenAlbum} /> : state.kind === "loading" ? (
        <div aria-busy="true" aria-live="polite" className="catalog-empty"><p>正在读取歌手歌曲</p><span>歌曲列表会按页加载。</span></div>
      ) : state.kind === "notFound" ? (
        <div className="catalog-empty"><p>没有找到这个歌手</p><span>返回上一页后可以继续浏览其他歌曲。</span></div>
      ) : state.kind === "error" ? (
        <div aria-live="assertive" className="catalog-empty" role="alert"><p>歌手页面暂时不可用</p><span>请检查网络或稍后重新读取。</span><button className="text-button text-button--primary" onClick={() => setRetryToken((value) => value + 1)} type="button">重新读取</button></div>
      ) : page && page.items.length === 0 ? (
        <div className="catalog-empty"><p>这个歌手暂时没有可显示的歌曲</p><span>可以返回上一页继续搜索。</span></div>
      ) : page ? (
        <>
          {page.warningCount > 0 ? <p aria-live="polite" className="artist-page__partial">已显示可用内容，{page.warningCount} 项歌曲暂未能读取。</p> : null}
          <div className="catalog-table-wrap artist-page__table">
            <table className="catalog-table">
              <thead><tr><th scope="col">#</th><th scope="col">封面</th><th scope="col">曲目</th><th scope="col">歌手</th><th scope="col">专辑</th><th scope="col">音质</th><th scope="col">时长</th></tr></thead>
              <tbody>{page.items.map((track, index) => {
                const active = currentTrack?.id === track.id;
                return (
                  <tr className={active ? "catalog-table__active" : undefined} key={track.id}>
                    <td><span className={active ? "catalog-needle catalog-needle--active" : "catalog-needle"}>{active ? <span className="sr-only">当前曲目</span> : String((page.page - 1) * ARTIST_PAGE_SIZE + index + 1).padStart(2, "0")}</span></td>
                    <td><AlbumArtwork compact track={artworkFor(track)} /></td>
                    <td><button className="catalog-table__title" onClick={() => void playOne(track)} type="button"><strong>{track.title}</strong><small>{track.id}</small></button></td>
                    <td><span className="artist-page__artists">{artistRefsFor(track).map((item, artistIndex) => (
                      <span key={`${item.id || item.name}-${artistIndex}`}>
                        {artistIndex > 0 ? <span aria-hidden="true"> / </span> : null}
                        {item.id ? <button className="artist-page__artist-link" onClick={() => onOpenArtist(item)} type="button">{item.name}</button> : <span>{item.name}</span>}
                      </span>
                    ))}</span></td>
                    <td>{track.albumId && onOpenAlbum ? <button className="catalog-table__artist" type="button" onClick={() => onOpenAlbum({ kind: "album", id: track.albumId!, title: track.album, publishDate: track.albumPublishDate ?? "", description: "", coverCacheKey: track.coverCacheKey })}>{track.album}</button> : track.album || "未知专辑"}</td>
                    <td><span className="quality-tag">{qualityLabel(track)}</span></td>
                    <td className="catalog-table__duration">{formatDuration(track.durationMs)}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          <nav aria-label="歌手歌曲分页" className="playlist-detail__pagination artist-page__pagination">
            <button className="text-button" disabled={page.page <= 1 || Boolean(batchMode)} onClick={() => void openPage(page.page - 1)} type="button">上一页</button>
            <span>第 {page.page} 页</span>
            <button className="text-button" disabled={!page.hasMore || page.page >= 100 || Boolean(batchMode)} onClick={() => void openPage(page.page + 1)} type="button">下一页</button>
          </nav>
        </>
      ) : null}
    </section>
  );
}
