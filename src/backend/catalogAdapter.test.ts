import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CATALOG_COMMANDS,
  CatalogAdapterError,
  discoverCatalogSongs,
  getPlaylistSongs,
  parseCatalogSongPage,
  searchCatalogSongs,
} from "./catalogAdapter";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const SONG = {
  id: "0039MnYb0qxYhV", title: "晴天", subtitle: "",
  artists: [{ id: "artist-jay", name: "周杰伦" }], artist: "周杰伦", album: "叶惠美",
  mediaMid: "C4000039MnYb0qxYhV",
  coverCacheKey: "0039MnYb0qxYhV",
  durationMs: 269_000,
  qualityCandidates: [
    { quality: "flac", available: true, requiresSubscription: true },
    { quality: "320k", available: true, requiresSubscription: true },
    { quality: "128k", available: true, requiresSubscription: false },
  ],
  availability: { status: "unknown", requiresSubscription: true },
} as const;
const PAGE = {
  generation: 4, page: 1, hasMore: false, total: 1, warningCount: 0, items: [SONG],
} as const;

function songWithArtistCount(count: number) {
  const artists = Array.from({ length: count }, (_, index) => ({
    id: `artist-${index}`,
    name: `Artist ${index}`,
  }));
  return {
    ...SONG,
    artists,
    artist: artists.map(({ name }) => name).join(" / "),
  };
}

function setTauriRuntime(enabled: boolean) {
  if (enabled) Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

describe("catalog adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriRuntime(true);
  });
  afterEach(() => setTauriRuntime(false));

  it("严格解析不含封面 URL 或上游 transport 的歌曲页", () => {
    expect(parseCatalogSongPage(PAGE)).toEqual(PAGE);
    expect(() => parseCatalogSongPage({ ...PAGE, url: "SENTINEL" })).toThrow();
    expect(() => parseCatalogSongPage({ ...PAGE, items: [{ ...SONG, coverUrl: "SENTINEL" }] }))
      .toThrow();
    expect(() => parseCatalogSongPage({
      ...PAGE, items: [{ ...SONG, coverCacheKey: "bad/key" }],
    })).toThrow();
    expect(() => parseCatalogSongPage({
      ...PAGE, items: [{ ...SONG, mediaMid: "bad/media-mid" }],
    })).toThrow();
    const { mediaMid: _mediaMid, ...legacySong } = SONG;
    expect(parseCatalogSongPage({ ...PAGE, items: [legacySong] }).items[0]).toEqual(legacySong);
    expect(() => parseCatalogSongPage({
      ...PAGE,
      items: [{ ...SONG, qualityCandidates: [...SONG.qualityCandidates].reverse() }],
    })).toThrow(CatalogAdapterError);
    expect(() => parseCatalogSongPage({
      ...PAGE,
      items: [{ ...SONG, artists: [{ id: "artist/jay", name: "周杰伦" }] }],
    })).toThrow(CatalogAdapterError);
    expect(() => parseCatalogSongPage({
      ...PAGE,
      items: [{ ...SONG, artists: [{ id: "artist-jay", name: "另一位歌手" }] }],
    })).toThrow(CatalogAdapterError);
  });

  it("允许九位歌手的合作歌曲", () => {
    const song = songWithArtistCount(9);
    const page = parseCatalogSongPage({ ...PAGE, items: [song] });
    const parsedSong = page.items[0];
    expect(parsedSong).toBeDefined();
    if (!parsedSong) throw new Error("expected parsed song");
    expect(parsedSong.artists).toHaveLength(9);
    expect(parsedSong.artist).toBe(
      "Artist 0 / Artist 1 / Artist 2 / Artist 3 / Artist 4 / "
      + "Artist 5 / Artist 6 / Artist 7 / Artist 8",
    );
  });

  it("拒绝超过三十二位歌手并返回稳定错误编号", () => {
    expect(() => parseCatalogSongPage({ ...PAGE, items: [songWithArtistCount(33)] }))
      .toThrow("QMG-CATALOG-002");
  });

  it("搜索与发现只调用固定命令和规范化参数", async () => {
    invokeMock.mockResolvedValue(PAGE);
    await searchCatalogSongs(" 晴天 ", 4, 1, 20);
    await discoverCatalogSongs(5, 5);
    await getPlaylistSongs("99123456", 6, 2, 50, "201");
    expect(invokeMock.mock.calls).toEqual([
      [CATALOG_COMMANDS.searchSongs, { keyword: "晴天", page: 1, pageSize: 20, generation: 4 }],
      [CATALOG_COMMANDS.discoverNewSongs, { area: 5, generation: 5 }],
      [CATALOG_COMMANDS.playlistSongs, {
        playlistId: "99123456", editableId: "201", page: 2, pageSize: 50, generation: 6,
      }],
    ]);
  });

  it("发送前拒绝非法关键词/分页，IPC 原因只映射稳定编号", async () => {
    expect(() => searchCatalogSongs("", 1)).toThrow(CatalogAdapterError);
    expect(() => searchCatalogSongs("valid", 1, 0)).toThrow(CatalogAdapterError);
    expect(() => getPlaylistSongs("not-numeric", 1)).toThrow(CatalogAdapterError);
    expect(() => getPlaylistSongs("99123456", 1, 1, 50, "bad-dir")).toThrow(CatalogAdapterError);
    invokeMock.mockRejectedValue(new Error("Cookie=SENTINEL; raw body"));
    await expect(discoverCatalogSongs(1)).rejects.toEqual(
      new CatalogAdapterError("QMG-CATALOG-001"),
    );
  });
});
