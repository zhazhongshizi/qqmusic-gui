import {
  APP_SNAPSHOT_COMMAND,
  APP_SNAPSHOT_SCHEMA_VERSION,
  type AppSnapshot,
  type ExtensionCapabilities,
  type PlayerSnapshot,
  type ProviderCapabilitySummary,
  type ProviderSnapshot,
  type TargetSnapshot,
  type TrackSummary,
} from "../contracts/appSnapshot";

export const APP_SNAPSHOT_ERROR_CODES = {
  unavailable: "QMG-BOOTSTRAP-001",
  invalid: "QMG-BOOTSTRAP-002",
} as const;

export type AppSnapshotErrorCode =
  (typeof APP_SNAPSHOT_ERROR_CODES)[keyof typeof APP_SNAPSHOT_ERROR_CODES];

export type AppSnapshotSource = "tauri" | "browserFixture";

export type AppSnapshotLoadResult =
  | {
      readonly ok: true;
      readonly source: AppSnapshotSource;
      readonly snapshot: AppSnapshot;
    }
  | {
      readonly ok: false;
      readonly code: AppSnapshotErrorCode;
    };

const ROOT_KEYS = [
  "schemaVersion",
  "appVersion",
  "target",
  "provider",
  "player",
  "extensions",
] as const;
const TARGET_KEYS = ["os", "architecture"] as const;
const PROVIDER_BASE_KEYS = ["protocolVersion", "state"] as const;
const PROVIDER_READY_KEYS = ["protocolVersion", "state", "providerVersion", "capabilities"] as const;
const PROVIDER_CAPABILITY_KEYS = [
  "implementedMethods",
  "authMethods",
  "searchTypes",
  "playlistWrites",
] as const;
const PLAYER_KEYS = [
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
const PLAYER_FAILURE_KEYS = ["code", "recoverable", "generation"] as const;
const EXTENSION_KEYS = ["playlistRename", "playlistDescriptionEdit"] as const;

const BROWSER_FIXTURE_SNAPSHOT: AppSnapshot = Object.freeze({
  schemaVersion: APP_SNAPSHOT_SCHEMA_VERSION,
  appVersion: "browser-fixture",
  target: Object.freeze({
    os: "windows",
    architecture: "x86_64",
  }),
  provider: Object.freeze({
    protocolVersion: 1,
    state: "notStarted",
  }),
  player: Object.freeze({
    state: "idle",
    generation: 0,
    positionMs: 0,
    durationMs: null,
    volume: 1,
    muted: false,
    currentTrack: null,
    failure: null,
  }),
  extensions: Object.freeze({
    playlistRename: false,
    playlistDescriptionEdit: false,
  }),
});

class InvalidAppSnapshotError extends Error {
  constructor() {
    super("invalid app snapshot");
    this.name = "InvalidAppSnapshotError";
  }
}

function invalid(): never {
  throw new InvalidAppSnapshotError();
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalid();
  }

  const actualKeys = Object.keys(value);
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key))) {
    return invalid();
  }

  return value as Record<string, unknown>;
}

function literal<T extends string | number>(value: unknown, expected: T): T {
  return value === expected ? expected : invalid();
}

function boundedString(value: unknown, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    return invalid();
  }
  return value;
}

function safeUnsignedInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}

function normalizedVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return invalid();
  }
  return value;
}

function booleanValue(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid();
}

function boundedStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) return invalid();
  return value.map((item) => boundedString(item, 128));
}

function parseProviderCapabilities(value: unknown): ProviderCapabilitySummary {
  const record = exactRecord(value, PROVIDER_CAPABILITY_KEYS);
  return {
    implementedMethods: boundedStringArray(record.implementedMethods),
    authMethods: boundedStringArray(record.authMethods),
    searchTypes: boundedStringArray(record.searchTypes),
    playlistWrites: boundedStringArray(record.playlistWrites),
  };
}

function parseTarget(value: unknown): TargetSnapshot {
  const record = exactRecord(value, TARGET_KEYS);
  return {
    os: literal(record.os, "windows"),
    architecture: literal(record.architecture, "x86_64"),
  };
}

