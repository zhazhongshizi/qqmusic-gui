import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SavedQueues, PersonalLibrary } from "./PersonalLibrary";
import { ListeningStatistics, statisticsSince } from "./ListeningStatistics";
import { installPlaybackTransport } from "../../backend/playbackTransport";
import { resetPlayerFixture } from "../player/playerStore";
const actions = vi.hoisted(() => vi.fn());
vi.mock("../player/statisticsPlayback", () => ({ actOnStatisticsTrack: actions }));
const track = { id: "a", title: "夜航", artist: "歌手", album: "", durationMs: 9000 };
const stats = { events: [], forgotten: [], startedMs: 100, totalMs: 9000, qualifiedPlays: 1, storageAvailable: true, nextOverride: null, items: [{ ...{ id: "a", title: "夜航", artist: "歌手" }, listenedMs: 9000, qualifiedPlays: 1, lastPlayedMs: Date.now(), recentMs: 9000, recentPlays: 1 }], shuffle: { enabled: true, active: true, likesLoaded: true, items: [] } };
beforeEach(() => { resetPlayerFixture(); actions.mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); installPlaybackTransport(null); vi.useRealTimers(); vi.restoreAllMocks(); });

it("队列预览不切换，重命名与删除撤销提供独立操作", async () => {
  let name = "通勤"; let deleted: string | null = null;
  const transport = vi.fn(async (_command: string, payload?: Record<string, unknown>) => {
    const r = payload!.request as Record<string, unknown>;
    if (r.action === "previewQueue") return { items: [track], selectedIndex: 0, savedAtMs: 100 };
    if (r.action === "renameQueue") name = String(r.target);
    if (r.action === "deleteQueue") { deleted = name; name = ""; }
    if (r.action === "undoDeleteQueue") { name = deleted!; deleted = null; }
    return { queues: name ? [{ name, count: 1, savedAtMs: 100 }] : [], bookmarks: [], hasPrevious: false, deletedQueue: deleted, previous: null };
  });
  installPlaybackTransport(transport); render(<SavedQueues />);
  await screen.findByRole("option", { name: "通勤 · 1 首" });
  fireEvent.change(screen.getByLabelText("选择保存的队列"), { target: { value: "通勤" } });
  fireEvent.click(screen.getByRole("button", { name: "预览队列" }));
  await screen.findByText(/夜航 · 歌手（保存时选中）/);
  expect(transport.mock.calls.some(([, p]) => (p!.request as { action: string }).action === "loadQueue")).toBe(false);
  fireEvent.change(screen.getByLabelText("队列名称"), { target: { value: "夜间" } });
  const rename = screen.getByRole("button", { name: "重命名为输入名称" }); await waitFor(() => expect(rename).toBeEnabled()); fireEvent.click(rename);
  await screen.findByRole("option", { name: "夜间 · 1 首" });
  fireEvent.click(screen.getByRole("button", { name: "删除保存" }));
  const undo = await screen.findByRole("button", { name: "撤销删除" }); await waitFor(() => expect(undo).toBeEnabled()); fireEvent.click(undo);
  await screen.findByRole("option", { name: "夜间 · 1 首" }); expect(screen.queryByRole("button", { name: "撤销删除" })).toBeNull();
});

it("资料库分类、排序与置顶会保留书签封面元数据", async () => {
  const bookmarks = [{ kind: "album", id: "album1", title: "专辑 A", addedMs: 10, pinned: false, coverCacheKey: null }, { kind: "artist", id: "artist1", title: "歌手 B", addedMs: 20, pinned: false, coverCacheKey: null }];
  const transport = vi.fn(async (_command: string, payload?: Record<string, unknown>) => {
    const r = payload!.request as Record<string, unknown>;
    if (r.action === "pinBookmark") bookmarks.find(b => b.id === r.id)!.pinned = Boolean(r.pinned);
    return { queues: [], bookmarks: structuredClone(bookmarks), hasPrevious: false };
  });
  installPlaybackTransport(transport); render(<PersonalLibrary />);
  await screen.findByRole("button", { name: "置顶 专辑 A" });
  expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("歌手 B");
  fireEvent.click(screen.getByRole("button", { name: "置顶 专辑 A" }));
  await waitFor(() => expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("专辑 A"));
  fireEvent.click(within(screen.getByRole("navigation", { name: "书签分类" })).getByRole("button", { name: "歌手" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(1); expect(screen.queryByText("专辑 A")).toBeNull();
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索资料库" }), { target: { value: "不存在" } });
  expect(screen.getByText(/没有匹配的书签/)).toBeInTheDocument();
});

it("统计日期按本地午夜计算，重复选择当前范围不会卡在加载中", async () => {
  const transport = vi.fn(async () => stats); installPlaybackTransport(transport); render(<ListeningStatistics />);
  await screen.findByText("夜航"); fireEvent.click(screen.getByRole("button", { name: "今天" }));
  await screen.findByText("夜航"); expect(transport).toHaveBeenLastCalledWith("personal_library", { request: { action: "statistics", sinceMs: statisticsSince(1) } });
  fireEvent.click(screen.getByRole("button", { name: "今天" })); await screen.findByText("夜航");
  fireEvent.click(screen.getByRole("button", { name: "下一首播放 夜航" }));
  await waitFor(() => expect(actions).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "next"));
  const now = new Date(2026, 9, 3, 18, 30); expect(statisticsSince(7, now)).toBe(new Date(2026, 8, 27).getTime());
});

it("统计自动刷新仅在页面可见时运行，卸载后停止", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const transport = vi.fn(async () => stats); installPlaybackTransport(transport);
  const view = render(<ListeningStatistics />); await act(async () => {}); expect(transport).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); expect(transport).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("hidden"); await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); expect(transport).toHaveBeenCalledTimes(2);
  view.unmount(); await vi.advanceTimersByTimeAsync(15000); expect(transport).toHaveBeenCalledTimes(2);
});
