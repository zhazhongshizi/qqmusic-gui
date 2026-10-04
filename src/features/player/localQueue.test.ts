import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalMusicTrack } from "../../contracts/localMusic";
import {
  enqueueAndPlayLocalTrack,
  enqueueLocalTrack,
  queueTrackFromLocal,
} from "./localQueue";

const { enqueueMock, hydrateMock, playTrackMock } = vi.hoisted(() => ({
  enqueueMock: vi.fn(),
  hydrateMock: vi.fn(),
  playTrackMock: vi.fn(),
}));

vi.mock("../../backend/nativeQueueAdapter", () => ({ nativeQueueEnqueue: enqueueMock }));
vi.mock("./playerStore", () => ({
  playerActions: {
    hydrateNative: hydrateMock,
    playTrack: playTrackMock,
  },
}));

const TRACK: LocalMusicTrack = {
  id: "local_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_mp3",
  title: "本地夜航",
  artist: "本地艺术家",
  album: "本地专辑",
  durationMs: 180_000,
  format: "mp3",
};

function queue(items = [queueTrackFromLocal(TRACK)]) {
  return { generation: 4, selectedIndex: items.length > 0 ? 0 : null, items };
}

beforeEach(() => {
  enqueueMock.mockReset().mockResolvedValue(queue());
  hydrateMock.mockReset().mockResolvedValue(undefined);
  playTrackMock.mockReset();
});

describe("local queue helper", () => {
  it("maps local metadata without mediaMid, coverCacheKey, or a filesystem path", () => {
    expect(queueTrackFromLocal(TRACK)).toEqual({
      id: TRACK.id,
      title: TRACK.title,
      artist: TRACK.artist,
      album: TRACK.album,
      durationMs: TRACK.durationMs,
    });
  });

  it("enqueues and hydrates a local track without starting playback", async () => {
    await expect(enqueueLocalTrack(TRACK)).resolves.toEqual(queue());
    expect(enqueueMock).toHaveBeenCalledWith(queueTrackFromLocal(TRACK));
    expect(hydrateMock).toHaveBeenCalledWith(queue());
    expect(playTrackMock).not.toHaveBeenCalled();
  });

  it("enqueues, hydrates, and then asks the existing player actions to play", async () => {
    await enqueueAndPlayLocalTrack(TRACK);
    expect(hydrateMock).toHaveBeenCalledWith(queue());
    expect(playTrackMock).toHaveBeenCalledWith(TRACK.id);
  });

  it("rejects a native queue response that omitted the local item", async () => {
    enqueueMock.mockResolvedValueOnce({ generation: 4, selectedIndex: null, items: [] });
    await expect(enqueueLocalTrack(TRACK)).rejects.toThrow("local_music_queue_item_missing");
    expect(hydrateMock).not.toHaveBeenCalled();
  });
});
