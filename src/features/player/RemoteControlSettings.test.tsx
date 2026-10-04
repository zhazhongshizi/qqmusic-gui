import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemoteControlSettings } from "./RemoteControlSettings";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const off = { enabled: false, addresses: [], pairingCode: null };
const on = { enabled: true, addresses: ["http://192.168.1.10:19653", "http://127.0.0.1:19653"], pairingCode: "a".repeat(32) };
beforeEach(() => { Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} }); invoke.mockReset().mockResolvedValue(off); });
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
it("shows confirmed connection information, and removes it when disabled", async () => {
  render(<RemoteControlSettings />);
  const toggle = screen.getByRole("menuitemcheckbox");
  await waitFor(() => expect(toggle).not.toBeDisabled());
  invoke.mockResolvedValueOnce(on); fireEvent.click(toggle);
  expect(await screen.findByDisplayValue("http://192.168.1.10:19653")).toBeInTheDocument();
  expect(invoke).toHaveBeenLastCalledWith("remote_set_enabled", { enabled: true });
  invoke.mockResolvedValueOnce(off); fireEvent.click(toggle);
  await waitFor(() => expect(screen.queryByLabelText("连接码")).not.toBeInTheDocument());
  expect(invoke).toHaveBeenLastCalledWith("remote_set_enabled", { enabled: false });
});
it("keeps the service disabled when binding fails", async () => {
  render(<RemoteControlSettings />);
  const toggle = screen.getByRole("menuitemcheckbox");
  await waitFor(() => expect(toggle).not.toBeDisabled());
  invoke.mockRejectedValueOnce("遥控端口 19653 被占用或无法监听"); fireEvent.click(toggle);
  expect(await screen.findByRole("alert")).toHaveTextContent("端口");
  expect(toggle).toHaveAttribute("aria-checked", "false");
});
it("rejects malformed native connection data", async () => {
  invoke.mockResolvedValue({ ...on, pairingCode: "invalid" }); render(<RemoteControlSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("读取遥控状态失败");
  expect(screen.queryByLabelText("连接码")).not.toBeInTheDocument();
});
it("does not enable a server in a browser fixture", () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); render(<RemoteControlSettings />);
  expect(screen.getByRole("menuitemcheckbox")).toBeDisabled(); expect(invoke).not.toHaveBeenCalled();
});
