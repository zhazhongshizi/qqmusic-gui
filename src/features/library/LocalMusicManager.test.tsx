import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LocalMusicManager from "./LocalMusicManager";
import type { CatalogStatus } from "../../backend/localCatalogAdapter";
const api = vi.hoisted(() => vi.fn());
vi.mock("../../backend/localCatalogAdapter", () => ({ localCatalog: api }));
const directory = { id: "directory-1", path: "D:\\音乐", mode: "reference" as const, available: true, trackCount: 30, missingCount: 2, lastScanMs: 1791500000000 };
const status: CatalogStatus = { directories: [directory], scan: { running: false, cancelled: false, directoryId: "", processed: 0, added: 0, existing: 0, errors: 0, failures: [] } };
beforeEach(() => {
  api.mockReset().mockResolvedValue(status);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);
it("loads directory status, explains modes, and delegates selection to the native picker", async () => {
  const changed = vi.fn().mockResolvedValue(undefined);
  render(<LocalMusicManager onChanged={changed} />);
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "管理音乐目录" }));
  expect(await screen.findByText("D:\\音乐")).toBeInTheDocument();
  expect(screen.getByText(/30 首/)).toHaveTextContent("2 个文件待修复");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "copy" } });
  expect(screen.getByText(/需预留磁盘空间/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "添加音乐目录" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith({ action: "add", mode: "copy" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
});
it("requires a second click to remove only the directory index", async () => {
  render(<LocalMusicManager onChanged={vi.fn().mockResolvedValue(undefined)} />);
  fireEvent.click(screen.getByRole("button", { name: "管理音乐目录" }));
  fireEvent.click(await screen.findByRole("button", { name: "移除目录" }));
  expect(api).not.toHaveBeenCalledWith({ action: "remove", id: directory.id });
  fireEvent.click(screen.getByRole("button", { name: "确认仅移除索引" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith({ action: "remove", id: directory.id }));
  expect(await screen.findByText("目录索引已移除，原文件和已复制的音乐均保留。")).toBeInTheDocument();
});
it("allows cancellation while scanning and displays partial error records", async () => {
  api.mockResolvedValue({ ...status, scan: { ...status.scan, running: true, directoryId: directory.id, processed: 12, errors: 1, failures: [{ fileName: "损坏.flac", code: "local_music_metadata_unreadable" }] } });
  render(<LocalMusicManager onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "管理音乐目录" }));
  const cancel = await screen.findByRole("button", { name: "取消扫描" });
  expect(screen.getByRole("button", { name: "重新扫描" })).toBeDisabled();
  expect(screen.getByText(/损坏.flac/)).toBeInTheDocument();
  fireEvent.click(cancel);
  await waitFor(() => expect(api).toHaveBeenCalledWith({ action: "cancel" }));
});
it("relocates by ID, closes the modal and returns focus", async () => {
  render(<LocalMusicManager onChanged={vi.fn().mockResolvedValue(undefined)} />);
  const trigger = screen.getByRole("button", { name: "管理音乐目录" });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("button", { name: "重新定位" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith({ action: "relocate", id: directory.id }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "关闭目录管理" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
