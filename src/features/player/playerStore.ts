import { useSyncExternalStore } from "react";
import { localMusicFormatFromId } from "../../contracts/localMusic";
import { playbackSessionIdentity } from "../../backend/playbackTransport";
import { newestQueue } from "../../backend/sessionSnapshots";

import {
  nativePause,
  nativePlay,
  nativePlayerSnapshot,
  nativeSeek,
  nativeSetMuted,
  nativeSetVolume,
  nativeStop,
  PlayerAdapterError,
  type PlaybackLoadResult,
  type PlaybackFailureReason,
} from "../../backend/nativePlayerAdapter";
import {
  nativeQueueMove,
  nativeSetMvLyricOffset,
  nativeQueueNext,
  nativeQueuePlay,
  nativeQueuePrevious,
  nativeQueueRemove,
  nativeQueueReplace,
  nativeQueueSnapshot,
  nativePlaybackSessionSnapshot,
  nativePlaybackChangeQuality,
  nativeSetPlaybackMode,
} from "../../backend/nativeQueueAdapter";
import {
  nativeSetPreferredQuality,
  nativeSettingsSnapshot,
} from "../../backend/settingsAdapter";
import { setSongsLiked } from "../../backend/libraryAdapter";
import type { PlayerSnapshot as NativePlayerSnapshot } from "../../contracts/appSnapshot";
import { nativeTrack, actualQuality, expectedQuality, qualityFromExpected } from "./nativeTrack";
import type { TimedLyricLine } from "../../contracts/lyrics";
import type { PlaybackSessionSnapshot, QueueSnapshot } from "../../contracts/queue";
import { isPlaybackQuality, type PlaybackQuality } from "../../contracts/settings";
import { FIXTURE_TRACKS, type Track } from "./fixtures";

export type PlaybackMode = "sequence" | "repeat-all" | "repeat-one" | "shuffle";
type NativeFailureCode = NonNullable<NativePlayerSnapshot["failure"]>["code"];

export interface PlayerSnapshot {
  readonly nativeMode: boolean;
  readonly nativeLoaded: boolean;
  readonly lyricsReady?: boolean;
  readonly lyricOffsetMs?: number;
  readonly generation: number;
  readonly queue: readonly Track[];
  readonly currentIndex: number;
  readonly isPlaying: boolean;
  readonly positionMs: number;
  readonly volume: number;
  readonly muted: boolean;
  readonly mode: PlaybackMode;
  readonly defaultQuality: PlaybackQuality;
  readonly requestedQuality: PlaybackQuality;
  readonly likedIds: readonly string[];
  readonly playbackError: PlaybackErrorState | null;
}

export interface PlaybackErrorState {
  readonly reason: PlaybackFailureReason;
  readonly message: string;
}

const PLAYBACK_ERROR_MESSAGES: Record<PlaybackFailureReason, string> = {
  network: "网络暂不可用，检查连接后重试。",
  authentication: "登录状态已失效，请重新扫码登录。",
  entitlement: "当前账号没有这首歌曲的播放权益。",
  "device-limit": "当前账号的播放设备数已达上限。",
  "unsafe-media": "媒体地址未通过本地安全检查。",
  "native-player": "Windows 播放器无法打开这首歌曲。",
  unavailable: "当前歌曲暂时无法播放。",
  decoding: "Windows 播放器无法解码这首歌曲。",
  unsupported: "当前媒体格式不受 Windows 播放器支持。",
  unknown: "播放失败，请稍后重试。",
};

const NATIVE_FAILURE_REASONS: Record<NativeFailureCode, PlaybackFailureReason> = {
  network: "network",
  decoding: "decoding",
  unsupported: "unsupported",
  authentication: "authentication",
  unavailable: "unavailable",
};

const initialSnapshot: PlayerSnapshot = {
  nativeMode: false,
  nativeLoaded: false,
  generation: 0,
  queue: FIXTURE_TRACKS,
  currentIndex: 0,
  isPlaying: false,
  positionMs: 132_000,
  volume: 0.72,
  muted: false,
  mode: "sequence",
  defaultQuality: "320k",
  requestedQuality: "flac",
  likedIds: ["fixture-paper-moon"],
  playbackError: null,
};

