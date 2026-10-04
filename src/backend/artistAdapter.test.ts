import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARTIST_COMMANDS,
  ArtistAdapterError,
  getArtistDetail,
  getSongArtists,
  getArtistSongs,
  parseArtistDetail,
} from "./artistAdapter";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const SONG = {
  id: "song-mid-1",
  title: "纸月光",
  subtitle: "",
  artists: [{ id: "artist-mid-1", name: "林间电台" }],
  artist: "林间电台",
  album: "温室唱片",
  durationMs: 234_000,
  qualityCandidates: [
    { quality: "flac", available: false, requiresSubscription: true },
    { quality: "320k", available: true, requiresSubscription: false },
    { quality: "128k", available: true, requiresSubscription: false },
  ],
  availability: { status: "unknown", requiresSubscription: false },
} as const;
const PAGE = {
  generation: 7,
  page: 1,
  hasMore: false,
  total: 1,
  warningCount: 0,
  items: [SONG],
} as const;

function setTauriRuntime(enabled: boolean) {
  if (enabled) Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

describe("artist adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriRuntime(true);
  });

  afterEach(() => setTauriRuntime(false));

  it("reads exact song artist IDs and rejects invalid or URL-bearing replies", async () => {
    invokeMock.mockResolvedValueOnce([{ id: "artist-1", name: "同名歌手" }, { id: "artist-2", name: "另一位" }]);
    await expect(getSongArtists("song-mid-1")).resolves.toEqual([{ id: "artist-1", name: "同名歌手" }, { id: "artist-2", name: "另一位" }]);
    expect(invokeMock).toHaveBeenLastCalledWith("catalog_song_artists", { songId: "song-mid-1" });
    expect(() => getSongArtists("local_test")).toThrow(ArtistAdapterError);
    invokeMock.mockResolvedValueOnce([{ id: "artist-1", name: "歌手", url: "sentinel" }]);
    await expect(getSongArtists("song-mid-1")).rejects.toThrow(ArtistAdapterError);
    invokeMock.mockResolvedValueOnce([]);
    await expect(getSongArtists("song-mid-1")).rejects.toThrow(ArtistAdapterError);
  });

  it("严格解析歌手详情，允许受控头像缓存键或 null", () => {
    expect(parseArtistDetail({ id: "artist-mid-1", name: "林间电台" })).toEqual({
      id: "artist-mid-1", name: "林间电台",
    });
    expect(parseArtistDetail({ id: "artist-mid-1", name: "林间电台", avatarCacheKey: "artist-mid-1" }))
      .toEqual({ id: "artist-mid-1", name: "林间电台", avatarCacheKey: "artist-mid-1" });
    expect(parseArtistDetail(null)).toBeNull();
    expect(() => parseArtistDetail({ id: "artist-mid-1", name: "林间电台", coverUrl: "https://sentinel" }))
      .toThrow(ArtistAdapterError);
    expect(() => parseArtistDetail({ id: "artist/mid", name: "林间电台" })).toThrow(ArtistAdapterError);
  });

  it("调用固定歌手详情与歌曲分页命令", async () => {
    invokeMock.mockResolvedValueOnce({ id: "artist-mid-1", name: "林间电台" }).mockResolvedValueOnce(PAGE);

    await expect(getArtistDetail(" artist-mid-1 ")).resolves.toEqual({ id: "artist-mid-1", name: "林间电台" });
    await expect(getArtistSongs("artist-mid-1", 7)).resolves.toEqual(PAGE);
    expect(invokeMock.mock.calls).toEqual([
      [ARTIST_COMMANDS.detail, { artistId: "artist-mid-1" }],
      [ARTIST_COMMANDS.songs, { artistId: "artist-mid-1", generation: 7, page: 1, pageSize: 50 }],
    ]);
  });

  it("发送前拒绝非法 ID、分页和 generation，并收敛底层错误", async () => {
    expect(() => getArtistDetail("artist/mid")).toThrow(ArtistAdapterError);
    expect(() => getArtistSongs("artist-mid-1", 1, 0)).toThrow(ArtistAdapterError);
    expect(() => getArtistSongs("artist-mid-1", -1)).toThrow(ArtistAdapterError);
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockRejectedValue(new Error("Cookie=SENTINEL; raw response"));
    await expect(getArtistDetail("artist-mid-1")).rejects.toEqual(new ArtistAdapterError("QMG-ARTIST-001"));
  });
});
