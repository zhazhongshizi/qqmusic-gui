import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as windowAdapter from "../backend/windowAdapter";
import { WindowControls } from "./WindowControls";

describe("窗口控制组件 (WindowControls)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("渲染最小化、最大化和关闭按钮并支持点击操作", async () => {
    const minSpy = vi.spyOn(windowAdapter, "windowMinimize").mockResolvedValue();
    const maxSpy = vi.spyOn(windowAdapter, "windowToggleMaximize").mockResolvedValue();
    const closeSpy = vi.spyOn(windowAdapter, "windowClose").mockResolvedValue();
    vi.spyOn(windowAdapter, "windowIsMaximized").mockResolvedValue(false);

    const user = userEvent.setup();
    render(<WindowControls />);

    const minBtn = screen.getByRole("button", { name: "最小化" });
    const maxBtn = screen.getByRole("button", { name: "最大化" });
    const closeBtn = screen.getByRole("button", { name: "关闭" });

    expect(minBtn).toBeInTheDocument();
    expect(maxBtn).toBeInTheDocument();
    expect(closeBtn).toBeInTheDocument();

    await user.click(minBtn);
    expect(minSpy).toHaveBeenCalledTimes(1);

    await user.click(maxBtn);
    expect(maxSpy).toHaveBeenCalledTimes(1);

    await user.click(closeBtn);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("当窗口最大化时展示向下还原按钮", async () => {
    vi.spyOn(windowAdapter, "windowIsMaximized").mockResolvedValue(true);
    render(<WindowControls />);

    expect(await screen.findByRole("button", { name: "向下还原" })).toBeInTheDocument();
  });
});
