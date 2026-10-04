import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PlaybackHistory from "./PlaybackHistory";
import LibraryWorkspace from "./LibraryWorkspace";

const mocks = vi.hoisted(() => ({ read: vi.fn(), play: vi.fn() }));
vi.mock("../../backend/historyAdapter", () => ({ getPlaybackHistory: mocks.read }));
vi.mock("../player/historyPlayback", () => ({ playHistoryEntry: mocks.play }));
const rows = Array.from({ length: 21 }, (_, i) => ({ id: `song-${i}`, title: `历史歌曲${i}`, artist: `歌手${i}`, playedAtUnixMs: 1_700_000_000_000 - i * 1_000 }));
beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  mocks.read.mockReset().mockResolvedValue(rows);
  mocks.play.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

it("shows persisted history through the library route without requiring login", async () => {
  render(<LibraryWorkspace initialSection="history" authSnapshot={{ state: "signedOut" }} authRecovering={false} onBack={() => {}} />);
  expect(await screen.findByText("历史歌曲0")).toBeInTheDocument();
  expect(screen.queryByText(/账号曲库将在登录验收后开放/)).not.toBeInTheDocument();
  expect(mocks.read).toHaveBeenCalled();
});

it("paginates and searches all history, including items beyond the first page", async () => {
  render(<PlaybackHistory />);
  await screen.findByText("历史歌曲0");
  expect(screen.queryByText("历史歌曲20")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByText("历史歌曲20")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "歌手0" } });
  expect(screen.getByText("历史歌曲0")).toBeInTheDocument();
  expect(screen.queryByText("历史歌曲20")).not.toBeInTheDocument();
});

it("distinguishes empty history from search misses and read errors", async () => {
  mocks.read.mockRejectedValueOnce(new Error("private database path"));
  render(<PlaybackHistory />);
  expect(await screen.findByRole("alert")).toHaveTextContent("本地历史读取失败");
  expect(screen.queryByText(/private database path/)).not.toBeInTheDocument();
  mocks.read.mockResolvedValue([]);
  fireEvent.click(screen.getByRole("button", { name: "重新读取历史" }));
  await screen.findByText("还没有播放记录");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "不存在" } });
  expect(screen.getByText("没有找到匹配的历史歌曲")).toBeInTheDocument();
});

it("plays the selected historical track and exposes a recoverable playback error", async () => {
  mocks.play.mockRejectedValue(new Error("unavailable"));
  render(<PlaybackHistory />);
  fireEvent.click(await screen.findByRole("button", { name: "播放 历史歌曲0" }));
  await waitFor(() => expect(mocks.play).toHaveBeenCalledWith(rows[0]));
  expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法播放");
});

it("does not substitute fixtures for real history in a browser", () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  render(<PlaybackHistory />);
  expect(screen.getByText("请在桌面版查看本地播放历史")).toBeInTheDocument();
  expect(mocks.read).not.toHaveBeenCalled();
});
