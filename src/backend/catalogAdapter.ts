import { hasPlaybackTransport, invokePlayback } from "./playbackTransport";
import type {
  CatalogAvailability,
  CatalogQuality,
  CatalogQualityCandidate,
  CatalogSong,
  CatalogSongPage,
} from "../contracts/catalog";
import type { ArtistRef } from "../contracts/artist";

export const CATALOG_COMMANDS = {
  searchSongs: "catalog_search_songs",
  discoverNewSongs: "catalog_discover_new_songs",
  playlistSongs: "catalog_playlist_songs",
} as const;

export class CatalogAdapterError extends Error {
  readonly code: "QMG-CATALOG-001" | "QMG-CATALOG-002";

  constructor(code: CatalogAdapterError["code"]) {
    super(code);
    this.name = "CatalogAdapterError";
    this.code = code;
  }
}

const PAGE_KEYS = ["generation", "page", "hasMore", "warningCount", "items"] as const;
const PAGE_TOTAL_KEYS = [...PAGE_KEYS, "total"] as const;
const SONG_KEYS = [
  "id", "title", "subtitle", "artists", "artist", "album", "durationMs",
  "qualityCandidates", "availability",
] as const;
const ARTIST_KEYS = ["id", "name"] as const;
const QUALITY_KEYS = ["quality", "available", "requiresSubscription"] as const;
const AVAILABILITY_KEYS = ["status", "requiresSubscription"] as const;
const TRACK_ID = /^[A-Za-z0-9_-]+$/;
const QUALITY_ORDER: readonly CatalogQuality[] = ["flac", "320k", "128k"];
const MAX_ARTISTS_PER_SONG = 32;
const encoder = new TextEncoder();

function invalid(): never {
  throw new CatalogAdapterError("QMG-CATALOG-002");
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) return invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}

function unsigned(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}

function text(value: unknown, maximumBytes: number, allowEmpty = false): string {
  if (
    typeof value !== "string" || (!allowEmpty && value.length === 0) ||
    encoder.encode(value).byteLength > maximumBytes || /[\r\n\0]/.test(value)
  ) return invalid();
  return value;
}

function parseQuality(value: unknown, index: number): CatalogQualityCandidate {
  const record = exactRecord(value, QUALITY_KEYS);
  const quality = QUALITY_ORDER[index];
  if (!quality || record.quality !== quality) return invalid();
  if (typeof record.available !== "boolean" || typeof record.requiresSubscription !== "boolean") {
    return invalid();
  }
  return {
    quality,
    available: record.available,
    requiresSubscription: record.requiresSubscription,
  };
}

function parseAvailability(value: unknown): CatalogAvailability {
  const record = exactRecord(value, AVAILABILITY_KEYS);
  if (record.status !== "unknown" && record.status !== "unavailable") return invalid();
  if (typeof record.requiresSubscription !== "boolean") return invalid();
  return { status: record.status, requiresSubscription: record.requiresSubscription };
}

function parseArtist(value: unknown): ArtistRef {
  const record = exactRecord(value, ARTIST_KEYS);
  const id = stableMid(record.id);
  return { id, name: text(record.name, 512) };
}

