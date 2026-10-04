import { hasPlaybackTransport, invokePlayback } from "./playbackTransport";
import { parseCatalogSongPage } from "./catalogAdapter";
import type { CatalogSongPage } from "../contracts/catalog";
import type {
  OrganizerExecution,
  OrganizerPreview,
  OrganizerPreviewRequest,
  PlaylistKind,
  PlaylistPage,
  PlaylistSummary,
  WriteReceipt,
} from "../contracts/library";

export const LIBRARY_COMMANDS = {
  playlists: "library_playlists",
  likedSongs: "library_liked_songs",
  createPlaylist: "library_create_playlist",
  deletePlaylist: "library_delete_playlist",
  addSongs: "library_add_songs",
  removeSongs: "library_remove_songs",
  setLiked: "library_set_liked",
  setFavoritePlaylist: "library_set_favorite_playlist",
  organizerPreview: "organizer_preview",
  organizerExecute: "organizer_execute",
} as const;

export type LibraryAdapterErrorCode =
  | "QMG-LIBRARY-001"
  | "QMG-LIBRARY-002"
  | "QMG-LIBRARY-AUTH"
  | "QMG-LIBRARY-DRIFT"
  | "QMG-LIBRARY-EXPIRED"
  | "QMG-LIBRARY-UNKNOWN";

export class LibraryAdapterError extends Error {
  readonly code: LibraryAdapterErrorCode;

  constructor(code: LibraryAdapterErrorCode) {
    super(code);
    this.name = "LibraryAdapterError";
    this.code = code;
  }
}

const encoder = new TextEncoder();
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const NUMERIC_ID = /^\d{1,128}$/;
const PLAN_ID = /^plan-[a-f0-9]{32}$/;
const PLAYLIST_KEYS = ["id", "title", "description", "songCount"] as const;
const EDITABLE_PLAYLIST_KEYS = [...PLAYLIST_KEYS, "editableId"] as const;
const PAGE_KEYS = ["kind", "page", "hasMore", "total", "warningCount", "items"] as const;
const RECEIPT_KEYS = ["status"] as const;
const AFFECTED_RECEIPT_KEYS = ["status", "affectedCount"] as const;
const CREATED_RECEIPT_KEYS = ["status", "playlist"] as const;
const CREATED_PLAYLIST_KEYS = ["id", "editableId", "title"] as const;
const PREVIEW_KEYS = [
  "planId", "operation", "sourceTitle", "itemCount", "previewTruncated",
  "expiresAtUnixMs", "items",
] as const;
const TARGET_PREVIEW_KEYS = [...PREVIEW_KEYS, "targetTitle"] as const;
const PREVIEW_ITEM_KEYS = ["id", "title", "artist", "album"] as const;
const EXECUTION_KEYS = [
  "planId", "state", "itemCount", "completedCount", "failedCount",
  "pendingVerificationCount",
] as const;

