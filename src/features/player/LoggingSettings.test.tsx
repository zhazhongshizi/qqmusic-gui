import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoggingSettings } from "./LoggingSettings";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  invoke.mockReset().mockResolvedValue({ enabled: false, error: null });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
it("restores persisted state and confirms changes from the backend", async () => {
  invoke.mockResolvedValueOnce({ enabled: true, error: null });
  render(<LoggingSettings />);
  const button = screen.getByRole("menuitemcheckbox");
  await waitFor(() => expect(button).toHaveAttribute("aria-checked", "true"));
  fireEvent.click(button);
  await waitFor(() => expect(button).toHaveAttribute("aria-checked", "false"));
  expect(invoke).toHaveBeenLastCalledWith("logging_set_enabled", { enabled: false });
});
it("does not claim success when saving fails", async () => {
  render(<LoggingSettings />);
  const button = screen.getByRole("menuitemcheckbox");
  await waitFor(() => expect(button).not.toBeDisabled());
  invoke.mockRejectedValueOnce(new Error("private path must not appear"));
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("目录写入权限");
  expect(button).toHaveAttribute("aria-checked", "false");
  expect(screen.queryByText(/private path/)).not.toBeInTheDocument();
});
it("shows write failures restored at startup", async () => {
  invoke.mockResolvedValueOnce({ enabled: true, error: "日志写入失败" });
  render(<LoggingSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("日志写入失败");
});
