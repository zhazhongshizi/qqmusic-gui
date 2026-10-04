import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { playerActions, resetPlayerFixture } from "../features/player/playerStore";
import { TerminalMiniMode } from "../features/terminal/TerminalMiniMode";
import { StrictMode } from "react";
import { App, UI_MODE_STORAGE_KEY } from "./App";

const { bridgeMount, enterMiniMode, restoreNormal } = vi.hoisted(() => ({
  bridgeMount: vi.fn(),
  enterMiniMode: vi.fn(),
  restoreNormal: vi.fn(),
}));

const normalWindowSnapshot = {
  size: { width: 1280, height: 800 },
  position: { x: 120, y: 80 },
  maximized: false,
};

const scrollIntoView = vi.fn();

vi.mock("../backend/windowAdapter", async () => {
  const actual = await vi.importActual<typeof import("../backend/windowAdapter")>("../backend/windowAdapter");
  return {
    ...actual,
    windowEnterMiniMode: enterMiniMode,
    windowRestoreNormal: restoreNormal,
  };
});

vi.mock("../features/player/NativePlayerBridge", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  return {
    NativePlayerBridge: () => {
      useEffect(() => {
        bridgeMount();
      }, []);
      return <span data-testid="native-player-bridge" />;
    },
  };
});

