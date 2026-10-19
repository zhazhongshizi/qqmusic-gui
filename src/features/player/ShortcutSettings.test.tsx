import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShortcutSettings } from "./ShortcutSettings";
import { defaultShortcuts, type ShortcutSettingsValue } from "../../contracts/shortcuts";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let saved: ShortcutSettingsValue;
beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  saved = defaultShortcuts();
  invoke.mockReset().mockImplementation(async (_command, { request }) => {
    if (request.action === "save") saved = structuredClone(request.settings);
    return { settings: structuredClone(saved), errors: [] };
  });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
async function ready() { await waitFor(() => expect(screen.getByRole("button", { name: "保存快捷键" })).toBeEnabled()); }

it("normal settings expand on demand and include the new play/pause shortcut", async () => {
  render(<ShortcutSettings />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("快捷键设置"));
  await ready();
  expect(screen.getByRole("button", { name: "修改播放／暂停快捷键" })).toHaveTextContent("Ctrl + Alt + 空格");
  expect(screen.getAllByRole("checkbox")).toHaveLength(6);
});

it("master switch saves disabled state while retaining each configured combination", async () => {
  render(<ShortcutSettings presentation="rhine" />); await ready();
  fireEvent.click(screen.getByRole("checkbox", { name: "启用全局快捷键" }));
  expect(screen.getByRole("checkbox", { name: "启用下一首快捷键" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  await screen.findByText("快捷键已保存并生效");
  expect(saved.enabled).toBe(false);
  expect(saved.bindings).toEqual(defaultShortcuts().bindings);
});

it("can disable one action and edit another combination without affecting the rest", async () => {
  render(<ShortcutSettings presentation="rhine" />); await ready();
  fireEvent.click(screen.getByRole("checkbox", { name: "启用上一首快捷键" }));
  fireEvent.click(screen.getByRole("button", { name: "修改下一首快捷键" }));
  const group = within(screen.getByRole("group", { name: "下一首组合键" }));
  fireEvent.click(group.getByRole("checkbox", { name: "Alt" }));
  fireEvent.click(group.getByRole("checkbox", { name: "Shift" }));
  fireEvent.change(group.getByRole("combobox", { name: "下一首主键" }), { target: { value: "KeyK" } });
  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  await screen.findByText("快捷键已保存并生效");
  expect(saved.bindings.find(item => item.action === "next")?.shortcut).toBe("Control+Shift+KeyK");
  expect(saved.bindings.find(item => item.action === "previous")?.enabled).toBe(false);
  expect(saved.bindings.find(item => item.action === "volumeUp")).toEqual(defaultShortcuts().bindings[3]);
});

it("keeps drafts after a conflict, reports failure, and allows retry", async () => {
  render(<ShortcutSettings presentation="rhine" />); await ready();
  fireEvent.click(screen.getByRole("checkbox", { name: "启用下一首快捷键" }));
  invoke.mockRejectedValueOnce("播放／暂停的快捷键注册失败，可能已被其他程序占用。配置未保存");
  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("配置未保存");
  expect(screen.queryByText("快捷键已保存并生效")).not.toBeInTheDocument();
  expect(saved.bindings.find(item => item.action === "next")?.enabled).toBe(true);
  expect(screen.getByRole("checkbox", { name: "启用下一首快捷键" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  await screen.findByText("快捷键已保存并生效");
  expect(saved.bindings.find(item => item.action === "next")?.enabled).toBe(false);
});

it("shares persisted configuration across normal and Rhine editors and resets only on save", async () => {
  saved.enabled = false; saved.bindings[0]!.shortcut = "Control+KeyP";
  const view = render(<ShortcutSettings presentation="rhine" />); await ready();
  expect(screen.getByRole("checkbox", { name: "启用全局快捷键" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "恢复默认快捷键" }));
  expect(saved.enabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  await screen.findByText("快捷键已保存并生效"); view.unmount();
  render(<ShortcutSettings />); fireEvent.click(screen.getByText("快捷键设置")); await ready();
  expect(screen.getByRole("checkbox", { name: "启用全局快捷键" })).toBeChecked();
  expect(saved).toEqual(defaultShortcuts());
});

it("shows startup registration errors and allows reading to be retried", async () => {
  invoke.mockRejectedValueOnce(new Error("private path"));
  render(<ShortcutSettings presentation="rhine" />);
  fireEvent.click(await screen.findByRole("button", { name: "重新读取快捷键配置" }));
  await ready();
  expect(screen.queryByText(/private path/)).not.toBeInTheDocument();
  cleanup();
  invoke.mockResolvedValueOnce({ settings: saved, errors: ["下一首的快捷键无法启用"] });
  render(<ShortcutSettings presentation="rhine" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("下一首的快捷键无法启用");
});

it("does not intercept select navigation or send desktop commands in browser preview", () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  const parentKey = vi.fn();
  render(<div onKeyDown={parentKey}><ShortcutSettings presentation="rhine" /></div>);
  const master = screen.getByRole("checkbox", { name: "启用全局快捷键" });
  fireEvent.keyDown(master, { key: "ArrowDown" }); expect(parentKey).not.toHaveBeenCalled();
  fireEvent.keyDown(master, { key: "Escape" }); expect(parentKey).toHaveBeenCalledOnce();
  expect(master).toBeDisabled(); expect(invoke).not.toHaveBeenCalled();
});
