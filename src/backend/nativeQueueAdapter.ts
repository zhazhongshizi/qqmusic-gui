import { hasPlaybackTransport, invokePlayback } from "./playbackTransport";
import type {
  NativePlaybackMode,
  PlaybackSessionSnapshot,
  QueuePlayResult,
  QueueSnapshot,
  QueueTrack,
} from "../contracts/queue";
import { isPlaybackQuality, type PlaybackQuality } from "../contracts/settings";
import {
  parsePlaybackLoadResult,
  parsePlayerSnapshot,
  playerErrorFromInvoke,
  type PreferredQuality,
} from "./nativePlayerAdapter";

export const QUEUE_COMMANDS = {
  snapshot: "queue_snapshot",
  replace: "queue_replace",
  enqueue: "queue_enqueue",
  remove: "queue_remove",
  move: "queue_move",
  play: "queue_play",
  sessionSnapshot: "playback_session_snapshot",
  setMode: "playback_set_mode",
  next: "queue_next",
  previous: "queue_previous",
  changeQuality: "playback_change_quality",
} as const;

export class QueueAdapterError extends Error {
  readonly code: "QMG-QUEUE-001" | "QMG-QUEUE-002";

  constructor(code: QueueAdapterError["code"]) {
    super(code);
    this.name = "QueueAdapterError";
    this.code = code;
  }
}

const SNAPSHOT_KEYS = ["generation", "selectedIndex", "items"] as const;
const TRACK_KEYS = ["id", "title", "artist", "album", "durationMs"] as const;
const OPTIONAL_TRACK_KEYS = ["mediaMid", "coverCacheKey"] as const;
const PLAY_KEYS = ["requestedQuality", "queue", "playback"] as const;
const SESSION_KEYS = ["mode", "queue", "player", "requestedQuality"] as const;
const STABLE_ID = /^[A-Za-z0-9_.:-]+$/;
const CACHE_KEY = /^[A-Za-z0-9_-]+$/;
const MAX_ITEMS = 1_000;
const encoder = new TextEncoder();

function invalid(): never {
  throw new QueueAdapterError("QMG-QUEUE-002");
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

function displayText(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    encoder.encode(value).byteLength > 512 ||
    /[\r\n\0]/.test(value)
  ) return invalid();
  return value;
}

function stableText(value: unknown, cacheKey = false): string {
  if (
    typeof value !== "string" ||
    encoder.encode(value).byteLength === 0 ||
    encoder.encode(value).byteLength > 128 ||
    !(cacheKey ? CACHE_KEY : STABLE_ID).test(value)
  ) return invalid();
  return value;
}

export function parseQueueTrack(value: unknown): QueueTrack {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const hasCover = typeof value === "object" && value !== null && "coverCacheKey" in value;
  const hasMediaMid = "mediaMid" in value;
  const keys = [
    ...TRACK_KEYS,
    ...OPTIONAL_TRACK_KEYS.filter((key) => key in value),
  ];
  const record = exactRecord(value, keys);
  const track: QueueTrack = {
    id: stableText(record.id),
    title: displayText(record.title),
    artist: displayText(record.artist),
    album: displayText(record.album, true),
    durationMs: unsigned(record.durationMs),
  };
  return {
    ...track,
    ...(hasMediaMid ? { mediaMid: stableText(record.mediaMid) } : {}),
    ...(hasCover ? { coverCacheKey: stableText(record.coverCacheKey, true) } : {}),
  };
}

function normalizeItems(value: unknown): QueueTrack[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return invalid();
  const items = value.map(parseQueueTrack);
  if (new Set(items.map(({ id }) => id)).size !== items.length) return invalid();
  return items;
}

export function parseQueueSnapshot(value: unknown): QueueSnapshot {
  const record = exactRecord(value, SNAPSHOT_KEYS);
  const items = normalizeItems(record.items);
  const selectedIndex = record.selectedIndex === null ? null : unsigned(record.selectedIndex);
  if (selectedIndex !== null && selectedIndex >= items.length) return invalid();
  if ((items.length === 0) !== (selectedIndex === null)) return invalid();
  return { generation: unsigned(record.generation), selectedIndex, items };
}

export function parseQueuePlayResult(value: unknown): QueuePlayResult {
  const record = exactRecord(value, PLAY_KEYS);
  return {
    requestedQuality: parseQuality(record.requestedQuality),
    queue: parseQueueSnapshot(record.queue),
    playback: parsePlaybackLoadResult(record.playback),
  };
}

export function parsePlaybackSessionSnapshot(value: unknown, knownQueue?: QueueSnapshot): PlaybackSessionSnapshot {
  const keys = [...SESSION_KEYS, ...["actualQuality", "lyricOffsetMs"].filter(key => typeof value === "object" && value !== null && key in value)];
  const record = exactRecord(value, keys);
  const actualQuality = record.actualQuality;
  if (record.lyricOffsetMs !== undefined && (!Number.isSafeInteger(record.lyricOffsetMs) || Math.abs(record.lyricOffsetMs as number) > 60000)) return invalid();
  if (actualQuality !== undefined && actualQuality !== null && (typeof actualQuality !== "string" || !["flac", "320k", "128k", "local", "qq-mv"].includes(actualQuality))) return invalid();
  const mode = record.mode;
  if (!(["sequence", "repeat-all", "repeat-one", "shuffle"] as const).includes(mode as NativePlaybackMode)) {
    return invalid();
  }
  return {
    ...(record.lyricOffsetMs !== undefined ? { lyricOffsetMs: record.lyricOffsetMs as number } : {}),
    ...(actualQuality !== undefined ? { actualQuality: actualQuality as PlaybackSessionSnapshot["actualQuality"] } : {}),
    requestedQuality: parseQuality(record.requestedQuality),
    mode: mode as NativePlaybackMode,
    queue: record.queue === null && knownQueue ? knownQueue : parseQueueSnapshot(record.queue),
    player: parsePlayerSnapshot(record.player),
  };
}

