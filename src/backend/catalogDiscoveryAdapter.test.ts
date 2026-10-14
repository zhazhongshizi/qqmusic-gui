import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getRecommendedPlaylists, getRecommendedSongs, getSearchSuggestions, parseCatalogSuggestions } from "./catalogDiscoveryAdapter";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => {
  invoke.mockReset();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
});
afterEach(() => Reflect.deleteProperty(window, "__TAURI_INTERNALS__"));
it("only sends validated suggestion keywords and generations", async () => {
  invoke.mockResolvedValue({ generation: 4, keyword: "晴天", items: ["晴天 周杰伦"], warningCount: 0 });
  expect((await getSearchSuggestions(" 晴天 ", 4)).items).toEqual(["晴天 周杰伦"]);
  expect(invoke).toHaveBeenCalledWith("catalog_search_suggestions", { keyword: "晴天", generation: 4 });
  for (const keyword of ["", "a\nsecret", "a".repeat(101)]) {
    await expect(getSearchSuggestions(keyword, 1)).rejects.toThrow("QMG-CATALOG-002");
  }
  expect(invoke).toHaveBeenCalledTimes(1);
});
it("rejects stale responses, unknown fields and oversized suggestions", async () => {
  const result = { generation: 1, keyword: "晴天", items: ["晴天"], warningCount: 0 };
  invoke.mockResolvedValue(result);
  await expect(getSearchSuggestions("夜曲", 1)).rejects.toThrow("QMG-CATALOG-002");
  await expect(getSearchSuggestions("晴天", 2)).rejects.toThrow("QMG-CATALOG-002");
  for (const value of [{ ...result, url: "SENTINEL" }, { ...result, items: Array(21).fill("a") },
    { ...result, items: ["a\nsecret"] }, { ...result, warningCount: 129 }]) {
    expect(() => parseCatalogSuggestions(value)).toThrow("QMG-CATALOG-002");
  }
});
it("routes recommendation kinds and validates pagination before IPC", async () => {
  invoke.mockResolvedValue({ generation: 2, page: 1, hasMore: false, warningCount: 0, items: [] });
  await getRecommendedSongs("guess", 2);
  expect(invoke).toHaveBeenLastCalledWith("catalog_recommend_songs", { kind: "guess", generation: 2, page: 1 });
  await getRecommendedSongs("radar", 2, 3);
  expect(invoke).toHaveBeenLastCalledWith("catalog_recommend_songs", { kind: "radar", generation: 2, page: 3 });
  await getRecommendedPlaylists(2, 3, 10);
  expect(invoke).toHaveBeenLastCalledWith("catalog_recommend_playlists", { generation: 2, page: 3, pageSize: 10 });
  expect(() => getRecommendedSongs("guess", 2, 2)).toThrow();
  expect(() => getRecommendedSongs("radar", 2, 101)).toThrow();
  expect(() => getRecommendedPlaylists(2, 1, 51)).toThrow();
  expect(invoke).toHaveBeenCalledTimes(3);
});
