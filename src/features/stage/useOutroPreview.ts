import { useEffect, useState, useSyncExternalStore } from "react";
import { playbackConnectionRevision, subscribePlaybackConnection } from "../../backend/playbackTransport";
import { nativeQueuePreviewNext } from "../../backend/nativeQueueAdapter";
import { deriveTerminalUpNext } from "../terminal/nextTrackPreview";
import { getCurrentTrack, usePlayerSelector, type PlayerSnapshot } from "../player/playerStore";

const selectEpoch = (s: PlayerSnapshot) => `${s.generation}:${getCurrentTrack(s)?.id ?? ""}`;
const selectPlaying = (s: PlayerSnapshot) => s.isPlaying;
const selectMode = (s: PlayerSnapshot) => s.mode;
const selectQueue = (s: PlayerSnapshot) => s.queue;
const selectNative = (s: PlayerSnapshot) => s.nativeMode;
export function isOutroPosition(s: PlayerSnapshot): boolean {
  const track = getCurrentTrack(s);
  const last = track?.lyrics.filter((line) => line.original.trim()).at(-1);
  if (!track || track.durationMs <= 0 || s.positionMs >= track.durationMs || s.playbackError) return false;
  // Wait for the current lyric request before treating an empty timeline as instrumental.
  if (!last && s.nativeMode && s.lyricsReady === false) return false;
  const triggerMs = last ? last.atMs + 3000 : Math.max(0, track.durationMs - 3000);
  return s.positionMs >= triggerMs;
}

export function useOutroPreview() {
  const connectionRevision = useSyncExternalStore(subscribePlaybackConnection, playbackConnectionRevision, playbackConnectionRevision);
  const epoch = usePlayerSelector(selectEpoch);
  const eligible = usePlayerSelector(isOutroPosition);
  const playing = usePlayerSelector(selectPlaying);
  const mode = usePlayerSelector(selectMode);
  const queue = usePlayerSelector(selectQueue);
  // Metadata refreshes may rebuild Track objects without changing playback order.
  const queueKey = JSON.stringify(queue.map((track) => track.id));
  const native = usePlayerSelector(selectNative);
  const current = usePlayerSelector(getCurrentTrack);
  const [dismissedEpoch, setDismissedEpoch] = useState<string | null>(null);
  const [startedEpoch, setStartedEpoch] = useState<string | null>(null);
  const [nativePreview, setNativePreview] = useState<{ epoch: string; queueKey: string; mode: typeof mode; id: string | null } | null>(null);
  useEffect(() => {
    if (!eligible || !native) return;
    let active = true;
    void nativeQueuePreviewNext().then((id) => {
      if (active) setNativePreview({ epoch, queueKey, mode, id });
    }, () => { if (active) setNativePreview({ epoch, queueKey, mode, id: null }); });
    return () => { active = false; };
  }, [eligible, native, epoch, queueKey, mode, connectionRevision]);
  const fixtureNext = deriveTerminalUpNext(current, queue, mode, 1).items[0]?.trackId ?? null;
  const nextId = native
    ? nativePreview?.epoch === epoch && nativePreview.queueKey === queueKey && nativePreview.mode === mode ? nativePreview.id : null
    : fixtureNext;
  useEffect(() => {
    if (eligible && playing && nextId && dismissedEpoch !== epoch) setStartedEpoch(epoch);
  }, [eligible, playing, nextId, epoch, dismissedEpoch]);
  return {
    active: eligible && startedEpoch === epoch && dismissedEpoch !== epoch && nextId !== null,
    nextId,
    label: mode === "repeat-one" ? "即将重播" : "即将播放",
    dismiss: () => setDismissedEpoch(epoch),
  };
}
