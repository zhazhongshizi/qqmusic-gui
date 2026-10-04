import { afterEach, expect, it, vi } from "vitest";
import { getPlaybackHistory } from "./historyAdapter";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
afterEach(() => vi.clearAllMocks());
const old = { id: "song", title: "歌名", artist: "歌手", playedAtUnixMs: 1000 };
it("reads legacy rows and validates the preserved playback metadata", async () => {
  mocks.invoke.mockResolvedValue([old, { ...old, id: "new", album: "专辑", durationMs: 120000, coverCacheKey: "cover_1", mediaMid: "media_1" }]);
  const rows = await getPlaybackHistory();
  expect(rows[0]).toEqual({ ...old, album: "", durationMs: 0 });
  expect(rows[1]).toMatchObject({ album: "专辑", durationMs: 120000, coverCacheKey: "cover_1", mediaMid: "media_1" });
});
it.each([{ coverCacheKey: "../cover" }, { mediaMid: "https://url" }, { durationMs: -1 }, { playedAtUnixMs: NaN }])("rejects invalid history metadata %j", async fields => {
  mocks.invoke.mockResolvedValue([{ ...old, ...fields }]);
  await expect(getPlaybackHistory()).rejects.toThrow("本地历史读取失败");
});
