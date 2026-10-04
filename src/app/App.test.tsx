import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { playerActions, resetPlayerFixture } from "../features/player/playerStore";
import { App } from "./App";

describe("黑胶温室应用外壳", () => {
  beforeEach(() => {
    resetPlayerFixture();
  });

  afterEach(() => {
    cleanup();
  });

  it("从歌词舞台控制播放并打开队列", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole("heading", { name: "暮色温室" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "播放" }));
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开播放队列" }));
    const drawer = screen.getByRole("dialog", { name: "播放队列" });
    expect(drawer).toBeInTheDocument();

    await user.click(within(drawer).getByRole("button", { name: "下移《暮色温室》" }));
    const items = within(drawer).getAllByRole("listitem");
    expect(within(items[0]!).getByText("纸月光")).toBeInTheDocument();
  });

  it("按需载入曲库并筛选本地目录", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "曲库" }));
    expect(await screen.findByRole("heading", { name: "今日唱片目录" })).toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "搜索歌曲、歌手或专辑" });
    await user.type(search, "潮汐");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /潮汐来信/ })).toBeInTheDocument();
    });
  });

  it("可从更多菜单预览并退出部分数据状态", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("menuitemradio", { name: "部分内容" }));

    expect(screen.getByText("已显示可用内容").closest("[role='status']")).toHaveTextContent("已显示可用内容");
    await user.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.queryByText("已显示可用内容")).not.toBeInTheDocument();
  });


  it("在歌词区域显示设置，调整后保持打开并支持返回", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "更多" }));
    const settings = screen.getByRole("region", { name: "设置" });
    expect(settings.closest(".stage-lyrics-panel")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "展开歌曲列表" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitemcheckbox", { name: "轻量动态微光" }));
    expect(settings).toBeVisible();
    await user.click(screen.getByRole("button", { name: "下一首" }));
    expect(settings).toBeVisible();
    await user.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(screen.queryByRole("region", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更多" })).toHaveFocus();
  });

  it("从曲库和空队列仍可打开设置", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "曲库" }));
    expect(await screen.findByRole("heading", { name: "今日唱片目录" })).toBeInTheDocument();
    act(() => playerActions.clearQueue());
    await user.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("region", { name: "设置" })).toBeVisible();
    expect(screen.getByText("队列是空的")).toBeVisible();
  });

  it("支持空格键播放快捷键", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
  });
});
