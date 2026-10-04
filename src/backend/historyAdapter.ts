import { parseQueueTrack } from "./nativeQueueAdapter";

export interface HistoryEntry {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album?: string;
  readonly durationMs?: number;
  readonly coverCacheKey?: string;
  readonly mediaMid?: string;
  readonly playedAtUnixMs: number;
}

export async function getPlaybackHistory(): Promise<readonly HistoryEntry[]> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const payload = await invoke<unknown>("playback_history");
    if (!Array.isArray(payload) || payload.length > 5_000) throw new Error();
    return payload.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") throw new Error();
      const value = entry as Record<string, unknown>;
      const track = parseQueueTrack({ id: value.id, title: value.title, artist: value.artist,
        album: value.album ?? "", durationMs: value.durationMs ?? 0,
        ...(value.coverCacheKey != null ? { coverCacheKey: value.coverCacheKey } : {}),
        ...(value.mediaMid != null ? { mediaMid: value.mediaMid } : {}),
      });
      if (typeof value.playedAtUnixMs !== "number" || !Number.isSafeInteger(value.playedAtUnixMs)
        || value.playedAtUnixMs < 0 || value.playedAtUnixMs > 8_640_000_000_000_000) throw new Error();
      return { ...track, playedAtUnixMs: value.playedAtUnixMs };
    });
  } catch { throw new Error("本地历史读取失败"); }
}
