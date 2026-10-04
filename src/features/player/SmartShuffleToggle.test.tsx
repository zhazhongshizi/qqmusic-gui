import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmartShuffleToggle } from "./SmartShuffleToggle";

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("../../backend/smartShuffleAdapter", () => ({ getSmartShuffleStatus: mocks.get, setSmartShuffleEnabled: mocks.set }));

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  mocks.get.mockReset().mockResolvedValue({ enabled: false, likesLoaded: false });
  mocks.set.mockReset();
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

describe("experimental smart shuffle", () => {
  it("enables and disables only after native confirmation", async () => {
    render(<SmartShuffleToggle />);
    const button = screen.getByRole("menuitemcheckbox");
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveAttribute("aria-checked", "false");
    mocks.set.mockResolvedValueOnce({ enabled: true, likesLoaded: true });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-checked", "true"));
    expect(mocks.set).toHaveBeenCalledWith(true);
    mocks.set.mockResolvedValueOnce({ enabled: false, likesLoaded: false });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-checked", "false"));
    expect(mocks.set).toHaveBeenLastCalledWith(false);
  });

  it("shows unavailable likes without claiming favorite weighting", async () => {
    mocks.get.mockResolvedValue({ enabled: true, likesLoaded: false });
    render(<SmartShuffleToggle />);
    expect(await screen.findByText(/喜欢列表暂未同步/)).toBeInTheDocument();
  });

  it("restores the saved enabled state on mount", async () => {
    mocks.get.mockResolvedValue({ enabled: true, likesLoaded: true });
    render(<SmartShuffleToggle />);
    await waitFor(() => expect(screen.getByRole("menuitemcheckbox")).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText(/下次启动保持开启/)).toBeInTheDocument();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("preserves the switch on save failure", async () => {
    mocks.set.mockRejectedValue(new Error("disk"));
    render(<SmartShuffleToggle />);
    const button = screen.getByRole("menuitemcheckbox");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("设置失败");
    expect(button).toHaveAttribute("aria-checked", "false");
  });

  it("does not pretend browser fixtures have a native experiment", () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    render(<SmartShuffleToggle />);
    expect(screen.getByRole("menuitemcheckbox")).toBeDisabled();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
