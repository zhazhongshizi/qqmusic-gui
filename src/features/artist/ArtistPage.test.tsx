import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtistDetail, ArtistRef } from "../../contracts/artist";
import type { CatalogSong } from "../../contracts/catalog";
import { resetPlayerFixture } from "../player/playerStore";
import { ArtistPage } from "./ArtistPage";

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  songs: vi.fn(),
  enqueue: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("../../backend/artistAdapter", () => ({
  getArtistDetail: mocks.detail,
  getArtistSongs: mocks.songs,
}));
vi.mock("../player/catalogQueue", () => ({
  enqueueAndPlayCatalogTrack: mocks.enqueue,
  replaceAndPlayCatalogTracks: mocks.replace,
}));

const ARTIST: ArtistRef = { id: "artist-mid-1", name: "林间电台" };
const DETAIL: ArtistDetail = { ...ARTIST, avatarCacheKey: "artist-mid-1" };
const SONG: CatalogSong = {
  id: "song-mid-1",
  title: "纸月光",
  subtitle: "",
  artists: [ARTIST, { id: "artist-mid-2", name: "方格岛" }],
  artist: "林间电台 / 方格岛",
  album: "温室唱片",
  durationMs: 234_000,
  qualityCandidates: [
    { quality: "flac", available: false, requiresSubscription: true },
    { quality: "320k", available: true, requiresSubscription: false },
    { quality: "128k", available: true, requiresSubscription: false },
  ],
  availability: { status: "unknown", requiresSubscription: false },
};
const SONG_TWO: CatalogSong = { ...SONG, id: "song-mid-2", title: "潮汐来信", artists: [ARTIST], artist: ARTIST.name };

function page(items: readonly CatalogSong[] = [SONG], pageNumber = 1, hasMore = false) {
  return {
    generation: 1,
    page: pageNumber,
    hasMore,
    total: hasMore ? 2 : items.length,
    warningCount: 0,
    items,
  };
}

function renderPage(onBack = vi.fn(), onOpenArtist = vi.fn()) {
  return render(<ArtistPage artist={ARTIST} onBack={onBack} onOpenArtist={onOpenArtist} />);
}

describe("ArtistPage", () => {
  beforeEach(() => {
    mocks.detail.mockReset().mockResolvedValue(DETAIL);
    mocks.songs.mockReset().mockResolvedValue(page());
    mocks.enqueue.mockReset().mockResolvedValue(undefined);
    mocks.replace.mockReset().mockResolvedValue({ loadedCount: 1, truncated: false });
  });

  afterEach(() => {
    cleanup();
    resetPlayerFixture();
  });

  it("并行读取歌手详情与首个歌曲页，并显示歌曲数量", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "林间电台" })).toBeInTheDocument();
    expect(screen.getByText("共 1 首歌曲")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /纸月光/ })).toBeInTheDocument();
    expect(mocks.detail).toHaveBeenCalledWith(ARTIST.id);
    expect(mocks.songs).toHaveBeenCalledWith(ARTIST.id, expect.any(Number), 1, 30);
  });

  it("歌曲名直接交给统一队列播放，歌手名字独立导航", async () => {
    const user = userEvent.setup();
    const onOpenArtist = vi.fn();
    renderPage(vi.fn(), onOpenArtist);
    await screen.findByRole("button", { name: /纸月光/ });

    await user.click(screen.getByRole("button", { name: /纸月光/ }));
    expect(mocks.enqueue).toHaveBeenCalledWith(SONG);

    const row = screen.getByRole("button", { name: /纸月光/ }).closest("tr");
    expect(row).not.toBeNull();
    await user.click(within(row!).getByRole("button", { name: "方格岛" }));
    expect(onOpenArtist).toHaveBeenCalledWith({ id: "artist-mid-2", name: "方格岛" });
  });

  it("支持分页及播放全部/随机播放，并沿用统一集合播放 helper", async () => {
    const user = userEvent.setup();
    mocks.songs.mockImplementation((_id: string, _generation: number, pageNumber: number) =>
      Promise.resolve(page(pageNumber === 1 ? [SONG] : [SONG_TWO], pageNumber, pageNumber === 1)),
    );
    renderPage();
    await screen.findByRole("button", { name: /纸月光/ });

    mocks.replace.mockResolvedValueOnce({ loadedCount: 2, truncated: false });
    await user.click(screen.getByRole("button", { name: "随机播放" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith([SONG, SONG_TWO], "shuffle", expect.any(Function)));
    expect(screen.getByText("已载入 2 首并开始播放")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("button", { name: /潮汐来信/ })).toBeInTheDocument();
    expect(screen.getByText("31")).toBeInTheDocument();
    expect(mocks.songs).toHaveBeenCalledWith(ARTIST.id, expect.any(Number), 2, 30);
  });

  it("批量播放按 30 首连续读取，并在 1000 首处停止", async () => {
    const user = userEvent.setup();
    const songs = Array.from({ length: 30 }, (_, index) => ({
      ...SONG,
      id: `song-batch-${index + 1}`,
      title: `批量歌曲 ${index + 1}`,
    }));
    mocks.songs.mockImplementation((_id: string, _generation: number, pageNumber: number, pageSize: number) => {
      expect(pageSize).toBe(30);
      const pageItems = songs.map((song, index) => ({
        ...song,
        id: `song-batch-${(pageNumber - 1) * songs.length + index + 1}`,
        title: `批量歌曲 ${(pageNumber - 1) * songs.length + index + 1}`,
      }));
      return Promise.resolve(page(pageItems, pageNumber, true));
    });
    mocks.replace.mockResolvedValueOnce({ loadedCount: 1_000, truncated: false });
    renderPage();
    await screen.findByText("批量歌曲 1");

    await user.click(screen.getByRole("button", { name: "播放全部" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledTimes(1));

    const requestedPages = mocks.songs.mock.calls.map((call) => call[2]);
    expect(requestedPages).toEqual(Array.from({ length: 34 }, (_, index) => index + 1));
    expect(mocks.songs.mock.calls.every((call) => call[3] === 30)).toBe(true);
    expect(mocks.replace).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "song-batch-1000" })]),
      "preserve", expect.any(Function),
    );
    expect(mocks.replace.mock.calls[0]?.[0]).toHaveLength(1_000);
  });

  it("区分歌手不存在、空歌曲和请求失败状态", async () => {
    mocks.detail.mockResolvedValueOnce(null);
    renderPage();
    expect(await screen.findByText("没有找到这个歌手")).toBeInTheDocument();
    cleanup();

    mocks.detail.mockResolvedValue(DETAIL);
    mocks.songs.mockResolvedValue(page([], 1, false));
    renderPage();
    expect(await screen.findByText("这个歌手暂时没有可显示的歌曲")).toBeInTheDocument();
    cleanup();

    mocks.detail.mockRejectedValue(new Error("network"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("歌手页面暂时不可用");
  });
});
