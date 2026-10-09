import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalMusicListResult, LocalMusicTrack } from "../../contracts/localMusic";
import LocalMusicLibrary from "./LocalMusicLibrary";

const { getMock, importMock, deleteMock, enqueueMock, playMock, hydrateMock, applySessionMock, currentTrackMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  importMock: vi.fn(),
  deleteMock: vi.fn(),
  enqueueMock: vi.fn(),
  playMock: vi.fn(),
  hydrateMock: vi.fn(),
  applySessionMock: vi.fn(),
  currentTrackMock: vi.fn(),
}));

vi.mock("../../backend/localMusicAdapter", () => ({
  getLocalMusic: getMock,
  importLocalMusic: importMock,
  deleteLocalMusic: deleteMock,
}));
vi.mock("../player/localQueue", () => ({
  enqueueLocalTrack: enqueueMock,
  enqueueAndPlayLocalTrack: playMock,
}));
vi.mock("../player/playerStore", () => ({
  getCurrentTrack: currentTrackMock,
  usePlayerSelector: (selector: (value: unknown) => unknown) => selector({}),
  playerActions: { hydrateNative: hydrateMock, applyAuthoritativeSession: applySessionMock },
}));

const TRACK: LocalMusicTrack = {
  id: "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_mp3",
  title: "本地夜航",
  artist: "本地艺术家",
  album: "本地专辑",
  durationMs: 180_000,
  format: "mp3",
};
const SECOND: LocalMusicTrack = { ...TRACK, id: "local_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_flac", title: "玻璃雨声", format: "flac" };

