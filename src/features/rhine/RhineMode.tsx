import { lazy, Suspense, useEffect, useRef, useState, type Ref } from "react";
import { getLibraryPlaylists } from "../../backend/libraryAdapter";
import { getPlaylistSongs } from "../../backend/catalogAdapter";
import type { AuthSnapshot } from "../../contracts/auth";
import type { PlaylistKind, PlaylistPage, PlaylistSummary } from "../../contracts/library";
import type { CatalogSong, CatalogSongPage } from "../../contracts/catalog";
import { WindowControls } from "../../components/WindowControls";
import { Icon, type IconName } from "../../components/Icon";
import { TapeDeck, NowPlaying } from "./TapeDeck";
import { QueueDrawer } from "../player/QueueDrawer";
import { enqueueCatalogTrack, enqueueNextCatalogTrack } from "../player/catalogQueue";
import { getCurrentTrack, playerActions, usePlayerSelector } from "../player/playerStore";
import { usePlaylistPlayback } from "../library/usePlaylistPlayback";
import { ScrollingLyrics } from "../stage/ScrollingLyrics";
import { ArchiveCanvas } from "./ArchiveCanvas";
import { RhineBoot } from "./RhineBoot";
import { SongCover } from "./SongCover";
import { ArchiveSearch } from "./ArchiveSearch";
import { PersonalLibrary } from "../library/PersonalLibrary";
import { ListeningStatistics } from "../library/ListeningStatistics";
import { usePlaylistSongSearch } from "./usePlaylistSongSearch";
import { RhineSettingsPanel } from "./RhineSettingsPanel";
import { defaultRhineSettings, readRhineSettings, writeRhineSettings } from "./rhineSettings";
import "./rhine.css";
import { ArtistNavigationContext, ArtistNavigationContent, useArtistNavigation } from "../artist/ArtistNavigation";
import { SongArtistLinks } from "../artist/SongArtistLinks";
const LocalMusicLibrary = lazy(() => import("../library/LocalMusicLibrary"));
const LocalMusicArchive = lazy(() => import("./LocalMusicArchive"));
const HistoryArchive = lazy(() => import("./HistoryArchive"));

function RhineNavButton({ icon, label, shortLabel, active, onClick, buttonRef }: {
  icon: IconName; label: string; shortLabel: string; active: boolean; onClick: () => void; buttonRef?: Ref<HTMLButtonElement>;
}) {
  return <button ref={buttonRef} type="button" className="rhine-nav-button" aria-label={label} aria-pressed={active} data-tauri-drag-region="false" onClick={onClick}>
    <Icon name={icon} size={24} />{active && <span className="rhine-nav-label" aria-hidden="true">{shortLabel}</span>}
    <span className="rhine-nav-tooltip" aria-hidden="true">{label}</span>
  </button>;
}

function Lyrics() {
  const track = usePlayerSelector(getCurrentTrack);
  const position = usePlayerSelector(s => {
    const lyrics = getCurrentTrack(s)?.lyrics ?? [];
    let index = lyrics.length - 1;
    while (index >= 0 && (lyrics[index]?.atMs ?? Infinity) > s.positionMs) index--;
    return index;
  });
  return track?.lyrics.length ? <ScrollingLyrics lyrics={track.lyrics} activeIndex={position} /> : <p>当前歌曲暂无歌词</p>;
}

