import { hasPlaybackTransport, invokePlayback } from "./playbackTransport";
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

function invalid(): never {
  throw new CoverAdapterError("QMG-COVER-002");
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) return invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
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

export async function getCoverImage(cacheKey: string): Promise<CoverImagePayload> {
  if (!CACHE_KEY.test(cacheKey)) return invalid();
  return parseCoverPayload(await invoke(COVER_COMMAND, { cacheKey }));
}

export async function getArtistImage(avatarCacheKey: string): Promise<CoverImagePayload> {
  if (!CACHE_KEY.test(avatarCacheKey)) return invalid();
  return parseCoverPayload(await invoke(COVER_COMMAND, {
    cacheKey: avatarCacheKey,
    kind: "artist",
  }));
}
