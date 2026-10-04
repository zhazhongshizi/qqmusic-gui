import { hasPlaybackTransport, invokePlayback } from "./playbackTransport";
import type { LyricTimeline, TimedLyricLine } from "../contracts/lyrics";

export const LYRICS_COMMAND = "lyrics_get" as const;

export class LyricsAdapterError extends Error {
  readonly code: "QMG-LYRICS-001" | "QMG-LYRICS-002";

  constructor(code: LyricsAdapterError["code"]) {
    super(code);
    this.name = "LyricsAdapterError";
    this.code = code;
  }
}

const TIMELINE_KEYS = ["generation", "trackId", "lines"] as const;
const LINE_KEYS = ["atMs", "original"] as const;
const LINE_TRANSLATION_KEYS = [...LINE_KEYS, "translation"] as const;
const LINE_ROMANIZATION_KEYS = [...LINE_KEYS, "romanization"] as const;
const LINE_ALL_KEYS = [...LINE_KEYS, "translation", "romanization"] as const;
const TRACK_ID = /^[A-Za-z0-9_-]+$/;
const MAX_LINES = 5_000;
const encoder = new TextEncoder();

function invalid(): never {
  throw new LyricsAdapterError("QMG-LYRICS-002");
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

function boundedText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    encoder.encode(value).byteLength > maximumBytes ||
    /[\r\n\0]/.test(value)
  ) return invalid();
  return value;
}

function parseLine(value: unknown): TimedLyricLine {
  const hasTranslation = typeof value === "object" && value !== null && "translation" in value;
  const hasRomanization = typeof value === "object" && value !== null && "romanization" in value;
  const keys = hasTranslation && hasRomanization
    ? LINE_ALL_KEYS
    : hasTranslation
      ? LINE_TRANSLATION_KEYS
      : hasRomanization
        ? LINE_ROMANIZATION_KEYS
        : LINE_KEYS;
  const record = exactRecord(value, keys);
  return {
    atMs: unsigned(record.atMs),
    original: boundedText(record.original, 512),
    ...(hasTranslation ? { translation: boundedText(record.translation, 512) } : {}),
    ...(hasRomanization ? { romanization: boundedText(record.romanization, 512) } : {}),
  };
}

export function parseLyricTimeline(value: unknown): LyricTimeline {
  const record = exactRecord(value, TIMELINE_KEYS);
  const trackId = boundedText(record.trackId, 128);
  if (!TRACK_ID.test(trackId)) return invalid();
  if (!Array.isArray(record.lines) || record.lines.length === 0 || record.lines.length > MAX_LINES) {
    return invalid();
  }
  const lines = record.lines.map(parseLine);
  if (lines.some((line, index) => index > 0 && line.atMs <= (lines[index - 1]?.atMs ?? 0))) {
    return invalid();
  }
  return { generation: unsigned(record.generation), trackId, lines };
}

function isTauriRuntime(): boolean {
  return hasPlaybackTransport();
}

export async function getTimedLyrics(trackId: string, generation: number): Promise<LyricTimeline> {
  const normalizedId = boundedText(trackId, 128);
  if (!TRACK_ID.test(normalizedId)) return invalid();
  const normalizedGeneration = unsigned(generation);
  if (!isTauriRuntime()) throw new LyricsAdapterError("QMG-LYRICS-001");
  try {
    return parseLyricTimeline(await invokePlayback(LYRICS_COMMAND, {
      trackId: normalizedId,
      generation: normalizedGeneration,
    }));
  } catch (error) {
    if (error instanceof LyricsAdapterError) throw error;
    throw new LyricsAdapterError("QMG-LYRICS-001");
  }
}
