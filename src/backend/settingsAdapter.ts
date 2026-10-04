import {
  isPlaybackQuality,
  type PlaybackQuality,
  type SettingsSnapshot,
} from "../contracts/settings";

export const SETTINGS_COMMANDS = {
  snapshot: "settings_snapshot",
  setPreferredQuality: "settings_set_preferred_quality",
  setLiveSpectrumEnabled: "settings_set_live_spectrum_enabled",
} as const;

export class SettingsAdapterError extends Error {
  readonly code: "QMG-SETTINGS-001" | "QMG-SETTINGS-002";

  constructor(code: SettingsAdapterError["code"]) {
    super(code);
    this.name = "SettingsAdapterError";
    this.code = code;
  }
}

const SETTINGS_KEYS = ["preferredQuality", "liveSpectrumEnabled"] as const;

function invalid(): never {
  throw new SettingsAdapterError("QMG-SETTINGS-002");
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) return invalid();
  const keys = Object.keys(value);
  const expected: readonly string[] = "mvFallbackEnabled" in value ? [...SETTINGS_KEYS, "mvFallbackEnabled"] : SETTINGS_KEYS;
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

export function parseSettingsSnapshot(value: unknown): SettingsSnapshot {
  const record = exactRecord(value);
  if (!isPlaybackQuality(record.preferredQuality)) return invalid();
  if (typeof record.liveSpectrumEnabled !== "boolean") return invalid();
  if (record.mvFallbackEnabled !== undefined && typeof record.mvFallbackEnabled !== "boolean") return invalid();
  return {
    ...(record.mvFallbackEnabled !== undefined ? { mvFallbackEnabled: record.mvFallbackEnabled as boolean } : {}),
    preferredQuality: record.preferredQuality,
    liveSpectrumEnabled: record.liveSpectrumEnabled,
  };
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke(command: string, payload?: Record<string, unknown>): Promise<unknown> {
  if (!isTauriRuntime()) throw new SettingsAdapterError("QMG-SETTINGS-001");
  try {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return await tauriInvoke(command, payload);
  } catch (error) {
    if (error instanceof SettingsAdapterError) throw error;
    throw new SettingsAdapterError("QMG-SETTINGS-001");
  }
}

export async function nativeSettingsSnapshot(): Promise<SettingsSnapshot> {
  return parseSettingsSnapshot(await invoke(SETTINGS_COMMANDS.snapshot));
}

export async function nativeSetPreferredQuality(
  preferredQuality: PlaybackQuality,
): Promise<SettingsSnapshot> {
  if (!isPlaybackQuality(preferredQuality)) return invalid();
  return parseSettingsSnapshot(await invoke(SETTINGS_COMMANDS.setPreferredQuality, { preferredQuality }));
}

export async function nativeSetLiveSpectrumEnabled(
  enabled: boolean,
): Promise<SettingsSnapshot> {
  if (typeof enabled !== "boolean") return invalid();
  return parseSettingsSnapshot(await invoke(SETTINGS_COMMANDS.setLiveSpectrumEnabled, { enabled }));
}

export async function nativeSetMvFallbackEnabled(enabled: boolean): Promise<SettingsSnapshot> {
  if (typeof enabled !== "boolean") return invalid();
  return parseSettingsSnapshot(await invoke("settings_set_mv_fallback_enabled", { enabled }));
}
