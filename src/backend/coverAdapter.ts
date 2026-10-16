import { createSchemaGuards } from "./schemaGuards";
import { hasPlaybackTransport, invokePlayback, playbackSessionIdentity } from "./playbackTransport";
const MAX_COVER_BYTES = 2 * 1024 * 1024;
const CACHE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

export const COVER_COMMAND = "cover_get" as const;

export interface CoverImagePayload {
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
  readonly bytes: Uint8Array;
}

export class CoverAdapterError extends Error {
  readonly code: "QMG-COVER-001" | "QMG-COVER-002";

  constructor(code: CoverAdapterError["code"]) {
    super(code);
    this.name = "CoverAdapterError";
    this.code = code;
  }
}

const { exactRecord } = createSchemaGuards(invalid);

function invalid(): never {
  throw new CoverAdapterError("QMG-COVER-002");
}

function isTauriRuntime(): boolean {
  return hasPlaybackTransport();
}

function parseMimeType(value: unknown): CoverImagePayload["mimeType"] {
  if (value === "image/jpeg" || value === "image/png" || value === "image/webp") return value;
  return invalid();
}

export function parseCoverPayload(value: unknown): CoverImagePayload {
  const record = exactRecord(value, ["mimeType", "bytes"]);
  const mimeType = parseMimeType(record.mimeType);
  const binary = record.bytes instanceof Uint8Array ? record.bytes
    : record.bytes instanceof ArrayBuffer ? new Uint8Array(record.bytes) : null;
  if (binary) {
    if (!binary.byteLength || binary.byteLength > MAX_COVER_BYTES) return invalid();
    return { mimeType, bytes: binary };
  }
  if (!Array.isArray(record.bytes) || record.bytes.length === 0 || record.bytes.length > MAX_COVER_BYTES) {
    return invalid();
  }
  if (!record.bytes.every((byte) => Number.isInteger(byte) && (byte as number) >= 0 && (byte as number) <= 255)) {
    return invalid();
  }
  return { mimeType, bytes: Uint8Array.from(record.bytes as number[]) };
}

async function invoke(command: string, payload: Record<string, unknown>): Promise<unknown> {
  if (!isTauriRuntime()) throw new CoverAdapterError("QMG-COVER-001");
  try {
    return await invokePlayback(command, payload);
  } catch (error) {
    if (error instanceof CoverAdapterError) throw error;
    throw new CoverAdapterError("QMG-COVER-001");
  }
}

const cachedImages = new Map<string, CoverImagePayload>();
const pendingImages = new Map<string, Promise<CoverImagePayload>>();
let cacheSession = playbackSessionIdentity();
let cachedBytes = 0;
const MAX_CACHED_BYTES = 32 * 1024 * 1024;

function readImage(cacheKey: string, kind: "album" | "artist" | "playlist"): Promise<CoverImagePayload> {
  if (!CACHE_KEY.test(cacheKey)) return Promise.reject(new CoverAdapterError("QMG-COVER-002"));
  const session = playbackSessionIdentity();
  if (cacheSession !== session) {
    cacheSession = session;
    cachedImages.clear(); pendingImages.clear(); cachedBytes = 0;
  }
  if (!isTauriRuntime()) return Promise.reject(new CoverAdapterError("QMG-COVER-001"));
  const key = `${kind}:${cacheKey}`;
  const cached = cachedImages.get(key);
  if (cached) {
    cachedImages.delete(key); cachedImages.set(key, cached);
    return Promise.resolve(cached);
  }
  const existing = pendingImages.get(key);
  if (existing) return existing;
  const pending = invoke(COVER_COMMAND, { cacheKey, ...(kind !== "album" ? { kind } : {}) })
    .then(parseCoverPayload).then(image => {
      if (session === playbackSessionIdentity() && cacheSession === session) {
        cachedImages.set(key, image); cachedBytes += image.bytes.byteLength;
        while (cachedImages.size > 128 || cachedBytes > MAX_CACHED_BYTES) {
          const oldest = cachedImages.keys().next().value!;
          cachedBytes -= cachedImages.get(oldest)!.bytes.byteLength;
          cachedImages.delete(oldest);
        }
      }
      return image;
    }).finally(() => { if (pendingImages.get(key) === pending) pendingImages.delete(key); });
  pendingImages.set(key, pending);
  return pending;
}

export function getCoverImage(cacheKey: string): Promise<CoverImagePayload> {
  return readImage(cacheKey, "album");
}

export function getPlaylistImage(cacheKey: string): Promise<CoverImagePayload> {
  return readImage(cacheKey, "playlist");
}

export async function getArtistImage(avatarCacheKey: string): Promise<CoverImagePayload> {
  return readImage(avatarCacheKey, "artist");
}
