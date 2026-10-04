import { hasPlaybackTransport, invokePlayback } from "./playbackTransport";
import type { PlayerSnapshot, TrackSummary } from "../contracts/appSnapshot";

export const PLAYER_COMMANDS = {
  snapshot: "player_snapshot",
  play: "player_play",
  pause: "player_pause",
  stop: "player_stop",
  seek: "player_seek",
  setVolume: "player_set_volume",
  setMuted: "player_set_muted",
} as const;

export type PreferredQuality = "auto" | "flac" | "320k" | "128k";

export interface PlaybackLoadResult {
  readonly quality: Exclude<PreferredQuality, "auto"> | "local" | "qq-mv";
  readonly expiresInSeconds: number;
  readonly player: PlayerSnapshot;
}

export class PlayerAdapterError extends Error {
  readonly code: "QMG-PLAYER-001" | "QMG-PLAYER-002";
  readonly reason: PlaybackFailureReason;

  constructor(code: PlayerAdapterError["code"], reason: PlaybackFailureReason = "unknown") {
    super(code);
    this.name = "PlayerAdapterError";
    this.code = code;
    this.reason = reason;
  }
}

export type PlaybackFailureReason =
  | "network"
  | "decoding"
  | "unsupported"
  | "authentication"
  | "entitlement"
  | "device-limit"
  | "unsafe-media"
  | "native-player"
  | "unavailable"
  | "unknown";

const PUBLIC_ERROR_KEYS = ["code", "retryable", "operation", "correlationId", "userMessage"] as const;
const PUBLIC_PLAYBACK_CODES: Record<string, PlaybackFailureReason> = {
  network_unavailable: "network",
  authentication_required: "authentication",
  playback_entitlement_denied: "entitlement",
  playback_device_limit: "device-limit",
  playback_unsafe_media_url: "unsafe-media",
  playback_native_unavailable: "native-player",
  playback_unavailable: "unavailable",
  local_music_file_missing: "unavailable",
  local_music_codec_unavailable: "unsupported",
  provider_unavailable: "unavailable",
  upstream_schema_changed: "unavailable",
};

const SNAPSHOT_KEYS = [
  "state",
  "generation",
  "positionMs",
  "durationMs",
  "volume",
  "muted",
  "currentTrack",
  "failure",
] as const;
const TRACK_KEYS = ["id", "title", "artist"] as const;
const FAILURE_KEYS = ["code", "recoverable", "generation"] as const;
const LOAD_KEYS = ["quality", "expiresInSeconds", "player"] as const;

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new PlayerAdapterError("QMG-PLAYER-002");
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new PlayerAdapterError("QMG-PLAYER-002");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new PlayerAdapterError("QMG-PLAYER-002");
  }
  return value;
}

function unsigned(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PlayerAdapterError("QMG-PLAYER-002");
  }
  return value as number;
}

function parseTrack(value: unknown): TrackSummary | null {
  if (value === null) return null;
  const hasSource = typeof value === "object" && value !== null && "source" in value;
  const record = exactRecord(value, hasSource ? [...TRACK_KEYS, "source"] : TRACK_KEYS);
  if (hasSource && record.source !== "qq-mv") throw new PlayerAdapterError("QMG-PLAYER-002");
  return {
    id: text(record.id, 128),
    title: text(record.title, 512),
    artist: text(record.artist, 512),
    ...(hasSource ? { source: "qq-mv" as const } : {}),
  };
}

function parseFailure(value: unknown): PlayerSnapshot["failure"] {
  if (value === null) return null;
  const record = exactRecord(value, FAILURE_KEYS);
  const codes = ["network", "decoding", "unsupported", "authentication", "unavailable"];
  if (!codes.includes(record.code as string) || typeof record.recoverable !== "boolean") {
    throw new PlayerAdapterError("QMG-PLAYER-002");
  }
  return {
    code: record.code as NonNullable<PlayerSnapshot["failure"]>["code"],
    recoverable: record.recoverable,
    generation: unsigned(record.generation),
  };
}

