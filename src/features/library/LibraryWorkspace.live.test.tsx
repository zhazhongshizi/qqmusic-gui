import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invalidatePlaylistSongs } from "./readPlaylistSongs";
import LibraryWorkspace from "./LibraryWorkspace";
import { resetPlayerFixture } from "../player/playerStore";
import type { AuthSnapshot } from "../../contracts/auth";

const {
  discoverMock,
  searchMock,
  playlistSongsMock,
  playlistsMock,
  likedMock,
  enqueueMock,
  enqueueManyMock,
  replaceMock,
  playMock,
  addToPlaylistMock,
} = vi.hoisted(() => ({
  discoverMock: vi.fn(),
  searchMock: vi.fn(),
  playlistSongsMock: vi.fn(),
  playlistsMock: vi.fn(),
  likedMock: vi.fn(),
  enqueueMock: vi.fn(),
  enqueueManyMock: vi.fn(),
  replaceMock: vi.fn(),
  playMock: vi.fn(),
  addToPlaylistMock: vi.fn(),
}));

vi.mock("../../backend/libraryAdapter", () => ({
  getLibraryPlaylists: playlistsMock,
  getLikedSongs: likedMock,
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  addSongsToPlaylist: addToPlaylistMock,
  setPlaylistFavorite: vi.fn(),
  setSongsLiked: vi.fn(),
}));

vi.mock("../../backend/catalogAdapter", () => ({
  discoverCatalogSongs: discoverMock,
  searchCatalogSongs: searchMock,
  getPlaylistSongs: playlistSongsMock,
}));
vi.mock("../artist/ArtistPage", () => ({
  ArtistPage: ({ artist, onBack }: { artist: { id: string; name: string }; onBack: () => void }) => (
    <section>
      <h1>{artist.name} · ARTIST</h1>
      <button onClick={onBack} type="button">返回上一页</button>
    </section>
  ),
}));
vi.mock("../../backend/nativeQueueAdapter", () => ({
  nativeQueueEnqueue: enqueueMock,
  nativeQueueEnqueueMany: enqueueManyMock,
  nativeQueueReplace: replaceMock,
  nativeQueuePlay: playMock,
  nativeQueueSnapshot: vi.fn(),
  nativeQueueMove: vi.fn(),
  nativeQueueRemove: vi.fn(),
  nativeQueueNext: vi.fn(),
  nativeQueuePrevious: vi.fn(),
  nativePlaybackSessionSnapshot: vi.fn(),
  nativeSetPlaybackMode: vi.fn(),
}));
vi.mock("../../backend/nativePlayerAdapter", () => ({
  PlayerAdapterError: class PlayerAdapterError extends Error {},
  nativePlayerSnapshot: vi.fn().mockResolvedValue({
    state: "idle", generation: 0, positionMs: 0, durationMs: null,
    volume: 0.72, muted: false, currentTrack: null, failure: null,
  }),
  nativePlay: vi.fn(),
  nativePause: vi.fn(),
  nativeSeek: vi.fn(),
  nativeSetMuted: vi.fn(),
  nativeSetVolume: vi.fn(),
  nativeStop: vi.fn(),
}));

const SONG = {
  id: "0039MnYb0qxYhV", title: "晴天", subtitle: "",
  artists: [{ id: "artist-mid-jay", name: "周杰伦" }], artist: "周杰伦", album: "叶惠美",
  durationMs: 269_000,
  qualityCandidates: [
    { quality: "flac", available: true, requiresSubscription: true },
    { quality: "320k", available: true, requiresSubscription: true },
    { quality: "128k", available: true, requiresSubscription: false },
  ],
  availability: { status: "unknown", requiresSubscription: true },
} as const;
const SONG_TWO = { ...SONG, id: "0039MnYb0qxYhV-2", title: "夜曲" } as const;
const PAGE = { generation: 1, page: 1, hasMore: false, warningCount: 0, items: [SONG] };
const AUTHENTICATED = {
  state: "authenticated",
  account: { musicId: "779436361", loginMethod: "qq" },
} as const;

function renderWorkspace(
  initialSection: "discover" | "search" | "liked" | "playlists" = "discover",
  authSnapshot: AuthSnapshot = AUTHENTICATED,
  authRecovering = false,
) {
  return render(
    <LibraryWorkspace
      authRecovering={authRecovering}
      authSnapshot={authSnapshot}
      initialSection={initialSection}
      onBack={() => undefined}
    />,
  );
}