let snapshot = initialSnapshot;
let nativeSessionIdentity = playbackSessionIdentity();
let lastNativeQueue: QueueSnapshot | undefined;
let playbackRetry: (() => Promise<void>) | null = null;
let nativeFailureKey: string | null = null;
type OperationDomain = "source" | "transport" | "seek" | "volume" | "mode" | "queue" | "like" | "quality";
const operationVersions: Record<OperationDomain, number> = {
  source: 0,
  transport: 0,
  seek: 0,
  volume: 0,
  mode: 0,
  queue: 0,
  like: 0,
  quality: 0,
};
const listeners = new Set<() => void>();

function emit(nextSnapshot: PlayerSnapshot) {
  const keys = Object.keys(nextSnapshot) as (keyof PlayerSnapshot)[];
  if (keys.length === Object.keys(snapshot).length && keys.every((key) => Object.is(snapshot[key], nextSnapshot[key]))) return;
  snapshot = nextSnapshot;
  listeners.forEach((listener) => listener());
}

function applyNative(
  queue: QueueSnapshot,
  player: NativePlayerSnapshot,
  quality?: PlaybackLoadResult["quality"],
  mode?: PlaybackMode,
  requestedQuality?: PlaybackQuality,
  lyricOffsetMs?: number,
) {
  if (nativeSessionIdentity !== playbackSessionIdentity()) {
    nativeSessionIdentity = playbackSessionIdentity();
    lastNativeQueue = undefined;
    nativeFailureKey = null;
    playbackRetry = null;
    snapshot = { ...initialSnapshot, queue: [], positionMs: 0, likedIds: [] };
  }
  if (snapshot.nativeMode && player.generation < snapshot.generation) return;
  queue = newestQueue(lastNativeQueue, queue);
  const queueUnchanged = queue === lastNativeQueue;
  let tracks = snapshot.queue;
  if (!queueUnchanged) {
    const previous = new Map(snapshot.queue.map((track) => [track.id, track]));
    tracks = queue.items.map((track) => nativeTrack(track, previous.get(track.id)));
  }
  const playerIndex = player.currentTrack
    ? queueUnchanged && currentTrackFrom(snapshot)?.id === player.currentTrack.id
      ? snapshot.currentIndex
      : tracks.findIndex((track) => track.id === player.currentTrack?.id)
    : -1;
  const currentIndex = playerIndex >= 0 ? playerIndex : (queue.selectedIndex ?? 0);
  const current = tracks[currentIndex];
  if (current && player.durationMs !== null && player.currentTrack?.id === current.id) {
    if (current.durationMs !== player.durationMs) {
      const next = [...tracks];
      next[currentIndex] = { ...current, durationMs: player.durationMs };
      tracks = next;
    }
  }
  const updatedCurrent = tracks[currentIndex];
  const effectiveQuality = player.currentTrack?.source === "qq-mv" ? "qq-mv" : quality;
  const sourceChangedBack = updatedCurrent?.actualQuality === "QQ MV 音轨"
    && player.currentTrack?.id === updatedCurrent.id && player.currentTrack.source !== "qq-mv";
  const qualityLabel = effectiveQuality && updatedCurrent
    ? actualQuality(effectiveQuality, updatedCurrent.id)
    : sourceChangedBack ? "未知音质" : undefined;
  if (qualityLabel && updatedCurrent && updatedCurrent.actualQuality !== qualityLabel) {
    const next = [...tracks];
    next[currentIndex] = {
      ...updatedCurrent,
      actualQuality: qualityLabel,
    };
    tracks = next;
  }
  const currentRequestedQuality = requestedQuality ?? (
    updatedCurrent && updatedCurrent.id === currentTrackFrom(snapshot)?.id
      ? snapshot.requestedQuality
      : snapshot.defaultQuality
  );
  if (updatedCurrent && updatedCurrent.expectedQuality !== expectedQuality(currentRequestedQuality)) {
    const next = [...tracks];
    next[currentIndex] = {
      ...tracks[currentIndex]!,
      expectedQuality: expectedQuality(currentRequestedQuality),
    };
    tracks = next;
  }
  const nextQueue = tracks === snapshot.queue || (
    tracks.length === snapshot.queue.length && tracks.every((track, index) => track === snapshot.queue[index])
  )
    ? snapshot.queue
    : tracks;
  let playbackError = snapshot.playbackError;
  if (player.failure) {
    const key = `${player.failure.generation}:${player.failure.code}`;
    if (key !== nativeFailureKey) {
      nativeFailureKey = key;
      playbackRetry = retryCurrentNativeTrack;
      const reason = NATIVE_FAILURE_REASONS[player.failure.code];
      playbackError = { reason, message: PLAYBACK_ERROR_MESSAGES[reason] };
    }
  } else if (nativeFailureKey !== null) {
    nativeFailureKey = null;
    playbackError = null;
  }
  lastNativeQueue = queue;
  emit({
    nativeMode: true,
    lyricOffsetMs: lyricOffsetMs ?? (snapshot.generation === player.generation ? snapshot.lyricOffsetMs ?? 0 : 0),
    lyricsReady: snapshot.nativeMode && snapshot.generation === player.generation && currentTrackFrom(snapshot)?.id === updatedCurrent?.id ? snapshot.lyricsReady : false,
    nativeLoaded: player.currentTrack !== null,
    generation: player.generation,
    queue: nextQueue,
    currentIndex,
    isPlaying: player.state === "playing" || player.state === "loading",
    positionMs: player.positionMs,
    volume: player.volume,
    muted: player.muted,
    mode: mode ?? (snapshot.nativeMode ? snapshot.mode : "sequence"),
    defaultQuality: snapshot.defaultQuality,
    requestedQuality: currentRequestedQuality,
    likedIds: snapshot.nativeMode ? snapshot.likedIds : [],
    playbackError,
  });
}

