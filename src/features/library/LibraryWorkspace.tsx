import { hasPlaybackTransport } from "../../backend/playbackTransport";
import { useEffect, useRef, useState } from "react";

import type { LibrarySection } from "../../app/uiModes";
import { discoverCatalogSongs, getPlaylistSongs, searchCatalogSongs } from "../../backend/catalogAdapter";
import {
  addSongsToPlaylist,
  createPlaylist,
  deletePlaylist,
  getLibraryPlaylists,
  getLikedSongs,
  setPlaylistFavorite,
  setSongsLiked,
} from "../../backend/libraryAdapter";
import { usePlaylistPlayback } from "./usePlaylistPlayback";
import { Icon } from "../../components/Icon";
import type { ArtistRef } from "../../contracts/artist";
import { SongArtistLinks } from "../artist/SongArtistLinks";
import type { CatalogSong, CatalogSongPage } from "../../contracts/catalog";
import type { AuthSnapshot } from "../../contracts/auth";
import type { PlaylistPage, PlaylistSummary } from "../../contracts/library";
import { CatalogDetails, AlbumLink } from "../catalog/CatalogDetails";
import { CatalogEntityResults, SearchTypeTabs } from "../catalog/CatalogEntityResults";
import type { CatalogEntity, CatalogSearchType } from "../../contracts/catalogBrowse";
import { OrganizerPanel } from "../organizer/OrganizerPanel";
import { FIXTURE_TRACKS } from "../player/fixtures";
import {
  getCurrentTrack,
  playerActions,
  usePlayerSelector,
  type PlayerSnapshot,
} from "../player/playerStore";
import {
  CatalogPlaybackStartError,
  enqueueAndPlayCatalogTrack,
  enqueueCatalogTrack,
  enqueueNextCatalogTrack,
} from "../player/catalogQueue";
import { AlbumArtwork, type ArtworkTrack } from "../stage/AlbumArtwork";
import PlaylistPicker from "./PlaylistPicker";
import LocalMusicLibrary from "./LocalMusicLibrary";
import PlaylistSongList from "./PlaylistSongList";
import PlaybackHistory from "./PlaybackHistory";
import { PersonalLibrary } from "./PersonalLibrary";
import { ListeningStatistics } from "./ListeningStatistics";
import { SearchHistory, rememberSearch, searchHistoryRevision } from "./searchHistory";

interface LibraryWorkspaceProps {
  remote?: boolean;
  onSectionChange?: (section: LibrarySection) => void;
  authRecovering: boolean;
  authSnapshot: AuthSnapshot;
  initialSection: LibrarySection;
  onBack: () => void;
}

const SECTIONS: readonly { id: LibrarySection; label: string; group?: string }[] = [
  { id: "discover", label: "发现", group: "浏览" },
  { id: "search", label: "搜索" },
  { id: "liked", label: "喜欢", group: "我的音乐" },
  { id: "local", label: "本地音乐" },
  { id: "playlists", label: "歌单" },
  { id: "history", label: "本地历史" },
  { id: "collection", label: "我的资料库" },
  { id: "statistics", label: "听歌统计" },
  { id: "organizer", label: "整理器", group: "工具" },
];

const SECTION_HEADINGS: Record<LibrarySection, { title: string; subtitle: string }> = {
  discover: { title: "今日唱片目录", subtitle: "QQ 音乐实时新歌目录" },
  search: { title: "搜索音乐", subtitle: "歌曲、歌手、专辑与歌单" },
  liked: { title: "喜欢的音乐", subtitle: "随当前 QQ 音乐账号同步" },
  local: { title: "本地音乐", subtitle: "存放在软件目录中的本地曲库" },
  playlists: { title: "我的歌单", subtitle: "创建歌单与收藏歌单" },
  history: { title: "最近播放", subtitle: "仅保存在这台设备" },
  collection: { title: "我的资料库", subtitle: "本地专辑、歌手与播放队列" },
  statistics: { title: "听歌统计", subtitle: "实际收听与智能随机解释" },
  organizer: { title: "歌单整理器", subtitle: "预览后再执行，不直接修改歌单" },
};

const selectLikedIds = (snapshot: PlayerSnapshot) => snapshot.likedIds;
const PLAYLIST_PAGE_SIZE = 20;

type LiveCatalogState =
  | { readonly state: "preview" }
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly page: CatalogSongPage }
  | { readonly state: "error" };

type CatalogDisplayTrack =
  | { readonly source: "preview"; readonly track: (typeof FIXTURE_TRACKS)[number] }
  | { readonly source: "live"; readonly track: CatalogSong };

type PlaylistSectionState =
  | { readonly state: "preview" }
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "error" }
  | { readonly state: "ready"; readonly page: PlaylistPage };

type PlaylistDetailState =
  | { readonly state: "idle" }
  | { readonly state: "loading"; readonly playlist: PlaylistSummary; readonly page: number }
  | { readonly state: "error"; readonly playlist: PlaylistSummary; readonly page: number }
  | { readonly state: "ready"; readonly playlist: PlaylistSummary; readonly page: CatalogSongPage };

function isTauriRuntime() {
  return hasPlaybackTransport();
}