function invalid(): never {
  throw new LibraryAdapterError("QMG-LIBRARY-002");
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

function text(value: unknown, maximum = 512, allowEmpty = false): string {
  if (
    typeof value !== "string" || (!allowEmpty && value.length === 0) ||
    encoder.encode(value).byteLength > maximum || /[\r\n\0]/.test(value)
  ) return invalid();
  return value;
}

function identifier(value: unknown, numeric = false): string {
  const result = text(value, 128);
  if (!(numeric ? NUMERIC_ID : ID).test(result)) return invalid();
  return result;
}

function parsePlaylist(value: unknown, kind: PlaylistKind): PlaylistSummary {
  const record = exactRecord(value, kind === "created" ? EDITABLE_PLAYLIST_KEYS : PLAYLIST_KEYS);
  const result: PlaylistSummary = {
    id: identifier(record.id),
    title: text(record.title),
    description: text(record.description, 512, true),
    songCount: unsigned(record.songCount),
  };
  return kind === "created" ? { ...result, editableId: identifier(record.editableId, true) } : result;
}

export function parsePlaylistPage(value: unknown): PlaylistPage {
  const record = exactRecord(value, PAGE_KEYS);
  if (record.kind !== "created" && record.kind !== "favorite") return invalid();
  if (!Array.isArray(record.items) || record.items.length > 50 || typeof record.hasMore !== "boolean") {
    return invalid();
  }
  const page = unsigned(record.page);
  if (page < 1 || page > 100) return invalid();
  return {
    kind: record.kind,
    page,
    hasMore: record.hasMore,
    total: unsigned(record.total),
    warningCount: unsigned(record.warningCount),
    items: record.items.map((item) => parsePlaylist(item, record.kind as PlaylistKind)),
  };
}

function parseReceipt(value: unknown): WriteReceipt {
  const raw = value as Record<string, unknown> | null;
  const keys = raw && "playlist" in raw
    ? CREATED_RECEIPT_KEYS
    : raw && "affectedCount" in raw
      ? AFFECTED_RECEIPT_KEYS
      : RECEIPT_KEYS;
  const record = exactRecord(value, keys);
  if (record.status !== "applied") return invalid();
  if ("affectedCount" in record) return { status: "applied", affectedCount: unsigned(record.affectedCount) };
  if ("playlist" in record) {
    const playlist = exactRecord(record.playlist, CREATED_PLAYLIST_KEYS);
    return {
      status: "applied",
      playlist: {
        id: identifier(playlist.id, true),
        editableId: identifier(playlist.editableId, true),
        title: text(playlist.title),
      },
    };
  }
  return { status: "applied" };
}

function parseOrganizerPreview(value: unknown): OrganizerPreview {
  const hasTarget = typeof value === "object" && value !== null && "targetTitle" in value;
  const record = exactRecord(value, hasTarget ? TARGET_PREVIEW_KEYS : PREVIEW_KEYS);
  const operations = ["copy", "move", "remove", "deduplicate"] as const;
  if (!operations.includes(record.operation as never) || typeof record.previewTruncated !== "boolean") return invalid();
  if (!Array.isArray(record.items) || record.items.length > 100) return invalid();
  const planId = text(record.planId, 128);
  if (!PLAN_ID.test(planId)) return invalid();
  const result: OrganizerPreview = {
    planId,
    operation: record.operation as OrganizerPreview["operation"],
    sourceTitle: text(record.sourceTitle),
    itemCount: unsigned(record.itemCount),
    previewTruncated: record.previewTruncated,
    expiresAtUnixMs: unsigned(record.expiresAtUnixMs),
    items: record.items.map((item) => {
      const entry = exactRecord(item, PREVIEW_ITEM_KEYS);
      return {
        id: identifier(entry.id),
        title: text(entry.title),
        artist: text(entry.artist),
        album: text(entry.album),
      };
    }),
  };
  return hasTarget ? { ...result, targetTitle: text(record.targetTitle) } : result;
}

function parseOrganizerExecution(value: unknown): OrganizerExecution {
  const record = exactRecord(value, EXECUTION_KEYS);
  const states = ["preview", "running", "partial", "complete", "expired"] as const;
  if (!states.includes(record.state as never)) return invalid();
  const planId = text(record.planId, 128);
  if (!PLAN_ID.test(planId)) return invalid();
  return {
    planId,
    state: record.state as OrganizerExecution["state"],
    itemCount: unsigned(record.itemCount),
    completedCount: unsigned(record.completedCount),
    failedCount: unsigned(record.failedCount),
    pendingVerificationCount: unsigned(record.pendingVerificationCount),
  };
}

function isTauriRuntime(): boolean {
  return hasPlaybackTransport();
}

function safePublicError(error: unknown): LibraryAdapterErrorCode {
  if (typeof error !== "object" || error === null || !("code" in error)) return "QMG-LIBRARY-001";
  switch ((error as { code?: unknown }).code) {
    case "authentication_required": return "QMG-LIBRARY-AUTH";
    case "organizer_plan_drifted": return "QMG-LIBRARY-DRIFT";
    case "organizer_plan_expired": return "QMG-LIBRARY-EXPIRED";
    case "write_outcome_unknown": return "QMG-LIBRARY-UNKNOWN";
    default: return "QMG-LIBRARY-001";
  }
}

async function invoke<T>(
  command: string,
  payload: Record<string, unknown>,
  parse: (value: unknown) => T,
): Promise<T> {
  if (!isTauriRuntime()) throw new LibraryAdapterError("QMG-LIBRARY-001");
  try {
    return parse(await invokePlayback(command, payload));
  } catch (error) {
    if (error instanceof LibraryAdapterError) throw error;
    throw new LibraryAdapterError(safePublicError(error));
  }
}

function numericPage(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) return invalid();
  return value;
}

