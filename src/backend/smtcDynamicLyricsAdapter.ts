export const SMTC_DYNAMIC_LYRICS_COMMAND = "smtc_dynamic_lyrics_set_enabled" as const;

export interface SmtcDynamicLyricsState {
  readonly enabled: boolean;
}

export class SmtcDynamicLyricsAdapterError extends Error {
  readonly code: "QMG-SMTC-DYNAMIC-LYRICS-001" | "QMG-SMTC-DYNAMIC-LYRICS-002";

  constructor(code: SmtcDynamicLyricsAdapterError["code"]) {
    super(code);
    this.name = "SmtcDynamicLyricsAdapterError";
    this.code = code;
  }
}

function invalid(): never {
  throw new SmtcDynamicLyricsAdapterError("QMG-SMTC-DYNAMIC-LYRICS-002");
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

export function parseSmtcDynamicLyricsState(value: unknown): SmtcDynamicLyricsState {
  const record = exactRecord(value, ["enabled"]);
  if (typeof record.enabled !== "boolean") return invalid();
  return { enabled: record.enabled };
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function setSmtcDynamicLyricsEnabled(
  enabled: boolean,
): Promise<SmtcDynamicLyricsState> {
  if (typeof enabled !== "boolean") return invalid();

  // Browser previews deliberately do not claim that Windows SMTC is available.
  if (!isTauriRuntime()) return { enabled: false };

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return parseSmtcDynamicLyricsState(await invoke(SMTC_DYNAMIC_LYRICS_COMMAND, { enabled }));
  } catch (error) {
    if (error instanceof SmtcDynamicLyricsAdapterError) throw error;
    throw new SmtcDynamicLyricsAdapterError("QMG-SMTC-DYNAMIC-LYRICS-001");
  }
}
