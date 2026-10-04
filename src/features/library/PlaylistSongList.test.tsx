import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogSong, CatalogSongPage } from "../../contracts/catalog";
import PlaylistSongList from "./PlaylistSongList";
import { invalidatePlaylistSongs } from "./readPlaylistSongs";

const { read, enqueue } = vi.hoisted(() => ({ read: vi.fn(), enqueue: vi.fn() }));
vi.mock("../../backend/catalogAdapter", () => ({ getPlaylistSongs: read }));
vi.mock("../player/catalogQueue", () => ({ enqueueCatalogTracks: enqueue }));

const songs: CatalogSong[] = Array.from({ length: 23 }, (_, index) => ({
  id: `song-${index}`, title: `歌曲 ${index + 1}`, subtitle: "", artist: index === 22 ? "独立歌手" : "共同歌手",
  artists: [], album: index === 22 ? "Moon Album" : "日光", durationMs: 180000,
  qualityCandidates: [], availability: { status: "unknown", requiresSubscription: false },
}));
const firstPage: CatalogSongPage = { generation: 1, page: 1, hasMore: true, total: 23, warningCount: 0, items: songs.slice(0, 20) };

function setup(initialPage = firstPage) {
  return render(<PlaylistSongList playlist={{ id: "123", editableId: "12", title: "测试歌单", description: "", songCount: 23 }}
    initialPage={initialPage} disabled={false} onBusyChange={vi.fn()}
    renderCells={(track) => <td>{track.title}</td>} />);
}

describe("playlist search and bulk queue selection", () => {
  beforeEach(() => {
    invalidatePlaylistSongs();
    read.mockReset().mockImplementation((_id, generation, page, pageSize) => Promise.resolve({
      generation, page, hasMore: false, warningCount: 0,
      items: pageSize === 50 ? songs : songs.slice(20),
    }));
    enqueue.mockReset().mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("搜索覆盖未浏览的歌曲、歌手、专辑，忽略大小写及首尾空格并复用完整缓存", async () => {
    const user = userEvent.setup();
    setup();
    expect(read).not.toHaveBeenCalled();
    await user.type(screen.getByRole("searchbox"), "  mOoN  ");
    expect(await screen.findByText("歌曲 23")).toBeInTheDocument();
    expect(screen.queryByText("歌曲 1")).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledWith("123", 1, 1, 50, "12");
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "独立歌手");
    expect(screen.getByText("歌曲 23")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "不存在");
    expect(screen.getByText("歌单内没有匹配的歌曲")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清空歌单搜索" }));
    expect(screen.getByText("歌曲 1")).toBeInTheDocument();
  });

  it("跨页保留选择，按歌单顺序追加并在成功后清空选择", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await user.click(await screen.findByRole("checkbox", { name: "选择 歌曲 23" }));
    await user.click(screen.getByRole("button", { name: "上一页" }));
    await user.click(await screen.findByRole("checkbox", { name: "选择 歌曲 1" }));
    expect(screen.getByText("已选 2 首")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "加入播放队列" }));
    expect(await screen.findByText("已将 2 首歌曲加入播放队列")).toBeInTheDocument();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0].map((track: CatalogSong) => track.id)).toEqual(["song-0", "song-22"]);
    expect(screen.getByText("已选 0 首")).toBeInTheDocument();
  });

  it("全选搜索结果包含所有结果页，切换搜索保留选中曲目", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole("searchbox"), "歌曲");
    const selectAll = await screen.findByRole("checkbox", { name: "全选搜索结果" });
    await waitFor(() => expect(selectAll).toBeEnabled());
    await user.click(selectAll);
    expect(screen.getByText("已选 23 首")).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "Moon");
    expect(screen.getByRole("checkbox", { name: "选择 歌曲 23" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "加入播放队列" }));
    expect(await screen.findByText("已将 23 首歌曲加入播放队列")).toBeInTheDocument();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(songs);
  });

  it("整批失败后保留所有选择，只有显式重试才再次提交", async () => {
    const user = userEvent.setup();
    enqueue.mockRejectedValueOnce(new Error("failed"));
    setup();
    await user.click(screen.getByRole("checkbox", { name: "全选本页" }));
    await user.click(screen.getByRole("button", { name: "加入播放队列" }));
    expect(await screen.findByText(/批量入队未确认/)).toBeInTheDocument();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenLastCalledWith(songs.slice(0, 20));
    expect(screen.getByText("已选 20 首")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择 歌曲 1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "选择 歌曲 2" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "加入播放队列" }));
    expect(await screen.findByText("已将 20 首歌曲加入播放队列")).toBeInTheDocument();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenLastCalledWith(songs.slice(0, 20));
    expect(screen.getByText("已选 0 首")).toBeInTheDocument();
  });

  it("批量追加期间禁用重复点击和选择，离开后不再次提交", async () => {
    let resolve!: () => void;
    enqueue.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const user = userEvent.setup();
    const view = setup();
    await user.click(screen.getByRole("checkbox", { name: "全选本页" }));
    await user.dblClick(screen.getByRole("button", { name: "加入播放队列" }));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在加入…" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "全选本页" })).toBeDisabled();
    view.unmount();
    resolve();
    await new Promise((done) => setTimeout(done, 0));
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("完整读取失败不把部分结果当作无匹配，允许显式重试", async () => {
    const user = userEvent.setup();
    read.mockResolvedValueOnce({ ...firstPage, items: songs.slice(0, 20) }).mockRejectedValueOnce(new Error("offline"));
    setup();
    await user.type(screen.getByRole("searchbox"), "Moon");
    expect(await screen.findByRole("alert")).toHaveTextContent("未能读取完整歌单");
    expect(screen.queryByText("歌单内没有匹配的歌曲")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新读取歌曲" }));
    expect(await screen.findByText("歌曲 23")).toBeInTheDocument();
  });

  it("清空搜索后忽略迟到的读取结果", async () => {
    let resolve!: (page: CatalogSongPage) => void;
    read.mockImplementation(() => new Promise<CatalogSongPage>((done) => { resolve = done; }));
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole("searchbox"), "Moon");
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "清空歌单搜索" }));
    resolve({ ...firstPage, hasMore: false, items: songs });
    await waitFor(() => expect(screen.getByText("歌曲 1")).toBeInTheDocument());
    expect(screen.queryByText("歌曲 23")).not.toBeInTheDocument();
  });

  it("只有一页的歌单直接本地搜索，部分勾选显示半选状态", async () => {
    const user = userEvent.setup();
    setup({ ...firstPage, hasMore: false });
    await user.click(screen.getByRole("checkbox", { name: "选择 歌曲 1" }));
    expect(screen.getByRole("checkbox", { name: "全选本页" })).toBePartiallyChecked();
    await user.type(screen.getByRole("searchbox"), "歌曲 1");
    expect(read).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "清空选择" }));
    expect(screen.getByRole("button", { name: "加入播放队列" })).toBeDisabled();
  });
});
