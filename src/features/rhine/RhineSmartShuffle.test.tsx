import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RhineSettingsPanel } from "./RhineSettingsPanel";
import { defaultRhineSettings } from "./rhineSettings";
import { SmartShuffleToggle } from "../player/SmartShuffleToggle";

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("../../backend/smartShuffleAdapter", () => ({ getSmartShuffleStatus: mocks.get, setSmartShuffleEnabled: mocks.set }));
const props = { settings: defaultRhineSettings(), backLabel: "返回档案", onRendererChange: vi.fn(), onFrameLimitChange: vi.fn(), onSpatialUpscalingChange: vi.fn(), onQualityChange: vi.fn(), onSuperPerformanceChange: vi.fn(), onCassetteMotionChange: vi.fn(), onReset: vi.fn(), onClose: vi.fn(), onAccount: vi.fn(), onExit: vi.fn() };
let saved = false;
beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  saved = false;
  mocks.get.mockReset().mockImplementation(async () => ({ enabled: saved, likesLoaded: true }));
  mocks.set.mockReset().mockImplementation(async (enabled: boolean) => { saved = enabled; return { enabled, likesLoaded: true }; });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
async function openPlayback() {
  fireEvent.click(screen.getByRole("button", { name: /播放设置/ }));
  const control = screen.getByRole("switch", { name: "智能随机 · 遗忘度" });
  await waitFor(() => expect(control).not.toBeDisabled());
  return control;
}

it("空间超分可切换，并在 2D 与超级性能模式下保留选项但暂停使用", () => {
  const change = vi.fn();
  const view = render(<RhineSettingsPanel {...props} onSpatialUpscalingChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: /详细参数/ }));
  const checkbox = screen.getByLabelText("空间超分（FSR 1 · 试验）");
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  expect(change).toHaveBeenCalledExactlyOnceWith(true);
  view.rerender(<RhineSettingsPanel {...props} settings={{ ...props.settings, renderer: "canvas2d", spatialUpscaling: true }} />);
  expect(checkbox).toBeChecked();
  expect(checkbox).toBeDisabled();
  view.rerender(<RhineSettingsPanel {...props} settings={{ ...props.settings, superPerformance: true, spatialUpscaling: true }} />);
  expect(checkbox).toBeChecked();
  expect(checkbox).toBeDisabled();
  view.rerender(<RhineSettingsPanel {...props} settings={{ ...props.settings, spatialUpscaling: true }} />);
  expect(checkbox).not.toBeDisabled();
});

it("莱茵与普通设置读取和保存同一个智能随机开关", async () => {
  const rhine = render(<RhineSettingsPanel {...props} />);
  const control = await openPlayback();
  expect(control).toHaveAttribute("aria-checked", "false");
  fireEvent.click(control);
  await waitFor(() => expect(control).toHaveAttribute("aria-checked", "true"));
  expect(mocks.set).toHaveBeenCalledExactlyOnceWith(true);
  rhine.unmount();
  const normal = render(<SmartShuffleToggle />);
  const menu = screen.getByRole("menuitemcheckbox");
  await waitFor(() => expect(menu).toHaveAttribute("aria-checked", "true"));
  fireEvent.click(menu);
  await waitFor(() => expect(menu).toHaveAttribute("aria-checked", "false"));
  normal.unmount();
  render(<RhineSettingsPanel {...props} />);
  expect(await openPlayback()).toHaveAttribute("aria-checked", "false");
  expect(mocks.set).toHaveBeenLastCalledWith(false);
  expect(screen.getByText(/仅影响随机播放/)).toBeInTheDocument();
});

it("等待保存确认，失败时保留原状态并允许重试", async () => {
  mocks.get.mockResolvedValue({ enabled: true, likesLoaded: false });
  let rejectSave: (error: Error) => void = () => {};
  mocks.set.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
  render(<RhineSettingsPanel {...props} />);
  const control = await openPlayback();
  expect(screen.getByRole("status")).toHaveTextContent("喜欢列表暂未同步");
  fireEvent.click(control);
  expect(control).toBeDisabled();
  expect(control).toHaveAttribute("aria-checked", "true");
  rejectSave(new Error("private storage path"));
  expect(await screen.findByRole("alert")).toHaveTextContent("智能随机设置失败，请重试");
  expect(control).toHaveAttribute("aria-checked", "true");
  await waitFor(() => expect(control).not.toBeDisabled());
  fireEvent.click(control);
  await waitFor(() => expect(control).toHaveAttribute("aria-checked", "false"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("浏览器展示入口但不伪装成可保存的原生设置", () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  render(<RhineSettingsPanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /播放设置/ }));
  expect(screen.getByRole("switch", { name: "智能随机 · 遗忘度" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("请在桌面版试用");
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.set).not.toHaveBeenCalled();
});
