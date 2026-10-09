import { hasPlaybackTransport, invokePlayback } from "./playbackTransport";
import {
  LOCAL_MUSIC_FORMATS,
  localMusicFormatFromId,
  type LocalMusicFormat,
  type LocalMusicImportFailure,
  type LocalMusicImportFailureCode,
  type LocalMusicImportResult,
  type LocalMusicListResult,
  type LocalMusicDeleteResult,
  type LocalMusicTrack,
} from "../contracts/localMusic";
import { parsePlaybackSessionSnapshot } from "./nativeQueueAdapter";

export const LOCAL_MUSIC_COMMANDS = {
  list: "local_music_list",
  import: "local_music_import",
  delete: "local_music_delete",
} as const;

export type LocalMusicAdapterErrorCode =
  | "QMG-LOCAL-MUSIC-001"
  | "QMG-LOCAL-MUSIC-002"
  | "QMG-LOCAL-MUSIC-STORAGE"
  | "QMG-LOCAL-MUSIC-INVALID"
  | "QMG-LOCAL-MUSIC-UNSUPPORTED"
  | "QMG-LOCAL-MUSIC-LARGE"
  | "QMG-LOCAL-MUSIC-METADATA"
  | "QMG-LOCAL-MUSIC-CODEC"
  | "QMG-LOCAL-MUSIC-COPY"
  | "QMG-LOCAL-MUSIC-CONFLICT"
  | "QMG-LOCAL-MUSIC-MISSING"
  | "QMG-LOCAL-MUSIC-DELETE"
  | "QMG-LOCAL-MUSIC-OUTCOME";

export class LocalMusicAdapterError extends Error {
  readonly code: LocalMusicAdapterErrorCode;

  constructor(code: LocalMusicAdapterErrorCode) {
    super(code);
    this.name = "LocalMusicAdapterError";
    this.code = code;
  }
}

const TRACK_KEYS = ["id", "title", "artist", "album", "durationMs", "format"] as const;
const LIST_KEYS = ["tracks", "warningCount"] as const;
const IMPORT_KEYS = ["imported", "existingCount", "failures"] as const;
const DELETE_KEYS = ["deletedId", "session", "autoPlayStarted"] as const;
const FAILURE_KEYS = ["fileName", "code"] as const;
const PUBLIC_ERROR_KEYS = ["code", "retryable", "operation", "correlationId", "userMessage"] as const;
const MAX_TRACKS = 100_000;
const MAX_TEXT_BYTES = 512;
const MAX_FILE_NAME_BYTES = 512;
const encoder = new TextEncoder();
const FAILURE_CODES: readonly LocalMusicImportFailureCode[] = [
  "local_music_invalid_file",
  "local_music_unsupported_format",
  "local_music_file_too_large",
  "local_music_metadata_unreadable",
  "local_music_codec_unavailable",
  "local_music_copy_failed",
  "local_music_storage_conflict",
];

function invalid(): never {
  throw new LocalMusicAdapterError("QMG-LOCAL-MUSIC-002");
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

function unsigned(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}

function text(value: unknown, maximum = MAX_TEXT_BYTES): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    encoder.encode(value).byteLength > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) return invalid();
  return value;
}

function fileName(value: unknown): string {
  const result = text(value, MAX_FILE_NAME_BYTES);
  if (
    /[\\/:]/u.test(result) ||
    result === "." ||
    result === ".." ||
    /^[a-z][a-z\d+.-]*:/iu.test(result) ||
    result.startsWith("//")
  ) return invalid();
  return result;
}

function format(value: unknown): LocalMusicFormat {
  if (!LOCAL_MUSIC_FORMATS.includes(value as LocalMusicFormat)) return invalid();
  return value as LocalMusicFormat;
}

function localTrackId(value: unknown, expectedFormat?: LocalMusicFormat): string {
  const result = text(value, 80);
  const parsedFormat = localMusicFormatFromId(result);
  if (!parsedFormat || (expectedFormat && parsedFormat !== expectedFormat)) return invalid();
  return result;
}

export function parseLocalMusicTrack(value: unknown): LocalMusicTrack {
  const optional = ["available", "referenced", "coverCacheKey"].filter(key => typeof value === "object" && value !== null && key in value);
  const record = exactRecord(value, [...TRACK_KEYS, ...optional]);
  const trackFormat = format(record.format);
  for (const key of ["available", "referenced"]) {
    if (key in record && typeof record[key] !== "boolean") return invalid();
  }
  if ("coverCacheKey" in record && record.coverCacheKey !== record.id) return invalid();
  return {
    id: localTrackId(record.id, trackFormat),
    title: text(record.title),
    artist: text(record.artist),
    album: record.album === "" ? "" : text(record.album),
    durationMs: unsigned(record.durationMs),
    format: trackFormat,
    ...("available" in record ? { available: record.available as boolean } : {}),
    ...("referenced" in record ? { referenced: record.referenced as boolean } : {}),
    ...("coverCacheKey" in record ? { coverCacheKey: record.coverCacheKey as string } : {}),
  };
}

