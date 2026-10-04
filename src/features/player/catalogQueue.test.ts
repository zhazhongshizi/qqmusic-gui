import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogSong } from "../../contracts/catalog";
import {
  CatalogQueuePlaybackError,
  enqueueCatalogTrack,
  enqueueAndPlayCatalogTrack,
  MAX_CATALOG_QUEUE_ITEMS,
  queueTrackFromCatalog,
  replaceAndPlayCatalogTracks,
} from "./catalogQueue";

const {
  enqueueMock,
  nextMock,
  replaceMock,
  setModeMock,
  hydrateMock,
  hydrateSessionMock,
  playTrackMock,
} = vi.hoisted(() => ({
  enqueueMock: vi.fn(),
  nextMock: vi.fn(),
  replaceMock: vi.fn(),
  setModeMock: vi.fn(),
  hydrateMock: vi.fn(),
  hydrateSessionMock: vi.fn(),
  playTrackMock: vi.fn(),
}));

vi.mock("../../backend/nativeQueueAdapter", () => ({
  nativeQueueEnqueue: enqueueMock,
  nativeQueueNext: nextMock,
  nativeQueueReplace: replaceMock,
  nativeSetPlaybackMode: setModeMock,
}));

vi.mock("./playerStore", () => ({
  playerActions: {
    hydrateNative: hydrateMock,
    hydrateNativeSession: hydrateSessionMock,
    playTrack: playTrackMock,
  },
}));

const SONG: CatalogSong = {
  id: "song-mid-1",
  mediaMid: "media-mid-1",
  coverCacheKey: "album-mid-1",
  title: "纸月光",
  subtitle: "",
  artists: [{ id: "artist-mid-1", name: "林间电台" }],
  artist: "林间电台",
  album: "温室唱片",
  durationMs: 234_000,
  qualityCandidates: [
    { quality: "flac", available: false, requiresSubscription: true },
    { quality: "320k", available: true, requiresSubscription: true },
    { quality: "128k", available: true, requiresSubscription: false },
  ],
  availability: { status: "unknown", requiresSubscription: true },
};

function queue(items = [queueTrackFromCatalog(SONG)]) {
  return { generation: 1, selectedIndex: items.length > 0 ? 0 : null, items };
}

function player(track = SONG) {
  return {
    state: "playing" as const,
    generation: 2,
    currentTrack: { id: track.id, title: track.title, artist: track.artist },
    durationMs: track.durationMs,
    positionMs: 0,
    volume: 0.7,
    muted: false,
    failure: null,
  };
}

beforeEach(() => {
  enqueueMock.mockReset().mockResolvedValue(queue());
  replaceMock.mockReset().mockImplementation(async (items) => queue(items));
  nextMock.mockReset();
  setModeMock.mockReset();
  hydrateMock.mockReset().mockResolvedValue(undefined);
  hydrateSessionMock.mockReset().mockResolvedValue(undefined);
  playTrackMock.mockReset();
});

describe("catalog queue helper", () => {
  it("does not finish before play confirmation and reports a failed start after replacement", async () => {
    let resolve!: (value: boolean) => void;
    playTrackMock.mockImplementation(() => new Promise<boolean>(done => { resolve = done; }));
    const pending = replaceAndPlayCatalogTracks([SONG], "preserve");
    const rejected = expect(pending).rejects.toEqual(new CatalogQueuePlaybackError(true));
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    resolve(false);
    await rejected;
  });
  it("converts, enqueues, hydrates and plays one normalized catalog song", async () => {
    await enqueueAndPlayCatalogTrack(SONG);

    expect(enqueueMock).toHaveBeenCalledWith(queueTrackFromCatalog(SONG));
    expect(hydrateMock).toHaveBeenCalledWith(queue());
    expect(playTrackMock).toHaveBeenCalledWith(SONG.id);
  });

  it("can enqueue and hydrate without starting playback", async () => {
    await expect(enqueueCatalogTrack(SONG)).resolves.toEqual(queue());
    expect(hydrateMock).toHaveBeenCalledWith(queue());
    expect(playTrackMock).not.toHaveBeenCalled();
  });

  it("replaces the queue and starts the first song without changing mode", async () => {
    const second = { ...SONG, id: "song-mid-2", title: "第二首" };
    await expect(replaceAndPlayCatalogTracks([SONG, second], "preserve")).resolves.toEqual({
      loadedCount: 2,
      truncated: false,
    });

    expect(replaceMock).toHaveBeenCalledWith([
      queueTrackFromCatalog(SONG),
      queueTrackFromCatalog(second),
    ]);
    expect(setModeMock).not.toHaveBeenCalled();
    expect(playTrackMock).toHaveBeenCalledWith(SONG.id);
  });

  it("uses the native shuffle mode and queue-next selection instead of page randomness", async () => {
    const second = { ...SONG, id: "song-mid-2", title: "第二首" };
    const replaced = queue([queueTrackFromCatalog(SONG), queueTrackFromCatalog(second)]);
    const session = { mode: "shuffle", queue: replaced, player: player() } as const;
    const next = {
      queue: { ...replaced, selectedIndex: 1 },
      playback: { quality: "320k", expiresInSeconds: 90, player: player(second) },
    } as const;
    replaceMock.mockResolvedValue(replaced);
    setModeMock.mockResolvedValue(session);
    nextMock.mockResolvedValue(next);

    await replaceAndPlayCatalogTracks([SONG, second], "shuffle");

    expect(setModeMock).toHaveBeenCalledWith("shuffle");
    expect(hydrateSessionMock).toHaveBeenCalledWith(session);
    expect(nextMock).toHaveBeenCalledTimes(1);
    expect(hydrateMock).toHaveBeenLastCalledWith(next.queue, next.playback.player, "320k");
    expect(playTrackMock).not.toHaveBeenCalled();
  });

  it("deduplicates and respects the existing 1000-item queue boundary", async () => {
    const many = Array.from({ length: MAX_CATALOG_QUEUE_ITEMS + 2 }, (_, index) => ({
      ...SONG,
      id: `song-${index}`,
    }));
    many.push(many[0]!);

    const result = await replaceAndPlayCatalogTracks(many, "preserve");

    expect(result).toEqual({ loadedCount: MAX_CATALOG_QUEUE_ITEMS, truncated: true });
    expect(replaceMock.mock.calls[0]?.[0]).toHaveLength(MAX_CATALOG_QUEUE_ITEMS);
  });

  it("reports whether a collection failure happened before or after queue replacement", async () => {
    replaceMock.mockRejectedValueOnce(new Error("replace failed"));
    await expect(replaceAndPlayCatalogTracks([SONG], "preserve")).rejects.toEqual(
      new CatalogQueuePlaybackError(false),
    );

    replaceMock.mockResolvedValueOnce(queue());
    hydrateMock.mockRejectedValueOnce(new Error("hydrate failed"));
    await expect(replaceAndPlayCatalogTracks([SONG], "preserve")).rejects.toEqual(
      new CatalogQueuePlaybackError(true),
    );
  });

  it("does not start playback if the page is left while replacement is pending", async () => {
    let current = true;
    let resolve!: (value: ReturnType<typeof queue>) => void;
    replaceMock.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const playback = replaceAndPlayCatalogTracks([SONG], "preserve", () => current);
    current = false;
    resolve(queue());
    await expect(playback).resolves.toBeNull();
    expect(hydrateMock).not.toHaveBeenCalled();
    expect(playTrackMock).not.toHaveBeenCalled();
  });
});
