import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import UpdateSettings, { UpdateNotice } from "./UpdateSettings";
import { installPlaybackTransport } from "../../backend/playbackTransport";
const api = vi.hoisted(() => vi.fn());
vi.mock("../../backend/updateAdapter", () => ({ updatesControl: api }));
const fixture = { currentVersion: "1.0.1", buildChannel: "Debug", automatic: false, state: "available", checkedMs: 1000,
  release: { version: "1.10.0", name: "新的稳定版", notes: "<script>text</script>", url: "https://github.com/zhazhongshizi/qqmusic-gui/releases/tag/v1.10.0", publishedAt: null },
  applicationData: "C:\\AppData", localMusic: "D:\\播放器\\local-music", smartShuffle: "D:\\播放器\\smart-shuffle.sqlite3", migrationBackups: "C:\\AppData\\migration-backups" };
beforeEach(() => {
  installPlaybackTransport(async () => null); api.mockReset().mockResolvedValue(fixture);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); installPlaybackTransport(null); });
it("shows the current build, plain release notes, migration locations and returns focus", async () => {
  render(<UpdateSettings />); const trigger = screen.getByRole("menuitem"); fireEvent.click(trigger);
  expect(await screen.findByText("Debug · 开发测试版本")).toBeInTheDocument();
  expect(screen.getByText("<script>text</script>")).toBeInTheDocument(); expect(document.querySelector("dialog script")).toBeNull();
  fireEvent.click(screen.getByText("升级前的数据位置与迁移说明")); expect(screen.getByText(fixture.applicationData)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "打开此版本发行页 ↗" })); await waitFor(() => expect(api).toHaveBeenCalledWith({ action: "openRelease" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭更新设置" })); expect(screen.queryByRole("dialog")).toBeNull(); expect(trigger).toHaveFocus();
});
it("keeps a failed preference write unchecked and recovers from an offline manual check", async () => {
  api.mockResolvedValue({ ...fixture, state: "idle", release: null }); render(<UpdateSettings presentation="rhine" />);
  fireEvent.click(screen.getByRole("button", { name: "版本与更新" })); const checkbox = await screen.findByRole("checkbox");
  api.mockRejectedValueOnce(new Error("disk full")); fireEvent.click(checkbox);
  expect(await screen.findByRole("alert")).toHaveTextContent("更新设置未能保存"); expect(checkbox).not.toBeChecked();
  api.mockResolvedValueOnce({ ...fixture, state: "unavailable", release: null }); fireEvent.click(screen.getByRole("button", { name: "检查新版本" }));
  expect(await screen.findByText(/暂时无法检查更新/)).toBeInTheDocument();
  api.mockResolvedValueOnce(fixture); fireEvent.click(screen.getByRole("button", { name: "检查新版本" })); expect(await screen.findByText("发现新的稳定版本。")).toBeInTheDocument();
});
it("offers a dismissible nonmodal notice without taking focus", async () => {
  render(<><button>播放控制</button><UpdateNotice /></>); screen.getByText("播放控制").focus();
  expect(await screen.findByLabelText("新版本提示")).toBeInTheDocument(); expect(screen.getByText("播放控制")).toHaveFocus(); expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "稍后" })); expect(screen.queryByLabelText("新版本提示")).toBeNull();
});
it("keeps modal keyboard events away from the underlying settings menu", async () => {
  const keyHandler = vi.fn(); render(<section onKeyDown={keyHandler}><UpdateSettings /></section>);
  fireEvent.click(screen.getByRole("menuitem")); await screen.findByRole("checkbox");
  fireEvent.keyDown(screen.getByRole("checkbox"), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("checkbox"), { key: "Escape" });
  expect(keyHandler).not.toHaveBeenCalled();
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: false, cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.getByRole("menuitem")).toHaveFocus();
});
