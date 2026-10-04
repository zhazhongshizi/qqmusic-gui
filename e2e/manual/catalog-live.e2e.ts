import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { $, browser, expect } from "@wdio/globals";

describe("QQ Music GUI live anonymous catalog", () => {
  it("renders the real discover page and adds one normalized song to the isolated local queue", async () => {
    await $('button*=曲库').click();
    const liveMarker = await $(".library-sidebar__foot strong");
    await liveMarker.waitForDisplayed({ timeout: 20_000 });
    await expect(liveMarker).toHaveText("QQ / LIVE");

    const firstTrack = await $(".catalog-table tbody tr:first-child .catalog-table__title");
    await firstTrack.waitForDisplayed({ timeout: 20_000 });
    const title = (await firstTrack.$("strong").getText()).trim();
    expect(title.length).toBeGreaterThan(0);
    expect(title).not.toContain("暮色温室");

    const add = await $('button=加入本地队列');
    await add.click();
    const notice = await $(".catalog-inspector__notice");
    await notice.waitForDisplayed();
    await expect(notice).toHaveText("已加入本地队列");

    const evidenceRoot = resolve("output", "wdio");
    await mkdir(evidenceRoot, { recursive: true });
    await browser.saveScreenshot(resolve(evidenceRoot, "live-catalog.png"));
  });
});