function parseProvider(value: unknown): ProviderSnapshot {
  const ready = typeof value === "object" && value !== null && "providerVersion" in value;
  const record = exactRecord(value, ready ? PROVIDER_READY_KEYS : PROVIDER_BASE_KEYS);
  const protocolVersion = literal(record.protocolVersion, 1);
  if (record.state === "ready" && ready) {
    return {
      protocolVersion,
      state: "ready",
      providerVersion: boundedString(record.providerVersion, 64),
      capabilities: parseProviderCapabilities(record.capabilities),
    };
  }
  if (
    !ready &&
    (record.state === "notStarted" || record.state === "starting" || record.state === "failed")
  ) {
    return { protocolVersion, state: record.state };
  }
  return invalid();
}

function parseTrack(value: unknown): TrackSummary | null {
  if (value === null) return null;
  const hasSource = typeof value === "object" && value !== null && "source" in value;
  const record = exactRecord(value, hasSource ? [...TRACK_KEYS, "source"] : TRACK_KEYS);
  if (hasSource && record.source !== "qq-mv") return invalid();
  return {
    id: boundedString(record.id, 256),
    title: boundedString(record.title, 512),
    artist: boundedString(record.artist, 512),
    ...(hasSource ? { source: "qq-mv" as const } : {}),
  };
}

function parsePlayer(value: unknown): PlayerSnapshot {
  const record = exactRecord(value, PLAYER_KEYS);
  const durationMs = record.durationMs === null
    ? null
    : safeUnsignedInteger(record.durationMs);

  const state = record.state;
  if (![
    "idle", "loading", "playing", "paused", "ended", "failed",
  ].includes(state as string)) return invalid();
  const generation = safeUnsignedInteger(record.generation);
  let failure: PlayerSnapshot["failure"] = null;
  if (record.failure !== null) {
    const failureRecord = exactRecord(record.failure, PLAYER_FAILURE_KEYS);
    const codes = ["network", "decoding", "unsupported", "authentication", "unavailable"];
    if (!codes.includes(failureRecord.code as string)) return invalid();
    const failureGeneration = safeUnsignedInteger(failureRecord.generation);
    if (failureGeneration !== generation) return invalid();
    failure = {
      code: failureRecord.code as NonNullable<PlayerSnapshot["failure"]>["code"],
      recoverable: booleanValue(failureRecord.recoverable),
      generation: failureGeneration,
    };
  }
  return {
    state: state as PlayerSnapshot["state"],
    generation,
    positionMs: safeUnsignedInteger(record.positionMs),
    durationMs,
    volume: normalizedVolume(record.volume),
    muted: booleanValue(record.muted),
    currentTrack: parseTrack(record.currentTrack),
    failure,
  };
}

function parseExtensions(value: unknown): ExtensionCapabilities {
  const record = exactRecord(value, EXTENSION_KEYS);
  return {
    playlistRename: booleanValue(record.playlistRename),
    playlistDescriptionEdit: booleanValue(record.playlistDescriptionEdit),
  };
}

export function parseAppSnapshot(value: unknown): AppSnapshot {
  const record = exactRecord(value, ROOT_KEYS);
  return {
    schemaVersion: literal(record.schemaVersion, APP_SNAPSHOT_SCHEMA_VERSION),
    appVersion: boundedString(record.appVersion, 64),
    target: parseTarget(record.target),
    provider: parseProvider(record.provider),
    player: parsePlayer(record.player),
    extensions: parseExtensions(record.extensions),
  };
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeAppSnapshot(): Promise<unknown> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<unknown>(APP_SNAPSHOT_COMMAND);
}

export async function loadAppSnapshot(): Promise<AppSnapshotLoadResult> {
  if (!isTauriRuntime()) {
    return {
      ok: true,
      source: "browserFixture",
      snapshot: BROWSER_FIXTURE_SNAPSHOT,
    };
  }

  let rawSnapshot: unknown;
  try {
    rawSnapshot = await invokeAppSnapshot();
  } catch {
    return { ok: false, code: APP_SNAPSHOT_ERROR_CODES.unavailable };
  }

  try {
    return {
      ok: true,
      source: "tauri",
      snapshot: parseAppSnapshot(rawSnapshot),
    };
  } catch {
    return { ok: false, code: APP_SNAPSHOT_ERROR_CODES.invalid };
  }
}