async function refreshNative(
  queue?: QueueSnapshot,
  playback?: PlaybackLoadResult,
  isCurrent: () => boolean = () => true,
  requestedQuality?: PlaybackQuality,
) {
  const identity = playbackSessionIdentity();
  const [nextQueue, player] = await Promise.all([
    queue ? Promise.resolve(queue) : nativeQueueSnapshot(),
    playback ? Promise.resolve(playback.player) : nativePlayerSnapshot(),
  ]);
  if (identity === playbackSessionIdentity() && isCurrent()) applyNative(nextQueue, player, playback?.quality, undefined, requestedQuality);
}

function applyControl(
  player: NativePlayerSnapshot,
  domain: "transport" | "seek" | "volume",
  isCurrent: () => boolean,
) {
  if (!isCurrent() || player.generation < snapshot.generation) return;
  if (domain === "transport") {
    emit({ ...snapshot, isPlaying: player.state === "playing" || player.state === "loading" });
  } else if (domain === "seek") {
    if (player.currentTrack?.id !== currentTrackFrom(snapshot)?.id) return;
    const loadedSource = !snapshot.nativeLoaded || player.generation > snapshot.generation;
    emit({
      ...snapshot,
      positionMs: player.positionMs,
      generation: player.generation,
      nativeLoaded: player.currentTrack !== null,
      isPlaying: loadedSource ? player.state === "playing" || player.state === "loading" : snapshot.isPlaying,
      lyricsReady: player.generation === snapshot.generation && snapshot.lyricsReady,
    });
  } else {
    emit({ ...snapshot, volume: player.volume, muted: player.muted });
  }
}

function clearPlaybackError() {
  if (nativeFailureKey !== null) return;
  playbackRetry = null;
  if (snapshot.playbackError) emit({ ...snapshot, playbackError: null });
}

function reportPlaybackError(error: unknown, retry?: () => Promise<void>) {
  // A failed source still needs reloading, regardless of later control errors.
  if (nativeFailureKey !== null) return;
  const reason = error instanceof PlayerAdapterError ? error.reason : "unknown";
  playbackRetry = retry ?? null;
  emit({
    ...snapshot,
    isPlaying: false,
    playbackError: { reason, message: PLAYBACK_ERROR_MESSAGES[reason] },
  });
}