function PlaylistDetail({ playlist, onBack, onPlayback }: { playlist: PlaylistSummary; onBack: () => void; onPlayback: () => void }) {
  const generation = useRef(0);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [resultPage, setResultPage] = useState(1);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searching = !!normalizedQuery;
  const search = usePlaylistSongSearch(playlist, searching);
  const [songs, setSongs] = useState<CatalogSongPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [singleBusy, setSingleBusy] = useState(false);
  const pending = useRef(false);
  const currentId = usePlayerSelector(s => getCurrentTrack(s)?.id);
  const { playlistPlaybackBusy, handlePlayAll, queueNotice, setQueueNotice } = usePlaylistPlayback(playlist, generation, singleBusy);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(false); setSongs(null);
    void getPlaylistSongs(playlist.id, generation.current, page, 20, playlist.editableId).then(result => {
      if (alive) setSongs(result);
    }).catch(() => { if (alive) setError(true); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [playlist.id, playlist.editableId, page, retry]);
  async function act(track: CatalogSong, play: boolean, next = false) {
    if (pending.current || playlistPlaybackBusy) return;
    const epoch = generation.current;
    pending.current = true; setSingleBusy(true);
    try {
      if (next) await enqueueNextCatalogTrack(track); else await enqueueCatalogTrack(track);
      if (generation.current !== epoch) return;
      if (play) {
        if (await playerActions.playTrack(track.id) === false) throw new Error("playback_failed");
        if (generation.current !== epoch) return;
        onPlayback();
      }
      setQueueNotice(play ? `正在播放：${track.title}` : next ? `下一首播放：${track.title}` : `已加入队列：${track.title}`);
    } catch { if (generation.current === epoch) setQueueNotice("操作失败，请重试"); }
    finally { pending.current = false; if (generation.current === epoch) setSingleBusy(false); }
  }
  const matches = search.allSongs?.map((track, index) => ({ track, index })).filter(({ track }) =>
    `${track.title}\n${track.artist}\n${track.album}`.toLocaleLowerCase().includes(normalizedQuery)) ?? [];
  const shownPage = searching ? resultPage : page;
  const rows = searching ? matches.slice((resultPage - 1) * 20, resultPage * 20)
    : (songs?.items ?? []).map((track, index) => ({ track, index: (page - 1) * 20 + index }));
  const rowsLoading = searching ? search.loading : loading;
  const rowsError = searching ? search.error : error;
  const hasMore = searching ? resultPage * 20 < matches.length : !!songs?.hasMore;
  return <section className="rhine-document rhine-playlist-document" aria-label="歌单详情">
    <button className="rhine-back" onClick={onBack}>← 返回档案阵列</button>
    <p className="rhine-eyebrow">PLAYLIST / {playlist.id}</p>
    <h2>{playlist.title}</h2><p>{playlist.description || "音乐档案"}</p>
    <div className="rhine-document-actions"><span>{playlist.songCount} 首歌曲</span><button disabled={singleBusy || playlistPlaybackBusy || loading || error || !songs?.items.length} onClick={() => { const epoch = generation.current; void handlePlayAll().then(result => { if (result && generation.current === epoch) onPlayback(); }); }}>播放全部</button></div>
    <form className="rhine-playlist-search rhine-search-form" onSubmit={e => { e.preventDefault(); setQuery(searchInput.trim()); setResultPage(1); }}>
      <input type="search" aria-label="在歌单内搜索" placeholder="在此歌单搜索歌曲、歌手或专辑" maxLength={100} value={searchInput} onChange={e => { setSearchInput(e.target.value); if (!e.target.value.trim()) { setQuery(""); setResultPage(1); } }} />
      <button type="submit" disabled={!searchInput.trim()}>搜索</button>
      <button type="button" disabled={singleBusy || playlistPlaybackBusy} onClick={()=>{search.retry();setRetry(r=>r+1);setPage(1);setResultPage(1);}}>刷新歌单</button>
      {searching && <button type="button" onClick={() => { setSearchInput(""); setQuery(""); setResultPage(1); }}>清除</button>}
    </form>
    {searching && !rowsLoading && !rowsError && <p className="rhine-search-count" role="status">“{query}” · {matches.length} 首匹配</p>}
    <p className="rhine-notice" role="status">{queueNotice}</p>
    {rowsLoading ? <p role="status">{searching ? "正在读取整张歌单以搜索…" : "正在读取歌曲…"}</p> : rowsError ? <p role="alert">{searching ? "未能读取完整歌单，搜索尚未完成" : "歌曲读取失败"} <button onClick={() => searching ? search.retry() : setRetry(r => r + 1)}>重试</button></p> : !rows.length ? <p>{searching ? "歌单内没有匹配的歌曲，换个关键词试试。" : "这个歌单还没有歌曲"}</p> : <ol className="rhine-songs" start={(shownPage - 1) * 20 + 1}>
      {rows.map(({ track, index }) => <li key={track.id} value={index + 1} data-playing={track.id === currentId}>
        <div className="rhine-song-info"><SongCover cacheKey={track.coverCacheKey} title={track.title} /><span className="rhine-song-text"><strong>{track.title}</strong><small><SongArtistLinks track={track} /> · {track.album}</small></span></div>
        <span className="rhine-song-actions">
          <button className="play-next-button" disabled={singleBusy || playlistPlaybackBusy} aria-label={`下一首播放 ${track.title}`} title="下一首播放" onClick={() => void act(track, false, true)}><Icon name="play-next" size={20} /></button>
          <button disabled={singleBusy || playlistPlaybackBusy} aria-label={`播放 ${track.title}`} onClick={() => void act(track, true)}>播放</button>
          <button disabled={singleBusy || playlistPlaybackBusy} aria-label={`加入队列 ${track.title}`} onClick={() => void act(track, false)}>＋</button>
        </span>
      </li>)}
    </ol>}
    <nav className="rhine-pages" aria-label="歌曲分页"><button disabled={rowsLoading || rowsError || shownPage === 1} onClick={() => searching ? setResultPage(p => p - 1) : setPage(p => p - 1)}>上一页</button><span>第 {shownPage} 页</span><button disabled={rowsLoading || rowsError || !hasMore} onClick={() => searching ? setResultPage(p => p + 1) : setPage(p => p + 1)}>下一页</button></nav>
  </section>;
}

export default function RhineMode({ auth, authRecovering, active, onExit, onAccount }: {
  auth: AuthSnapshot; authRecovering: boolean; active: boolean; onExit: () => void; onAccount: () => void;
}) {
  const artistNavigation = useArtistNavigation();
  const [booting, setBooting] = useState(true);
  const [settings, setSettings] = useState(readRhineSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const [kind, setKind] = useState<PlaylistKind>("created");
  const [page, setPage] = useState(1);
  const [catalog, setCatalog] = useState<PlaylistPage | null>(null);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState(false);
  const [search, setSearch] = useState(false);
  const [deck, setDeck] = useState(false);
  const playing = usePlayerSelector(s => s.isPlaying && !s.playbackError);
  const currentTrack = usePlayerSelector(getCurrentTrack);
  const trackIndex = usePlayerSelector(s => s.currentIndex);
  const queueLength = usePlayerSelector(s => s.queue.length);
  const [lyrics, setLyrics] = useState(false);
  const [queue, setQueue] = useState(false);
  const [localPage, setLocalPage] = useState<"local" | "history" | "collection" | "statistics" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const accountId = auth.state === "authenticated" ? auth.account?.musicId : undefined;
  function closeSettings(restoreFocus = false) {
    artistNavigation.closeArtist(false);
    setSettingsOpen(false);
    if (restoreFocus) queueMicrotask(() => settingsTrigger.current?.focus());
  }
  useEffect(() => { writeRhineSettings(settings); }, [settings]);
  useEffect(() => {
    let alive = true;
    setCatalog(null); setSearch(false); setDetail(false); setDeck(false); setLyrics(false); setQueue(false); setSelected(0); setError(false);
    if (authRecovering || auth.state !== "authenticated") { setLoading(false); return; }
    setLoading(true);
    void getLibraryPlaylists(kind, page, 20).then(result => { if (alive) setCatalog(result); })
      .catch(() => { if (alive) setError(true); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [authRecovering, auth.state, accountId, kind, page, retry]);
  const playlist = catalog?.items[selected];
  const items = catalog?.items ?? [];
  const navigation = settingsOpen ? "settings" : localPage ?? (search ? "search" : kind);
  return <ArtistNavigationContext.Provider value={artist => { setSettingsOpen(false); setQueue(false); artistNavigation.openArtist(artist); }}><div className="rhine-mode" data-renderer={settings.renderer}>
    {booting && <RhineBoot active={active} onComplete={() => setBooting(false)} />}
    <header className="rhine-header" data-tauri-drag-region inert={booting}>
      <div className="rhine-brand"><strong>RHINE LAB</strong><span>MUSIC ARCHIVE / 音乐档案</span></div>
      <nav className="rhine-navigation" aria-label="档案分类">
        <RhineNavButton icon="cassette-add" label="创建的歌单" shortLabel="我的歌单" active={navigation === "created"} onClick={() => { closeSettings(); setLocalPage(null); setSearch(false); setDeck(false); setLyrics(false); setQueue(false); setDetail(false); setKind("created"); setPage(1); }} />
        <RhineNavButton icon="cassette-heart" label="收藏的歌单" shortLabel="收藏" active={navigation === "favorite"} onClick={() => { closeSettings(); setLocalPage(null); setSearch(false); setDeck(false); setLyrics(false); setQueue(false); setDetail(false); setKind("favorite"); setPage(1); }} />
        <RhineNavButton icon="search" label="搜索" shortLabel="搜索" active={navigation === "search"} onClick={() => { closeSettings(); setLocalPage(null); setSearch(true); setDeck(false); setLyrics(false); setQueue(false); }} />
        <RhineNavButton icon="folder-music" label="本地音乐" shortLabel="本地" active={navigation === "local"} onClick={() => { closeSettings(); setSearch(false); setDeck(false); setLyrics(false); setQueue(false); setDetail(false); setLocalPage("local"); }} />
        <RhineNavButton icon="history" label="最近播放" shortLabel="最近" active={navigation === "history"} onClick={() => { closeSettings(); setSearch(false); setDeck(false); setLyrics(false); setQueue(false); setDetail(false); setLocalPage("history"); }} />
        <RhineNavButton icon="library" label="资料库" shortLabel="资料库" active={navigation === "collection"} onClick={() => { closeSettings(); setLocalPage("collection"); }} />
        <RhineNavButton icon="statistics" label="听歌统计" shortLabel="统计" active={navigation === "statistics"} onClick={() => { closeSettings(); setLocalPage("statistics"); }} />
        <RhineNavButton buttonRef={settingsTrigger} icon="settings" label="设置" shortLabel="设置" active={navigation === "settings"} onClick={() => { artistNavigation.closeArtist(false); setLocalPage(null); settingsTrigger.current?.focus(); setSettingsOpen(true); }} />
      </nav><WindowControls />
    </header>
    <main className="rhine-workspace" inert={booting} data-detail={detail || lyrics || queue} data-deck={deck} data-search={search && !deck} data-settings={settingsOpen} data-artist={!!artistNavigation.artist}>
      <ArtistNavigationContent rhine artist={artistNavigation.artist} onBack={artistNavigation.closeArtist}>
      {localPage === "local" ? <Suspense fallback={<p role="status">正在载入本地音乐磁带…</p>}><LocalMusicLibrary rhine={{ component: LocalMusicArchive, renderer: settings.renderer, frameLimit: settings.frameLimit, spatialUpscaling: settings.spatialUpscaling, active: active && !booting && !artistNavigation.artist, quality: settings.quality, superPerformance: settings.superPerformance, onBack: () => setLocalPage(null), onDeck: () => { setLocalPage(null); setSearch(false); setLyrics(false); setQueue(false); setDeck(true); } }} /></Suspense> : localPage === "history" ? <Suspense fallback={<p role="status">正在载入最近播放磁带…</p>}><HistoryArchive renderer={settings.renderer} frameLimit={settings.frameLimit} spatialUpscaling={settings.spatialUpscaling} active={active && !booting && !artistNavigation.artist} quality={settings.quality} superPerformance={settings.superPerformance} onBack={() => setLocalPage(null)} onDeck={() => { setLocalPage(null); setSearch(false); setLyrics(false); setQueue(false); setDeck(true); }} /></Suspense> : localPage ? <section className="rhine-local-page" aria-label={localPage === "collection" ? "我的资料库" : "听歌统计"}>
        <div className="rhine-local-page-actions"><button onClick={() => setLocalPage(null)}>← 返回档案</button><button onClick={() => { setLocalPage(null); setDeck(true); }}>进入磁带机 ↗</button></div>
        <Suspense fallback={<p role="status">正在打开…</p>}>{localPage === "collection" ? <PersonalLibrary /> : <ListeningStatistics />}</Suspense>
      </section> : <>
      {!!items.length && <ArchiveCanvas renderer={settings.renderer} frameLimit={settings.frameLimit} spatialUpscaling={settings.spatialUpscaling} booting={booting} key={`${kind}:${page}:${accountId}`} count={items.length} titles={items.map(item => item.title)} quality={settings.quality} superPerformance={settings.superPerformance} disableCassetteMotionWhilePlaying={settings.disableCassetteMotionWhilePlaying} reduceCassetteMotionWhilePlaying={settings.reduceCassetteMotionWhilePlaying} selected={selected} detail={detail || lyrics || queue} deck={deck} queueOpen={queue} playing={playing} track={currentTrack} trackIndex={trackIndex} queueLength={queueLength} active={active && !booting && !settingsOpen && !artistNavigation.artist && (!search || deck)} onSelect={index => { if (!search && !detail && !lyrics && !deck) setSelected(index); }} onOpen={index => { if (!search && !detail && !lyrics && !deck && items[index]) { setSelected(index); setDetail(true); } }} onPlaybackCassetteOpen={() => { setLyrics(false); setQueue(true); }} />}
      <div className="rhine-index"><span>{deck ? "TAPE TRANSPORT" : "COLLECTION"} / {String((deck ? trackIndex : selected) + 1).padStart(2, "0")}</span><i /><span>{deck ? "ANALOG FORM / DIGITAL SOUND" : "音乐，由此展开"}</span></div>
      {(!deck || queue || settingsOpen) && <NowPlaying onOpen={() => { closeSettings(); setQueue(false); setDeck(true); }} />}
      {!search && (authRecovering || loading ? <p className="rhine-empty" role="status">正在读取音乐档案…</p> : auth.state !== "authenticated" ? <div className="rhine-empty"><h2>登录后访问你的音乐档案</h2><button onClick={onAccount}>打开账号</button></div> : error ? <div className="rhine-empty" role="alert">歌单读取失败 <button onClick={() => setRetry(r => r + 1)}>重试</button></div> : !items.length ? <p className="rhine-empty">这里还没有{kind === "created" ? "创建" : "收藏"}的歌单</p> : null)}
      <div hidden={search || deck || lyrics || queue} className="rhine-browse-content">{detail && playlist ? <PlaylistDetail key={playlist.id} playlist={playlist} onBack={() => setDetail(false)} onPlayback={() => setDeck(true)} /> : playlist ? <section className="rhine-selection"><p className="rhine-eyebrow">PLAYLIST / {String(selected + 1).padStart(2, "0")} · ID {playlist.id}</p><h1>{playlist.title}</h1><p>{playlist.songCount} 首歌曲</p><button onClick={() => setDetail(true)}>抽取档案 · 打开歌单 ↗</button></section> : null}</div>
      {search && <ArchiveSearch key={accountId ?? "guest"} active={!deck && !lyrics && !settingsOpen} onClose={() => setSearch(false)} />}
      {deck && !queue && <TapeDeck playlistTitle={search ? "搜索试听" : playlist?.title} onBack={() => { setDeck(false); setLyrics(false); }} onLyrics={() => setLyrics(v => !v)} onQueue={() => { setLyrics(false); setQueue(true); }} />}
      {lyrics && <section className="rhine-document rhine-lyrics" aria-label="当前歌词"><button onClick={() => setLyrics(false)}>← 返回磁带机</button><Lyrics /></section>}
      <QueueDrawer open={queue} onClose={() => setQueue(false)} presentation="rhine-detail" />
      {settingsOpen && <RhineSettingsPanel settings={settings}
        onRendererChange={renderer => setSettings(current => ({ ...current, renderer }))}
        onSpatialUpscalingChange={spatialUpscaling => setSettings(current => ({ ...current, spatialUpscaling }))}
        onFrameLimitChange={frameLimit => setSettings(current => ({ ...current, frameLimit }))}
        onQualityChange={quality => setSettings(current => ({ ...current, quality }))}
        onSuperPerformanceChange={superPerformance => setSettings(current => ({ ...current, superPerformance }))}
        onCassetteMotionChange={mode => setSettings(current => ({ ...current, disableCassetteMotionWhilePlaying: mode === "disabled", reduceCassetteMotionWhilePlaying: mode === "reduced" }))}
        onReset={() => setSettings(defaultRhineSettings())}
        backLabel={deck ? "← 返回磁带机" : search ? "← 返回搜索" : "← 返回档案"}
        onClose={() => closeSettings(true)}
        onAccount={() => { closeSettings(); onAccount(); }}
        onExit={() => { closeSettings(); onExit(); }} />}
      {!search && !deck && !detail && !lyrics && !!items.length && <div className="rhine-catalog">
        <div className="rhine-card-list" aria-label="选择歌单">{items.map((item, index) => <button key={item.id} aria-pressed={index === selected} onClick={() => setSelected(index)} onDoubleClick={() => { setSelected(index); setDetail(true); }}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong><small>{item.songCount} 首</small></button>)}</div>
        <nav className="rhine-pages" aria-label="歌单分页"><button disabled={page === 1 || loading} onClick={() => setPage(p => p - 1)}>上一页</button><span>第 {page} 页 · 共 {catalog?.total} 个歌单</span><button disabled={!catalog?.hasMore || loading} onClick={() => setPage(p => p + 1)}>下一页</button></nav>
      </div>}
      </>}
      </ArtistNavigationContent>
      {artistNavigation.artist && <NowPlaying onOpen={() => { artistNavigation.closeArtist(false); setLocalPage(null); setQueue(false); setDeck(true); }} />}
    </main>
  </div></ArtistNavigationContext.Provider>;
}
