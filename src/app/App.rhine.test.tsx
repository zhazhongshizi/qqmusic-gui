import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { App, UI_MODE_STORAGE_KEY } from "./App";
import { resetPlayerFixture } from "../features/player/playerStore";
const state = vi.hoisted(() => ({ mounts: vi.fn(), unmounts: vi.fn(), bridges: vi.fn() }));
vi.mock("../features/rhine/RhineMode", () => ({ default: ({ onExit }: { onExit: () => void }) => {
  useEffect(() => { state.mounts(); return () => { state.unmounts(); }; }, []);
  return <button onClick={onExit}>退出测试莱茵</button>;
} }));
vi.mock("../features/player/NativePlayerBridge", () => ({ NativePlayerBridge: () => {
  useEffect(() => { state.bridges(); }, []); return null;
} }));
beforeEach(() => { localStorage.removeItem(UI_MODE_STORAGE_KEY); resetPlayerFixture(); });
afterEach(() => { cleanup(); localStorage.removeItem(UI_MODE_STORAGE_KEY); vi.clearAllMocks(); });
it("普通模式不挂载重型界面，切换并退出只卸载界面且保存选择", async () => {
  render(<App />);
  expect(state.mounts).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "莱茵界面" }));
  fireEvent.click(await screen.findByRole("button", { name: "退出测试莱茵" }));
  await screen.findByRole("button", { name: "更多" });
  expect(state.unmounts).toHaveBeenCalledTimes(1);
  expect(state.bridges).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(UI_MODE_STORAGE_KEY)).toBe("normal");
});
it("记住莱茵模式并在下次挂载时恢复", async () => {
  localStorage.setItem(UI_MODE_STORAGE_KEY, "rhine");
  render(<App />);
  await screen.findByRole("button", { name: "退出测试莱茵" });
  await waitFor(() => expect(state.mounts).toHaveBeenCalledTimes(1));
  expect(localStorage.getItem(UI_MODE_STORAGE_KEY)).toBe("rhine");
});
