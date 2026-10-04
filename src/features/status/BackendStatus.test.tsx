import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  APP_SNAPSHOT_ERROR_CODES,
  type AppSnapshotLoadResult,
} from "../../backend/appSnapshotAdapter";
import type { AppSnapshot } from "../../contracts/appSnapshot";
import { BackendStatus } from "./BackendStatus";

const VALID_SNAPSHOT: AppSnapshot = {
  schemaVersion: 1,
  appVersion: "0.1.1",
  target: { os: "windows", architecture: "x86_64" },
  provider: { protocolVersion: 1, state: "notStarted" },
  player: {
    state: "idle",
    generation: 0,
    positionMs: 0,
    durationMs: null,
    volume: 1,
    muted: false,
    currentTrack: null,
    failure: null,
  },
  extensions: {
    playlistRename: false,
    playlistDescriptionEdit: false,
  },
};

afterEach(() => {
  cleanup();
});

describe("公开后端启动状态", () => {
  it("先显示 loading，再显示经过校验的 Tauri 成功状态", async () => {
    let settle: ((result: AppSnapshotLoadResult) => void) | undefined;
    const pending = new Promise<AppSnapshotLoadResult>((resolve) => {
      settle = resolve;
    });

    render(<BackendStatus loadSnapshot={() => pending} />);
    expect(screen.getByRole("status", { name: "正在读取本地核心公开状态" })).toHaveTextContent("核心连接中");

    await act(async () => {
      settle?.({ ok: true, source: "tauri", snapshot: VALID_SNAPSHOT });
      await pending;
    });

    expect(screen.getByRole("status", { name: /本地核心已连接/ })).toHaveTextContent("核心 0.1.1");
  });

  it("失败只呈现稳定 code，不呈现 rejected promise 的原始文本", async () => {
    render(
      <BackendStatus
        loadSnapshot={() => Promise.reject(new Error("cookie=SECRET; raw ipc trace"))}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(APP_SNAPSHOT_ERROR_CODES.unavailable);
    expect(alert).not.toHaveTextContent("SECRET");
    expect(alert).not.toHaveTextContent("raw ipc trace");
  });

  it("明确呈现非 Tauri 浏览器 fixture 回退", async () => {
    render(
      <BackendStatus
        loadSnapshot={() => Promise.resolve({
          ok: true,
          source: "browserFixture",
          snapshot: { ...VALID_SNAPSHOT, appVersion: "browser-fixture" },
        })}
      />,
    );

    expect(await screen.findByRole("status", { name: /未连接 Tauri 核心/ })).toHaveTextContent("浏览器预览");
  });
});
