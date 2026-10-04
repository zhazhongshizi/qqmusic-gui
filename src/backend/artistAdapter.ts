import { hasPlaybackTransport, invokePlayback } from "./playbackTransport";
import type { ArtistDetail, ArtistRef } from "../contracts/artist";
import type { CatalogSongPage } from "../contracts/catalog";
import { parseCatalogSongPage } from "./catalogAdapter";

export const ARTIST_COMMANDS = {
  detail: "catalog_artist_detail",
  songs: "catalog_artist_songs",
} as const;

export class ArtistAdapterError extends Error {
  readonly code: "QMG-ARTIST-001" | "QMG-ARTIST-002";

  constructor(code: ArtistAdapterError["code"]) {
    super(code);
    this.name = "ArtistAdapterError";
    this.code = code;
  }
}

const ARTIST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const encoder = new TextEncoder();

function invalid(): never {
  throw new ArtistAdapterError("QMG-ARTIST-002");
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

function text(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    encoder.encode(value).byteLength > maximumBytes || /[\r\n\0]/.test(value)
  ) return invalid();
  return value;
}

function artistId(value: unknown): string {
  const result = text(value, 128);
  if (!ARTIST_ID.test(result)) return invalid();
  return result;
}

function parseArtist(value: unknown): ArtistDetail {
  const hasAvatar = typeof value === "object" && value !== null && "avatarCacheKey" in value;
  const hasDescription = typeof value === "object" && value !== null && "description" in value;
  const record = exactRecord(value, ["id", "name", ...(hasAvatar ? ["avatarCacheKey"] : []), ...(hasDescription ? ["description"] : [])]);
  if (hasDescription && (typeof record.description !== "string" || encoder.encode(record.description).byteLength > 16384 || /\0/.test(record.description))) return invalid();
  return {
    id: artistId(record.id),
    name: text(record.name, 512),
    ...(hasAvatar ? { avatarCacheKey: artistId(record.avatarCacheKey) } : {}),
    ...(hasDescription ? { description: record.description as string } : {}),
  };
}

function isTauriRuntime(): boolean {
  return hasPlaybackTransport();
}

async function invoke(command: string, payload: Record<string, unknown>): Promise<unknown> {
  if (!isTauriRuntime()) throw new ArtistAdapterError("QMG-ARTIST-001");
  try {
    return await invokePlayback(command, payload);
  } catch (error) {
    if (error instanceof ArtistAdapterError) throw error;
    throw new ArtistAdapterError("QMG-ARTIST-001");
  }
}

function stableId(value: string): string {
  const normalized = value.trim();
  if (!ARTIST_ID.test(normalized)) return invalid();
  return normalized;
}

function unsigned(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}

export function parseArtistDetail(value: unknown): ArtistDetail | null {
  return value === null ? null : parseArtist(value);
}

export function getArtistDetail(id: string): Promise<ArtistDetail | null> {
  return invoke(ARTIST_COMMANDS.detail, { artistId: stableId(id) }).then(parseArtistDetail);
}

export function getSongArtists(songId: string): Promise<readonly ArtistRef[]> {
  const id = stableId(songId);
  if (id.startsWith("local_") || id.startsWith("fixture-")) return invalid();
  return invoke("catalog_song_artists", { songId: id }).then(value => {
    if (!Array.isArray(value) || !value.length || value.length > 32) return invalid();
    return value.map(item => {
      const record = exactRecord(item, ["id", "name"]);
      return { id: artistId(record.id), name: text(record.name, 512) };
    });
  });
}

export function getArtistSongs(
  id: string,
  generation: number,
  page = 1,
  pageSize = 50,
): Promise<CatalogSongPage> {
  if (!Number.isInteger(page) || page < 1 || page > 100) return invalid();
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) return invalid();
  return invoke(ARTIST_COMMANDS.songs, {
    artistId: stableId(id),
    generation: unsigned(generation),
    page,
    pageSize,
  }).then(parseCatalogSongPage);
}
