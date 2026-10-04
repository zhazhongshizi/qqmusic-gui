import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./App", () => ({
  App: () => <div>MAIN_ROOT_FIXTURE</div>,
}));
vi.mock("../features/tray/TrayMenu", () => ({
  TrayMenu: () => <div>TRAY_ROOT_FIXTURE</div>,
}));

import { WindowRoot, selectWindowRoot } from "./WindowRoot";

describe("WindowRoot", () => {
  afterEach(() => cleanup());

  it("选择 main、浏览器默认值和 tray-menu 根组件", async () => {
    expect(selectWindowRoot(undefined)).toBe("main");
    expect(selectWindowRoot("main")).toBe("main");
    expect(selectWindowRoot("tray-menu")).toBe("tray-menu");

    render(<WindowRoot windowLabel="tray-menu" />);
    expect(await screen.findByText("TRAY_ROOT_FIXTURE")).toBeInTheDocument();

    cleanup();
    render(<WindowRoot />);
    expect(await screen.findByText("MAIN_ROOT_FIXTURE")).toBeInTheDocument();
  });

  it("未知 Tauri 窗口不误挂载完整主应用", () => {
    expect(selectWindowRoot("unexpected-window")).toBeNull();
    const { container } = render(<WindowRoot windowLabel="unexpected-window" />);
    expect(container).toBeEmptyDOMElement();
  });
});
