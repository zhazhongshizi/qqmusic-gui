import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getCurrentTrack, playerActions, resetPlayerFixture } from "../player/playerStore";
import { FIXTURE_TRACKS } from "../player/fixtures";
import { TapeDeck } from "./TapeDeck";

const { previewNext } = vi.hoisted(() => ({ previewNext: vi.fn() }));
vi.mock("../../backend/nativeQueueAdapter", async importOriginal => ({
  ...await importOriginal<typeof import("../../backend/nativeQueueAdapter")>(),
  nativeQueuePreviewNext: previewNext,
}));
beforeEach(() => resetPlayerFixture());
afterEach(() => { cleanup(); resetPlayerFixture(); vi.useRealTimers(); vi.resetAllMocks(); });
const renderDeck = () => render(<TapeDeck onBack={() => {}} onQueue={() => {}} onLyrics={() => {}} />);
const enterOutro = () => act(() => { playerActions.toggle(); playerActions.seek(219000); });

it("无歌词的原生歌曲在结束前三秒显示下一首预告", async () => {
  const items = FIXTURE_TRACKS.slice(0, 2).map(({ title, artist, album, durationMs }, index) => ({ id: `instrumental-${index}`, title, artist, album, durationMs }));
  const player = { generation: 1, state: "playing" as const, currentTrack: { id: items[0]!.id, title: items[0]!.title, artist: items[0]!.artist },
    positionMs: 244999, durationMs: 248000, volume: .5, muted: false, failure: null };
  const session = { requestedQuality: "320k" as const, mode: "sequence" as const,
    queue: { generation: 1, selectedIndex: 0, items }, player };
  previewNext.mockResolvedValue(items[1]!.id);
  playerActions.applyAuthoritativeSession(session);
  renderDeck();
  act(() => playerActions.applyTimedLyrics(items[0]!.id, 1, []));
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  expect(previewNext).not.toHaveBeenCalled();
  act(() => playerActions.applyAuthoritativeSession({ ...session, player: { ...player, positionMs: 245000 } }));
  const panel = await screen.findByRole("complementary", { name: "下一首预告" });
  expect(panel.querySelector('[data-up-next="true"]')).toHaveTextContent(items[1]!.title);
  expect(previewNext).toHaveBeenCalledOnce();
});

it("退场保留旧预告，立即停止交互，300 毫秒后移除", () => {
  vi.useFakeTimers();
  renderDeck();
  enterOutro();
  const panel = screen.getByRole("complementary");
  const text = panel.textContent;
  act(() => playerActions.next());
  expect(panel).toHaveAttribute("data-exiting", "true");
  expect(panel).toHaveAttribute("inert");
  expect(panel).toHaveAttribute("aria-hidden", "true");
  expect(panel.textContent).toBe(text);
  act(() => vi.advanceTimersByTime(299));
  expect(panel).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(panel).not.toBeInTheDocument();
});

it("退场中重新触发可复用面板，旧计时器不会移除新的预告", () => {
  vi.useFakeTimers();
  renderDeck();
  enterOutro();
  const panel = screen.getByRole("complementary");
  act(() => playerActions.seek(100000));
  act(() => vi.advanceTimersByTime(150));
  act(() => playerActions.seek(219000));
  expect(screen.getByRole("complementary")).toBe(panel);
  expect(panel).toHaveAttribute("data-exiting", "false");
  expect(panel).not.toHaveAttribute("inert");
  act(() => vi.advanceTimersByTime(500));
  expect(panel).toBeInTheDocument();
});

it("沿用尾奏触发、突出下一首、点击歌曲播放后自动收起", () => {
  renderDeck();
  act(() => { playerActions.toggle(); playerActions.seek(218999); });
  expect(screen.queryByRole("complementary", { name: "下一首预告" })).not.toBeInTheDocument();
  act(() => playerActions.seek(219000));
  const panel = screen.getByRole("complementary", { name: "下一首预告" });
  expect(within(panel).getByRole("heading", { name: "即将播放" })).toBeInTheDocument();
  const next = panel.querySelector<HTMLButtonElement>('[data-up-next="true"]')!;
  expect(next).toHaveTextContent(FIXTURE_TRACKS[1]!.title);
  fireEvent.click(next);
  expect(getCurrentTrack()?.id).toBe(FIXTURE_TRACKS[1]!.id);
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

it("暂停时不首次出现，向前拖动或切歌后收起", () => {
  renderDeck();
  act(() => playerActions.seek(219000));
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  act(() => playerActions.toggle());
  expect(screen.getByRole("complementary")).toBeInTheDocument();
  act(() => playerActions.seek(100000));
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  act(() => playerActions.seek(219000));
  act(() => playerActions.next());
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

it("Escape 关闭本曲预告并将焦点返回播放按钮", () => {
  renderDeck();
  enterOutro();
  fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "暂停" })).toHaveFocus();
  act(() => playerActions.seek(225000));
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

it("单曲循环预告重播，顺序队尾没有虚构下一首", () => {
  renderDeck();
  act(() => { playerActions.cycleMode(); playerActions.cycleMode(); });
  enterOutro();
  expect(screen.getByRole("heading", { name: "即将重播" })).toBeInTheDocument();
  expect(document.querySelector('[data-up-next="true"]')).toHaveAttribute("aria-current", "true");
  cleanup();
  resetPlayerFixture();
  renderDeck();
  act(() => {
    playerActions.playTrack(FIXTURE_TRACKS.at(-1)!.id);
    playerActions.seek(getCurrentTrack()!.lyrics.at(-1)!.atMs + 3000);
  });
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

it("随机播放使用原生预告结果，大队列仅渲染目标附近五行", async () => {
  const queue = Array.from({ length: 482 }, (_, index) => ({
    id: `song-${index}`, title: `歌曲 ${index}`, artist: "歌手", album: "专辑", durationMs: 248000,
  }));
  previewNext.mockResolvedValue("song-230");
  playerActions.applyAuthoritativeSession({
    requestedQuality: "320k", mode: "shuffle",
    queue: { generation: 1, selectedIndex: 0, items: queue },
    player: { generation: 1, state: "playing", currentTrack: queue[0]!, positionMs: 219000, durationMs: 248000, volume: .5, muted: false, failure: null },
  });
  playerActions.applyTimedLyrics("song-0", 1, [{ atMs: 216000, original: "最后一句" }]);
  renderDeck();
  const panel = await screen.findByRole("complementary", { name: "下一首预告" });
  expect(previewNext).toHaveBeenCalledOnce();
  expect(panel).toHaveTextContent("482 首歌曲");
  expect(within(panel).getAllByRole("listitem")).toHaveLength(5);
  expect(panel.querySelector('[data-up-next="true"]')).toHaveTextContent("歌曲 230");
  expect(within(panel).queryByText("歌曲 1", { exact: true })).not.toBeInTheDocument();
});
