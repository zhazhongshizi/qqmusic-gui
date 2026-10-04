import { hasPlaybackTransport, invokePlayback } from "./playbackTransport";
import { CatalogAdapterError, parseCatalogSongPage } from "./catalogAdapter";
import { parseArtistDetail } from "./artistAdapter";
import type { CatalogAlbum, CatalogEntity, CatalogEntityPage, CatalogSearchType } from "../contracts/catalogBrowse";

const encoder = new TextEncoder();
function invalid(): never { throw new CatalogAdapterError("QMG-CATALOG-002"); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const result = value as Record<string, unknown>;
  if (required.some(k => !(k in result)) || Object.keys(result).some(k => !required.includes(k) && !optional.includes(k))) return invalid();
  return result;
}
function text(value: unknown, max = 512, empty = false, multiline = false): string {
  if (typeof value !== "string" || (!empty && !value) || encoder.encode(value).length > max || (multiline ? /\0/ : /[\r\n\0]/).test(value)) return invalid();
  return value;
}
function id(value: unknown): string { const v = text(value, 128); if (!/^[A-Za-z0-9_-]+$/.test(v)) return invalid(); return v; }
function uint(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid(); return value as number; }
function paging(page: number, pageSize: number, generation: number) {
  if (!Number.isInteger(page) || page < 1 || page > 100 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) return invalid();
  return { page, pageSize, generation: uint(generation) };
}
export function parseCatalogAlbum(value: unknown): CatalogAlbum {
  const r = record(value, ["id", "title", "publishDate", "description"], ["coverCacheKey"]);
  return { id: id(r.id), title: text(r.title), publishDate: text(r.publishDate, 512, true),
    description: text(r.description, 16384, true, true), ...("coverCacheKey" in r ? { coverCacheKey: id(r.coverCacheKey) } : {}) };
}
function entity(value: unknown): CatalogEntity {
  const r = record(value, ["kind"], ["id", "name", "title", "avatarCacheKey", "coverCacheKey", "description", "publishDate", "songCount", "listenCount"]);
  const { kind, ...body } = r;
  if (kind === "artist") {
    const artist = parseArtistDetail(body); if (!artist) return invalid(); return { kind, ...artist };
  }
  if (kind === "album") return { kind, ...parseCatalogAlbum(body) };
  if (kind === "playlist") {
    const p = record(body, ["id", "title", "description", "songCount", "listenCount"]);
    const playlistId = id(p.id); if (!/^\d+$/.test(playlistId) || Number(playlistId) <= 0 || !Number.isSafeInteger(Number(playlistId))) return invalid();
    return { kind, id: playlistId, title: text(p.title), description: text(p.description, 16384, true, true), songCount: uint(p.songCount), listenCount: uint(p.listenCount) };
  }
  return invalid();
}
export function parseCatalogEntityPage(value: unknown): CatalogEntityPage {
  const r = record(value, ["generation", "page", "hasMore", "warningCount", "items"], ["total"]);
  if (!Array.isArray(r.items) || r.items.length > 50 || typeof r.hasMore !== "boolean") return invalid();
  const page = uint(r.page); if (page < 1 || page > 100) return invalid();
  return { generation: uint(r.generation), page, hasMore: r.hasMore, warningCount: uint(r.warningCount), items: r.items.map(entity),
    ...("total" in r ? { total: uint(r.total) } : {}) };
}
async function invoke(command: string, payload: Record<string, unknown>): Promise<unknown> {
  if (!hasPlaybackTransport()) throw new CatalogAdapterError("QMG-CATALOG-001");
  try { return await invokePlayback(command, payload); }
  catch (e) { if (e instanceof CatalogAdapterError) throw e; throw new CatalogAdapterError("QMG-CATALOG-001"); }
}
export function searchCatalogEntities(kind: Exclude<CatalogSearchType, "songs">, keyword: string, generation: number, page = 1, pageSize = 20) {
  const normalized = keyword.trim();
  if (!["artists", "albums", "playlists"].includes(kind) || !normalized || [...normalized].length > 100 || /[\r\n\0]/.test(normalized)) return invalid();
  return invoke("catalog_search_entities", { kind, keyword: normalized, ...paging(page, pageSize, generation) }).then(parseCatalogEntityPage);
}
export function getAlbumDetail(albumId: string) { return invoke("catalog_album_detail", { albumId: id(albumId) }).then(parseCatalogAlbum); }
export function getAlbumSongs(albumId: string, generation: number, page = 1, pageSize = 20) {
  return invoke("catalog_album_songs", { albumId: id(albumId), ...paging(page, pageSize, generation) }).then(parseCatalogSongPage);
}
export function getArtistAlbums(artistId: string, generation: number, page = 1, pageSize = 20) {
  return invoke("catalog_artist_albums", { artistId: id(artistId), ...paging(page, pageSize, generation) }).then(parseCatalogEntityPage);
}
