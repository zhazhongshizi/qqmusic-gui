import { afterEach, expect, it, vi } from "vitest";
import { installPlaybackTransport } from "./playbackTransport";
import { parseUpdateSnapshot, updatesControl } from "./updateAdapter";
export const fixture = { currentVersion: "1.0.1", buildChannel: "Debug", automatic: false, state: "available", checkedMs: 1000,
  release: { version: "1.10.0", name: "新的稳定版", notes: "<script>text</script>", url: "https://github.com/zhazhongshizi/qqmusic-gui/releases/tag/v1.10.0", publishedAt: null },
  applicationData: "C:\\AppData", localMusic: "D:\\播放器\\local-music", smartShuffle: "D:\\播放器\\smart-shuffle.sqlite3", migrationBackups: "C:\\AppData\\migration-backups" };
afterEach(() => installPlaybackTransport(null));
it("accepts stable official release metadata and rejects foreign links, missing metadata and unknown fields", () => {
  expect(parseUpdateSnapshot(fixture).release?.version).toBe("1.10.0");
  for (const release of [{ ...fixture.release, url: "https://evil.test/release" }, { ...fixture.release, url: fixture.release.url + "?next=evil" }, null]) {
    expect(() => parseUpdateSnapshot({ ...fixture, release })).toThrow();
  }
  expect(() => parseUpdateSnapshot({ ...fixture, checkedMs: -1 })).toThrow();
  expect(() => parseUpdateSnapshot({ ...fixture, downloadUrl: "https://evil.test" })).toThrow();
});
it("sends only a typed action and signals completed changes without polling event loops", async () => {
  const transport = vi.fn().mockResolvedValue(fixture), changed = vi.fn();
  installPlaybackTransport(transport); window.addEventListener("updates-changed", changed);
  try {
    await updatesControl({ action: "status" }); expect(changed).not.toHaveBeenCalled();
    await updatesControl({ action: "setAutomatic", enabled: true });
    expect(transport).toHaveBeenLastCalledWith("updates_control", { request: { action: "setAutomatic", enabled: true } }); expect(changed).toHaveBeenCalledOnce();
  } finally { window.removeEventListener("updates-changed", changed); }
});