function list(tracks: readonly LocalMusicTrack[] = [TRACK]): LocalMusicListResult {
  return { tracks, warningCount: 0 };
}

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  getMock.mockReset().mockResolvedValue(list());
  importMock.mockReset().mockResolvedValue({ imported: [], existingCount: 0, failures: [] });
  deleteMock.mockReset();
  enqueueMock.mockReset().mockResolvedValue({ generation: 1, selectedIndex: 0, items: [TRACK] });
  playMock.mockReset().mockResolvedValue(undefined);
  hydrateMock.mockReset();
  applySessionMock.mockReset();
  currentTrackMock.mockReset().mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("LocalMusicLibrary", () => {
  it("keeps reference deletion unavailable and blocks missing-track playback", async () => {
    getMock.mockResolvedValue(list([{ ...TRACK, referenced: true, available: false }]));
    render(<LocalMusicLibrary />);
    const inspector = await screen.findByRole("complementary", { name: "当前选中本地曲目" });
    expect(within(inspector).queryByRole("button", { name: "删除歌曲" })).not.toBeInTheDocument();
    expect(within(inspector).getByRole("button", { name: "立即播放" })).toBeDisabled();
    expect(within(inspector).getByRole("button", { name: "加入本地队列" })).toBeDisabled();
  });

  it("renders bounded pages but searches all indexed songs", async () => {
    const tracks = Array.from({ length: 250 }, (_, i) => ({ ...TRACK, id: `local_${i.toString(16).padStart(64, "0")}_mp3`, title: `音乐 ${i}` }));
    getMock.mockResolvedValue(list(tracks));
    render(<LocalMusicLibrary />);
    await screen.findByRole("button", { name: /音乐 0/ });
    expect(screen.getAllByRole("row")).toHaveLength(101);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByRole("button", { name: /音乐 100/ })).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "搜索本地歌曲" }), "音乐 249");
    expect(screen.getByRole("button", { name: /音乐 249/ })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("does not expose directory management to remote clients", async () => {
    render(<LocalMusicLibrary remote />);
    await screen.findByRole("complementary", { name: "当前选中本地曲目" });
    expect(screen.queryByRole("button", { name: "管理音乐目录" })).not.toBeInTheDocument();
  });
  it("loads and renders the local catalog, then filters by title, artist, or album", async () => {
    const user = userEvent.setup();
    getMock.mockResolvedValueOnce(list([TRACK, SECOND]));
    render(<LocalMusicLibrary />);

    expect(await screen.findByRole("heading", { name: "本地音乐" })).toBeInTheDocument();
    expect(screen.getAllByText("本地夜航").length).toBeGreaterThan(0);
    expect(screen.getAllByText("玻璃雨声").length).toBeGreaterThan(0);
    const search = screen.getByRole("searchbox", { name: "搜索本地歌曲" });
    await user.type(search, "玻璃");
    expect(screen.queryByText("本地夜航")).not.toBeInTheDocument();
    expect(screen.getAllByText("玻璃雨声").length).toBeGreaterThan(0);
  });

  it("selects a track and reuses local queue actions for enqueue and playback", async () => {
    const user = userEvent.setup();
    render(<LocalMusicLibrary />);
    await user.click(await screen.findByRole("button", { name: /本地夜航/ }));
    const inspector = screen.getByRole("complementary", { name: "当前选中本地曲目" });
    expect(within(inspector).getByText("MP3")).toBeInTheDocument();
    await user.click(within(inspector).getByRole("button", { name: "加入本地队列" }));
    await waitFor(() => expect(enqueueMock).toHaveBeenCalledWith(TRACK));
    await user.click(within(inspector).getByRole("button", { name: "立即播放" }));
    await waitFor(() => expect(playMock).toHaveBeenCalledWith(TRACK));
  });

  it("shows a batch import summary and refreshes once for newly imported tracks", async () => {
    const user = userEvent.setup();
    const imported = { ...SECOND, title: "新增歌曲" };
    importMock.mockResolvedValueOnce({
      imported: [imported],
      existingCount: 2,
      failures: [{ fileName: "bad.wav", code: "local_music_unsupported_format" }],
    });
    getMock.mockResolvedValueOnce(list()).mockResolvedValueOnce(list([TRACK, imported]));
    render(<LocalMusicLibrary />);
    await user.click(await screen.findByRole("button", { name: "导入音乐" }));
    expect(await screen.findByText("导入完成：新增 1 首，已存在 2 首，失败 1 项")).toBeInTheDocument();
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("新增歌曲")).toBeInTheDocument();
  });

  it("treats a cancelled picker result with all zero counts as a normal notice", async () => {
    const user = userEvent.setup();
    render(<LocalMusicLibrary />);
    await user.click(await screen.findByRole("button", { name: "导入音乐" }));
    expect(await screen.findByText("未选择本地音乐文件。")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("maps load failures to friendly text without exposing raw errors", async () => {
    getMock.mockRejectedValueOnce({ code: "QMG-LOCAL-MUSIC-STORAGE", path: "C:\\secret" });
    render(<LocalMusicLibrary />);
    expect(await screen.findByText("应用安装目录不可写，请确认目录权限后重试。")).toBeInTheDocument();
    expect(screen.queryByText("C:\\secret")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "重新读取" }));
  });

  it("requires two clicks, applies the authoritative session, refreshes once, and selects the adjacent track", async () => {
    const user = userEvent.setup();
    currentTrackMock.mockReturnValue(TRACK);
    getMock.mockReset().mockResolvedValueOnce(list([TRACK, SECOND])).mockResolvedValueOnce(list([SECOND]));
    const session = {
      mode: "sequence",
      requestedQuality: "320k",
      queue: { generation: 2, selectedIndex: 0, items: [SECOND] },
      player: {
        state: "playing", generation: 4, positionMs: 0, durationMs: SECOND.durationMs,
        volume: 0.7, muted: false,
        currentTrack: { id: SECOND.id, title: SECOND.title, artist: SECOND.artist },
        failure: null,
      },
    } as const;
    deleteMock.mockResolvedValue({ deletedId: TRACK.id, session, autoPlayStarted: false });
    render(<LocalMusicLibrary />);
    await user.click(await screen.findByRole("button", { name: /本地夜航/ }));
    const inspector = screen.getByRole("complementary", { name: "当前选中本地曲目" });
    const deleteButton = within(inspector).getByRole("button", { name: "删除歌曲" });
    await user.click(deleteButton);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(within(inspector).getByRole("button", { name: "确认删除《本地夜航》" })).toBeInTheDocument();
    await user.click(within(inspector).getByRole("button", { name: "确认删除《本地夜航》" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(TRACK.id));
    expect(applySessionMock).toHaveBeenCalledWith(session);
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("歌曲已删除，下一首未能播放")).toBeInTheDocument();
    expect(screen.getAllByText("玻璃雨声").length).toBeGreaterThan(0);
  });

  it("does not report an autoplay failure when deleting a non-current track", async () => {
    const user = userEvent.setup();
    currentTrackMock.mockReturnValue(SECOND);
    getMock.mockReset().mockResolvedValueOnce(list([TRACK, SECOND])).mockResolvedValueOnce(list([SECOND]));
    const session = {
      mode: "sequence",
      requestedQuality: "320k",
      queue: { generation: 2, selectedIndex: 0, items: [SECOND] },
      player: {
        state: "playing", generation: 4, positionMs: 0, durationMs: SECOND.durationMs,
        volume: 0.7, muted: false,
        currentTrack: { id: SECOND.id, title: SECOND.title, artist: SECOND.artist },
        failure: null,
      },
    } as const;
    deleteMock.mockResolvedValue({ deletedId: TRACK.id, session, autoPlayStarted: false });
    render(<LocalMusicLibrary />);
    await user.click(await screen.findByRole("button", { name: /本地夜航/ }));
    const inspector = screen.getByRole("complementary", { name: "当前选中本地曲目" });
    await user.click(within(inspector).getByRole("button", { name: "删除歌曲" }));
    await user.click(within(inspector).getByRole("button", { name: "确认删除《本地夜航》" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(TRACK.id));
    expect(await screen.findByText("歌曲已删除", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("歌曲已删除，下一首未能播放")).not.toBeInTheDocument();
  });

  it("does not report an autoplay failure when deleting the only current track", async () => {
    const user = userEvent.setup();
    currentTrackMock.mockReturnValue(TRACK);
    getMock.mockReset().mockResolvedValueOnce(list([TRACK])).mockResolvedValueOnce(list([]));
    const session = {
      mode: "sequence",
      requestedQuality: "320k",
      queue: { generation: 2, selectedIndex: null, items: [] },
      player: {
        state: "idle", generation: 4, positionMs: 0, durationMs: 0,
        volume: 0.7, muted: false,
        currentTrack: null,
        failure: null,
      },
    } as const;
    deleteMock.mockResolvedValue({ deletedId: TRACK.id, session, autoPlayStarted: false });
    render(<LocalMusicLibrary />);
    await user.click(await screen.findByRole("button", { name: /本地夜航/ }));
    const inspector = screen.getByRole("complementary", { name: "当前选中本地曲目" });
    await user.click(within(inspector).getByRole("button", { name: "删除歌曲" }));
    await user.click(within(inspector).getByRole("button", { name: "确认删除《本地夜航》" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(TRACK.id));
    expect(await screen.findByText("歌曲已删除", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("歌曲已删除，下一首未能播放")).not.toBeInTheDocument();
  });
});
