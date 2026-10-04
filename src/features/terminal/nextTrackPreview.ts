import type { Track } from "../player/fixtures";
import type { PlaybackMode } from "../player/playerStore";

export type TerminalUpNextStatus = "ready" | "repeat-current" | "shuffle-pending" | "end-of-queue";

export interface TerminalUpNextItem {
  readonly queueNumber: string;
  readonly trackId: string;
  readonly title: string;
  readonly artist: string;
  readonly isFirst: boolean;
}

export interface TerminalUpNext {
  readonly status: TerminalUpNextStatus;
  readonly items: readonly TerminalUpNextItem[];
}

function endOfQueue(): TerminalUpNext {
  return { status: "end-of-queue", items: [] };
}

function itemFor(track: Track, queueIndex: number, isFirst: boolean): TerminalUpNextItem {
  return {
    queueNumber: String(queueIndex + 1).padStart(2, "0"),
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    isFirst,
  };
}

function normalizedLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
}

export function deriveTerminalUpNext(
  currentTrack: Track | null | undefined,
  queue: readonly Track[],
  mode: PlaybackMode,
  limit: number,
): TerminalUpNext {
  if (!currentTrack || queue.length === 0) return endOfQueue();

  const currentIndex = queue.findIndex((track) => track.id === currentTrack.id);
  if (currentIndex < 0) return endOfQueue();

  const count = normalizedLimit(limit);
  if (count === 0) {
    const status = mode === "shuffle" ? "shuffle-pending" : mode === "repeat-one" ? "repeat-current" : "ready";
    return { status, items: [] };
  }

  if (mode === "shuffle") return { status: "shuffle-pending", items: [] };

  if (mode === "repeat-one") {
    const queueTrack = queue[currentIndex];
    if (!queueTrack) return endOfQueue();
    return {
      status: "repeat-current",
      items: [itemFor(queueTrack, currentIndex, true)],
    };
  }

  const itemCount = mode === "repeat-all"
    ? Math.min(count, queue.length)
    : Math.min(count, queue.length - currentIndex - 1);
  const items = Array.from({ length: itemCount }, (_, offset) => {
    const queueIndex = mode === "repeat-all"
      ? (currentIndex + offset + 1) % queue.length
      : currentIndex + offset + 1;
    const track = queue[queueIndex];
    return track ? itemFor(track, queueIndex, offset === 0) : undefined;
  }).filter((item): item is TerminalUpNextItem => item !== undefined);

  return items.length > 0 ? { status: "ready", items } : endOfQueue();
}

export interface TerminalNextPreview {
  readonly label: string;
  readonly detail: string;
}

function trackDetail(item: TerminalUpNextItem): string {
  return `${item.title} · ${item.artist}`;
}

/** Compatibility projection for the existing single-line Terminal caller. */
export function deriveTerminalNextPreview(
  currentTrack: Track | null,
  queue: readonly Track[],
  mode: PlaybackMode,
): TerminalNextPreview {
  const upNext = deriveTerminalUpNext(currentTrack, queue, mode, 1);

  if (upNext.status === "shuffle-pending") return { label: "NEXT //", detail: "SHUFFLE PENDING" };
  if (upNext.status === "repeat-current") {
    const item = upNext.items[0];
    return item
      ? { label: "REPEAT CURRENT //", detail: trackDetail(item) }
      : { label: "NEXT //", detail: "END OF QUEUE" };
  }

  const item = upNext.items[0];
  return item
    ? { label: `NEXT // ${item.queueNumber}`, detail: trackDetail(item) }
    : { label: "NEXT //", detail: "END OF QUEUE" };
}