function qualityLabel(track: CatalogSong) {
  const quality = track.qualityCandidates.find((candidate) => candidate.available)?.quality;
  if (quality === "flac") return "FLAC";
  if (quality === "320k") return "MP3 320k";
  if (quality === "128k") return "MP3 128k";
  return "不可播放";
}

function displayTrack(value: CatalogDisplayTrack) {
  if (value.source === "preview") {
    return {
      ...value.track,
      quality: value.track.actualQuality,
      identifier: value.track.id.replace("fixture-", "CAT-").toUpperCase(),
    };
  }
  return {
    ...value.track,
    quality: qualityLabel(value.track),
    identifier: value.track.id,
  };
}

const LIVE_ARTWORK_VARIANTS: readonly ArtworkTrack["artworkVariant"][] = ["fern", "moon", "tide", "train", "mist"];
const LIVE_ARTWORK_ACCENTS = ["#789575", "#9f9878", "#61858b", "#8c765e", "#72847c"] as const;

function liveArtworkTrack(track: CatalogSong): ArtworkTrack {
  const seed = [...track.id].reduce((value, character) => value + character.codePointAt(0)!, 0);
  const variant = seed % LIVE_ARTWORK_VARIANTS.length;
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    accent: LIVE_ARTWORK_ACCENTS[variant] ?? LIVE_ARTWORK_ACCENTS[0],
    artworkVariant: LIVE_ARTWORK_VARIANTS[variant] ?? "fern",
    ...(track.coverCacheKey ? { coverCacheKey: track.coverCacheKey } : {}),
  };
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

interface ArtistLinksProps {
  artists: readonly ArtistRef[];
  onOpenArtist: (artist: ArtistRef) => void;
}

function ArtistLinks({ artists, onOpenArtist }: ArtistLinksProps) {
  return (
    <span className="catalog-table__artists">
      {artists.map((artist, index) => (
        <span key={`${artist.id}-${index}`}>
          {index > 0 ? <span aria-hidden="true"> / </span> : null}
          <button
            aria-label={`查看歌手 ${artist.name}`}
            className="catalog-table__artist"
            onClick={() => onOpenArtist(artist)}
            type="button"
          >
            {artist.name}
          </button>
        </span>
      ))}
    </span>
  );
}