function parseSong(value: unknown): CatalogSong {
  const hasMediaMid = typeof value === "object" && value !== null && "mediaMid" in value;
  const hasCoverCacheKey = typeof value === "object" && value !== null && "coverCacheKey" in value;
  const record = exactRecord(value, [
    ...SONG_KEYS,
    ...(hasMediaMid ? ["mediaMid"] : []),
    ...(hasCoverCacheKey ? ["coverCacheKey"] : []),
    ...(typeof value === "object" && value !== null && "albumId" in value ? ["albumId"] : []),
    ...(typeof value === "object" && value !== null && "albumPublishDate" in value ? ["albumPublishDate"] : []),
  ]);
  const id = text(record.id, 128);
  if (!TRACK_ID.test(id)) return invalid();
  if (!Array.isArray(record.qualityCandidates) || record.qualityCandidates.length !== 3) {
    return invalid();
  }
  if (
    !Array.isArray(record.artists)
    || record.artists.length === 0
    || record.artists.length > MAX_ARTISTS_PER_SONG
  ) {
    return invalid();
  }
  const durationMs = unsigned(record.durationMs);
  if (durationMs > 86_400_000) return invalid();
  const artists = record.artists.map(parseArtist);
  const artist = text(record.artist, 512);
  if (artists.map((entry) => entry.name).join(" / ") !== artist) return invalid();
  const result: CatalogSong = {
    id,
    title: text(record.title, 512),
    subtitle: text(record.subtitle, 512, true),
    artists,
    artist,
    album: text(record.album, 512),
    durationMs,
    qualityCandidates: record.qualityCandidates.map(parseQuality),
    availability: parseAvailability(record.availability),
  };
  return {
    ...result,
    ...(hasMediaMid ? { mediaMid: stableMid(record.mediaMid) } : {}),
    ...(hasCoverCacheKey ? { coverCacheKey: stableMid(record.coverCacheKey) } : {}),
    ...("albumId" in record ? { albumId: stableMid(record.albumId) } : {}),
    ...("albumPublishDate" in record ? { albumPublishDate: text(record.albumPublishDate, 512, true) } : {}),
  };
}

function stableMid(value: unknown): string {
  const mid = text(value, 128);
  if (!TRACK_ID.test(mid)) return invalid();
  return mid;
}

export function parseCatalogSongPage(value: unknown): CatalogSongPage {
  const hasTotal = typeof value === "object" && value !== null && "total" in value;
  const record = exactRecord(value, hasTotal ? PAGE_TOTAL_KEYS : PAGE_KEYS);
  if (typeof record.hasMore !== "boolean" || !Array.isArray(record.items) || record.items.length > 50) {
    return invalid();
  }
  const page = unsigned(record.page);
  if (page === 0 || page > 100) return invalid();
  const result: CatalogSongPage = {
    generation: unsigned(record.generation),
    page,
    hasMore: record.hasMore,
    warningCount: unsigned(record.warningCount),
    items: record.items.map(parseSong),
  };
  return hasTotal ? { ...result, total: unsigned(record.total) } : result;
}

function isTauriRuntime(): boolean {
  return hasPlaybackTransport();
}

async function invoke(command: string, payload: Record<string, unknown>): Promise<CatalogSongPage> {
  if (!isTauriRuntime()) throw new CatalogAdapterError("QMG-CATALOG-001");
  try {
    return parseCatalogSongPage(await invokePlayback(command, payload));
  } catch (error) {
    if (error instanceof CatalogAdapterError) throw error;
    throw new CatalogAdapterError("QMG-CATALOG-001");
  }
}

export function searchCatalogSongs(
  keyword: string,
  generation: number,
  page = 1,
  pageSize = 20,
): Promise<CatalogSongPage> {
  const normalized = keyword.trim();
  if (!normalized || [...normalized].length > 100 || /[\r\n\0]/.test(normalized)) return invalid();
  if (!Number.isInteger(page) || page < 1 || page > 100) return invalid();
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) return invalid();
  return invoke(CATALOG_COMMANDS.searchSongs, {
    keyword: normalized,
    page,
    pageSize,
    generation: unsigned(generation),
  });
}

export function discoverCatalogSongs(generation: number, area = 5): Promise<CatalogSongPage> {
  if (!Number.isInteger(area) || area < 1 || area > 6) return invalid();
  return invoke(CATALOG_COMMANDS.discoverNewSongs, {
    area,
    generation: unsigned(generation),
  });
}

export function getPlaylistSongs(
  playlistId: string,
  generation: number,
  page = 1,
  pageSize = 20,
  editableId?: string,
): Promise<CatalogSongPage> {
  if (!/^\d{1,32}$/.test(playlistId) || playlistId === "0") return invalid();
  if (editableId !== undefined && (!/^\d{1,32}$/.test(editableId) || editableId === "0")) return invalid();
  if (!Number.isInteger(page) || page < 1 || page > 100) return invalid();
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) return invalid();
  return invoke(CATALOG_COMMANDS.playlistSongs, {
    playlistId,
    page,
    pageSize,
    generation: unsigned(generation),
    ...(editableId ? { editableId } : {}),
  });
}
