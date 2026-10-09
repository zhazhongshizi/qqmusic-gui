import { expect, it } from "vitest";
import { parseCatalogStatus } from "./localCatalogAdapter";
import { parseLocalMusicListResult, parseLocalMusicTrack } from "./localMusicAdapter";
const track = { id: `local_${"a".repeat(64)}_flac`, title: "本地", artist: "歌手", album: "", durationMs: 1000, format: "flac" };
it("accepts reference state and ID-bound artwork but rejects paths in track metadata", () => {
  expect(parseLocalMusicTrack({ ...track, referenced: true, available: false, coverCacheKey: track.id }).available).toBe(false);
  expect(() => parseLocalMusicTrack({ ...track, path: "D:\\音乐" })).toThrow();
  expect(() => parseLocalMusicTrack({ ...track, available: "false" })).toThrow();
  expect(() => parseLocalMusicTrack({ ...track, coverCacheKey: "C:\\cover.png" })).toThrow();
});
it("reads a library larger than the playback queue limit without dropping songs", () => {
  const tracks = Array.from({ length: 1200 }, (_, i) => ({ ...track, id: `local_${i.toString(16).padStart(64, "0")}_flac` }));
  expect(parseLocalMusicListResult({ tracks, warningCount: 0 }).tracks).toHaveLength(1200);
});
it("validates desktop directory metadata and scan counters", () => {
  const status = { directories: [{ id: "one", path: "D:\\音乐", mode: "reference", available: false, trackCount: 4, missingCount: 4, lastScanMs: null }], scan: { running: false, cancelled: true, directoryId: "one", processed: 1, added: 0, existing: 0, errors: 1, failures: [{ fileName: "损坏.flac", code: "local_music_metadata_unreadable" }] } };
  expect(parseCatalogStatus(status).directories[0]?.path).toBe("D:\\音乐");
  expect(() => parseCatalogStatus({ ...status, scan: { ...status.scan, processed: -1 } })).toThrow();
  expect(() => parseCatalogStatus({ ...status, directories: [{ ...status.directories[0], mode: "delete" }] })).toThrow();
});
