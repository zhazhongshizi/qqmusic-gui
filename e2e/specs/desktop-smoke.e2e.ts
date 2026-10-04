import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { $, browser, expect } from "@wdio/globals";

describe("QQ Music GUI desktop smoke", () => {
  it("launches the real Tauri webview, reads backend state, and closes a dialog", async () => {
    const brand = await $(".top-bar__brand strong");
    await expect(brand).toHaveText("QQ Music GUI");

    const backend = await $(".backend-status--ready");
    await backend.waitForDisplayed();
    await expect(backend).toHaveText("核心 0.1.1");
    expect(await backend.getAttribute("aria-label")).toContain("Provider 已就绪");

    const account = await $('button[aria-label="账号"]');
    await account.click();
    const login = await $('[role="dialog"][aria-labelledby="login-dialog-title"]');
    await login.waitForDisplayed();
    const loginText = await login.getText();
    expect(loginText.includes("QQ 扫码") || loginText.includes("登录成功")).toBe(true);
    expect(loginText).not.toContain("credential");
    await $('button[aria-label="关闭登录窗口"]').click();
    await login.waitForExist({ reverse: true });

    const nativeVolume = await browser.executeAsync((done) => {
      const tauri = (globalThis as typeof globalThis & {
        __TAURI__?: { core?: { invoke?: (command: string, payload?: object) => Promise<unknown> } };
      }).__TAURI__;
      const invoke = tauri?.core?.invoke;
      if (!invoke) {
        done({ ok: false, code: "tauri_global_missing" });
        return;
      }
      void invoke("player_set_volume", { volume: 0.35 }).then(
        (result: unknown) => done({ ok: true, result }),
        () => done({ ok: false, code: "player_command_failed" }),
      );
    });
    expect(nativeVolume).toMatchObject({
      ok: true,
      result: { state: "idle", volume: 0.35, currentTrack: null },
    });

    const nativeQueue = await browser.executeAsync((done) => {
      const tauri = (globalThis as typeof globalThis & {
        __TAURI__?: { core?: { invoke?: (command: string) => Promise<unknown> } };
      }).__TAURI__;
      const invoke = tauri?.core?.invoke;
      if (!invoke) {
        done({ ok: false, code: "tauri_global_missing" });
        return;
      }
      void invoke("queue_snapshot").then(
        (result: unknown) => done({ ok: true, result }),
        () => done({ ok: false, code: "queue_command_failed" }),
      );
    });
    expect(nativeQueue).toMatchObject({
      ok: true,
      result: { generation: 0 },
    });
    expect(JSON.stringify(nativeQueue)).not.toContain("http");
    expect(JSON.stringify(nativeQueue)).not.toContain("cookie");

    const invalidLyrics = await browser.executeAsync((done) => {
      const tauri = (globalThis as typeof globalThis & {
        __TAURI__?: { core?: { invoke?: (command: string, payload?: object) => Promise<unknown> } };
      }).__TAURI__;
      const invoke = tauri?.core?.invoke;
      if (!invoke) {
        done({ ok: false, code: "tauri_global_missing" });
        return;
      }
      void invoke("lyrics_get", { trackId: "bad/id", generation: 0 }).then(
        () => done({ ok: false, code: "invalid_lyrics_accepted" }),
        (error: unknown) => {
          const value = error as { code?: unknown; operation?: unknown };
          done({
            ok: true,
            code: typeof value?.code === "string" ? value.code : "missing_code",
            operation: typeof value?.operation === "string" ? value.operation : "missing_operation",
          });
        },
      );
    });
    expect(invalidLyrics).toMatchObject({
      ok: true,
      code: "invalid_request",
      operation: "catalog_read",
    });
    expect(JSON.stringify(invalidLyrics)).not.toContain("bad/id");

    const invalidCatalog = await browser.executeAsync((done) => {
      const tauri = (globalThis as typeof globalThis & {
        __TAURI__?: { core?: { invoke?: (command: string, payload?: object) => Promise<unknown> } };
      }).__TAURI__;
      const invoke = tauri?.core?.invoke;
      if (!invoke) {
        done({ ok: false, code: "tauri_global_missing" });
        return;
      }
      void invoke("catalog_search_songs", {
        keyword: "",
        page: 1,
        pageSize: 20,
        generation: 0,
      }).then(
        () => done({ ok: false, code: "invalid_catalog_accepted" }),
        (error: unknown) => {
          const value = error as { code?: unknown; operation?: unknown };
          done({
            ok: true,
            code: typeof value?.code === "string" ? value.code : "missing_code",
            operation: typeof value?.operation === "string" ? value.operation : "missing_operation",
          });
        },
      );
    });
    expect(invalidCatalog).toMatchObject({
      ok: true,
      code: "invalid_request",
      operation: "catalog_read",
    });

    const openQueue = await $('button[aria-label="打开播放队列"]');
    await openQueue.click();
    const queue = await $('[role="dialog"][aria-labelledby="player-queue-title"]');
    await queue.waitForDisplayed();
    await expect(await queue.getText()).toContain("本地队列");

    await $('button[aria-label="关闭播放队列"]').click();
    await queue.waitForExist({ reverse: true });

    const evidenceRoot = resolve("output", "wdio");
    await mkdir(evidenceRoot, { recursive: true });
    await browser.saveScreenshot(resolve(evidenceRoot, "desktop-smoke.png"));
  });
});
