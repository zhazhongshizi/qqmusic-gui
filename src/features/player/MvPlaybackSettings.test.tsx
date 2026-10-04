import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MvFallbackSetting } from "./MvPlaybackSettings";

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock("../../backend/settingsAdapter", () => ({ nativeSettingsSnapshot: mocks.read, nativeSetMvFallbackEnabled: mocks.save }));
afterEach(() => { cleanup(); vi.resetAllMocks(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

it("uses the saved MV preference and only updates after persistence succeeds", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  mocks.read.mockResolvedValue({ mvFallbackEnabled: false });
  mocks.save.mockResolvedValue({ mvFallbackEnabled: true });
  render(<MvFallbackSetting />);
  const checkbox = screen.getByRole("checkbox");
  await waitFor(() => expect(checkbox).toBeEnabled());
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox).toBeChecked());
  expect(mocks.save).toHaveBeenCalledWith(true);
});

it("does not display an unsaved MV preference as successfully enabled", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  mocks.read.mockResolvedValue({ mvFallbackEnabled: false });
  mocks.save.mockRejectedValue(new Error("disk write failed"));
  render(<MvFallbackSetting />);
  const checkbox = screen.getByRole("checkbox");
  await waitFor(() => expect(checkbox).toBeEnabled());
  fireEvent.click(checkbox);
  await screen.findByRole("alert");
  expect(checkbox).not.toBeChecked();
});
