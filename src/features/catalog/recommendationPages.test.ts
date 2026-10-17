import { expect, it, vi } from "vitest";
import type { CatalogSong, CatalogSongPage } from "../../contracts/catalog";
import { recommendationPages } from "./recommendationPages";

const songs = (from: number, count: number): CatalogSong[] => Array.from({ length: count }, (_, i) => ({
  id: `song-${from + i}`, title: `曲目 ${from + i}`, subtitle: "", artist: "歌手", artists: [{ id: "artist", name: "歌手" }],
  album: "专辑", durationMs: 1000, qualityCandidates: [], availability: { status: "unknown", requiresSubscription: false },
}));
const batch = (generation: number, page: number, from: number, count: number, hasMore = false): CatalogSongPage =>
  ({ generation, page, items: songs(from, count), hasMore, warningCount: 0 });

it("splits a 20-item upstream batch into 9, 9 and 2, retaining all entries and cached Back", async () => {
  const read = vi.fn(async (generation: number, page: number) => batch(generation, page, 1, 20));
  const get = recommendationPages(read, 9);
  const pages = await Promise.all([get(1, 1), get(2, 2), get(3, 3)]);
  expect(pages.map(page => page.items.length)).toEqual([9, 9, 2]);
  expect(pages.map(page => page.hasMore)).toEqual([true, true, false]);
  expect(pages.flatMap(page => page.items.map(item => item.id))).toEqual(songs(1, 20).map(item => item.id));
  expect((await get(1, 4)).generation).toBe(4);
  expect(read).toHaveBeenCalledExactlyOnceWith(1, 1);
});

it("carries radar's tenth song onto the next page across upstream batches", async () => {
  const read = vi.fn(async (generation: number, page: number) => batch(generation, page, (page - 1) * 10 + 1, 10, page === 1));
  const get = recommendationPages(read, 9), pages = [];
  for (let page = 1; page <= 3; page++) pages.push(await get(page, page));
  expect(pages.map(page => page.items.length)).toEqual([9, 9, 2]);
  expect(pages[1]!.items[0]!.id).toBe("song-10");
  expect(pages.flatMap(page => page.items.map(item => item.id))).toEqual(songs(1, 20).map(item => item.id));
  expect(read).toHaveBeenCalledTimes(2);
});

it("does not consume overflow when the next upstream request fails", async () => {
  const read = vi.fn(async (generation: number, page: number) => batch(generation, page, (page - 1) * 10 + 1, 10, page === 1));
  const get = recommendationPages(read, 9);
  await get(1, 1);read.mockRejectedValueOnce(new Error("offline"));
  await expect(get(2, 2)).rejects.toThrow("offline");
  expect((await get(2, 3)).items.map(item => item.id)).toEqual(songs(10, 9).map(item => item.id));
});

it("leaves short or empty batches reviewable without eagerly fetching further pages", async () => {
  const read = vi.fn(async (generation: number, page: number) => ({ ...batch(generation, page, 1, page === 1 ? 0 : 4), hasMore: page === 1, warningCount: page === 1 ? 1 : 0 }));
  const get = recommendationPages(read, 9);
  expect(await get(1, 1)).toMatchObject({ items: [], warningCount: 1, hasMore: true });
  expect(read).toHaveBeenCalledTimes(1);
  expect((await get(2, 2)).items).toHaveLength(4);
});
