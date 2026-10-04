import { useEffect, useSyncExternalStore } from "react";
import { hasPlaybackTransport, playbackConnectionRevision, subscribePlaybackConnection } from "../../backend/playbackTransport";

import { getTimedLyrics } from "../../backend/lyricsAdapter";
import { localMusicFormatFromId } from "../../contracts/localMusic";
import type { LyricTimeline } from "../../contracts/lyrics";
import {
  getCurrentTrack,
  playerActions,
  usePlayerSelector,
  type PlayerSnapshot,
} from "./playerStore";

const POLL_INTERVAL_MS = 500;
let refreshRequest: Promise<void> | null = null;
const lyricRequests = new Map<string, Promise<LyricTimeline>>();

const selectNativeMode = (snapshot: PlayerSnapshot) => snapshot.nativeMode;
const selectNativeLoaded = (snapshot: PlayerSnapshot) => snapshot.nativeLoaded;
const selectGeneration = (snapshot: PlayerSnapshot) => snapshot.generation;

function isTauriRuntime() {
  return hasPlaybackTransport();
}

function refreshNativeSnapshot() {
  if (!refreshRequest) {
    refreshRequest = playerActions.hydrateNativeSession().finally(() => {
      refreshRequest = null;
    });
  }
  return refreshRequest;
}

function readLyrics(trackId: string, generation: number, offset: number) {
  const key = `${trackId}:${generation}:${offset}`;
  const existing = lyricRequests.get(key);
  if (existing) return existing;
  lyricRequests.clear();
  const request = getTimedLyrics(trackId, generation).finally(() => {
    lyricRequests.delete(key);
  });
  lyricRequests.set(key, request);
  return request;
}

export function NativePlayerBridge() {
  const connectionRevision = useSyncExternalStore(subscribePlaybackConnection, playbackConnectionRevision, playbackConnectionRevision);
  const nativeMode = usePlayerSelector(selectNativeMode);
  const nativeLoaded = usePlayerSelector(selectNativeLoaded);
  const generation = usePlayerSelector(selectGeneration);
  const lyricOffset = usePlayerSelector(s => s.lyricOffsetMs ?? 0);
  const trackId = usePlayerSelector((snapshot) => getCurrentTrack(snapshot)?.id ?? null);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let timer: number | null = null;
    const stopPolling = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const startPolling = () => {
      stopPolling();
      if (document.visibilityState !== "visible") return;
      void refreshNativeSnapshot().catch(() => undefined);
      timer = window.setInterval(() => {
        void refreshNativeSnapshot().catch(() => undefined);
      }, POLL_INTERVAL_MS);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") startPolling();
      else stopPolling();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    startPolling();
    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!nativeMode || !nativeLoaded || !trackId) return;
    if (localMusicFormatFromId(trackId)) {
      lyricRequests.clear();
      playerActions.applyTimedLyrics(trackId, generation, []);
      return;
    }
    let active = true;
    void readLyrics(trackId, generation, lyricOffset).then(
      (timeline) => {
        if (active) {
          playerActions.applyTimedLyrics(timeline.trackId, timeline.generation, timeline.lines);
        }
      },
      () => { if (active) playerActions.applyTimedLyrics(trackId, generation, []); },
    );
    return () => {
      active = false;
    };
  }, [generation, nativeLoaded, nativeMode, trackId, connectionRevision, lyricOffset]);

  return null;
}