function runNative(domain: OperationDomain, operation: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
  const invoke = async (): Promise<void> => {
    const version = ++operationVersions[domain];
    const identity = playbackSessionIdentity();
    const isCurrent = () => operationVersions[domain] === version && identity === playbackSessionIdentity();
    try {
      await operation(isCurrent);
      if (isCurrent()) clearPlaybackError();
    } catch (error) {
      if (isCurrent()) reportPlaybackError(error, invoke);
    }
  };
  return invoke();
}

function retryCurrentNativeTrack(): Promise<void> {
  if (!snapshot.nativeMode || snapshot.queue.length === 0) return Promise.resolve();
  const track = currentTrackFrom(snapshot);
  const index = track ? snapshot.queue.findIndex((item) => item.id === track.id) : -1;
  if (index < 0) return Promise.resolve();
  return runNative("source", async (isCurrent) => {
    const playback = await nativeQueuePlay(index);
    if (!playback) return;
    await refreshNative(
      playback.queue,
      playback.playback,
      isCurrent,
      playback.requestedQuality,
    );
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

function currentTrackFrom(value: PlayerSnapshot) {
  return value.queue[value.currentIndex] ?? value.queue[0] ?? null;
}

function moveCurrentBy(step: number) {
  if (snapshot.queue.length === 0) return;
  const nextIndex =
    (snapshot.currentIndex + step + snapshot.queue.length) % snapshot.queue.length;
  const track = snapshot.queue[nextIndex];
  emit({
    ...snapshot,
    currentIndex: nextIndex,
    positionMs: 0,
    requestedQuality: track ? qualityFromExpected(track.expectedQuality) : snapshot.requestedQuality,
  });
}

function moveTrackTo(trackId: string, targetIndex: number): Promise<void> {
  if (!Number.isInteger(targetIndex)) return Promise.resolve();
  const sourceIndex = snapshot.queue.findIndex((track) => track.id === trackId);
  if (
    sourceIndex < 0 ||
    targetIndex < 0 ||
    targetIndex >= snapshot.queue.length ||
    sourceIndex === targetIndex
  ) return Promise.resolve();

  if (snapshot.nativeMode) {
    return runNative("queue", async (isCurrent) => {
      const queue = await nativeQueueMove(sourceIndex, targetIndex);
      await refreshNative(queue, undefined, isCurrent);
    });
  }

  const currentTrackId = currentTrackFrom(snapshot)?.id;
  const queue = [...snapshot.queue];
  const [track] = queue.splice(sourceIndex, 1);
  if (!track) return Promise.resolve();
  queue.splice(targetIndex, 0, track);
  const currentIndex = currentTrackId
    ? Math.max(0, queue.findIndex((item) => item.id === currentTrackId))
    : 0;
  emit({ ...snapshot, queue, currentIndex });
  return Promise.resolve();
}

export function usePlayerSnapshot() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePlayerSelector<T>(selector: (value: PlayerSnapshot) => T) {
  return useSyncExternalStore(
    subscribe,
    () => selector(snapshot),
    () => selector(snapshot),
  );
}

export function getCurrentTrack(value = snapshot) {
  return currentTrackFrom(value);
}

export const playerActions = {
  toggle() {
    if (snapshot.nativeMode) {
      if (nativeFailureKey !== null) {
        void retryCurrentNativeTrack();
        return;
      }
      if (snapshot.isPlaying) {
        runNative("transport", async (isCurrent) => {
          const player = await nativePause();
          applyControl(player, "transport", isCurrent);
        });
        return;
      }
      if (!snapshot.nativeLoaded) {
        runNative("source", async (isCurrent) => {
          if (snapshot.queue.length === 0) return;
          const playback = await nativeQueuePlay(snapshot.currentIndex);
          if (!playback) return;
          await refreshNative(playback.queue, playback.playback, isCurrent, playback.requestedQuality);
        });
        return;
      }
      runNative("transport", async (isCurrent) => {
        const player = await nativePlay();
        applyControl(player, "transport", isCurrent);
      });
      return;
    }
    emit({ ...snapshot, isPlaying: !snapshot.isPlaying });
  },
  reportPlaybackError(error: unknown, retry?: () => Promise<void>) {
    reportPlaybackError(error, retry);
  },
  retryPlayback() {
    if (nativeFailureKey !== null) {
      void retryCurrentNativeTrack();
      return;
    }
    if (!playbackRetry) return;
    const retry = playbackRetry;
    void retry();
  },
  clearPlaybackError,
  async setDefaultQuality(preferredQuality: PlaybackQuality) {
    if (!isPlaybackQuality(preferredQuality)) throw new Error("invalid quality");
    const confirmed = snapshot.nativeMode
      ? await nativeSetPreferredQuality(preferredQuality)
      : { preferredQuality };
    emit({ ...snapshot, defaultQuality: confirmed.preferredQuality });
  },
  async hydrateDefaultQuality() {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    const settings = await nativeSettingsSnapshot();
    emit({ ...snapshot, defaultQuality: settings.preferredQuality });
  },
  changeQuality(preferredQuality: PlaybackQuality) {
    if (!isPlaybackQuality(preferredQuality)) return Promise.resolve(false);
    const track = currentTrackFrom(snapshot);
    if (!track) return Promise.resolve(false);
    if (localMusicFormatFromId(track.id)) return Promise.resolve(false);
    if (snapshot.nativeMode) {
      const invoke = async (): Promise<boolean> => {
        const version = ++operationVersions.quality;
        const identity = playbackSessionIdentity();
        const isCurrent = () => operationVersions.quality === version && identity === playbackSessionIdentity();
        try {
          const playback = await nativePlaybackChangeQuality(preferredQuality);
          if (!playback || !isCurrent()) return false;
          await refreshNative(
            playback.queue,
            playback.playback,
            isCurrent,
            playback.requestedQuality,
          );
          if (isCurrent()) clearPlaybackError();
          return isCurrent();
        } catch (error) {
          if (isCurrent()) {
            reportPlaybackError(error, async () => {
              await invoke();
            });
          }
          return false;
        }
      };
      return invoke();
    }
    const queue = snapshot.queue.map((item, index) =>
      index === snapshot.currentIndex
        ? { ...item, expectedQuality: expectedQuality(preferredQuality) }
        : item,
    );
    emit({ ...snapshot, queue, requestedQuality: preferredQuality });
    return Promise.resolve(true);
  },
  next() {
    if (snapshot.nativeMode) {
      runNative("source", async (isCurrent) => {
        const playback = await nativeQueueNext();
        if (playback) await refreshNative(playback.queue, playback.playback, isCurrent, playback.requestedQuality);
      });
      return;
    }
    moveCurrentBy(1);
  },
  previous() {
    if (snapshot.nativeMode) {
      runNative(snapshot.positionMs > 5_000 ? "seek" : "source", async (isCurrent) => {
        if (snapshot.positionMs > 5_000) {
          const player = await nativeSeek(0);
          applyControl(player, "seek", isCurrent);
          return;
        }
        const playback = await nativeQueuePrevious();
        if (playback) await refreshNative(playback.queue, playback.playback, isCurrent, playback.requestedQuality);
      });
      return;
    }
    if (snapshot.positionMs > 5_000) {
      emit({ ...snapshot, positionMs: 0 });
      return;
    }
    moveCurrentBy(-1);
  },
  seek(positionMs: number) {
    const track = currentTrackFrom(snapshot);
    if (!track) return;
    const nextPosition = Math.max(0, Math.min(positionMs, track.durationMs));
    if (snapshot.nativeMode) {
      runNative("seek", async (isCurrent) => {
        const player = await nativeSeek(nextPosition);
        applyControl(player, "seek", isCurrent);
      });
      return;
    }
    emit({ ...snapshot, positionMs: nextPosition });
  },
  seekBy(deltaMs: number) {
    const track = currentTrackFrom(snapshot);
    if (!track) return;
    const nextPosition = Math.max(0, Math.min(snapshot.positionMs + deltaMs, track.durationMs));
    if (snapshot.nativeMode) {
      runNative("seek", async (isCurrent) => {
        const player = await nativeSeek(nextPosition);
        applyControl(player, "seek", isCurrent);
      });
      return;
    }
    emit({ ...snapshot, positionMs: nextPosition });
  },
  setVolume(volume: number) {
    if (snapshot.nativeMode) {
      runNative("volume", async (isCurrent) => {
        if (snapshot.muted) await nativeSetMuted(false);
        const player = await nativeSetVolume(Math.max(0, Math.min(volume, 1)));
        applyControl(player, "volume", isCurrent);
      });
      return;
    }
    emit({ ...snapshot, volume: Math.max(0, Math.min(volume, 1)), muted: false });
  },
  toggleMute() {
    if (snapshot.nativeMode) {
      runNative("volume", async (isCurrent) => {
        const player = await nativeSetMuted(!snapshot.muted);
        applyControl(player, "volume", isCurrent);
      });
      return;
    }
    emit({ ...snapshot, muted: !snapshot.muted });
  },
  cycleMode() {
    const modes: readonly PlaybackMode[] = [
      "sequence",
      "repeat-all",
      "repeat-one",
      "shuffle",
    ];
    const modeIndex = modes.indexOf(snapshot.mode);
    const mode = modes[(modeIndex + 1) % modes.length] ?? "sequence";
    if (snapshot.nativeMode) {
      runNative("mode", async (isCurrent) => {
        const session = await nativeSetPlaybackMode(mode);
        if (isCurrent()) applyNative(session.queue, session.player, undefined, session.mode, session.requestedQuality);
      });
      return;
    }
    emit({ ...snapshot, mode });
  },
  async playTrack(trackId: string): Promise<boolean> {
    if (snapshot.nativeMode) {
      const index = snapshot.queue.findIndex((track) => track.id === trackId);
      if (index < 0) return false;
      let started = false;
      await runNative("source", async (isCurrent) => {
        const playback = await nativeQueuePlay(index);
        if (!playback) return;
        await refreshNative(playback.queue, playback.playback, isCurrent, playback.requestedQuality);
        started = isCurrent();
      });
      return started;
    }
    let queue = snapshot.queue;
    let index = queue.findIndex((track) => track.id === trackId);

    if (index < 0) {
      const track = FIXTURE_TRACKS.find((item) => item.id === trackId);
      if (!track) return false;
      queue = [...queue, track];
      index = queue.length - 1;
    }

    emit({
      ...snapshot,
      queue,
      currentIndex: index,
      positionMs: 0,
      isPlaying: true,
      requestedQuality: qualityFromExpected(queue[index]!.expectedQuality),
    });
    return true;
  },
  toggleLike(trackId: string) {
    const liked = new Set(snapshot.likedIds);
    const nextLiked = liked.has(trackId) ? [...liked].filter((id) => id !== trackId) : [...liked, trackId];
    if (!snapshot.nativeMode) {
      emit({ ...snapshot, likedIds: nextLiked });
      return;
    }

    const track = currentTrackFrom(snapshot);
    if (!track || track.id !== trackId) return;
    const version = ++operationVersions.like;
    const previousLikedIds = snapshot.likedIds;
    emit({ ...snapshot, likedIds: nextLiked });
    void setSongsLiked([trackId], !liked.has(trackId)).catch(() => {
      if (operationVersions.like !== version || currentTrackFrom(snapshot)?.id !== trackId) return;
      emit({ ...snapshot, likedIds: previousLikedIds });
    });
  },
  removeTrack(trackId: string) {
    if (snapshot.nativeMode) {
      const index = snapshot.queue.findIndex((track) => track.id === trackId);
      if (index < 0) return;
      runNative("source", async (isCurrent) => {
        const removingCurrent = snapshot.nativeLoaded && index === snapshot.currentIndex;
        if (removingCurrent) await nativeStop();
        const queue = await nativeQueueRemove(index);
        if (removingCurrent && queue.selectedIndex !== null) {
          const playback = await nativeQueuePlay(queue.selectedIndex);
          if (!playback) return;
          await refreshNative(playback.queue, playback.playback, isCurrent, playback.requestedQuality);
          return;
        }
        await refreshNative(queue, undefined, isCurrent);
      });
      return;
    }
    if (snapshot.queue.length <= 1) return;
    const currentTrackId = currentTrackFrom(snapshot)?.id;
    const queue = snapshot.queue.filter((track) => track.id !== trackId);
    const currentIndex = currentTrackId === trackId
      ? Math.min(snapshot.currentIndex, queue.length - 1)
      : Math.max(0, queue.findIndex((track) => track.id === currentTrackId));
    emit({ ...snapshot, queue, currentIndex, positionMs: currentTrackId === trackId ? 0 : snapshot.positionMs });
  },
  clearQueue() {
    if (snapshot.queue.length === 0) return;
    if (snapshot.nativeMode) {
      const shouldStop = snapshot.nativeLoaded || snapshot.isPlaying;
      runNative("source", async (isCurrent) => {
        if (shouldStop) await nativeStop();
        try {
          const queue = await nativeQueueReplace([]);
          await refreshNative(queue, undefined, isCurrent);
        } catch (error) {
          if (shouldStop && isCurrent()) {
            await refreshNative(undefined, undefined, isCurrent).catch(() => undefined);
          }
          throw error;
        }
      });
      return;
    }
    emit({
      ...snapshot,
      queue: [],
      currentIndex: 0,
      isPlaying: false,
      positionMs: 0,
    });
  },
  moveTrackTo(trackId: string, targetIndex: number) {
    return moveTrackTo(trackId, targetIndex);
  },
  moveTrack(trackId: string, direction: -1 | 1) {
    const index = snapshot.queue.findIndex((track) => track.id === trackId);
    void moveTrackTo(trackId, index + direction);
  },
  async hydrateNative(
    queue?: QueueSnapshot,
    player?: NativePlayerSnapshot,
    quality?: PlaybackLoadResult["quality"],
  ) {
    const identity = playbackSessionIdentity();
    const [nextQueue, nextPlayer] = await Promise.all([
      queue ? Promise.resolve(queue) : nativeQueueSnapshot(),
      player ? Promise.resolve(player) : nativePlayerSnapshot(),
    ]);
    if (identity !== playbackSessionIdentity()) return;
    applyNative(nextQueue, nextPlayer, quality);
    clearPlaybackError();
  },
  async hydrateNativeSession(session?: PlaybackSessionSnapshot) {
    const identity = playbackSessionIdentity();
    const nextSession = session ?? await nativePlaybackSessionSnapshot(lastNativeQueue);
    if (identity !== playbackSessionIdentity()) return;
    applyNative(nextSession.queue, nextSession.player, nextSession.actualQuality ?? undefined, nextSession.mode, nextSession.requestedQuality, nextSession.lyricOffsetMs ?? 0);
  },
  applyAuthoritativeSession(session: PlaybackSessionSnapshot) {
    applyNative(session.queue, session.player, session.actualQuality ?? undefined, session.mode, session.requestedQuality, session.lyricOffsetMs ?? 0);
    clearPlaybackError();
  },
  applyTimedLyrics(trackId: string, generation: number, lyrics: readonly TimedLyricLine[]) {
    if (!snapshot.nativeMode || snapshot.generation !== generation) return;
    const normalizedLyrics = lyrics.map((line) => ({
      atMs: line.atMs,
      original: line.original,
      ...(line.translation ? { translation: line.translation } : {}),
      ...(line.romanization ? { romanized: line.romanization } : {}),
    }));
    const queue = snapshot.queue.map((track) =>
      track.id === trackId ? { ...track, lyrics: normalizedLyrics } : track,
    );
    emit({ ...snapshot, queue, lyricsReady: true });
  },
  async setMvLyricOffset(offsetMs: number) {
    const track = currentTrackFrom(snapshot);
    if (!track || track.actualQuality !== "QQ MV 音轨" || !snapshot.nativeMode) return;
    const identity = playbackSessionIdentity();
    const generation = snapshot.generation;
    const session = await nativeSetMvLyricOffset(track.id, generation, offsetMs);
    if (identity === playbackSessionIdentity() && snapshot.generation === generation && currentTrackFrom(snapshot)?.id === track.id) {
      playerActions.applyAuthoritativeSession(session);
    }
  },
};

export function resetPlayerFixture() {
  nativeSessionIdentity = playbackSessionIdentity();
  lastNativeQueue = undefined;
  playbackRetry = null;
  for (const domain of Object.keys(operationVersions) as OperationDomain[]) {
    operationVersions[domain] = 0;
  }
  nativeFailureKey = null;
  emit(initialSnapshot);
}
