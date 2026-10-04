import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";

import {
  WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY,
  App,
} from "./App";
import { resetPlayerFixture } from "../features/player/playerStore";

const mocks = vi.hoisted(() => ({
  setEnabled: vi.fn(),
}));

vi.mock("../backend/smtcDynamicLyricsAdapter", () => ({
  setSmtcDynamicLyricsEnabled: mocks.setEnabled,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("Windows 动态歌词实验开关", () => {
  beforeEach(() => {
    resetPlayerFixture();
    window.localStorage.removeItem(WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY);
    mocks.setEnabled.mockReset().mockResolvedValue({ enabled: false });
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY);
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("默认关闭、启动时同步一次，并用 menuitemcheckbox 暴露选中状态", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(false));
    await user.click(screen.getByRole("button", { name: "更多" }));

    expect(screen.getAllByText("实验性功能").length).toBeGreaterThan(0);
    expect(screen.getByRole("menuitemcheckbox", { name: "Windows 动态歌词" }))
      .toHaveAttribute("aria-checked", "false");
  });

  it("只接受精确 enabled 偏好，并在 Rust 确认后恢复开启态", async () => {
    const initialSync = deferred<{ enabled: boolean }>();
    mocks.setEnabled.mockReturnValueOnce(initialSync.promise);
    window.localStorage.setItem(WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY, "enabled");
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(true));
    await user.click(screen.getByRole("button", { name: "更多" }));
    const item = screen.getByRole("menuitemcheckbox", { name: "Windows 动态歌词" });
    expect(item).toHaveAttribute("aria-checked", "false");

    initialSync.resolve({ enabled: true });
    await waitFor(() => expect(item).toHaveAttribute("aria-checked", "true"));
    expect(window.localStorage.getItem(WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY)).toBe("enabled");
  });

  it("首次同步失败保持关闭且不写入 enabled", async () => {
    mocks.setEnabled.mockRejectedValueOnce(new Error("ipc unavailable"));
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(false));
    expect(window.localStorage.getItem(WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY)).toBeNull();
    await user.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Windows 动态歌词" }))
      .toHaveAttribute("aria-checked", "false");
  });

  it("StrictMode 启动流程只同步一次", async () => {
    render(<StrictMode><App /></StrictMode>);

    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(false));
    expect(mocks.setEnabled).toHaveBeenCalledTimes(1);
  });

  it("卸载后不再执行仍在队列中的切换命令", async () => {
    const startupSync = deferred<{ enabled: boolean }>();
    mocks.setEnabled.mockReturnValueOnce(startupSync.promise);
    const user = userEvent.setup();
    const rendered = render(<App />);

    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Windows 动态歌词" }));
    rendered.unmount();
    startupSync.resolve({ enabled: false });

    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.setEnabled).toHaveBeenCalledTimes(1);
  });

  it("损坏的本地偏好按关闭处理", async () => {
    window.localStorage.setItem(WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY, "true");
    render(<App />);

    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(false));
  });

  it("用户切换只在最终响应后持久化，并丢弃迟到的启动响应", async () => {
    const startupSync = deferred<{ enabled: boolean }>();
    const clickSync = deferred<{ enabled: boolean }>();
    mocks.setEnabled
      .mockReturnValueOnce(startupSync.promise)
      .mockReturnValueOnce(clickSync.promise);
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(false));
    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Windows 动态歌词" }));
    expect(mocks.setEnabled).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY)).toBeNull();

    startupSync.resolve({ enabled: true });
    await waitFor(() => expect(mocks.setEnabled).toHaveBeenLastCalledWith(true));
    await waitFor(() => expect(window.localStorage.getItem(WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY)).toBeNull());
    expect(screen.getByRole("menuitemcheckbox", { name: "Windows 动态歌词" }))
      .toHaveAttribute("aria-checked", "false");

    clickSync.resolve({ enabled: true });
    await waitFor(() => expect(window.localStorage.getItem(WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY)).toBe("enabled"));
    expect(screen.getByRole("menuitemcheckbox", { name: "Windows 动态歌词" }))
      .toHaveAttribute("aria-checked", "true");
  });

  it("切换失败保留上一次已确认状态和偏好", async () => {
    const user = userEvent.setup();
    mocks.setEnabled
      .mockResolvedValueOnce({ enabled: true })
      .mockRejectedValueOnce(new Error("native update failed"));
    render(<App />);

    await waitFor(() => expect(window.localStorage.getItem(WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY)).toBe("enabled"));
    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Windows 动态歌词" }));
    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(false));

    expect(screen.getByRole("menuitemcheckbox", { name: "Windows 动态歌词" }))
      .toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem(WINDOWS_DYNAMIC_LYRICS_STORAGE_KEY)).toBe("enabled");
  });

  it("键盘 End/ArrowUp 导航包含实验性 checkbox", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(false));
    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitemcheckbox", { name: "Windows 动态歌词" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitemcheckbox", { name: "实时频谱·实验" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitemradio", { name: "莱茵界面" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitemradio", { name: "光晕：增强" })).toHaveFocus();
  });
});