function parseQuality(value: unknown): PlaybackQuality {
  if (!isPlaybackQuality(value)) return invalid();
  return value;
}

function parseOptionalPlayResult(value: unknown): QueuePlayResult | null {
  return value === null ? null : parseQueuePlayResult(value);
}

function isTauriRuntime(): boolean {
  return hasPlaybackTransport();
}

async function invoke(command: string, payload?: Record<string, unknown>): Promise<unknown> {
  if (!isTauriRuntime()) throw new QueueAdapterError("QMG-QUEUE-001");
  try {
    return await invokePlayback(command, payload);
  } catch (error) {
    if (error instanceof QueueAdapterError) throw error;
    const playerError = playerErrorFromInvoke(error);
    if (playerError.reason !== "unknown") throw playerError;
    throw new QueueAdapterError("QMG-QUEUE-001");
  }
}

export async function nativeQueueSnapshot(): Promise<QueueSnapshot> {
  return parseQueueSnapshot(await invoke(QUEUE_COMMANDS.snapshot));
}

export async function nativeQueueReplace(items: readonly QueueTrack[]): Promise<QueueSnapshot> {
  const normalized = normalizeItems(items);
  return parseQueueSnapshot(await invoke(QUEUE_COMMANDS.replace, { items: normalized }));
}

export async function nativeQueueEnqueueMany(items: readonly QueueTrack[]): Promise<QueueSnapshot> {
  return parseQueueSnapshot(await invoke("queue_enqueue_many", { items: normalizeItems(items) }));
}

export async function nativeQueueEnqueue(item: QueueTrack): Promise<QueueSnapshot> {
  return parseQueueSnapshot(await invoke(QUEUE_COMMANDS.enqueue, { item: parseQueueTrack(item) }));
}

export async function nativeQueueEnqueueNext(item: QueueTrack): Promise<QueueSnapshot> {
  return parseQueueSnapshot(await invoke("queue_enqueue_next", { item: parseQueueTrack(item) }));
}

export async function nativeSetMvLyricOffset(trackId: string, generation: number, offsetMs: number): Promise<PlaybackSessionSnapshot> {
  if (!Number.isSafeInteger(offsetMs) || Math.abs(offsetMs) > 60000) return invalid();
  return parsePlaybackSessionSnapshot(await invoke("playback_set_mv_lyric_offset", { trackId: stableText(trackId), generation: unsigned(generation), offsetMs }));
}

export async function nativeQueueRemove(index: number): Promise<QueueSnapshot> {
  return parseQueueSnapshot(await invoke(QUEUE_COMMANDS.remove, { index: unsigned(index) }));
}

export async function nativeQueueMove(fromIndex: number, toIndex: number): Promise<QueueSnapshot> {
  return parseQueueSnapshot(await invoke(QUEUE_COMMANDS.move, {
    fromIndex: unsigned(fromIndex),
    toIndex: unsigned(toIndex),
  }));
}

export async function nativeQueuePlay(
  index: number,
  preferredQuality: PreferredQuality = "auto",
): Promise<QueuePlayResult | null> {
  if (!["auto", "flac", "320k", "128k"].includes(preferredQuality)) return invalid();
  return parseOptionalPlayResult(await invoke(QUEUE_COMMANDS.play, {
    index: unsigned(index),
    preferredQuality,
  }));
}

export async function nativePlaybackChangeQuality(
  preferredQuality: PlaybackQuality,
): Promise<QueuePlayResult | null> {
  return parseOptionalPlayResult(await invoke(QUEUE_COMMANDS.changeQuality, {
    preferredQuality: parseQuality(preferredQuality),
  }));
}

export async function nativePlaybackSessionSnapshot(knownQueue?: QueueSnapshot): Promise<PlaybackSessionSnapshot> {
  const payload = knownQueue ? { knownQueueGeneration: knownQueue.generation } : undefined;
  return parsePlaybackSessionSnapshot(await invoke(QUEUE_COMMANDS.sessionSnapshot, payload), knownQueue);
}

export async function nativeSetPlaybackMode(mode: NativePlaybackMode): Promise<PlaybackSessionSnapshot> {
  if (!(["sequence", "repeat-all", "repeat-one", "shuffle"] as const).includes(mode)) return invalid();
  return parsePlaybackSessionSnapshot(await invoke(QUEUE_COMMANDS.setMode, { mode }));
}

export async function nativeQueueNext(): Promise<QueuePlayResult | null> {
  return parseOptionalPlayResult(await invoke(QUEUE_COMMANDS.next));
}

export async function nativeQueuePrevious(): Promise<QueuePlayResult | null> {
  return parseOptionalPlayResult(await invoke(QUEUE_COMMANDS.previous));
}

/** Never mutates playback or reserves a shuffled track. */
export async function nativeQueuePreviewNext(): Promise<string | null> {
  const value = await invoke("queue_preview_next");
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 256 || !STABLE_ID.test(value)) return invalid();
  return value;
}
