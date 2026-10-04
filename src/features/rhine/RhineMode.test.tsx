import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invalidatePlaylistSongs } from "../library/readPlaylistSongs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RhineMode from "./RhineMode";
import { playerActions, resetPlayerFixture } from "../player/playerStore";
import { defaultRhineSettings, parseRhineSettings, RHINE_SETTINGS_STORAGE_KEY } from "./rhineSettings";

const mocks = vi.hoisted(() => ({ lists: vi.fn(), songs: vi.fn(), enqueue: vi.fn(), playAll: vi.fn() }));
vi.mock("../../backend/libraryAdapter", () => ({ getLibraryPlaylists: mocks.lists }));
vi.mock("../../backend/catalogAdapter", () => ({ getPlaylistSongs: mocks.songs }));
vi.mock("../player/catalogQueue", async importOriginal => ({ ...await importOriginal<object>(), enqueueCatalogTrack: mocks.enqueue, replaceAndPlayCatalogTracks: mocks.playAll }));
vi.mock("./ArchiveCanvas", () => ({ ArchiveCanvas: ({ active, renderer, frameLimit }: { active: boolean; renderer?: string; frameLimit?: number }) => <div data-testid="scene" data-active={active} data-renderer={renderer} data-frame-limit={frameLimit} /> }));
const playlist = { id: "123", title: "旅途收藏", description: "旅途中的声音", songCount: 1 };
const song = { id: "song-1", title: "沿途", artist: "测试歌手", album: "远方", durationMs: 200000 };
const props = { auth: { state: "authenticated" as const, account: { musicId: "123", loginMethod: "qq" as const } }, authRecovering: false, active: true, onExit: vi.fn(), onAccount: vi.fn() };
it("旧版禁用配置保留禁用，冲突字段也以禁用为准", () => {
  const legacy = { version: 1, quality: defaultRhineSettings().quality, superPerformance: false, disableCassetteMotionWhilePlaying: true };
  expect(parseRhineSettings(legacy)).toMatchObject({ disableCassetteMotionWhilePlaying: true, reduceCassetteMotionWhilePlaying: false });
  expect(parseRhineSettings({ ...legacy, reduceCassetteMotionWhilePlaying: true })).toMatchObject({ disableCassetteMotionWhilePlaying: true, reduceCassetteMotionWhilePlaying: false });
});
it("旧设置默认使用原版，未知绘制选项不清空既有画质", () => {
  const legacy = { version: 1, quality: { ...defaultRhineSettings().quality, shadows: 2048 }, superPerformance: true };
  expect(parseRhineSettings(legacy)).toMatchObject({ renderer: "webgl", quality: legacy.quality, superPerformance: true });
  expect(parseRhineSettings({ ...legacy, renderer: "future" })).toMatchObject({ renderer: "webgl", quality: legacy.quality });
});
it("旧设置默认 60 帧，非法帧数回落且不清空画质，三档均可读取", () => {
  const legacy = { version: 1, quality: { ...defaultRhineSettings().quality, shadows: 2048 }, superPerformance: true };
  expect(parseRhineSettings(legacy)).toMatchObject({ frameLimit: 60, quality: legacy.quality });
  for (const frameLimit of [30, 60, 0]) expect(parseRhineSettings({ ...legacy, frameLimit }).frameLimit).toBe(frameLimit);
  for (const frameLimit of [120, "30", null]) expect(parseRhineSettings({ ...legacy, frameLimit })).toMatchObject({ frameLimit: 60, quality: legacy.quality });
});
it("详细参数中的帧数限制即时应用、跨绘制模式保存并在重开后恢复", async () => {
  const view = render(<RhineMode {...props} />);
  await screen.findByRole("button", { name: /抽取档案/ });
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  fireEvent.click(screen.getByRole("button", { name: /详细参数/ }));
  expect(screen.getByLabelText("帧数限制")).toHaveValue("60");
  fireEvent.change(screen.getByLabelText("帧数限制"), { target: { value: "30" } });
  expect(screen.getByTestId("scene")).toHaveAttribute("data-frame-limit", "30");
  fireEvent.click(screen.getByRole("button", { name: /性能画质/ }));
  fireEvent.change(screen.getByLabelText("阵列绘制方式"), { target: { value: "canvas2d" } });
  fireEvent.click(screen.getByRole("button", { name: /详细参数/ }));
  expect(screen.getByLabelText("帧数限制")).not.toBeDisabled();
  expect(screen.getByLabelText("帧数限制")).toHaveValue("30");
  fireEvent.change(screen.getByLabelText("帧数限制"), { target: { value: "0" } });
  await waitFor(() => expect(JSON.parse(localStorage.getItem(RHINE_SETTINGS_STORAGE_KEY)!)).toMatchObject({ renderer: "canvas2d", frameLimit: 0 }));
  view.unmount(); render(<RhineMode {...props} />);
  await screen.findByRole("button", { name: /抽取档案/ });
  expect(screen.getByTestId("scene")).toHaveAttribute("data-frame-limit", "0");
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  fireEvent.click(screen.getByRole("button", { name: /详细参数/ }));
  expect(screen.getByLabelText("帧数限制")).toHaveValue("0");
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  expect(screen.getByLabelText("帧数限制")).toHaveValue("60");
});
it("2D 设置即时传入阵列并持久化，切回原版恢复原画质", async () => {
  const view = render(<RhineMode {...props} />);
  await screen.findByRole("button", { name: /抽取档案/ });
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  fireEvent.change(screen.getByLabelText("画质预设"), { target: { value: "original" } });
  fireEvent.change(screen.getByLabelText("阵列绘制方式"), { target: { value: "canvas2d" } });
  expect(screen.getByTestId("scene")).toHaveAttribute("data-renderer", "canvas2d");
  expect(screen.getByLabelText("画质预设")).toBeDisabled();
  expect(screen.getByLabelText("超级性能模式")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /详细参数/ }));
  expect(screen.getByLabelText("阴影分辨率")).toBeDisabled();
  await waitFor(() => expect(JSON.parse(localStorage.getItem(RHINE_SETTINGS_STORAGE_KEY)!)).toMatchObject({ renderer: "canvas2d", quality: { shadows: 2048, aoSamples: 32 } }));
  view.unmount();
  render(<RhineMode {...props} />);
  await screen.findByRole("button", { name: /抽取档案/ });
  expect(screen.getByTestId("scene")).toHaveAttribute("data-renderer", "canvas2d");
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  expect(screen.getByLabelText("阵列绘制方式")).toHaveValue("canvas2d");
  fireEvent.change(screen.getByLabelText("阵列绘制方式"), { target: { value: "webgl" } });
  expect(screen.getByTestId("scene")).toHaveAttribute("data-renderer", "webgl");
  expect(screen.getByLabelText("画质预设")).toHaveValue("original");
  expect(screen.getByLabelText("画质预设")).not.toBeDisabled();
  fireEvent.keyDown(screen.getByRole("region", { name: "系统设置" }), { key: "Escape" });
  await waitFor(() => expect(screen.getByRole("button", { name: "设置" })).toHaveFocus());
});
it("图标导航保留完整名称，切换页面时只有当前入口显示短名称", async () => {
  render(<RhineMode {...props} />);
  await screen.findByRole("button", { name: /抽取档案/ });
  const nav = screen.getByRole("navigation", { name: "档案分类" });
  const names = ["创建的歌单", "收藏的歌单", "搜索", "本地音乐", "最近播放", "资料库", "听歌统计", "设置"];
  expect(within(nav).getAllByRole("button")).toHaveLength(8);
  for (const name of names) {
    const button = within(nav).getByRole("button", { name });
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(button.querySelector(".rhine-nav-tooltip")).toHaveTextContent(name);
  }
  const chosen = () => [...nav.querySelectorAll('button[aria-pressed="true"]')].map(button => button.getAttribute("aria-label"));
  expect(chosen()).toEqual(["创建的歌单"]);
  expect(nav.querySelectorAll(".rhine-nav-label")).toHaveLength(1);
  expect(nav.querySelector(".rhine-nav-label")).toHaveTextContent("我的歌单");
  fireEvent.click(within(nav).getByRole("button", { name: "最近播放" }));
  expect(chosen()).toEqual(["最近播放"]);
  expect(nav.querySelector(".rhine-nav-label")).toHaveTextContent("最近");
  fireEvent.click(within(nav).getByRole("button", { name: "设置" }));
  expect(chosen()).toEqual(["设置"]);
  fireEvent.keyDown(await screen.findByRole("region", { name: "系统设置" }), { key: "Escape" });
  expect(chosen()).toEqual(["创建的歌单"]);
  await waitFor(() => expect(within(nav).getByRole("button", { name: "设置" })).toHaveFocus());
  fireEvent.click(within(nav).getByRole("button", { name: "收藏的歌单" }));
  expect(chosen()).toEqual(["收藏的歌单"]);
  expect(nav.querySelector(".rhine-nav-label")).toHaveTextContent("收藏");
});
beforeEach(() => {
  invalidatePlaylistSongs();
  localStorage.removeItem(RHINE_SETTINGS_STORAGE_KEY);
  resetPlayerFixture();
  mocks.lists.mockResolvedValue({ kind: "created", page: 1, hasMore: false, total: 1, warningCount: 0, items: [playlist] });
  mocks.songs.mockResolvedValue({ generation: 0, page: 1, hasMore: false, total: 1, warningCount: 0, items: [song] });
  mocks.enqueue.mockResolvedValue({});
  mocks.playAll.mockResolvedValue({ loadedCount: 1, truncated: false });
});
it("点播后进入磁带机，返回时保留同一个歌单详情", async () => {
  vi.spyOn(playerActions, "playTrack").mockResolvedValueOnce(true);
  const view = render(<RhineMode {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: /抽取档案/ }));
  const document = screen.getByRole("region", { name: "歌单详情" });
  fireEvent.click(await screen.findByRole("button", { name: "播放 沿途" }));
  expect(await screen.findByRole("region", { name: "磁带机" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "歌单详情" })).not.toBeInTheDocument();
  expect(view.container.querySelector(".player-bar")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "↙ 返回音乐档案" }));
  expect(screen.getByRole("region", { name: "歌单详情" })).toBe(document);
});
it("点播入队失败时留在详情并显示失败提示", async () => {
  mocks.enqueue.mockRejectedValueOnce(new Error("queue failed"));
  render(<RhineMode {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: /抽取档案/ }));
  fireEvent.click(await screen.findByRole("button", { name: "播放 沿途" }));
  await screen.findByText("操作失败，请重试");
  expect(screen.queryByRole("region", { name: "磁带机" })).not.toBeInTheDocument();
});
it("播放全部完成后进入磁带机，添加到队列则不进入", async () => {
  render(<RhineMode {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: /抽取档案/ }));
  fireEvent.click(await screen.findByRole("button", { name: "加入队列 沿途" }));
  await screen.findByText("已加入队列：沿途");
  expect(screen.queryByRole("region", { name: "磁带机" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
  await screen.findByRole("region", { name: "磁带机" });
  expect(mocks.playAll).toHaveBeenCalledWith([song], "preserve", expect.any(Function));
});
it("播放全部失败时不进入磁带机", async () => {
  mocks.playAll.mockRejectedValueOnce(new Error("failed"));
  render(<RhineMode {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: /抽取档案/ }));
  await screen.findByRole("button", { name: "播放 沿途" });
  fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
  await screen.findByText("播放全部失败；现有本地队列未改变");
  expect(screen.queryByRole("region", { name: "磁带机" })).not.toBeInTheDocument();
});
afterEach(() => { cleanup(); localStorage.removeItem(RHINE_SETTINGS_STORAGE_KEY); vi.clearAllMocks(); vi.restoreAllMocks(); });
it("顶部设置入口打开二级页，Escape 返回并恢复入口焦点", async () => {
  render(<RhineMode {...props} />);
  const trigger = screen.getByRole("button", { name: "设置" });
  expect(screen.queryByLabelText("三维画质")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "返回主界面" })).not.toBeInTheDocument();
  fireEvent.click(trigger);
  const page = screen.getByRole("region", { name: "系统设置" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveAttribute("aria-pressed", "true");
  expect(within(page).getByLabelText("画质预设")).toHaveValue("performance");
  fireEvent.keyDown(page, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "系统设置" })).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("未登录也可直接进入本地音乐和最近播放并返回档案", async () => {
  render(<RhineMode {...props} auth={{ state: "signedOut" }} />);
  fireEvent.click(screen.getByRole("button", { name: "本地音乐" }));
  expect(await screen.findByRole("region", { name: "本地音乐磁带阵列" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "最近播放" }));
  expect(await screen.findByRole("region", { name: "最近播放磁带阵列" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "← 返回档案" }));
  expect(screen.getByText("登录后访问你的音乐档案")).toBeInTheDocument();
});
it("画质参数、超级性能和播放起伏开关即时持久化，重置后恢复默认", async () => {
  const view = render(<RhineMode {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  const page = screen.getByRole("region", { name: "系统设置" });
  fireEvent.change(within(page).getByLabelText("画质预设"), { target: { value: "high" } });
  fireEvent.click(within(page).getByRole("button", { name: /详细参数/ }));
  fireEvent.change(within(page).getByLabelText("三维渲染比例"), { target: { value: "135" } });
  fireEvent.click(within(page).getByRole("button", { name: /性能画质/ }));
  fireEvent.click(within(page).getByLabelText(/超级性能模式/));
  fireEvent.change(within(page).getByLabelText("播放磁带动效"), { target: { value: "disabled" } });
  await waitFor(() => {
    const saved = JSON.parse(localStorage.getItem(RHINE_SETTINGS_STORAGE_KEY)!);
    expect(saved.quality.scale).toBe(135);
    expect(saved.quality.antialias).toBe("smaa");
    expect(saved.superPerformance).toBe(true);
    expect(saved.disableCassetteMotionWhilePlaying).toBe(true);
  });
  fireEvent.click(within(page).getByRole("button", { name: /详细参数/ }));
  expect(within(page).getByLabelText("抗锯齿")).toBeDisabled();
  expect(within(page).getByLabelText("透明材质分辨率")).toBeDisabled();

  view.unmount();
  render(<RhineMode {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  const restored = screen.getByRole("region", { name: "系统设置" });
  expect(within(restored).getByLabelText("画质预设")).toHaveValue("custom");
  expect(within(restored).getByLabelText("超级性能模式")).toBeChecked();
  expect(within(restored).getByLabelText("播放磁带动效")).toHaveValue("disabled");
  fireEvent.click(within(restored).getByRole("button", { name: "恢复默认" }));
  await waitFor(() => expect(JSON.parse(localStorage.getItem(RHINE_SETTINGS_STORAGE_KEY)!).quality).toEqual(defaultRhineSettings().quality));
  expect(within(restored).getByLabelText("画质预设")).toHaveValue("performance");
  expect(within(restored).getByLabelText("超级性能模式")).not.toBeChecked();
  expect(within(restored).getByLabelText("播放磁带动效")).toHaveValue("full");
});
it("兼容缺少播放起伏字段的 version 1 设置并保留原参数", async () => {
  const quality = { ...defaultRhineSettings().quality, scale: 125 };
  localStorage.setItem(RHINE_SETTINGS_STORAGE_KEY, JSON.stringify({ version: 1, quality, superPerformance: true }));
  render(<RhineMode {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  const page = screen.getByRole("region", { name: "系统设置" });
  expect(within(page).getByLabelText("超级性能模式")).toBeChecked();
  expect(within(page).getByLabelText("播放磁带动效")).toHaveValue("full");
  fireEvent.click(within(page).getByRole("button", { name: /详细参数/ }));
  expect(within(page).getByLabelText("三维渲染比例")).toHaveValue("125");
  await waitFor(() => {
    const saved = JSON.parse(localStorage.getItem(RHINE_SETTINGS_STORAGE_KEY)!);
    expect(saved.quality.scale).toBe(125);
    expect(saved.superPerformance).toBe(true);
    expect(saved.disableCassetteMotionWhilePlaying).toBe(false);
  });
});
it("减少动效独立持久化，禁用与完整仍可选择", async () => {
  const view = render(<RhineMode {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  fireEvent.change(screen.getByLabelText("播放磁带动效"), { target: { value: "reduced" } });
  await waitFor(() => {
    const saved = JSON.parse(localStorage.getItem(RHINE_SETTINGS_STORAGE_KEY)!);
    expect(saved.reduceCassetteMotionWhilePlaying).toBe(true);
    expect(saved.disableCassetteMotionWhilePlaying).toBe(false);
  });
  view.unmount(); render(<RhineMode {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  expect(screen.getByLabelText("播放磁带动效")).toHaveValue("reduced");
  fireEvent.change(screen.getByLabelText("播放磁带动效"), { target: { value: "disabled" } });
  expect(JSON.parse(localStorage.getItem(RHINE_SETTINGS_STORAGE_KEY)!).reduceCassetteMotionWhilePlaying).toBe(false);
  fireEvent.change(screen.getByLabelText("播放磁带动效"), { target: { value: "full" } });
  expect(JSON.parse(localStorage.getItem(RHINE_SETTINGS_STORAGE_KEY)!).disableCassetteMotionWhilePlaying).toBe(false);
});
it("账号或返回主界面操作会先关闭设置面板", async () => {
  render(<RhineMode {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  const page = screen.getByRole("region", { name: "系统设置" });
  fireEvent.click(within(page).getByRole("button", { name: /账号与界面/ }));
  fireEvent.click(within(page).getByRole("button", { name: /账号设置/ }));
  expect(props.onAccount).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("region", { name: "系统设置" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  const reopened = screen.getByRole("region", { name: "系统设置" });
  fireEvent.click(within(reopened).getByRole("button", { name: /账号与界面/ }));
  fireEvent.click(within(reopened).getByRole("button", { name: /返回主界面/ }));
  expect(props.onExit).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("region", { name: "系统设置" })).not.toBeInTheDocument();
});
it("设置页保留搜索关键词和同一个暂停场景，返回或切换搜索均正确", async () => {
  const view = render(<RhineMode {...props} />);
  await screen.findByRole("button", { name: /抽取档案/ });
  const scene = screen.getByTestId("scene");
  expect(scene).toHaveAttribute("data-active", "true");
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  const search = await screen.findByRole("region", { name: "音乐档案搜索" });
  const input = screen.getByRole("textbox", { name: "搜索歌曲" });
  fireEvent.change(input, { target: { value: "保存的关键词" } });

  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  const page = screen.getByRole("region", { name: "系统设置" });
  expect(scene).toBe(screen.getByTestId("scene"));
  expect(scene).toHaveAttribute("data-active", "false");
  expect(search).toHaveAttribute("hidden");
  expect(input).toHaveValue("保存的关键词");
  expect(screen.getByRole("button", { name: "搜索" })).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(within(page).getByRole("button", { name: "← 返回搜索" }));
  expect(search).not.toHaveAttribute("hidden");
  expect(input).toHaveValue("保存的关键词");
  expect(scene).toHaveAttribute("data-active", "false");

  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  expect(screen.queryByRole("region", { name: "系统设置" })).not.toBeInTheDocument();
  expect(search).not.toHaveAttribute("hidden");
  expect(screen.getByRole("button", { name: "设置" })).toHaveAttribute("aria-pressed", "false");
  expect(view.container.querySelector(".rhine-settings-page")).toBeNull();
});
it("在整张歌单中搜索后续页的歌手与专辑，清除后恢复浏览", async () => {
  const later = { ...song, id: "later-song", title: "深夜", artist: "远行歌手", album: "特别专辑" };
  mocks.songs.mockImplementation((_id, generation, page, size) => Promise.resolve({ generation, page, hasMore: size === 50 && page === 1, items: page === 2 ? [later] : [song] }));
  render(<RhineMode {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: /抽取档案/ }));
  await screen.findByRole("button", { name: "播放 沿途" });
  const detail = within(screen.getByRole("region", { name: "歌单详情" }));
  fireEvent.change(detail.getByRole("searchbox", { name: "在歌单内搜索" }), { target: { value: "远行歌手" } });
  fireEvent.click(detail.getByRole("button", { name: "搜索" }));
  await detail.findByRole("button", { name: "播放 深夜" });
  expect(detail.queryByRole("button", { name: "播放 沿途" })).not.toBeInTheDocument();
  expect(mocks.songs).toHaveBeenCalledWith(playlist.id, expect.any(Number), 2, 50, undefined);
  const reads = mocks.songs.mock.calls.length;
  fireEvent.change(detail.getByRole("searchbox", { name: "在歌单内搜索" }), { target: { value: "特别专辑" } });
  fireEvent.click(detail.getByRole("button", { name: "搜索" }));
  expect(detail.getByRole("button", { name: "播放 深夜" })).toBeInTheDocument();
  expect(mocks.songs).toHaveBeenCalledTimes(reads);
  fireEvent.click(detail.getByRole("button", { name: "清除" }));
  expect(detail.getByRole("button", { name: "播放 沿途" })).toBeInTheDocument();
});
it("打开的是歌单详情并通过共享操作加入歌曲", async () => {
  render(<RhineMode {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: /抽取档案/ }));
  fireEvent.click(await screen.findByRole("button", { name: "加入队列 沿途" }));
  await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledWith(song));
  expect(screen.getByRole("region", { name: "歌单详情" })).toBeInTheDocument();
});
it("未登录时不请求歌单，保留账号入口", () => {
  render(<RhineMode {...props} auth={{ state: "signedOut" }} />);
  expect(mocks.lists).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "打开账号" })).toBeInTheDocument();
});
it("切换分类后丢弃旧列表的延迟响应", async () => {
  let finish!: (value: unknown) => void;
  mocks.lists.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<RhineMode {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "收藏的歌单" }));
  await screen.findByRole("button", { name: /抽取档案/ });
  finish({ items: [{ ...playlist, title: "旧响应" }] });
  await waitFor(() => expect(screen.queryByText("旧响应")).not.toBeInTheDocument());
});
// Opening lifecycle is covered separately; these tests exercise the music UI.
vi.mock("./RhineBoot", async () => {
  const { useEffect } = await import("react");
  return { RhineBoot: ({ onComplete }: { onComplete: () => void }) => {
    useEffect(onComplete, []);
    return null;
  } };
});
