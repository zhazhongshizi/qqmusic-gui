import { hasPlaybackTransport } from "../../backend/playbackTransport";
import { Suspense, useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import type { LocalArchiveOptions, LocalMusicArchiveProps } from "../rhine/LocalMusicArchive";

import {
  deleteLocalMusic,
  getLocalMusic,
  importLocalMusic,
} from "../../backend/localMusicAdapter";
import type {
  LocalMusicImportResult,
  LocalMusicTrack,
} from "../../contracts/localMusic";
import { Icon } from "../../components/Icon";
import { AlbumArtwork, type ArtworkTrack } from "../stage/AlbumArtwork";
import {
  enqueueAndPlayLocalTrack,
  enqueueLocalTrack,
} from "../player/localQueue";
import {
  getCurrentTrack,
  playerActions,
  usePlayerSelector,
} from "../player/playerStore";

type LocalMusicState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly tracks: readonly LocalMusicTrack[]; readonly warningCount: number }
  | { readonly state: "error" };

const LOCAL_ARTWORK_VARIANTS: readonly ArtworkTrack["artworkVariant"][] = ["fern", "moon", "tide", "train", "mist"];
const LOCAL_ARTWORK_ACCENTS = ["#789575", "#9f9878", "#61858b", "#8c765e", "#72847c"] as const;

function isTauriRuntime(): boolean {
  return hasPlaybackTransport();
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function artworkTrack(track: LocalMusicTrack): ArtworkTrack {
  const seed = [...track.id].reduce((value, character) => value + character.codePointAt(0)!, 0);
  const variant = seed % LOCAL_ARTWORK_VARIANTS.length;
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    accent: LOCAL_ARTWORK_ACCENTS[variant] ?? LOCAL_ARTWORK_ACCENTS[0],
    artworkVariant: LOCAL_ARTWORK_VARIANTS[variant] ?? "fern",
  };
}

function publicErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function friendlyError(error: unknown, operation: "load" | "import" | "queue" | "delete"): string {
  const code = publicErrorCode(error);
  if (code === "QMG-LOCAL-MUSIC-STORAGE" || code === "local_music_storage_unavailable") {
    return "应用安装目录不可写，请确认目录权限后重试。";
  }
  if (code === "QMG-LOCAL-MUSIC-UNSUPPORTED" || code === "local_music_unsupported_format") {
    return "只支持 MP3、FLAC 和当前设备可解码的 OGG 文件。";
  }
  if (code === "QMG-LOCAL-MUSIC-LARGE" || code === "local_music_file_too_large") {
    return "文件超过 4 GiB，无法导入。";
  }
  if (code === "QMG-LOCAL-MUSIC-CONFLICT" || code === "local_music_storage_conflict") {
    return "本地音乐存储发生冲突，请检查受控目录后重试。";
  }
  if (code === "QMG-LOCAL-MUSIC-MISSING" || code === "local_music_file_missing") {
    return "歌曲已不存在，请重新读取本地曲库。";
  }
  if (code === "QMG-LOCAL-MUSIC-OUTCOME" || code === "local_music_delete_outcome_unknown") {
    return "删除结果暂时无法确认，请重新读取本地曲库。";
  }
  if (operation === "load") return "本地音乐暂时无法读取，请稍后重试。";
  if (operation === "queue") return "本地歌曲加入播放队列失败。";
  if (operation === "delete") return "歌曲删除失败，播放队列未改变。";
  return "本地音乐导入失败，请检查文件后重试。";
}

function importSummary(result: LocalMusicImportResult): string {
  if (result.imported.length === 0 && result.existingCount === 0 && result.failures.length === 0) {
    return "未选择本地音乐文件。";
  }
  return `导入完成：新增 ${result.imported.length} 首，已存在 ${result.existingCount} 首，失败 ${result.failures.length} 项`;
}

