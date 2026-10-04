import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installPlaybackTransport } from "../../backend/playbackTransport";
import { CatalogEntityResults } from "./CatalogEntityResults";
import { CatalogDetails } from "./CatalogDetails";
import { resetPlayerFixture } from "../player/playerStore";

const queue = vi.hoisted(() => ({ replace: vi.fn(), next: vi.fn(), enqueue: vi.fn(), play: vi.fn() }));
vi.mock("../player/catalogQueue", () => ({ replaceAndPlayCatalogTracks: queue.replace,
  enqueueNextCatalogTrack: queue.next, enqueueCatalogTrack: queue.enqueue, enqueueAndPlayCatalogTrack: queue.play }));
const album = { kind: "album" as const, id: "album-1", title: "专辑一", publishDate: "2026-10-01", description: "第一段\n第二段" };
const artist = { id: "artist-1", name: "歌手一", description: "歌手简介\n第二段" };
const song = { id: "song-1", title: "歌曲一", subtitle: "", artists: [artist].map(({ id, name }) => ({ id, name })), artist: artist.name,
  album: album.title, albumId: album.id, albumPublishDate: album.publishDate, durationMs: 1000,
  qualityCandidates: ["flac", "320k", "128k"].map(quality => ({ quality, available: true, requiresSubscription: false })), availability: { status: "unknown", requiresSubscription: false } };
const invoke = vi.fn();
function page(p: Record<string, unknown>, items: unknown[], hasMore = false) {
  return { generation: p.generation, page: p.page, hasMore, warningCount: 0, items };
}
beforeEach(() => {
  resetPlayerFixture(); queue.replace.mockReset().mockResolvedValue({ loadedCount: 2, truncated: false });
  queue.next.mockReset().mockResolvedValue(undefined);
  invoke.mockReset().mockImplementation(async (command, p) => {
    if (command === "catalog_album_detail") { const { kind: _, ...detail } = album; return detail; }
    if (command === "catalog_album_songs") return page(p, [{ ...song, id: `song-${p.page}` }], p.page === 1);
    if (command === "catalog_artist_detail") return artist;
    if (command === "catalog_artist_songs") return page(p, [song]);
    if (command === "catalog_artist_albums" || command === "catalog_search_entities") return page(p, [album]);
    throw Error("fixture");
  });
  installPlaybackTransport(invoke);
});
afterEach(() => { cleanup(); installPlaybackTransport(null); });
it("keeps descriptions, opens artist albums lazily and returns to the selected tab", async () => {
  render(<CatalogDetails entity={album} onBack={() => {}} />);
  await screen.findByRole("button", { name: "播放 歌曲一" });
  expect(screen.getByText("第一段 第二段")).toHaveTextContent("第一段 第二段");
  fireEvent.click(screen.getByRole("button", { name: "歌手一" }));
  await screen.findByText("歌手简介 第二段");
  expect(invoke.mock.calls.some(([c]) => c === "catalog_artist_albums")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "专辑" }));
  fireEvent.click(await screen.findByRole("button", { name: /2026-10-01/ }));
  await screen.findByRole("button", { name: "播放 歌曲一" });
  fireEvent.click(screen.getByRole("button", { name: /返回上一页/ }));
  expect(screen.getByRole("button", { name: "专辑" })).toHaveAttribute("aria-pressed", "true");
  await screen.findByRole("button", { name: /2026-10-01/ });
});
it("plays an entire album in source order and supports next-play insertion", async () => {
  render(<CatalogDetails entity={album} onBack={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "下一首播放 歌曲一" }));
  await waitFor(() => expect(queue.next).toHaveBeenCalledWith(expect.objectContaining({ id: "song-1" })));
  fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
  await waitFor(() => expect(queue.replace).toHaveBeenCalledWith(
    [expect.objectContaining({ id: "song-1" }), expect.objectContaining({ id: "song-2" })], "preserve", expect.any(Function)));
});
it("does not replace the queue after leaving during a complete collection read", async () => {
  let finish!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, p) => command === "catalog_album_songs" && p.page === 2
    ? new Promise(resolve => { finish = resolve; }) : original(command, p));
  const view = render(<CatalogDetails entity={album} onBack={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "播放全部" }));
  await waitFor(() => expect(finish).toBeTypeOf("function")); view.unmount();
  await act(async () => finish(page({ generation: 1, page: 2 }, [song])));
  expect(queue.replace).not.toHaveBeenCalled();
});
it("rejects late entity search results after changing the keyword", async () => {
  let finish!: (value: unknown) => void;
  invoke.mockImplementation((_, p) => p.keyword === "旧" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(page(p, [album])));
  const view = render(<CatalogEntityResults kind="albums" keyword="旧" onOpen={() => {}} />);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.rerender(<CatalogEntityResults kind="albums" keyword="新" onOpen={() => {}} />);
  await screen.findByRole("button", { name: /2026-10-01/ });
  await act(async () => finish(page({ generation: 1, page: 1 }, [{ ...album, title: "旧结果" }])));
  expect(screen.queryByText("旧结果")).not.toBeInTheDocument();
});
