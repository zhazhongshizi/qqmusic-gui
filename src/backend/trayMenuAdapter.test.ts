import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TRAY_MENU_ACTIONS,
  TRAY_MENU_COMMAND,
  TRAY_MENU_EVENTS,
  TrayMenuAdapterError,
  listenTrayMenuEvent,
  listenTrayMenuHidden,
  listenTrayMenuShown,
  sendTrayMenuAction,
} from "./trayMenuAdapter";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

function setTauriRuntime(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  } else {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
}

describe("托盘菜单前端适配器", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset();
    setTauriRuntime(true);
  });

  afterEach(() => setTauriRuntime(false));

  it("只发送固定六动作和 { action } payload", async () => {
    for (const action of TRAY_MENU_ACTIONS) await sendTrayMenuAction(action);

    expect(invokeMock.mock.calls).toEqual(
      TRAY_MENU_ACTIONS.map((action) => [TRAY_MENU_COMMAND, { action }]),
    );
    await expect(sendTrayMenuAction("shell" as never)).rejects.toEqual(
      new TrayMenuAdapterError("QMG-TRAY-002"),
    );
  });

  it("浏览器环境和底层 IPC 错误只暴露稳定错误", async () => {
    setTauriRuntime(false);
    await expect(sendTrayMenuAction("hide")).rejects.toEqual(
      new TrayMenuAdapterError("QMG-TRAY-001"),
    );
    setTauriRuntime(true);
    invokeMock.mockRejectedValue(new Error("Cookie=SENTINEL; filesystem path"));
    await expect(sendTrayMenuAction("quit")).rejects.toEqual(
      new TrayMenuAdapterError("QMG-TRAY-001"),
    );
    expect(invokeMock.mock.calls[0]?.[1]).toEqual({ action: "quit" });
  });

  it("shown/hidden 只监听固定事件，注销函数可重复安全调用", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const shown = vi.fn();
    const hidden = vi.fn();

    const shownUnlisten = await listenTrayMenuShown(shown);
    const hiddenUnlisten = await listenTrayMenuHidden(hidden);
    expect(listenMock).toHaveBeenNthCalledWith(1, TRAY_MENU_EVENTS.shown, expect.any(Function));
    expect(listenMock).toHaveBeenNthCalledWith(2, TRAY_MENU_EVENTS.hidden, expect.any(Function));

    const shownCallback = listenMock.mock.calls[0]?.[1] as () => void;
    shownCallback();
    expect(shown).toHaveBeenCalledTimes(1);

    shownUnlisten();
    shownUnlisten();
    hiddenUnlisten();
    hiddenUnlisten();
    expect(unlisten).toHaveBeenCalledTimes(2);
    await expect(listenTrayMenuEvent("unknown" as never, vi.fn())).rejects.toEqual(
      new TrayMenuAdapterError("QMG-TRAY-002"),
    );
  });
});