describe("live catalog workspace", () => {
  beforeEach(() => {
    invalidatePlaylistSongs();
    enqueueManyMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    discoverMock.mockReset().mockResolvedValue(PAGE);
    searchMock.mockReset().mockImplementation((_keyword: string, generation: number) =>
      Promise.resolve({ ...PAGE, generation }),
    );
    playlistSongsMock.mockReset().mockImplementation((_id: string, generation: number) =>
      Promise.resolve({ ...PAGE, generation }),
    );
    likedMock.mockReset().mockImplementation((_page: number, pageSize: number, generation: number) =>
      Promise.resolve({ ...PAGE, generation, pageSize }),
    );
    playlistsMock.mockReset().mockImplementation((kind: "created" | "favorite") => Promise.resolve({
      kind, page: 1, hasMore: false, total: kind === "created" ? 1 : 0, warningCount: 0,
      items: kind === "created" ? [{
        id: "99123456", editableId: "88", title: "我喜欢", songCount: 11,
      }] : [],
    }));
    enqueueMock.mockReset().mockResolvedValue({
      generation: 1, selectedIndex: 0,
      items: [{ id: SONG.id, title: SONG.title, artist: SONG.artist, album: SONG.album, durationMs: SONG.durationMs }],
    });
    replaceMock.mockReset().mockResolvedValue({
      generation: 2,
      selectedIndex: 0,
      items: [
        { id: SONG.id, title: SONG.title, artist: SONG.artist, album: SONG.album, durationMs: SONG.durationMs },
        { id: SONG_TWO.id, title: SONG_TWO.title, artist: SONG_TWO.artist, album: SONG_TWO.album, durationMs: SONG_TWO.durationMs },
      ],
    });
    playMock.mockReset().mockResolvedValue({
      queue: {
        generation: 2, selectedIndex: 0,
        items: [{ id: SONG.id, title: SONG.title, artist: SONG.artist, album: SONG.album, durationMs: SONG.durationMs }],
      },
      playback: {
        quality: "128k",
        expiresInSeconds: 300,
        player: {
          state: "playing", generation: 7, positionMs: 0, durationMs: SONG.durationMs,
          volume: 0.72, muted: false,
          currentTrack: { id: SONG.id, title: SONG.title, artist: SONG.artist },
          failure: null,
        },
      },
    });
    addToPlaylistMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    resetPlayerFixture();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("Tauri 窗口读取真实发现页且不显示 fixture 曲目", async () => {
    renderWorkspace();
    expect((await screen.findAllByText("晴天")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("周杰伦").length).toBeGreaterThan(0);
    expect(screen.queryByText("暮色温室")).not.toBeInTheDocument();
    expect(screen.getByText("QQ / LIVE")).toBeInTheDocument();
  });

  it("搜索去抖后只保留新 generation，并可加入后交给原生播放器", async () => {
    const user = userEvent.setup();
    renderWorkspace("search");
    await user.type(screen.getByRole("searchbox"), "晴天");
    expect((await screen.findAllByText("晴天")).length).toBeGreaterThan(0);
    expect(searchMock).toHaveBeenCalledWith("晴天", expect.any(Number), 1);

    await user.click(screen.getByRole("button", { name: "原生播放" }));
    await waitFor(() => expect(enqueueMock).toHaveBeenCalled());
    expect(playMock).toHaveBeenCalledWith(0);
    expect(await screen.findByText("已交给 Windows 原生播放器")).toBeInTheDocument();
  });

  it("从真实歌单卡片打开详情并返回列表", async () => {
    const user = userEvent.setup();
    renderWorkspace("playlists");
    expect(await screen.findByText("我创建的 · 1")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "打开歌单" })[0]!);
    expect(await screen.findByRole("heading", { name: "我喜欢" })).toBeInTheDocument();
    expect(playlistSongsMock).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 1, 20, "88");
    expect(screen.getAllByText("晴天").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /返回全部歌单/ }));
    expect(await screen.findByRole("heading", { name: "我的歌单" })).toBeInTheDocument();
  });

  it("选择目标歌单后沿用既有加入歌单路径，选择器不会读取额外 Provider 数据", async () => {
    const user = userEvent.setup();
    playlistsMock.mockImplementation((kind: "created" | "favorite") => Promise.resolve({
      kind, page: 1, hasMore: false, total: kind === "created" ? 2 : 0, warningCount: 0,
      items: kind === "created" ? [
        { id: "99123456", editableId: "88", title: "我喜欢", songCount: 11 },
        { id: "99123457", editableId: "89", title: "夜航目标", songCount: 4 },
      ] : [],
    }));

    renderWorkspace("playlists");
    await user.click((await screen.findAllByRole("button", { name: "打开歌单" }))[0]!);
    await screen.findByRole("heading", { name: "我喜欢" });

    await user.click(screen.getByRole("combobox", { name: "目标歌单：我喜欢" }));
    await user.click(screen.getByRole("option", { name: "夜航目标" }));
    await user.click(screen.getByRole("button", { name: "加入歌单" }));

    await waitFor(() => expect(addToPlaylistMock).toHaveBeenCalledWith("99123457", "89", [SONG.id]));
    expect(playlistSongsMock).toHaveBeenCalledTimes(1);
    expect(playlistsMock).toHaveBeenCalledTimes(2);
  });

  it("搜索后选择未浏览的歌曲可查看详情并批量追加，保留已有队列且不启动播放", async () => {
    const user = userEvent.setup();
    playlistSongsMock.mockImplementation((_id: string, generation: number, _page: number, pageSize: number) => Promise.resolve(
      pageSize === 50 ? { ...PAGE, generation, items: [SONG, SONG_TWO] }
        : { ...PAGE, generation, hasMore: true },
    ));
    enqueueManyMock.mockImplementation(async (tracks) => ({
      generation: 3, selectedIndex: 0,
      items: [{ id: SONG.id, title: SONG.title, artist: SONG.artist, album: SONG.album, durationMs: SONG.durationMs }, ...tracks],
    }));
    renderWorkspace("playlists");
    await user.click((await screen.findAllByRole("button", { name: "打开歌单" }))[0]!);
    await user.type(await screen.findByRole("searchbox", { name: "歌单内搜索" }), "夜曲");
    await user.click(await screen.findByRole("button", { name: /^夜曲/ }));
    expect(screen.getByRole("heading", { name: "夜曲" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "选择 夜曲" }));
    await user.click(screen.getByRole("button", { name: "加入播放队列" }));
    expect(await screen.findByText("已将 1 首歌曲加入播放队列")).toBeInTheDocument();
    expect(enqueueManyMock).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ id: SONG_TWO.id })]);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(playMock).not.toHaveBeenCalled();
  });

  it("从表格或歌曲信息的歌手名字进入 Artist Page，并返回原歌单详情", async () => {
    const user = userEvent.setup();
    renderWorkspace("playlists");
    await user.click((await screen.findAllByRole("button", { name: "打开歌单" }))[0]!);
    await screen.findByRole("heading", { name: "我喜欢" });

    await user.click(screen.getByRole("button", { name: /^晴天/ }));
    expect(screen.queryByRole("heading", { name: "周杰伦 · ARTIST" })).not.toBeInTheDocument();

    await user.click(within(screen.getByRole("table")).getByRole("button", { name: "查看歌手 周杰伦" }));
    expect(await screen.findByRole("heading", { name: "周杰伦 · ARTIST" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回上一页" }));
    expect(await screen.findByRole("heading", { name: "我喜欢" })).toBeInTheDocument();
    expect(screen.getAllByText("叶惠美").length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole("button", { name: "查看歌手 周杰伦" }).at(-1)!);
    expect(await screen.findByRole("heading", { name: "周杰伦 · ARTIST" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回上一页" }));
    expect(await screen.findByRole("heading", { name: "我喜欢" })).toBeInTheDocument();
  });

  it("打开歌单后读取全部分页，替换本地队列并播放第一首", async () => {
    const user = userEvent.setup();
    playlistSongsMock.mockImplementation((_id: string, generation: number, page: number, pageSize: number) => {
      if (pageSize === 20) return Promise.resolve({ ...PAGE, generation });
      if (page === 1) {
        return Promise.resolve({
          generation,
          page: 1,
          hasMore: true,
          total: 2,
          warningCount: 0,
          items: [SONG],
        });
      }
      return Promise.resolve({
        generation,
        page: 2,
        hasMore: false,
        total: 2,
        warningCount: 0,
        items: [SONG_TWO],
      });
    });

    renderWorkspace("playlists");
    await user.click((await screen.findAllByRole("button", { name: "打开歌单" }))[0]!);
    await screen.findByRole("heading", { name: "我喜欢" });
    await user.click(screen.getByRole("button", { name: "播放全部" }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1));
    expect(playlistSongsMock).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 1, 50, "88");
    expect(playlistSongsMock).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 2, 50, "88");
    expect(replaceMock).toHaveBeenCalledWith([
      { id: SONG.id, title: SONG.title, artist: SONG.artist, album: SONG.album, durationMs: SONG.durationMs },
      { id: SONG_TWO.id, title: SONG_TWO.title, artist: SONG_TWO.artist, album: SONG_TWO.album, durationMs: SONG_TWO.durationMs },
    ]);
    await waitFor(() => expect(playMock).toHaveBeenCalledWith(0));
    expect(await screen.findByText("已载入 2 首并开始播放")).toBeInTheDocument();
  });

  it("账号恢复期间不读取喜欢，认证后以 20 首自动读取", async () => {
    const view = renderWorkspace("liked", { state: "signedOut" } as const, true);
    expect(screen.getByText("正在恢复账号")).toBeInTheDocument();
    expect(likedMock).not.toHaveBeenCalled();

    view.rerender(
      <LibraryWorkspace
        authRecovering={false}
        authSnapshot={AUTHENTICATED}
        initialSection="liked"
        onBack={() => undefined}
      />,
    );
    expect((await screen.findAllByText("晴天")).length).toBeGreaterThan(0);
    expect(likedMock).toHaveBeenCalledWith(1, 20, expect.any(Number));
  });

  it("创建歌单失败时仍显示收藏歌单并只重试创建分区", async () => {
    const user = userEvent.setup();
    playlistsMock.mockImplementation((kind: "created" | "favorite") => kind === "created"
      ? Promise.reject(new Error("created unavailable"))
      : Promise.resolve({
          kind, page: 1, hasMore: false, total: 1, warningCount: 0,
          items: [{ id: "772233", title: "夜航收藏", description: "", songCount: 9 }],
        }));

    renderWorkspace("playlists");
    expect(await screen.findByText("创建歌单暂时不可用")).toBeInTheDocument();
    expect(screen.getByText("夜航收藏")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新读取创建歌单" }));
    await waitFor(() => {
      expect(playlistsMock.mock.calls.filter(([kind]) => kind === "created")).toHaveLength(2);
    });
    expect(playlistsMock.mock.calls.filter(([kind]) => kind === "favorite")).toHaveLength(1);
  });

  it("收藏歌单失败时仍显示创建歌单", async () => {
    const user = userEvent.setup();
    playlistsMock.mockImplementation((kind: "created" | "favorite") => kind === "favorite"
      ? Promise.reject(new Error("favorite unavailable"))
      : Promise.resolve({
          kind, page: 1, hasMore: false, total: 1, warningCount: 0,
          items: [{ id: "99123456", editableId: "88", title: "我喜欢", description: "", songCount: 11 }],
        }));

    renderWorkspace("playlists");
    expect(await screen.findByText("收藏歌单暂时不可用")).toBeInTheDocument();
    expect(screen.getByText("我喜欢")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新读取收藏歌单" }));
    await waitFor(() => {
      expect(playlistsMock.mock.calls.filter(([kind]) => kind === "favorite")).toHaveLength(2);
    });
    expect(playlistsMock.mock.calls.filter(([kind]) => kind === "created")).toHaveLength(1);
  });

  it("喜欢读取失败后只重试喜欢歌曲", async () => {
    const user = userEvent.setup();
    likedMock.mockRejectedValue(new Error("liked unavailable"));
    renderWorkspace("liked");
    expect(await screen.findByText("喜欢的音乐暂时不可用")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新读取喜欢的音乐" }));
    await waitFor(() => expect(likedMock).toHaveBeenCalledTimes(2));
    expect(playlistsMock).not.toHaveBeenCalled();
  });
  it("播放超过队列上限的歌单时只载入前 1000 首", async () => {
    let queue = { generation: 2, selectedIndex: 0, items: [] as Array<{ id: string; title: string; artist: string; album: string; durationMs: number }> };
    replaceMock.mockImplementation(async items => queue = { ...queue, items });
    playMock.mockImplementation(async index => ({ queue, playback: { quality: "320k", expiresInSeconds: 300, player: {
      state: "playing", generation: 7, positionMs: 0, durationMs: queue.items[index]!.durationMs, volume: .72, muted: false,
      currentTrack: queue.items[index], failure: null,
    } } }));
    const user = userEvent.setup();
    playlistSongsMock.mockImplementation((_id: string, generation: number, page: number, pageSize: number) => {
      if (pageSize === 20) return Promise.resolve({ ...PAGE, generation });
      const all = Array.from({ length: 1001 }, (_, i) => ({ ...SONG, id: `song-${i}` }));
      return Promise.resolve({ ...PAGE, generation, page, hasMore: page * pageSize < all.length, items: all.slice((page - 1) * pageSize, page * pageSize) });
    });
    renderWorkspace("playlists");
    await user.click((await screen.findAllByRole("button", { name: "打开歌单" }))[0]!);
    await user.click(await screen.findByRole("button", { name: "播放全部" }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
    expect(replaceMock.mock.calls[0]![0]).toHaveLength(1000);
    expect(await screen.findByText("歌单超过队列上限，已载入前 1000 首并开始播放")).toBeInTheDocument();
  });

  it("leaving the library cancels an unfinished play-all read", async () => {
    const user = userEvent.setup();
    let resolve!: (value: typeof PAGE) => void;
    playlistSongsMock.mockImplementation((_id: string, generation: number, _page: number, size: number) =>
      size === 20 ? Promise.resolve({ ...PAGE, generation }) : new Promise(r => { resolve = r; }));
    const view = renderWorkspace("playlists");
    await user.click((await screen.findAllByRole("button", { name: "打开歌单" }))[0]!);
    await user.click(await screen.findByRole("button", { name: "播放全部" }));
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    view.unmount();
    await act(async () => { resolve(PAGE); });
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
