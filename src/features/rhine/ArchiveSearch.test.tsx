import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArchiveSearch } from "./ArchiveSearch";
import { playerActions, resetPlayerFixture } from "../player/playerStore";
const mocks = vi.hoisted(() => ({ search: vi.fn(), enqueue: vi.fn() }));
vi.mock("../../backend/catalogAdapter", () => ({ searchCatalogSongs: mocks.search }));
vi.mock("../player/catalogQueue", () => ({ enqueueCatalogTrack: mocks.enqueue }));
const song = { id: "search-song", title: "夜航", artist: "歌手", artists: [{ id: "artist-1", name: "歌手" }], album: "专辑", durationMs: 180000 };
const result = { generation: 1, page: 1, hasMore: false, total: 1, items: [song] };
beforeEach(() => { localStorage.clear(); resetPlayerFixture(); mocks.search.mockResolvedValue(result); mocks.enqueue.mockResolvedValue({}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
function submit(query: string) { fireEvent.change(screen.getByRole("textbox", { name: "搜索歌曲" }), { target: { value: query } }); fireEvent.click(screen.getByRole("button", { name: "搜索 ↗" })); }
it("试听留在搜索页，封面缺失有占位，历史可再次搜索与清空", async () => {
  const close = vi.fn(), play = vi.spyOn(playerActions, "playTrack");
  render(<ArchiveSearch active onClose={close} />); submit("夜航");
  fireEvent.click(await screen.findByRole("button", { name: "播放 夜航" }));
  await waitFor(() => expect(play).toHaveBeenCalledWith(song.id));
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("img", { name: "夜航暂无封面" })).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem("qqmusic_search_history_v1")!)).toEqual([{query:"夜航",type:"songs"}]);
  fireEvent.click(screen.getByRole("button", { name: "清空搜索历史" }));
  expect(localStorage.getItem("qqmusic_search_history_v1")).toBe("[]");
});
it("新搜索不会被旧搜索的迟到结果覆盖", async () => {
  let finish!: (value: unknown) => void;
  mocks.search.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ArchiveSearch active onClose={() => {}} />); submit("旧词"); submit("夜航");
  await screen.findByRole("button", { name: "播放 夜航" });
  await act(async () => finish({ ...result, items: [{ ...song, title: "旧结果" }] }));
  expect(screen.queryByText("旧结果")).not.toBeInTheDocument();
});
it("关闭后迟到的入队操作不会继续启动播放", async () => {
  let finish!: () => void;
  mocks.enqueue.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const play = vi.spyOn(playerActions, "playTrack");
  const view = render(<ArchiveSearch active onClose={() => {}} />); submit("夜航");
  fireEvent.click(await screen.findByRole("button", { name: "播放 夜航" }));
  view.unmount(); await act(async () => finish());
  expect(play).not.toHaveBeenCalled();
});
it("暂时离开搜索再返回也不会启动此前的迟到播放", async () => {
  let finish!: () => void;
  mocks.enqueue.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const play = vi.spyOn(playerActions, "playTrack"), close = () => {};
  const view = render(<ArchiveSearch active onClose={close} />); submit("夜航");
  fireEvent.click(await screen.findByRole("button", { name: "播放 夜航" }));
  view.rerender(<ArchiveSearch active={false} onClose={close} />);
  view.rerender(<ArchiveSearch active onClose={close} />);
  await act(async () => finish());
  expect(play).not.toHaveBeenCalled();
});