export default function LibraryWorkspace({
  remote = false,
  onSectionChange,
  authRecovering,
  authSnapshot,
  initialSection,
  onBack,
}: LibraryWorkspaceProps) {
  const liveAccountRuntime = isTauriRuntime();
  const currentTrack = usePlayerSelector(getCurrentTrack);
  const likedIds = usePlayerSelector(selectLikedIds);
  const [section, setSection] = useState<LibrarySection>(initialSection);
  const [query, setQuery] = useState("");
  const [searchType, setSearchType] = useState<CatalogSearchType>("songs");
  const [remotePage, setRemotePage] = useState(1);
  useEffect(() => { setRemotePage(1); }, [section, query, searchType]);
  const [selectedId, setSelectedId] = useState(currentTrack?.id ?? FIXTURE_TRACKS[0]?.id ?? "");
  const [liveCatalog, setLiveCatalog] = useState<LiveCatalogState>(() =>
    isTauriRuntime() ? { state: "idle" } : { state: "preview" },
  );
  const [createdPlaylistsState, setCreatedPlaylistsState] = useState<PlaylistSectionState>(() =>
    isTauriRuntime() ? { state: "idle" } : { state: "preview" },
  );
  const [favoritePlaylistsState, setFavoritePlaylistsState] = useState<PlaylistSectionState>(() =>
    isTauriRuntime() ? { state: "idle" } : { state: "preview" },
  );
  const [likedRetry, setLikedRetry] = useState(0);
  const [createdRetry, setCreatedRetry] = useState(0);
  const [favoriteRetry, setFavoriteRetry] = useState(0);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [libraryNotice, setLibraryNotice] = useState("");
  const [armedDeleteId, setArmedDeleteId] = useState("");
  const [targetPlaylistId, setTargetPlaylistId] = useState("");
  const [playlistBatchBusy, setPlaylistBatchBusy] = useState(false);
  const [inspectedPlaylistTrack, setInspectedPlaylistTrack] = useState<CatalogSong | null>(null);
  const [playlistDetail, setPlaylistDetail] = useState<PlaylistDetailState>({ state: "idle" });
  const [openedEntity, setOpenedEntity] = useState<CatalogEntity | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!query.trim() || !["search","discover"].includes(section)) return;
    const revision=searchHistoryRevision();
    const timer=window.setTimeout(()=>{if(revision===searchHistoryRevision())rememberSearch(query,searchType);},1000);
    return()=>window.clearTimeout(timer);
  }, [query, searchType, section]);
  const playlistReturnRef = useRef<HTMLButtonElement>(null);
  const catalogGeneration = useRef(0);
  const playlistGeneration = useRef(0);
  const { queueNotice, setQueueNotice, playlistPlaybackBusy, setPlaylistPlaybackBusy, handlePlayAll } = usePlaylistPlayback(
    playlistDetail.state === "ready" && playlistDetail.page.items.length > 0 ? playlistDetail.playlist : null,
    playlistGeneration,
    playlistBatchBusy,
  );

  useEffect(() => {
    playlistGeneration.current++;
    setPlaylistPlaybackBusy(false);
  }, [section, initialSection, setPlaylistPlaybackBusy]);

  useEffect(() => {
    setSection(initialSection);
    setPlaylistDetail({ state: "idle" });
    setOpenedEntity(null);
    if (initialSection === "search") searchRef.current?.focus();
  }, [initialSection]);

  useEffect(() => {
    if (section !== "playlists") setPlaylistDetail({ state: "idle" });
  }, [section]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const normalized = query.trim();
    if (section === "liked") {
      if (authRecovering || authSnapshot.state !== "authenticated") {
        setLiveCatalog({ state: "idle" });
        return;
      }
      const generation = catalogGeneration.current + 1;
      catalogGeneration.current = generation;
      let active = true;
      setLiveCatalog({ state: "loading" });
      void getLikedSongs(remote ? remotePage : 1, 20, generation).then(
        (page) => {
          if (active && page.generation === catalogGeneration.current) {
            setLiveCatalog({ state: "ready", page });
            setSelectedId(page.items[0]?.id ?? "");
          }
        },
        () => { if (active) setLiveCatalog({ state: "error" }); },
      );
      return () => { active = false; };
    }
    if (section !== "discover" && section !== "search") {
      setLiveCatalog({ state: "idle" });
      return;
    }
    if ((section === "search" || normalized) && searchType !== "songs") {
      setLiveCatalog({ state: "idle" });
      return;
    }
    if (!normalized && section === "search") {
      setLiveCatalog({ state: "idle" });
      return;
    }
    const generation = catalogGeneration.current + 1;
    catalogGeneration.current = generation;
    let active = true;
    const timeout = window.setTimeout(() => {
      setLiveCatalog({ state: "loading" });
      const request = normalized
        ? searchCatalogSongs(normalized, generation, remotePage)
        : discoverCatalogSongs(generation);
      void request.then(
        (page) => {
          if (active && page.generation === catalogGeneration.current) {
            setLiveCatalog({ state: "ready", page });
            setSelectedId((current) =>
              page.items.some((track) => track.id === current) ? current : (page.items[0]?.id ?? ""),
            );
          }
        },
        () => {
          if (active && generation === catalogGeneration.current) setLiveCatalog({ state: "error" });
        },
      );
    }, normalized ? 300 : 0);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [authRecovering, authSnapshot.state, likedRetry, query, section, remote, remotePage, searchType]);

  useEffect(() => {
    if (!isTauriRuntime() || !["playlists", "organizer"].includes(section)) return;
    if (authRecovering || authSnapshot.state !== "authenticated") {
      setCreatedPlaylistsState({ state: "idle" });
      return;
    }
    let active = true;
    setCreatedPlaylistsState({ state: "loading" });
    void getLibraryPlaylists("created", 1, 20).then(
      (page) => {
        if (!active) return;
        setCreatedPlaylistsState({ state: "ready", page });
        setTargetPlaylistId((current) =>
          page.items.some((playlist) => playlist.id === current)
            ? current
            : (page.items[0]?.id ?? ""),
        );
      },
      () => { if (active) setCreatedPlaylistsState({ state: "error" }); },
    );
    return () => { active = false; };
  }, [authRecovering, authSnapshot.state, createdRetry, section]);

  useEffect(() => {
    if (!isTauriRuntime() || section !== "playlists") return;
    if (authRecovering || authSnapshot.state !== "authenticated") {
      setFavoritePlaylistsState({ state: "idle" });
      return;
    }
    let active = true;
    setFavoritePlaylistsState({ state: "loading" });
    void getLibraryPlaylists("favorite", 1, 20).then(
      (page) => { if (active) setFavoritePlaylistsState({ state: "ready", page }); },
      () => { if (active) setFavoritePlaylistsState({ state: "error" }); },
    );
    return () => { active = false; };
  }, [authRecovering, authSnapshot.state, favoriteRetry, section]);

  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  let visibleTracks: CatalogDisplayTrack[];
  if (liveCatalog.state === "preview") {
    let previewTracks = section === "liked"
      ? FIXTURE_TRACKS.filter((track) => likedIds.includes(track.id))
      : FIXTURE_TRACKS;
    if (normalizedQuery) {
      previewTracks = FIXTURE_TRACKS.filter((track) =>
      `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery),
      );
      if (section === "liked") {
        previewTracks = previewTracks.filter((track) => likedIds.includes(track.id));
      }
    }
    visibleTracks = previewTracks.map((track) => ({ source: "preview", track }));
  } else if (playlistDetail.state === "ready") {
    visibleTracks = playlistDetail.page.items.map((track) => ({ source: "live", track }));
  } else {
    visibleTracks = liveCatalog.state === "ready"
      ? liveCatalog.page.items.map((track) => ({ source: "live", track }))
      : [];
  }
  const selectedTrack: CatalogDisplayTrack | null = playlistDetail.state === "ready" && inspectedPlaylistTrack
    ? { source: "live", track: inspectedPlaylistTrack }
    : visibleTracks.find(({ track }) => track.id === selectedId) ?? visibleTracks[0] ?? null;
  const heading = SECTION_HEADINGS[section];
  const createdPlaylists: readonly PlaylistSummary[] = createdPlaylistsState.state === "ready"
    ? createdPlaylistsState.page.items
    : [];
  const activeArtist = openedEntity;

  function openArtist(artist: ArtistRef) {
    setOpenedEntity({ kind: "artist", ...artist });
  }

  function closeArtist() {
    setOpenedEntity(null);
  }

  async function openPlaylist(playlist: PlaylistSummary, page = 1) {
    const generation = playlistGeneration.current + 1;
    playlistGeneration.current = generation;
    setPlaylistPlaybackBusy(false);
    setQueueNotice("");
    setSelectedId("");
    setInspectedPlaylistTrack(null);
    setPlaylistDetail({ state: "loading", playlist, page });
    try {
      const result = await getPlaylistSongs(
        playlist.id,
        generation,
        page,
        PLAYLIST_PAGE_SIZE,
        playlist.editableId,
      );
      if (generation !== playlistGeneration.current) return;
      setPlaylistDetail({ state: "ready", playlist, page: result });
      setSelectedId(result.items[0]?.id ?? "");
    } catch {
      if (generation === playlistGeneration.current) {
        setPlaylistDetail({ state: "error", playlist, page });
      }
    }
  }

  function closePlaylist() {
    playlistGeneration.current += 1;
    setPlaylistPlaybackBusy(false);
    setQueueNotice("");
    setPlaylistDetail({ state: "idle" });
    setSelectedId("");
    requestAnimationFrame(() => playlistReturnRef.current?.focus());
  }

  async function refreshCreatedPlaylists() {
    const created = await getLibraryPlaylists("created", 1, 20);
    setCreatedPlaylistsState({ state: "ready", page: created });
    setTargetPlaylistId((current) =>
      created.items.some((playlist) => playlist.id === current) ? current : (created.items[0]?.id ?? ""),
    );
  }

  async function refreshFavoritePlaylists() {
    const favorite = await getLibraryPlaylists("favorite", 1, 20);
    setFavoritePlaylistsState({ state: "ready", page: favorite });
  }

  async function handleCreatePlaylist() {
    const name = newPlaylistName.trim();
    if (!name) return;
    setLibraryNotice("正在创建歌单…");
    try {
      await createPlaylist(name);
      setNewPlaylistName("");
      await refreshCreatedPlaylists();
      setLibraryNotice("歌单已创建并完成读回核对");
    } catch {
      setLibraryNotice("创建结果未确认；应用没有自动重复提交");
    }
  }

  async function handleDeletePlaylist(playlist: PlaylistSummary) {
    if (!playlist.editableId) return;
    if (armedDeleteId !== playlist.id) {
      setArmedDeleteId(playlist.id);
      setLibraryNotice(`再次点击“确认删除 ${playlist.title}”才会提交`);
      return;
    }
    setLibraryNotice("正在删除并重新读取歌单…");
    try {
      await deletePlaylist(playlist.editableId);
      setArmedDeleteId("");
      await refreshCreatedPlaylists();
      setLibraryNotice("歌单已删除并完成读回核对");
    } catch {
      setLibraryNotice("删除结果待核对；应用没有自动重复提交");
    }
  }

  async function handleLiveLike(track: CatalogSong) {
    setLibraryNotice("正在更新喜欢状态…");
    try {
      const liked = !(remote && section === "liked");
      await setSongsLiked([track.id], liked);
      if (!liked) setLikedRetry(value => value + 1);
      setLibraryNotice(liked ? "已喜欢；账号状态将在下次读取时核对" : "已取消喜欢");
    } catch {
      setLibraryNotice("喜欢状态待核对；应用没有自动重复提交");
    }
  }

  async function handleAddToPlaylist(track: CatalogSong) {
    const target = createdPlaylists.find((playlist) => playlist.id === targetPlaylistId);
    if (!target?.editableId) return;
    setLibraryNotice(`正在加入“${target.title}”…`);
    try {
      await addSongsToPlaylist(target.id, target.editableId, [track.id]);
      setLibraryNotice(`已加入“${target.title}”并等待目录读回`);
    } catch {
      setLibraryNotice("加入结果待核对；应用没有自动重复提交");
    }
  }

  async function handleFavoritePlaylist(playlist: PlaylistSummary, favorite: boolean) {
    setLibraryNotice(favorite ? "正在收藏歌单…" : "正在取消收藏…");
    try {
      await setPlaylistFavorite(playlist.id, favorite);
      await refreshFavoritePlaylists();
      setLibraryNotice(favorite ? "已收藏并完成读回核对" : "已取消收藏并完成读回核对");
    } catch {
      setLibraryNotice("收藏状态待核对；应用没有自动重复提交");
    }
  }

  async function updateNativeQueue(track: CatalogSong, playNow: boolean) {
    setQueueNotice(playNow ? "正在交给原生播放器…" : "正在加入本地队列…");
    try {
      if (playNow) {
        await enqueueAndPlayCatalogTrack(track);
      } else {
        await enqueueCatalogTrack(track);
      }
      setQueueNotice(playNow ? "已交给 Windows 原生播放器" : "已加入本地队列");
    } catch (error) {
      if (playNow && !(error instanceof CatalogPlaybackStartError)) {
        playerActions.reportPlaybackError(error, () => updateNativeQueue(track, true));
      }
      setQueueNotice(playNow ? "播放失败，原因显示在底部播放器" : "加入本地队列失败");
    }
  }

  async function playNext(track: CatalogSong) {
    setQueueNotice("正在安排下一首…");
    try { await enqueueNextCatalogTrack(track); setQueueNotice(`下一首播放：${track.title}`); }
    catch { setQueueNotice("安排下一首失败，请重试"); }
  }

  return (
    <main
      className={activeArtist ? "library-workspace library-workspace--artist" : "library-workspace"}
      id="main-content"
    >
      <aside className="library-sidebar" aria-label="曲库导航">
        <button className="library-sidebar__back" onClick={onBack} type="button"><Icon name="back" size={17} />返回舞台</button>
        <nav>
          {SECTIONS.filter(item => !remote || ["discover", "search", "liked", "local", "playlists", "collection", "statistics"].includes(item.id)).map((item) => (
            <div key={item.id}>
              {item.group ? <span className="library-sidebar__group">{item.group}</span> : null}
              <button
                aria-current={section === item.id ? "page" : undefined}
                className={section === item.id ? "library-sidebar__item library-sidebar__item--active" : "library-sidebar__item"}
                onClick={() => {
                  setOpenedEntity(null);
                  setSection(item.id);
                  onSectionChange?.(item.id);
                  if (item.id === "search") requestAnimationFrame(() => searchRef.current?.focus());
                }}
                type="button"
              >
                <span>{item.label}</span>
                {item.id === "liked" && !remote ? <small>{likedIds.length}</small> : null}
              </button>
            </div>
          ))}
        </nav>
        <div className="library-sidebar__foot">
          <span>{section === "history" ? "本机播放记录" : liveCatalog.state === "preview" ? "本地预览" : "真实只读目录"}</span>
          <strong>{section === "history" ? "LOCAL / HISTORY" : liveCatalog.state === "preview" ? "FIXTURE / 01" : "QQ / LIVE"}</strong>
        </div>
      </aside>

      {activeArtist ? (
        <CatalogDetails entity={activeArtist} key={`${activeArtist.kind}:${activeArtist.id}`} onBack={closeArtist} />
      ) : section === "local" ? (
        <LocalMusicLibrary remote={remote} />
      ) : section === "history" ? (
        <PlaybackHistory />
      ) : section === "collection" ? (
        <PersonalLibrary />
      ) : section === "statistics" ? (
        <ListeningStatistics />
      ) : (
        <>
      <section className="catalog-pane">
        <header className="catalog-pane__header">
          <div>
            <span className="section-label">RECORD CATALOG</span>
            <h1>{playlistDetail.state !== "idle" ? playlistDetail.playlist.title : heading.title}</h1>
            <p>{playlistDetail.state !== "idle"
              ? `${playlistDetail.playlist.songCount} 首歌曲 · QQ 音乐实时歌单`
              : liveCatalog.state === "preview" && section !== "playlists" && section !== "organizer" ? "本地界面预览 · 5 首编辑精选" : heading.subtitle}</p>
          </div>
          {playlistDetail.state !== "idle" ? (
            <div className="playlist-detail__actions">
              {playlistDetail.state === "ready" && playlistDetail.page.items.length > 0 ? (
                <button
                  className="text-button text-button--primary playlist-detail__play-all"
                  disabled={playlistPlaybackBusy || playlistBatchBusy}
                  onClick={() => void handlePlayAll()}
                  type="button"
                >
                  <Icon name="play" size={16} />{playlistPlaybackBusy ? "正在准备…" : "播放全部"}
                </button>
              ) : null}
              <button className="text-button playlist-detail__back" onClick={closePlaylist} type="button">
                <Icon name="back" size={16} />返回全部歌单
              </button>
            </div>
          ) : null}
        </header>

        {section !== "playlists" && section !== "organizer" && !(remote && section === "liked") ? <label className="catalog-search">
          <Icon name="search" size={18} />
          <span className="sr-only">搜索歌曲、歌手或专辑</span>
          <input
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索歌曲、歌手或专辑"
            ref={searchRef}
            type="search"
            maxLength={100}
            onKeyDown={event=>{if(event.key==="Enter"&&!event.nativeEvent.isComposing)rememberSearch(query,searchType);}}
            value={query}
          />
          {query ? <button aria-label="清空搜索" onClick={() => setQuery("")} type="button"><Icon name="close" size={16} /></button> : null}
        </label> : null}

        {(section === "search" || (section === "discover" && query.trim())) && <SearchTypeTabs value={searchType} onChange={setSearchType} />}
        {section === "search" && <SearchHistory onSelect={entry=>{setQuery(entry.query);setSearchType(entry.type);setRemotePage(1);rememberSearch(entry.query,entry.type);}} />}
        {(section === "search" || (section === "discover" && query.trim())) && searchType !== "songs" ? <CatalogEntityResults kind={searchType} keyword={query} page={remotePage} onPageChange={setRemotePage} onOpen={setOpenedEntity} /> : section === "organizer" ? (
          <div className="organizer-note">
            <span className="organizer-note__rule" />
            <p><strong>先看变化，再决定是否执行。</strong>计划绑定当前账号与歌单快照；超时只读回核对，绝不盲目重复写入。</p>
          </div>
        ) : null}

        {section === "organizer" ? (
          createdPlaylistsState.state === "preview" ? (
            <OrganizerPanel playlists={[]} previewRuntime />
          ) : liveAccountRuntime && authRecovering ? (
            <div aria-live="polite" className="catalog-empty"><p>正在恢复账号</p><span>恢复完成后会自动读取创建歌单。</span></div>
          ) : liveAccountRuntime && authSnapshot.state === "signedOut" ? (
            <div className="catalog-empty"><p>请先登录后读取账号曲库</p><span>请在电脑端登录，登录成功后当前页面会自动恢复。</span></div>
          ) : liveAccountRuntime && authSnapshot.state === "unavailable" ? (
            <div role="alert" className="catalog-empty"><p>账号恢复失败</p><span>请打开账号面板重新登录。</span></div>
          ) : createdPlaylistsState.state === "loading" || createdPlaylistsState.state === "idle" ? (
            <div aria-live="polite" className="catalog-empty"><p>正在读取账号歌单</p><span>完成后才可生成整理计划。</span></div>
          ) : createdPlaylistsState.state === "error" ? (
            <div role="alert" className="catalog-empty">
              <p>创建歌单暂时不可用</p><span>网络恢复后可以单独重新读取。</span>
              <button className="text-button text-button--primary" onClick={() => setCreatedRetry((value) => value + 1)} type="button">重新读取创建歌单</button>
            </div>
          ) : (
            <OrganizerPanel playlists={createdPlaylists} previewRuntime={false} />
          )
        ) : section === "playlists" && playlistDetail.state !== "idle" ? (
          playlistDetail.state === "loading" ? (
            <div aria-live="polite" className="catalog-empty"><p>正在读取歌单</p><span>歌曲会按页加载，不会一次读取全部内容。</span></div>
          ) : playlistDetail.state === "error" ? (
            <div role="alert" className="catalog-empty">
              <p>歌单暂时无法打开</p><span>网络恢复后可以重新读取。</span>
              <button className="text-button text-button--primary" onClick={() => void openPlaylist(playlistDetail.playlist, playlistDetail.page)} type="button">重新读取</button>
            </div>
          ) : playlistDetail.page.items.length === 0 ? (
            <div className="catalog-empty"><p>这个歌单还没有歌曲</p><span>返回全部歌单后可以继续浏览。</span></div>
          ) : (
            <PlaylistSongList
              key={playlistDetail.playlist.id}
              playlist={playlistDetail.playlist}
              initialPage={playlistDetail.page}
              currentTrackId={currentTrack?.id}
              disabled={playlistPlaybackBusy}
              onBusyChange={setPlaylistBatchBusy}
              renderCells={(track) => <>
                <td><AlbumArtwork compact track={liveArtworkTrack(track)} /></td>
                <td><button className="catalog-table__title" onClick={() => { setSelectedId(track.id); setInspectedPlaylistTrack(track); }} type="button"><strong>{track.title}</strong><small>{track.id}</small></button></td>
                <td><ArtistLinks artists={track.artists} onOpenArtist={openArtist} /></td>
                <td><AlbumLink track={track} onOpen={setOpenedEntity} /></td><td><span className="quality-tag">{qualityLabel(track)}</span></td>
                <td className="catalog-table__duration">{formatDuration(track.durationMs)}</td>
              </>}
            />
          )
        ) : section === "playlists" ? (
          createdPlaylistsState.state === "preview" ? (
            <div className="catalog-empty"><p>本地预览不包含伪造歌单</p><span>桌面端登录后可管理真实账号歌单。</span></div>
          ) : liveAccountRuntime && authRecovering ? (
            <div aria-live="polite" className="catalog-empty"><p>正在恢复账号</p><span>恢复完成后会自动读取歌单。</span></div>
          ) : liveAccountRuntime && authSnapshot.state === "signedOut" ? (
            <div className="catalog-empty"><p>请先登录后读取账号曲库</p><span>登录成功后当前页面会自动恢复。</span></div>
          ) : liveAccountRuntime && authSnapshot.state === "unavailable" ? (
            <div role="alert" className="catalog-empty"><p>账号恢复失败</p><span>请打开账号面板重新登录。</span></div>
          ) : (
            <div className="playlist-workspace">
              <form
                className="playlist-create"
                hidden={remote}
                onSubmit={(event) => { event.preventDefault(); void handleCreatePlaylist(); }}
              >
                <label htmlFor="new-playlist-name">新建歌单</label>
                <input
                  id="new-playlist-name"
                  maxLength={100}
                  onChange={(event) => setNewPlaylistName(event.currentTarget.value)}
                  placeholder="输入歌单名称"
                  value={newPlaylistName}
                />
                <button className="text-button text-button--primary" disabled={!newPlaylistName.trim()} type="submit">创建</button>
              </form>
              {libraryNotice ? <p aria-live="polite" className="organizer-message">{libraryNotice}</p> : null}
              <section aria-labelledby="created-playlists-title">
                <h2 id="created-playlists-title">我创建的{createdPlaylistsState.state === "ready" ? ` · ${createdPlaylistsState.page.total}` : ""}</h2>
                {createdPlaylistsState.state === "loading" || createdPlaylistsState.state === "idle" ? (
                  <div aria-live="polite" className="catalog-empty catalog-empty--section"><p>正在读取创建歌单</p></div>
                ) : createdPlaylistsState.state === "error" ? (
                  <div role="alert" className="catalog-empty catalog-empty--section">
                    <p>创建歌单暂时不可用</p><span>收藏歌单仍会独立显示。</span>
                    <button className="text-button text-button--primary" onClick={() => setCreatedRetry((value) => value + 1)} type="button">重新读取创建歌单</button>
                  </div>
                ) : createdPlaylistsState.state === "ready" && createdPlaylistsState.page.items.length === 0 ? (
                  <div className="catalog-empty catalog-empty--section"><p>还没有创建歌单</p></div>
                ) : <div className="playlist-grid">
                  {createdPlaylists.map((playlist) => (
                    <article className="playlist-card" key={playlist.id}>
                      <span className="section-label">CREATED</span>
                      <h3>{playlist.title}</h3><p>{playlist.songCount} 首歌曲</p>
                      <button className="text-button text-button--primary" onClick={() => void openPlaylist(playlist)} ref={playlist.id === createdPlaylists[0]?.id ? playlistReturnRef : undefined} type="button">打开歌单</button>
                      <button className="text-button" hidden={remote} onClick={() => void handleDeletePlaylist(playlist)} type="button">
                        {armedDeleteId === playlist.id ? `确认删除 ${playlist.title}` : "删除歌单"}
                      </button>
                    </article>
                  ))}
                </div>}
              </section>
              <section aria-labelledby="favorite-playlists-title">
                <h2 id="favorite-playlists-title">我收藏的{favoritePlaylistsState.state === "ready" ? ` · ${favoritePlaylistsState.page.total}` : ""}</h2>
                {favoritePlaylistsState.state === "loading" || favoritePlaylistsState.state === "idle" ? (
                  <div aria-live="polite" className="catalog-empty catalog-empty--section"><p>正在读取收藏歌单</p></div>
                ) : favoritePlaylistsState.state === "error" ? (
                  <div role="alert" className="catalog-empty catalog-empty--section">
                    <p>收藏歌单暂时不可用</p><span>创建歌单仍会独立显示。</span>
                    <button className="text-button text-button--primary" onClick={() => setFavoriteRetry((value) => value + 1)} type="button">重新读取收藏歌单</button>
                  </div>
                ) : favoritePlaylistsState.state === "ready" && favoritePlaylistsState.page.items.length === 0 ? (
                  <div className="catalog-empty catalog-empty--section"><p>还没有收藏歌单</p></div>
                ) : <div className="playlist-grid">
                  {favoritePlaylistsState.state === "ready" ? favoritePlaylistsState.page.items.map((playlist) => (
                    <article className="playlist-card" key={playlist.id}>
                      <span className="section-label">FAVORITE</span>
                      <h3>{playlist.title}</h3><p>{playlist.songCount} 首歌曲</p>
                      <button className="text-button text-button--primary" onClick={() => void openPlaylist(playlist)} type="button">打开歌单</button>
                      <button className="text-button" hidden={remote} onClick={() => void handleFavoritePlaylist(playlist, false)} type="button">取消收藏</button>
                    </article>
                  )) : null}
                </div>}
              </section>
            </div>
          )
        ) : section === "liked" && liveAccountRuntime && authRecovering ? (
          <div aria-live="polite" className="catalog-empty"><p>正在恢复账号</p><span>恢复完成后会自动读取喜欢的音乐。</span></div>
        ) : section === "liked" && liveAccountRuntime && authSnapshot.state === "signedOut" ? (
          <div className="catalog-empty"><p>请先登录后读取账号曲库</p><span>登录成功后当前页面会自动恢复。</span></div>
        ) : section === "liked" && liveAccountRuntime && authSnapshot.state === "unavailable" ? (
          <div role="alert" className="catalog-empty"><p>账号恢复失败</p><span>请打开账号面板重新登录。</span></div>
        ) : liveCatalog.state === "loading" ? (
          <div aria-live="polite" className="catalog-empty"><p>正在读取 QQ 音乐目录</p><span>返回后只保留规范化歌曲信息。</span></div>
        ) : liveCatalog.state === "error" ? (
          <div role="alert" className="catalog-empty">
            <p>{section === "liked" ? "喜欢的音乐暂时不可用" : "目录暂时不可用"}</p>
            <span>请检查网络或稍后重新读取。</span>
            {section === "liked" ? <button className="text-button text-button--primary" onClick={() => setLikedRetry((value) => value + 1)} type="button">重新读取喜欢的音乐</button> : null}
          </div>
        ) : visibleTracks.length > 0 ? (
          <div className="catalog-table-wrap">
            <table className="catalog-table">
              <thead><tr><th scope="col">#</th><th scope="col">封面</th><th scope="col">曲目</th><th scope="col">歌手</th><th scope="col">专辑</th><th scope="col">音质</th><th scope="col">时长</th></tr></thead>
              <tbody>
                {visibleTracks.map((value, index) => {
                  const track = displayTrack(value);
                  const artworkTrack = value.source === "preview" ? value.track : liveArtworkTrack(value.track);
                  const active = currentTrack?.id === track.id;
                  return (
                    <tr className={active ? "catalog-table__active" : undefined} key={track.id}>
                       <td><span className={active ? "catalog-needle catalog-needle--active" : "catalog-needle"}>{active ? <span className="sr-only">当前曲目</span> : String(index + 1).padStart(2, "0")}</span></td>
                      <td><AlbumArtwork compact track={artworkTrack} /></td>
                      <td><button className="catalog-table__title" onClick={() => setSelectedId(track.id)} type="button"><strong>{track.title}</strong><small>{track.identifier}</small></button>{remote && value.source === "live" && value.track.albumId ? <small className="remote-song-album"><AlbumLink track={value.track} onOpen={setOpenedEntity} /></small> : null}</td>
                      <td>{value.source === "live" ? <ArtistLinks artists={value.track.artists} onOpenArtist={openArtist} /> : track.artist}</td><td><AlbumLink track={track} onOpen={setOpenedEntity} /></td><td><span className="quality-tag">{track.quality}</span></td><td className="catalog-table__duration">{formatDuration(track.durationMs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="catalog-empty">
            <p>{liveCatalog.state === "idle" && section === "search" ? "输入关键词开始搜索" : "没有找到匹配的音乐"}</p>
            <span>{liveCatalog.state === "idle" && !["discover", "search"].includes(section) ? "账号曲库将在登录验收后开放；这里不会显示伪造内容。" : "换一个歌名、歌手或专辑试试。"}</span>
          </div>
        )}
        {liveCatalog.state === "ready" && (section === "search" || query.trim() || (remote && section === "liked")) ? <div className="remote-pagination"><button className="text-button" disabled={remotePage === 1} onClick={() => setRemotePage(p => p - 1)}>上一页</button><span>第 {remotePage} 页</span><button className="text-button" disabled={!liveCatalog.page.hasMore || remotePage >= 100} onClick={() => setRemotePage(p => p + 1)}>下一页</button></div> : null}
      </section>

      {selectedTrack && !((section === "search" || (section === "discover" && query.trim())) && searchType !== "songs") && (section !== "playlists" || playlistDetail.state === "ready") && section !== "organizer" ? (
        <aside className="catalog-inspector" aria-label="当前选中曲目">
          <span className="section-label">CURRENT SELECTION</span>
          <AlbumArtwork
            compact
            track={selectedTrack.source === "preview" ? selectedTrack.track : liveArtworkTrack(selectedTrack.track)}
          />
          <h2>{selectedTrack.track.title}</h2>
          <p><SongArtistLinks track={selectedTrack.track} onOpenArtist={openArtist} /></p>
          <dl><div><dt>专辑</dt><dd><AlbumLink track={selectedTrack.track} onOpen={setOpenedEntity} /></dd></div><div><dt>实际音质</dt><dd>{selectedTrack.source === "preview" ? selectedTrack.track.actualQuality : qualityLabel(selectedTrack.track)}</dd></div><div><dt>时长</dt><dd>{formatDuration(selectedTrack.track.durationMs)}</dd></div></dl>
          {selectedTrack.source === "preview" ? (
            <>
              <button className="text-button text-button--primary catalog-inspector__play" onClick={() => playerActions.playTrack(selectedTrack.track.id)} type="button"><Icon name="play" size={17} />立即播放</button>
              <button aria-pressed={likedIds.includes(selectedTrack.track.id)} className="text-button" onClick={() => playerActions.toggleLike(selectedTrack.track.id)} type="button"><Icon name="heart" size={17} />{likedIds.includes(selectedTrack.track.id) ? "取消喜欢" : "喜欢"}</button>
              <button className="text-button" type="button">加入歌单</button>
            </>
          ) : (
            <>
              <div className="catalog-inspector__play-actions">
                <button aria-label={`下一首播放 ${selectedTrack.track.title}`} title="下一首播放" className="text-button play-next-button" onClick={() => void playNext(selectedTrack.track)} type="button"><Icon name="play-next" size={20} /></button>
                <button className="text-button text-button--primary catalog-inspector__play" onClick={() => void updateNativeQueue(selectedTrack.track, true)} type="button"><Icon name="play" size={17} />{remote ? "在电脑播放" : "原生播放"}</button>
              </div>
              <button className="text-button" onClick={() => void updateNativeQueue(selectedTrack.track, false)} type="button"><Icon name="queue" size={17} />{remote ? "加入电脑队列" : "加入本地队列"}</button>
              <button className="text-button" onClick={() => void handleLiveLike(selectedTrack.track)} type="button"><Icon name="heart" size={17} />{remote && section === "liked" ? "取消喜欢" : "喜欢"}</button>
              {!remote && createdPlaylists.length > 0 ? (
                <div className="catalog-inspector__playlist">
                  <span>目标歌单</span>
                  <PlaylistPicker
                    label="目标歌单"
                    onChange={setTargetPlaylistId}
                    options={createdPlaylists.map((playlist) => ({ id: playlist.id, title: playlist.title }))}
                    value={targetPlaylistId}
                  />
                  <button className="text-button" onClick={() => void handleAddToPlaylist(selectedTrack.track)} type="button">加入歌单</button>
                </div>
              ) : null}
              {queueNotice ? <p aria-live="polite" className="catalog-inspector__notice">{queueNotice}</p> : null}
              {libraryNotice ? <p aria-live="polite" className="catalog-inspector__notice">{libraryNotice}</p> : null}
            </>
          )}
        </aside>
      ) : null}
        </>
      )}
    </main>
  );
}