describe("React Terminal Mini Mode", () => {
  beforeEach(() => {
    localStorage.removeItem(UI_MODE_STORAGE_KEY);
    resetPlayerFixture();
    bridgeMount.mockReset();
    enterMiniMode.mockReset();
    enterMiniMode.mockResolvedValue({ snapshot: normalWindowSnapshot, applied: true });
    restoreNormal.mockReset();
    restoreNormal.mockResolvedValue(true);
    scrollIntoView.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem(UI_MODE_STORAGE_KEY);
    vi.useRealTimers();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("重启恢复 Mini，返回主模式后下次恢复主模式", async () => {
    const user = userEvent.setup();
    const first = render(<App />);
    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    await screen.findByTestId("terminal-mini");
    expect(localStorage.getItem(UI_MODE_STORAGE_KEY)).toBe("terminal");
    first.unmount();

    const second = render(<App />);
    expect(screen.getByTestId("terminal-mini")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入终端模式" })).not.toBeInTheDocument();
    await waitFor(() => expect(enterMiniMode).toHaveBeenCalledTimes(2));
    await user.click(screen.getAllByRole("button", { name: "G GUI" })[0]!);
    await screen.findByRole("button", { name: "进入终端模式" });
    expect(restoreNormal).toHaveBeenCalledWith(normalWindowSnapshot);
    expect(localStorage.getItem(UI_MODE_STORAGE_KEY)).toBe("normal");
    second.unmount();

    render(<App />);
    expect(screen.queryByTestId("terminal-mini")).not.toBeInTheDocument();
    expect(enterMiniMode).toHaveBeenCalledTimes(2);
  });

  it("StrictMode 启动恢复只调整一次 Mini 窗口", async () => {
    localStorage.setItem(UI_MODE_STORAGE_KEY, "terminal");
    render(<StrictMode><App /></StrictMode>);
    expect(screen.getByTestId("terminal-mini")).toBeInTheDocument();
    await waitFor(() => expect(enterMiniMode).toHaveBeenCalledTimes(1));
  });

  it("未知模式回到主模式", () => {
    localStorage.setItem(UI_MODE_STORAGE_KEY, "unknown-mode");
    render(<App />);
    expect(screen.getByRole("button", { name: "进入终端模式" })).toBeInTheDocument();
    expect(enterMiniMode).not.toHaveBeenCalled();
  });

  it("切换 Normal/Terminal 视图且只挂载一次 NativePlayerBridge", async () => {
    let finishRestore: ((restored: boolean) => void) | undefined;
    restoreNormal.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishRestore = resolve;
    }));
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    expect(await screen.findByTestId("terminal-mini")).toBeInTheDocument();
    expect(enterMiniMode).toHaveBeenCalledTimes(1);
    expect(bridgeMount).toHaveBeenCalledTimes(1);

    await user.click(screen.getAllByRole("button", { name: "G GUI" })[0]!);
    expect(screen.getByTestId("terminal-mini")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入终端模式" })).not.toBeInTheDocument();
    expect(restoreNormal).toHaveBeenCalledWith(normalWindowSnapshot);

    finishRestore?.(true);
    await waitFor(() => {
      expect(screen.queryByTestId("terminal-mini")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "进入终端模式" })).toBeInTheDocument();
    expect(bridgeMount).toHaveBeenCalledTimes(1);
  });

  it("窗口恢复失败时仍返回 Normal GUI", async () => {
    restoreNormal.mockRejectedValueOnce(new Error("restore failed"));
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    await screen.findByTestId("terminal-mini");
    await user.click(screen.getAllByRole("button", { name: "G GUI" })[0]!);

    expect(await screen.findByRole("button", { name: "进入终端模式" })).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-mini")).not.toBeInTheDocument();
    expect(bridgeMount).toHaveBeenCalledTimes(1);
  });

  it("把 Terminal 快捷键交给现有 playerActions", async () => {
    const toggle = vi.spyOn(playerActions, "toggle");
    const previous = vi.spyOn(playerActions, "previous");
    const next = vi.spyOn(playerActions, "next");
    const seekBy = vi.spyOn(playerActions, "seekBy");
    const setVolume = vi.spyOn(playerActions, "setVolume");
    const toggleMute = vi.spyOn(playerActions, "toggleMute");
    const cycleMode = vi.spyOn(playerActions, "cycleMode");
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    await screen.findByTestId("terminal-mini");

    fireEvent.keyDown(window, { key: " " });
    fireEvent.keyDown(window, { key: "p" });
    fireEvent.keyDown(window, { key: "n" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "m" });
    fireEvent.keyDown(window, { key: "o" });

    expect(toggle).toHaveBeenCalledOnce();
    expect(previous).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(seekBy).toHaveBeenCalledWith(-5_000);
    expect(setVolume).toHaveBeenCalledWith(0.77);
    expect(toggleMute).toHaveBeenCalledOnce();
    expect(cycleMode).toHaveBeenCalledOnce();
  });

  it("保持同一播放快照并支持歌词面板与 G 返回", async () => {
    playerActions.seek(45_000);
    playerActions.toggle();
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    await screen.findByTestId("terminal-mini");
    expect(screen.getByText("暮色温室")).toBeInTheDocument();
    expect(screen.getByText("00:45")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-vinyl")).toHaveClass("terminal-vinyl--playing");

    fireEvent.keyDown(window, { key: "l" });
    expect(screen.getByRole("region", { name: "歌词" })).toBeInTheDocument();
    expect(screen.getByText("唱针落下，森林从纹路里生长")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "g" });
    expect(await screen.findByRole("button", { name: "进入终端模式" })).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-mini")).not.toBeInTheDocument();
  });

  it("全屏歌词进入与换行时自动把当前歌词平滑居中", async () => {
    playerActions.seek(47_000);
    render(<TerminalMiniMode onExit={() => undefined} />);

    fireEvent.keyDown(window, { key: "l" });
    const current = screen.getByText("唱针落下，森林从纹路里生长").closest("p");
    expect(current).toHaveAttribute("aria-current", "true");
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    });

    scrollIntoView.mockClear();
    act(() => playerActions.seek(103_000));
    const next = screen.getByText("把没有寄出的晚风，留在这一面窗").closest("p");
    await waitFor(() => {
      expect(next).toHaveAttribute("aria-current", "true");
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
  });

  it("手动浏览歌词时暂停跟随并在四秒后回到最新歌词", () => {
    vi.useFakeTimers();
    playerActions.seek(47_000);
    render(<TerminalMiniMode onExit={() => undefined} />);

    fireEvent.keyDown(window, { key: "l" });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(600));

    fireEvent.scroll(screen.getByRole("region", { name: "歌词" }));
    act(() => playerActions.seek(103_000));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(4_000));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(screen.getByText("把没有寄出的晚风，留在这一面窗").closest("p")).toHaveAttribute("aria-current", "true");
  });

  it("反映暂停状态和队列自然切换后的当前歌曲与进度", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    await screen.findByTestId("terminal-mini");

    expect(screen.getByTestId("terminal-vinyl")).not.toHaveClass("terminal-vinyl--playing");
    playerActions.toggle();
    await waitFor(() => {
      expect(screen.getByTestId("terminal-vinyl")).toHaveClass("terminal-vinyl--playing");
    });

    playerActions.next();
    await waitFor(() => {
      expect(screen.getByText("纸月光")).toBeInTheDocument();
      expect(screen.getByText("00:00")).toBeInTheDocument();
    });
  });

  it("使用竖向主控制与次控制分组", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    await screen.findByTestId("terminal-mini");

    expect(screen.getByRole("navigation", { name: "主要播放控制" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "次要播放控制" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "SPACE PLAY" })).toHaveClass("terminal-key--emphasis");
    expect(screen.getByRole("button", { name: /M MUTE/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /O MODE/ })).toBeInTheDocument();
    const runway = screen.getByTestId("terminal-up-next");
    expect(runway).toHaveTextContent("UP NEXT //");
    expect(runway).toHaveTextContent("02");
    expect(runway).toHaveTextContent("纸月光");
    expect(runway).toHaveTextContent("方格岛");
    expect(runway.querySelector("button")).toBeNull();
    expect(screen.queryByText("SPACE PLAY/PAUSE")).not.toBeInTheDocument();
  });

  it("快速重复点击 MINI 时只保存一次原窗口快照", async () => {
    let finishEnter: ((value: { snapshot: typeof normalWindowSnapshot; applied: boolean }) => void) | undefined;
    enterMiniMode.mockImplementationOnce(() => new Promise((resolve) => {
      finishEnter = resolve;
    }));
    render(<App />);

    const miniButton = screen.getByRole("button", { name: "进入终端模式" });
    fireEvent.click(miniButton);
    fireEvent.click(miniButton);

    await waitFor(() => expect(enterMiniMode).toHaveBeenCalledTimes(1));
    finishEnter?.({ snapshot: normalWindowSnapshot, applied: true });
    expect(await screen.findByTestId("terminal-mini")).toBeInTheDocument();
  });
});
