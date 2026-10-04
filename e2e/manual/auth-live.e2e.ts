import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { $, browser, expect } from "@wdio/globals";

describe("QQ Music GUI live QR acceptance", () => {
  it("keeps a real QQ QR session alive until the user authenticates", async function () {
    this.timeout(210_000);

    const backend = await $(".backend-status--ready");
    await backend.waitForDisplayed();
    expect(await backend.getAttribute("aria-label")).toContain("Provider 已就绪");

    await $('button[aria-label="账号"]').click();
    const qqLogin = await $("button*=QQ 扫码");
    await qqLogin.waitForClickable();
    await qqLogin.click();

    const qrImage = await $('img[alt="QQ 登录二维码"]');
    await qrImage.waitForDisplayed({ timeout: 30_000 });
    const evidenceRoot = resolve("output", "wdio");
    await mkdir(evidenceRoot, { recursive: true });
    const screenshot = resolve(evidenceRoot, "auth-live-qr.png");
    await browser.saveScreenshot(screenshot);
    console.log(`AUTH_QR_READY ${screenshot}`);

    const success = await $("h3=登录成功");
    await success.waitForDisplayed({ timeout: 175_000, interval: 500 });
    await expect(success).toBeDisplayed();
    await browser.saveScreenshot(resolve(evidenceRoot, "auth-live-success.png"));
  });
});