export default function LocalMusicLibrary({ remote = false, rhine }: { remote?: boolean; rhine?: LocalArchiveOptions & { component: ComponentType<LocalMusicArchiveProps> } }) {
  const liveRuntime = isTauriRuntime();
  const currentTrack = usePlayerSelector(getCurrentTrack);
  const [library, setLibrary] = useState<LocalMusicState>({ state: liveRuntime ? "loading" : "idle" });
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [armedDeleteId, setArmedDeleteId] = useState("");
  const [notice, setNotice] = useState("");
  const generationRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadLibrary = useCallback(async (preferredId?: string) => {
    if (!liveRuntime) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setArmedDeleteId("");
    setLibrary({ state: "loading" });
    try {
      const result = await getLocalMusic();
      if (!mountedRef.current || generation !== generationRef.current) return;
      setLibrary({ state: "ready", tracks: result.tracks, warningCount: result.warningCount });
      setSelectedId((current) => result.tracks.some((track) => track.id === preferredId)
        ? preferredId!
        : result.tracks.some((track) => track.id === current)
          ? current
        : (result.tracks[0]?.id ?? ""));
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setLibrary({ state: "error" });
      setNotice(friendlyError(error, "load"));
    }
  }, [liveRuntime]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  const tracks = library.state === "ready" ? library.tracks : [];
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleTracks = normalizedQuery
    ? tracks.filter((track) => `${track.title} ${track.artist} ${track.album}`
      .toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    : tracks;
  const selectedTrack = visibleTracks.find((track) => track.id === selectedId) ?? visibleTracks[0] ?? null;

  async function handleImport() {
    if (importBusy || deleteBusy || !liveRuntime) return;
    setImportBusy(true);
    setNotice("");
    try {
      const result = await importLocalMusic();
      setNotice(importSummary(result));
      if (result.imported.length > 0) await loadLibrary();
    } catch (error) {
      setNotice(friendlyError(error, "import"));
    } finally {
      setImportBusy(false);
    }
  }

  async function handleQueue(track: LocalMusicTrack, playNow: boolean) {
    if (deleteBusy) return;
    setNotice(playNow ? "正在准备本地播放…" : "正在加入本地队列…");
    try {
      if (playNow) await enqueueAndPlayLocalTrack(track);
      else await enqueueLocalTrack(track);
      setNotice(playNow ? "已开始播放本地歌曲" : "已加入本地队列");
    } catch (error) {
      setNotice(friendlyError(error, "queue"));
    }
  }

  async function handleDelete(track: LocalMusicTrack) {
    if (deleteBusy || importBusy || !liveRuntime) return;
    if (armedDeleteId !== track.id) {
      setArmedDeleteId(track.id);
      setNotice("");
      return;
    }

    const index = tracks.findIndex((item) => item.id === track.id);
    const preferredId = tracks[index + 1]?.id ?? tracks[index - 1]?.id;
    setDeleteBusy(true);
    setArmedDeleteId("");
    setNotice("正在删除本地歌曲…");
    try {
      const deletedCurrent = currentTrack?.id === track.id;
      const result = await deleteLocalMusic(track.id);
      playerActions.applyAuthoritativeSession(result.session);
      await loadLibrary(preferredId);
      const autoPlayFailed = deletedCurrent
        && result.session.queue.items.length > 0
        && !result.autoPlayStarted;
      setNotice(autoPlayFailed ? "歌曲已删除，下一首未能播放" : "歌曲已删除");
    } catch (error) {
      setArmedDeleteId("");
      setNotice(friendlyError(error, "delete"));
    } finally {
      setDeleteBusy(false);
    }
  }

  const RhineArchive = rhine?.component;
  if (rhine && RhineArchive) return <Suspense fallback={<p role="status">正在载入本地音乐磁带…</p>}><RhineArchive {...rhine}
    state={library.state} liveRuntime={liveRuntime} tracks={tracks} visibleTracks={visibleTracks}
    selectedId={selectedTrack?.id ?? ""} onSelect={id => { setSelectedId(id); setArmedDeleteId(""); }}
    query={query} onQueryChange={setQuery} notice={notice} warningCount={library.state === "ready" ? library.warningCount : 0}
    busy={importBusy || deleteBusy} importBusy={importBusy} armedDeleteId={armedDeleteId}
    onImport={() => void handleImport()} onReload={() => void loadLibrary()}
    onPlay={track => void handleQueue(track, true)} onEnqueue={track => void handleQueue(track, false)} onDelete={track => void handleDelete(track)} />
  </Suspense>;

  return (
    <>
      <section aria-labelledby="local-music-title" className="catalog-pane">
        <header className="catalog-pane__header">
          <div>
            <span className="section-label">LOCAL MUSIC</span>
            <h1 id="local-music-title">本地音乐</h1>
            <p>{remote ? "电脑上的本地曲库 · MP3 / FLAC / OGG" : "EXE 相邻 local-music · 支持 MP3 / FLAC / OGG"}</p>
          </div>
          {liveRuntime ? (
            <button
              className="text-button text-button--primary"
              disabled={importBusy || deleteBusy}
              hidden={remote}
              onClick={() => void handleImport()}
              type="button"
            >
              <Icon name="library" size={16} />{importBusy ? "正在导入…" : "导入音乐"}
            </button>
          ) : null}
        </header>

        {liveRuntime ? (
          <label className="catalog-search">
            <Icon name="search" size={18} />
            <span className="sr-only">搜索本地歌曲</span>
            <input
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="搜索本地歌曲、歌手或专辑"
              type="search"
              value={query}
            />
            {query ? <button aria-label="清空本地搜索" onClick={() => setQuery("")} type="button"><Icon name="close" size={16} /></button> : null}
          </label>
        ) : null}

        {notice ? <p aria-live="polite" className="organizer-message">{notice}</p> : null}

        {!liveRuntime ? (
          <div className="catalog-empty"><p>请在桌面端导入本地音乐</p><span>浏览器预览不打开本地文件选择器。</span></div>
        ) : library.state === "loading" ? (
          <div aria-live="polite" className="catalog-empty"><p>正在读取本地曲库</p><span>只扫描 EXE 相邻的 local-music 目录。</span></div>
        ) : library.state === "error" ? (
          <div className="catalog-empty" role="alert">
            <p>本地曲库暂时不可用</p>
            <button className="text-button text-button--primary" onClick={() => void loadLibrary()} type="button">重新读取</button>
          </div>
        ) : visibleTracks.length === 0 ? (
          <div className="catalog-empty"><p>{tracks.length === 0 ? "还没有本地音乐" : "没有找到匹配的音乐"}</p><span>{tracks.length === 0 ? "请在电脑端导入 MP3、FLAC 或 OGG 文件。" : "换一个标题、歌手或专辑试试。"}</span></div>
        ) : (
          <div className="catalog-table-wrap">
            <table className="catalog-table">
              <thead><tr><th scope="col">#</th><th scope="col">封面</th><th scope="col">曲目</th><th scope="col">歌手</th><th scope="col">专辑</th><th scope="col">格式</th><th scope="col">时长</th></tr></thead>
              <tbody>{visibleTracks.map((track, index) => {
                const active = currentTrack?.id === track.id;
                return (
                  <tr className={active ? "catalog-table__active" : undefined} key={track.id}>
                    <td><span className={active ? "catalog-needle catalog-needle--active" : "catalog-needle"}>{active ? <span className="sr-only">当前曲目</span> : String(index + 1).padStart(2, "0")}</span></td>
                    <td><AlbumArtwork compact track={artworkTrack(track)} /></td>
                    <td><button className="catalog-table__title" onClick={() => { setSelectedId(track.id); setArmedDeleteId(""); }} type="button"><strong>{track.title}</strong><small>{track.id}</small></button></td>
                    <td>{track.artist}</td><td>{track.album}</td><td><span className="quality-tag">{track.format.toUpperCase()}</span></td><td className="catalog-table__duration">{formatDuration(track.durationMs)}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        {library.state === "ready" && library.warningCount > 0 ? <p aria-live="polite" className="catalog-inspector__notice">有 {library.warningCount} 个文件未能加入可播放列表。</p> : null}
      </section>

      {selectedTrack ? (
        <aside aria-label="当前选中本地曲目" className="catalog-inspector">
          <span className="section-label">CURRENT LOCAL TRACK</span>
          <AlbumArtwork compact track={artworkTrack(selectedTrack)} />
          <h2>{selectedTrack.title}</h2>
          <p>{selectedTrack.artist}</p>
          <dl>
            <div><dt>专辑</dt><dd>{selectedTrack.album || "未标注"}</dd></div>
            <div><dt>格式</dt><dd>{selectedTrack.format.toUpperCase()}</dd></div>
            <div><dt>时长</dt><dd>{formatDuration(selectedTrack.durationMs)}</dd></div>
          </dl>
          <button className="text-button text-button--primary catalog-inspector__play" disabled={deleteBusy || importBusy} onClick={() => void handleQueue(selectedTrack, true)} type="button"><Icon name="play" size={17} />立即播放</button>
          <button className="text-button" disabled={deleteBusy || importBusy} onClick={() => void handleQueue(selectedTrack, false)} type="button"><Icon name="queue" size={17} />加入本地队列</button>
          <button className="text-button text-button--danger" disabled={deleteBusy || importBusy} hidden={remote}
              onClick={() => void handleDelete(selectedTrack)} type="button">
            {armedDeleteId === selectedTrack.id ? `确认删除《${selectedTrack.title}》` : "删除歌曲"}
          </button>
        </aside>
      ) : null}
    </>
  );
}
