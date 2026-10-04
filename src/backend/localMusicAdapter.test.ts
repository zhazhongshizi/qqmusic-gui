import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getLocalMusic,
  deleteLocalMusic,
  importLocalMusic,
  LOCAL_MUSIC_COMMANDS,
  LocalMusicAdapterError,
  parseLocalMusicImportResult,
  parseLocalMusicDeleteResult,
  parseLocalMusicListResult,
  parseLocalMusicTrack,
} from "./localMusicAdapter";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TRACK = {
  id: `local_${HASH}_flac`,
  title: "纸月光",
  artist: "林间电台",
  album: "温室唱片",
  durationMs: 234_000,
  format: "flac",
} as const;
const QUEUE_TRACK = {
  id: TRACK.id,
  title: TRACK.title,
  artist: TRACK.artist,
  album: TRACK.album,
  durationMs: TRACK.durationMs,
} as const;
const SESSION = {
  mode: "sequence",
  requestedQuality: "320k",
  queue: { generation: 2, selectedIndex: 0, items: [QUEUE_TRACK] },
  player: {
    state: "playing",
    generation: 3,
    positionMs: 1_000,
    durationMs: TRACK.durationMs,
    volume: 0.7,
    muted: false,
    currentTrack: { id: TRACK.id, title: TRACK.title, artist: TRACK.artist },
    failure: null,
  },
} as const;

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  invokeMock.mockReset();
});

describe("local music adapter", () => {
  it("strictly parses a local track and binds the ID suffix to its format", () => {
    expect(parseLocalMusicTrack(TRACK)).toEqual(TRACK);
    expect(() => parseLocalMusicTrack({ ...TRACK, id: `local_${HASH}_ogg` })).toThrow(LocalMusicAdapterError);
    expect(() => parseLocalMusicTrack({ ...TRACK, id: `local_${HASH.toUpperCase()}_flac` })).toThrow();
    expect(() => parseLocalMusicTrack({ ...TRACK, id: `local_${HASH}_flac`, path: "C:\\secret.mp3" })).toThrow();
    expect(() => parseLocalMusicTrack({ ...TRACK, id: `local_${HASH}_wav` })).toThrow();
    expect(() => parseLocalMusicTrack({ ...TRACK, durationMs: -1 })).toThrow();
    expect(() => parseLocalMusicTrack({ ...TRACK, durationMs: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("parses list/import summaries without accepting paths, URLs, or unknown fields", () => {
    expect(parseLocalMusicListResult({ tracks: [TRACK], warningCount: 1 })).toEqual({
      tracks: [TRACK],
      warningCount: 1,
    });
    expect(parseLocalMusicImportResult({
      imported: [TRACK],
      existingCount: 2,
      failures: [{ fileName: "broken.mp3", code: "local_music_invalid_file" }],
    }).existingCount).toBe(2);
    expect(() => parseLocalMusicListResult({ tracks: [TRACK], warningCount: 0, path: "C:\\secret" })).toThrow();
    expect(() => parseLocalMusicImportResult({
      imported: [],
      existingCount: 0,
      failures: [{ fileName: "https://example.test/file.mp3", code: "local_music_invalid_file" }],
    })).toThrow();
    expect(() => parseLocalMusicImportResult({ imported: [], existingCount: 0, failures: [{
      fileName: "file.mp3",
      code: "unknown_error",
    }] })).toThrow();
  });

  it("uses fixed Tauri commands with no renderer path payload", async () => {
    invokeMock
      .mockResolvedValueOnce({ tracks: [TRACK], warningCount: 0 })
      .mockResolvedValueOnce({ imported: [TRACK], existingCount: 0, failures: [] });
    await expect(getLocalMusic()).resolves.toEqual({ tracks: [TRACK], warningCount: 0 });
    await expect(importLocalMusic()).resolves.toEqual({ imported: [TRACK], existingCount: 0, failures: [] });
    expect(invokeMock.mock.calls).toEqual([
      [LOCAL_MUSIC_COMMANDS.list, undefined],
      [LOCAL_MUSIC_COMMANDS.import, undefined],
    ]);
  });

  it("strictly maps public storage errors to stable adapter codes", async () => {
    invokeMock.mockRejectedValue({ code: "local_music_storage_unavailable", path: "C:\\secret" });
    await expect(importLocalMusic()).rejects.toEqual(new LocalMusicAdapterError("QMG-LOCAL-MUSIC-001"));
    invokeMock.mockRejectedValue({
      code: "local_music_storage_unavailable",
      retryable: true,
      operation: "local_music",
      correlationId: "123e4567-e89b-12d3-a456-426614174000",
      userMessage: "软件所在目录不可写，无法导入本地音乐。",
    });
    await expect(importLocalMusic()).rejects.toEqual(new LocalMusicAdapterError("QMG-LOCAL-MUSIC-STORAGE"));
  });

  it("strictly parses delete results and binds deletedId to the requested local ID", () => {
    const result = { deletedId: TRACK.id, session: SESSION, autoPlayStarted: false } as const;
    expect(parseLocalMusicDeleteResult(result, TRACK.id)).toEqual(result);
    expect(() => parseLocalMusicDeleteResult({ ...result, path: "C:\\secret" }, TRACK.id)).toThrow();
    expect(() => parseLocalMusicDeleteResult({ ...result, deletedId: `local_${HASH}_ogg` }, TRACK.id)).toThrow();
    expect(() => parseLocalMusicDeleteResult({ ...result, autoPlayStarted: "false" }, TRACK.id)).toThrow();
  });

  it("deletes by fixed command and sends only the validated local ID", async () => {
    invokeMock.mockResolvedValue({ deletedId: TRACK.id, session: SESSION, autoPlayStarted: true });
    await expect(deleteLocalMusic(TRACK.id)).resolves.toEqual({
      deletedId: TRACK.id,
      session: SESSION,
      autoPlayStarted: true,
    });
    expect(invokeMock).toHaveBeenCalledWith(LOCAL_MUSIC_COMMANDS.delete, { trackId: TRACK.id });
    await expect(deleteLocalMusic("C:\\secret.mp3")).rejects.toEqual(new LocalMusicAdapterError("QMG-LOCAL-MUSIC-002"));
  });
});