export function parsePlayerSnapshot(value: unknown): PlayerSnapshot {
  const record = exactRecord(value, SNAPSHOT_KEYS);
  const state = record.state;
  if (![
    "idle", "loading", "playing", "paused", "ended", "failed",
  ].includes(state as string)) throw new PlayerAdapterError("QMG-PLAYER-002");
  const volume = record.volume;
  if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 1) {
    throw new PlayerAdapterError("QMG-PLAYER-002");
  }
  if (typeof record.muted !== "boolean") throw new PlayerAdapterError("QMG-PLAYER-002");
  const durationMs = record.durationMs === null ? null : unsigned(record.durationMs);
  const generation = unsigned(record.generation);
  const failure = parseFailure(record.failure);
  if (failure && failure.generation !== generation) throw new PlayerAdapterError("QMG-PLAYER-002");
  return {
    state: state as PlayerSnapshot["state"],
    generation,
    positionMs: unsigned(record.positionMs),
    durationMs,
    volume,
    muted: record.muted,
    currentTrack: parseTrack(record.currentTrack),
    failure,
  };
}

export function parsePlaybackLoadResult(value: unknown): PlaybackLoadResult {
  const record = exactRecord(value, LOAD_KEYS);
  const quality = record.quality;
  if (quality !== "flac" && quality !== "320k" && quality !== "128k" && quality !== "local" && quality !== "qq-mv") {
    throw new PlayerAdapterError("QMG-PLAYER-002");
  }
  return {
    quality,
    expiresInSeconds: unsigned(record.expiresInSeconds),
    player: parsePlayerSnapshot(record.player),
  };
}

function isTauriRuntime(): boolean {
  return hasPlaybackTransport();
}

export function playerErrorFromInvoke(error: unknown): PlayerAdapterError {
  try {
    const record = exactRecord(error, PUBLIC_ERROR_KEYS);
    if (
      record.operation !== "playback"
      || typeof record.retryable !== "boolean"
      || typeof record.code !== "string"
      || typeof record.correlationId !== "string"
      || !/^[0-9a-f-]{36}$/i.test(record.correlationId)
      || typeof record.userMessage !== "string"
      || record.userMessage.length === 0
      || record.userMessage.length > 160
    ) return new PlayerAdapterError("QMG-PLAYER-001");
    return new PlayerAdapterError(
      "QMG-PLAYER-001",
      PUBLIC_PLAYBACK_CODES[record.code] ?? "unknown",
    );
  } catch {
    return new PlayerAdapterError("QMG-PLAYER-001");
  }
}

async function invoke(command: string, payload?: Record<string, unknown>): Promise<unknown> {
  if (!isTauriRuntime()) throw new PlayerAdapterError("QMG-PLAYER-001");
  try {
    return await invokePlayback(command, payload);
  } catch (error) {
    if (error instanceof PlayerAdapterError) throw error;
    throw playerErrorFromInvoke(error);
  }
}

export async function nativePlayerSnapshot(): Promise<PlayerSnapshot> {
  return parsePlayerSnapshot(await invoke(PLAYER_COMMANDS.snapshot));
}

export async function nativePlay(): Promise<PlayerSnapshot> {
  return parsePlayerSnapshot(await invoke(PLAYER_COMMANDS.play));
}

export async function nativePause(): Promise<PlayerSnapshot> {
  return parsePlayerSnapshot(await invoke(PLAYER_COMMANDS.pause));
}

export async function nativeStop(): Promise<PlayerSnapshot> {
  return parsePlayerSnapshot(await invoke(PLAYER_COMMANDS.stop));
}

export async function nativeSeek(positionMs: number): Promise<PlayerSnapshot> {
  return parsePlayerSnapshot(await invoke(PLAYER_COMMANDS.seek, { positionMs }));
}

export async function nativeSetVolume(volume: number): Promise<PlayerSnapshot> {
  return parsePlayerSnapshot(await invoke(PLAYER_COMMANDS.setVolume, { volume }));
}

export async function nativeSetMuted(muted: boolean): Promise<PlayerSnapshot> {
  return parsePlayerSnapshot(await invoke(PLAYER_COMMANDS.setMuted, { muted }));
}