function songIds(values: readonly string[]): string[] {
  if (values.length < 1 || values.length > 100 || values.some((value) => !ID.test(value))) return invalid();
  if (new Set(values).size !== values.length) return invalid();
  return [...values];
}

export function getLibraryPlaylists(kind: PlaylistKind, page = 1, pageSize = 20): Promise<PlaylistPage> {
  return invoke(LIBRARY_COMMANDS.playlists, {
    kind,
    page: numericPage(page, 100),
    pageSize: numericPage(pageSize, 50),
  }, parsePlaylistPage);
}

export function getLikedSongs(page = 1, pageSize = 20, generation = 0): Promise<CatalogSongPage> {
  return invoke(LIBRARY_COMMANDS.likedSongs, {
    page: numericPage(page, 100),
    pageSize: numericPage(pageSize, 50),
    generation: unsigned(generation),
  }, parseCatalogSongPage);
}

export function createPlaylist(name: string): Promise<WriteReceipt> {
  const normalized = name.trim();
  if (!normalized || [...normalized].length > 100 || /[\r\n\0]/.test(normalized)) return invalid();
  return invoke(LIBRARY_COMMANDS.createPlaylist, { name: normalized }, parseReceipt);
}

export function deletePlaylist(editableId: string): Promise<WriteReceipt> {
  return invoke(LIBRARY_COMMANDS.deletePlaylist, { editableId: identifier(editableId, true) }, parseReceipt);
}

export function addSongsToPlaylist(
  playlistId: string,
  editableId: string,
  values: readonly string[],
): Promise<WriteReceipt> {
  return invoke(LIBRARY_COMMANDS.addSongs, {
    playlistId: identifier(playlistId, true),
    editableId: identifier(editableId, true),
    songIds: songIds(values),
  }, parseReceipt);
}

export function removeSongsFromPlaylist(
  playlistId: string,
  editableId: string,
  values: readonly string[],
): Promise<WriteReceipt> {
  return invoke(LIBRARY_COMMANDS.removeSongs, {
    playlistId: identifier(playlistId, true),
    editableId: identifier(editableId, true),
    songIds: songIds(values),
  }, parseReceipt);
}

export function setSongsLiked(values: readonly string[], liked: boolean): Promise<WriteReceipt> {
  return invoke(LIBRARY_COMMANDS.setLiked, { songIds: songIds(values), liked }, parseReceipt);
}

export function setPlaylistFavorite(playlistId: string, favorite: boolean): Promise<WriteReceipt> {
  return invoke(LIBRARY_COMMANDS.setFavoritePlaylist, { playlistId: identifier(playlistId, true), favorite }, parseReceipt);
}

export function previewOrganizer(request: OrganizerPreviewRequest): Promise<OrganizerPreview> {
  return invoke(LIBRARY_COMMANDS.organizerPreview, { request }, parseOrganizerPreview);
}

export function executeOrganizer(planId: string): Promise<OrganizerExecution> {
  if (!PLAN_ID.test(planId)) return invalid();
  return invoke(LIBRARY_COMMANDS.organizerExecute, { planId, confirm: true }, parseOrganizerExecution);
}
