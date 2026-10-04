import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { getCurrentTrack, playerActions, resetPlayerFixture } from "../player/playerStore";
import type { LyricLine } from "../player/fixtures";
import { TapeDeck } from "./TapeDeck";

afterEach(() => { cleanup(); resetPlayerFixture(); });

it("提供三档音质选择，支持键盘切换和 Escape 返回按钮", async () => {
  resetPlayerFixture();
  const user = userEvent.setup();
  render(<TapeDeck onBack={() => {}} onQueue={() => {}} onLyrics={() => {}} />);
  const trigger = screen.getByRole("button", { name: "期望音质：无损优先" });
  await user.click(trigger);
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  const updatedTrigger = screen.getByRole("button", { name: "期望音质：标准 128k" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(updatedTrigger).toHaveFocus();
  expect(getCurrentTrack()?.expectedQuality).toBe("标准");
  await user.click(updatedTrigger);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(updatedTrigger).toHaveFocus();
});

it("本地音乐显示文件音质，不提供在线音质切换", () => {
  const track = { id: `local_${"a".repeat(64)}_flac`, title: "本地歌", artist: "歌手", album: "专辑", durationMs: 10000 };
  playerActions.applyAuthoritativeSession({
    requestedQuality: "320k", mode: "sequence",
    queue: { generation: 1, selectedIndex: 0, items: [track] },
    player: { state: "playing", generation: 1, currentTrack: track, positionMs: 0, durationMs: 10000, volume: .5, muted: false, failure: null },
  });
  render(<TapeDeck onBack={() => {}} onQueue={() => {}} onLyrics={() => {}} />);
  expect(screen.getByText("本地文件")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /期望音质/ })).not.toBeInTheDocument();
});

it("在权威快照和轮询中显示 MV 音轨，切回原曲后移除标识", () => {
  const track = { id: "mv-test", title: "测试歌曲", artist: "歌手", album: "专辑", durationMs: 240000 };
  const queue = { generation: 1, selectedIndex: 0, items: [track] };
  const player = { state: "playing" as const, generation: 1, currentTrack: { id: track.id, title: track.title, artist: track.artist, source: "qq-mv" as const }, positionMs: 0, durationMs: 317000, volume: .5, muted: false, failure: null };
  playerActions.applyAuthoritativeSession({ requestedQuality: "320k", mode: "sequence", queue, player });
  playerActions.applyAuthoritativeSession({ requestedQuality: "320k", mode: "sequence", queue, player: { ...player, positionMs: 1000 } });
  expect(getCurrentTrack()?.actualQuality).toBe("QQ MV 音轨");
  expect(getCurrentTrack()?.durationMs).toBe(317000);
  render(<TapeDeck onBack={() => {}} onQueue={() => {}} onLyrics={() => {}} />);
  expect(screen.getByText("QQ MV 音轨")).toBeInTheDocument();
  cleanup();
  playerActions.applyAuthoritativeSession({ requestedQuality: "320k", mode: "sequence", queue, player: { ...player, generation: 2, currentTrack: { id: track.id, title: track.title, artist: track.artist } } });
  expect(getCurrentTrack()?.actualQuality).toBe("未知音质");
});

function renderLyrics(lyrics: LyricLine[], positionMs = 1500) {
  const track = { id: "lyric-test", title: "测试歌曲", artist: "歌手", album: "专辑", durationMs: 10000 };
  playerActions.applyAuthoritativeSession({
    requestedQuality: "320k", mode: "sequence",
    queue: { generation: 1, selectedIndex: 0, items: [track] },
    player: { state: "playing", generation: 1, currentTrack: track, positionMs, durationMs: 10000, volume: .5, muted: false, failure: null },
  });
  playerActions.applyTimedLyrics(track.id, 1, lyrics);
  const onLyrics = vi.fn();
  render(<TapeDeck onBack={() => {}} onQueue={() => {}} onLyrics={onLyrics} />);
  return onLyrics;
}

it("显示当前原文及对应翻译，保留展开完整歌词操作", () => {
  const onLyrics = renderLyrics([
    { atMs: 1000, original: "どんな色だって", translation: "无论是什么颜色" },
    { atMs: 2000, original: "つくれるはずなんだよ", translation: "都应该能创造出来" },
  ]);
  const button = screen.getByRole("button", { name: "展开完整歌词" });
  expect(button.querySelector("span")).toHaveTextContent("どんな色だって");
  expect(button.querySelector("small")).toHaveTextContent("无论是什么颜色");
  expect(screen.queryByText("つくれるはずなんだよ")).not.toBeInTheDocument();
  fireEvent.click(button);
  expect(onLyrics).toHaveBeenCalledOnce();
});

it.each([undefined, "   "])("缺少翻译时只显示原文 (%s)", translation => {
  renderLyrics([{ atMs: 1000, original: "只有原文", translation }]);
  const button = screen.getByRole("button", { name: "展开完整歌词" });
  expect(button).toHaveTextContent("只有原文");
  expect(button.querySelector("small")).toBeNull();
});

it.each([
  { lyrics: [] },
  { lyrics: [{ atMs: 2000, original: "尚未唱到" }] },
  { lyrics: [{ atMs: 1000, original: "   ", translation: "不单独展示翻译" }] },
])("无当前歌词时隐藏歌词区域 %#", ({ lyrics }) => {
  renderLyrics(lyrics);
  expect(screen.queryByRole("button", { name: "展开完整歌词" })).not.toBeInTheDocument();
});