function parseTracks(value: unknown): LocalMusicTrack[] {
  if (!Array.isArray(value) || value.length > MAX_TRACKS) return invalid();
  const tracks = value.map(parseLocalMusicTrack);
  if (new Set(tracks.map(({ id }) => id)).size !== tracks.length) return invalid();
  return tracks;
}

function parseImportFailure(value: unknown): LocalMusicImportFailure {
  const record = exactRecord(value, FAILURE_KEYS);
  if (!FAILURE_CODES.includes(record.code as LocalMusicImportFailureCode)) return invalid();
  return {
    fileName: fileName(record.fileName),
    code: record.code as LocalMusicImportFailureCode,
  };
}

export function parseLocalMusicListResult(value: unknown): LocalMusicListResult {
  const record = exactRecord(value, LIST_KEYS);
  return {
    tracks: parseTracks(record.tracks),
    warningCount: unsigned(record.warningCount),
  };
}

export function parseLocalMusicImportResult(value: unknown): LocalMusicImportResult {
  const record = exactRecord(value, IMPORT_KEYS);
  if (!Array.isArray(record.failures) || record.failures.length > MAX_TRACKS) return invalid();
  return {
    imported: parseTracks(record.imported),
    existingCount: unsigned(record.existingCount),
    failures: record.failures.map(parseImportFailure),
  };
}

export function parseLocalMusicDeleteResult(
  value: unknown,
  expectedDeletedId?: string,
): LocalMusicDeleteResult {
  const record = exactRecord(value, DELETE_KEYS);
  if (typeof record.autoPlayStarted !== "boolean") return invalid();
  const deletedId = localTrackId(record.deletedId);
  if (expectedDeletedId !== undefined && deletedId !== expectedDeletedId) return invalid();
  return {
    deletedId,
    session: parsePlaybackSessionSnapshot(record.session),
    autoPlayStarted: record.autoPlayStarted,
  };
}

function isTauriRuntime(): boolean {
  return hasPlaybackTransport();
}

function publicErrorCode(error: unknown): LocalMusicAdapterErrorCode {
  let record: Record<string, unknown>;
  try {
    record = exactRecord(error, PUBLIC_ERROR_KEYS);
  } catch {
    return "QMG-LOCAL-MUSIC-001";
  }
  if (
    record.operation !== "local_music"
    || typeof record.retryable !== "boolean"
    || typeof record.code !== "string"
    || typeof record.correlationId !== "string"
    || !/^[0-9a-f-]{36}$/iu.test(record.correlationId)
    || typeof record.userMessage !== "string"
    || record.userMessage.length === 0
    || record.userMessage.length > 160
  ) return "QMG-LOCAL-MUSIC-001";
  switch (record.code) {
    case "local_music_storage_unavailable": return "QMG-LOCAL-MUSIC-STORAGE";
    case "local_music_invalid_file": return "QMG-LOCAL-MUSIC-INVALID";
    case "local_music_unsupported_format": return "QMG-LOCAL-MUSIC-UNSUPPORTED";
    case "local_music_file_too_large": return "QMG-LOCAL-MUSIC-LARGE";
    case "local_music_metadata_unreadable": return "QMG-LOCAL-MUSIC-METADATA";
    case "local_music_codec_unavailable": return "QMG-LOCAL-MUSIC-CODEC";
    case "local_music_copy_failed": return "QMG-LOCAL-MUSIC-COPY";
    case "local_music_storage_conflict": return "QMG-LOCAL-MUSIC-CONFLICT";
    case "local_music_file_missing": return "QMG-LOCAL-MUSIC-MISSING";
    case "local_music_delete_failed": return "QMG-LOCAL-MUSIC-DELETE";
    case "local_music_delete_outcome_unknown": return "QMG-LOCAL-MUSIC-OUTCOME";
    default: return "QMG-LOCAL-MUSIC-001";
  }
}

async function invoke(command: string, payload?: Record<string, unknown>): Promise<unknown> {
  if (!isTauriRuntime()) throw new LocalMusicAdapterError("QMG-LOCAL-MUSIC-001");
  try {
    return payload === undefined
      ? await invokePlayback(command)
      : await invokePlayback(command, payload);
  } catch (error) {
    if (error instanceof LocalMusicAdapterError) throw error;
    throw new LocalMusicAdapterError(publicErrorCode(error));
  }
}

export async function getLocalMusic(): Promise<LocalMusicListResult> {
  return parseLocalMusicListResult(await invoke(LOCAL_MUSIC_COMMANDS.list));
}

export async function importLocalMusic(): Promise<LocalMusicImportResult> {
  return parseLocalMusicImportResult(await invoke(LOCAL_MUSIC_COMMANDS.import));
}

export async function deleteLocalMusic(trackId: string): Promise<LocalMusicDeleteResult> {
  const normalizedId = localTrackId(trackId);
  const result = await invoke(LOCAL_MUSIC_COMMANDS.delete, { trackId: normalizedId });
  return parseLocalMusicDeleteResult(result, normalizedId);
}
