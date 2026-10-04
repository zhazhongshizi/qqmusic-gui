import type { PlayerSnapshot } from "./appSnapshot";
import type { PlaybackQuality } from "./settings";

export interface QueueTrack {
  readonly id: string;
  readonly mediaMid?: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly durationMs: number;
  readonly coverCacheKey?: string;
}

export interface QueueSnapshot {
  readonly generation: number;
  readonly selectedIndex: number | null;
  readonly items: readonly QueueTrack[];
}

export interface QueuePlayResult {
  readonly requestedQuality: PlaybackQuality;
  readonly queue: QueueSnapshot;
  readonly playback: {
    readonly quality: "flac" | "320k" | "128k" | "local" | "qq-mv";
    readonly expiresInSeconds: number;
    readonly player: PlayerSnapshot;
  };
}

export type NativePlaybackMode = "sequence" | "repeat-all" | "repeat-one" | "shuffle";

export interface PlaybackSessionSnapshot {
  readonly lyricOffsetMs?: number;
  readonly actualQuality?: "flac" | "320k" | "128k" | "local" | "qq-mv" | null;
  readonly requestedQuality: PlaybackQuality;
  readonly mode: NativePlaybackMode;
  readonly queue: QueueSnapshot;
  readonly player: PlayerSnapshot;
}
