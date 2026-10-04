import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlaybackSessionSnapshot } from "../../contracts/queue";
import { TrayMenu, trayViewModel } from "./TrayMenu";

const { snapshotMock, coverMock, actionMock, shownMock, hiddenMock } = vi.hoisted(() => ({
  snapshotMock: vi.fn(),
  coverMock: vi.fn(),
  actionMock: vi.fn(),
  shownMock: vi.fn(),
  hiddenMock: vi.fn(),
}));

vi.mock("../../backend/nativeQueueAdapter", () => ({ nativePlaybackSessionSnapshot: snapshotMock }));
vi.mock("../../backend/coverAdapter", () => ({ getCoverImage: coverMock }));
vi.mock("../../backend/trayMenuAdapter", () => ({
  listenTrayMenuShown: shownMock,
  listenTrayMenuHidden: hiddenMock,
  sendTrayMenuAction: actionMock,
}));

const TRACK = {
  id: "track-a",
  title: "晴天",
  artist: "周杰伦",
  album: "叶惠美",
  durationMs: 269_000,
  coverCacheKey: "cover-a",
} as const;

function session(state: PlaybackSessionSnapshot["player"]["state"] = "paused"): PlaybackSessionSnapshot {
  return {
    requestedQuality: "320k",
    mode: "sequence",
    queue: { generation: 3, selectedIndex: 0, items: [TRACK] },
    player: {
      state,
      generation: 3,
      positionMs: 0,
      durationMs: TRACK.durationMs,
      volume: 1,
      muted: false,
      currentTrack: { id: TRACK.id, title: TRACK.title, artist: TRACK.artist },
      failure: null,
    },
  };
}

let shownHandler: (() => void) | undefined;
let hiddenHandler: (() => void) | undefined;

async function openTray() {
  await waitFor(() => expect(shownHandler).toBeDefined());
  await act(async () => shownHandler?.());
  await waitFor(() => expect(nativeText()).toContain("晴天"));
}

function nativeText() {
  return document.body.textContent ?? "";
}

describe("TrayMenu", () => {
  beforeEach(() => {
    snapshotMock.mockReset().mockResolvedValue(session());
    coverMock.mockReset().mockRejectedValue(new Error("not in test"));
    actionMock.mockReset().mockResolvedValue(undefined);
    shownHandler = undefined;
    hiddenHandler = undefined;
    shownMock.mockReset().mockImplementation((handler: () => void) => {
      shownHandler = handler;
      return Promise.resolve(vi.fn());
    });
    hiddenMock.mockReset().mockImplementation((handler: () => void) => {
      hiddenHandler = handler;
      return Promise.resolve(vi.fn());
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("shown 后读取快照并映射 playing/loading/paused/ready/ended/failed/empty/error 状态", async () => {
    const states: Array<[PlaybackSessionSnapshot["player"]["state"], string, string]> = [
      ["playing", "正在播放", "暂停"],
      ["loading", "正在载入", "暂停"],
      ["paused", "已暂停", "播放"],
      ["idle", "准备播放", "播放"],
      ["ended", "播放结束", "播放"],
      ["failed", "播放中断", "播放"],
    ];

    for (const [state, status, button] of states) {
      const view = trayViewModel(session(state), false);
      expect(view.status).toBe(status);
      expect(view.canTransport).toBe(true);
      expect(button).toBeTruthy();
    }

    render(<TrayMenu />);
    await openTray();
    expect(screen.getByText("已暂停")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument();

    cleanup();
    snapshotMock.mockResolvedValue({ ...session(), queue: { generation: 3, selectedIndex: null, items: [] }, player: { ...session().player, currentTrack: null } });
    render(<TrayMenu />);
    await waitFor(() => expect(shownHandler).toBeDefined());
    await act(async () => shownHandler?.());
    await waitFor(() => expect(screen.getAllByText("暂无待播放歌曲").length).toBeGreaterThan(0));
    expect(screen.getAllByText("暂无待播放歌曲").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "打开主窗口" })).toHaveFocus();

    cleanup();
    snapshotMock.mockRejectedValue(new Error("snapshot failed"));
    render(<TrayMenu />);
    await waitFor(() => expect(shownHandler).toBeDefined());
    await act(async () => shownHandler?.());
    await waitFor(() => expect(screen.getByText("暂时无法读取播放状态")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "上一首" })).toBeDisabled();
  });

  it("当前播放器曲目优先于 selected item，且空队列不伪造歌曲", async () => {
    const selected = { ...TRACK, id: "track-selected", title: "准备曲目" };
    snapshotMock.mockResolvedValue({
      ...session(),
      queue: { generation: 3, selectedIndex: 1, items: [TRACK, selected] },
      player: { ...session().player, currentTrack: { id: TRACK.id, title: TRACK.title, artist: TRACK.artist } },
    });
    render(<TrayMenu />);
    await openTray();
    expect(screen.getByText("晴天")).toBeInTheDocument();
    expect(screen.queryByText("准备曲目")).not.toBeInTheDocument();
  });

  it("500ms 刷新单飞，hidden 后停止并清理监听", async () => {
    render(<TrayMenu />);
    await openTray();
    expect(snapshotMock).toHaveBeenCalledTimes(1);
    let resolveRefresh!: (value: PlaybackSessionSnapshot) => void;
    snapshotMock.mockReturnValueOnce(new Promise<PlaybackSessionSnapshot>((resolve) => { resolveRefresh = resolve; }));
    await waitFor(() => expect(snapshotMock).toHaveBeenCalledTimes(2), { timeout: 1_200 });
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    expect(snapshotMock).toHaveBeenCalledTimes(2);
    await act(async () => { hiddenHandler?.(); });
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    expect(snapshotMock).toHaveBeenCalledTimes(2);
    resolveRefresh(session("playing"));
  });

  it("动作使用固定命令，传输 pending 时禁用三枚传输按钮，失败可恢复", async () => {
    const user = userEvent.setup();
    render(<TrayMenu />);
    await openTray();
    await user.click(screen.getByRole("button", { name: "上一首" }));
    expect(actionMock).toHaveBeenCalledWith("previous");
    expect(snapshotMock).toHaveBeenCalledTimes(2);

    let resolveAction!: () => void;
    actionMock.mockReturnValueOnce(new Promise<void>((resolve) => { resolveAction = resolve; }));
    await user.click(screen.getByRole("button", { name: "下一首" }));
    expect(screen.getByRole("button", { name: "播放" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "打开主窗口" })).toBeEnabled();
    resolveAction();
    await waitFor(() => expect(screen.getByRole("button", { name: "播放" })).toBeEnabled());

    actionMock.mockRejectedValueOnce(new Error("action failed"));
    await user.click(screen.getByRole("button", { name: "播放" }));
    expect(await screen.findByText("操作未完成，请重试")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一首" }));
    await waitFor(() => expect(screen.queryByText("操作未完成，请重试")).not.toBeInTheDocument());
  });

  it("支持 Esc、动态 aria-label、焦点循环和封面 Object URL 清理", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:cover-a");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    coverMock.mockResolvedValue({ mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) });
    const user = userEvent.setup();
    render(<TrayMenu />);
    await openTray();
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "播放" })).toHaveFocus();

    const buttons = screen.getAllByRole("button");
    buttons[buttons.length - 1]?.focus();
    await user.tab();
    expect(screen.getAllByRole("button")[0]).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(actionMock).toHaveBeenCalledWith("hide");
    cleanup();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cover-a");
  });
});
