import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseCatalogAlbum, parseCatalogEntityPage, searchCatalogEntities, getAlbumDetail, getAlbumSongs, getArtistAlbums } from "./catalogBrowseAdapter";
import { parseCatalogSongPage } from "./catalogAdapter";
import { parseArtistDetail } from "./artistAdapter";
import { installPlaybackTransport } from "./playbackTransport";

const album = { id: "album-1", title: "专辑", publishDate: "2026-10-01", description: "第一段\n第二段", coverCacheKey: "album-1" };
const page = { generation: 7, page: 2, hasMore: false, total: 21, warningCount: 0, items: [{ kind: "album", ...album }] };
const invoke = vi.fn();
beforeEach(() => { invoke.mockReset(); installPlaybackTransport(invoke); });
afterEach(() => installPlaybackTransport(null));
it("preserves multiline descriptions, album references and release dates", () => {
  expect(parseCatalogAlbum(album)).toEqual(album);
  expect(parseArtistDetail({ id: "artist-1", name: "歌手", description: "简介\n第二段" })?.description).toBe("简介\n第二段");
  const song = { id: "song-1", title: "歌曲", subtitle: "", artists: [{ id: "artist-1", name: "歌手" }], artist: "歌手", album: "专辑", albumId: "album-1", albumPublishDate: "2026-10-01", durationMs: 1000,
    qualityCandidates: ["flac", "320k", "128k"].map(quality => ({ quality, available: true, requiresSubscription: false })), availability: { status: "unknown", requiresSubscription: false } };
  expect(parseCatalogSongPage({ ...page, items: [song] }).items[0]).toEqual(song);
});
it("rejects unknown media fields, invalid entities and oversized descriptions", () => {
  expect(() => parseCatalogAlbum({ ...album, url: "SENTINEL" })).toThrow();
  expect(() => parseCatalogEntityPage({ ...page, items: [{ kind: "album", ...album, coverUrl: "SENTINEL" }] })).toThrow();
  expect(() => parseCatalogEntityPage({ ...page, items: [{ kind: "other", ...album }] })).toThrow();
  expect(() => parseCatalogAlbum({ ...album, description: "界".repeat(6000) })).toThrow();
  expect(() => parseCatalogEntityPage({ ...page, items: [{ kind: "playlist", id: "bad-mid", title: "歌单", description: "", songCount: 1, listenCount: 0 }] })).toThrow();
});
it("routes each new read command with validated pagination and generation", async () => {
  invoke.mockResolvedValueOnce(page).mockResolvedValueOnce(album).mockResolvedValueOnce({ ...page, items: [] }).mockResolvedValueOnce(page);
  await searchCatalogEntities("albums", " 专辑 ", 7, 2);
  await getAlbumDetail("album-1"); await getAlbumSongs("album-1", 7, 2); await getArtistAlbums("artist-1", 7, 2);
  expect(invoke.mock.calls).toEqual([
    ["catalog_search_entities", { kind: "albums", keyword: "专辑", generation: 7, page: 2, pageSize: 20 }],
    ["catalog_album_detail", { albumId: "album-1" }],
    ["catalog_album_songs", { albumId: "album-1", generation: 7, page: 2, pageSize: 20 }],
    ["catalog_artist_albums", { artistId: "artist-1", generation: 7, page: 2, pageSize: 20 }],
  ]);
  expect(() => searchCatalogEntities("albums", "专辑", 7, 0)).toThrow();
});
