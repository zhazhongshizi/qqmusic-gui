import { act, fireEvent, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getCurrentTrack, playerActions, resetPlayerFixture } from "../player/playerStore";
import { StageLyricsPanel } from "./StageLyricsPanel";

beforeEach(() => resetPlayerFixture());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it("opens the current queue, plays a selection, and restores lyrics with Escape", async () => {
  const user = userEvent.setup();
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  const trigger = screen.getByRole("button", { name: "展开歌曲列表" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  await user.click(trigger);
  expect(screen.getByText("歌词内容")).not.toBeVisible();
  const songs = within(screen.getByRole("list")).getAllByRole("button");
  expect(songs.length).toBeGreaterThan(1);
  await user.click(songs[1]!);
  expect(songs[1]).toHaveAttribute("aria-current", "true");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  expect(screen.getByText("歌词内容")).toBeVisible();
  expect(trigger).toHaveFocus();
});
it("supports keyboard opening and closing from the edge toggle", async () => {
  const user = userEvent.setup();
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  await user.tab();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "返回歌词" })).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "展开歌曲列表" })).toHaveAttribute("aria-expanded", "false");
});

it("restarts the 20 second idle timeout after interaction", () => {
  vi.useFakeTimers();
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  fireEvent.click(screen.getByRole("button", { name: "展开歌曲列表" }));
  act(() => vi.advanceTimersByTime(19_000));
  fireEvent.pointerMove(screen.getByRole("list"));
  act(() => vi.advanceTimersByTime(19_000));
  expect(screen.getByRole("list")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1_000));
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});
it("pins the queue without lyrics and restores lyrics when available", () => {
  vi.useFakeTimers();
  const view = render(<StageLyricsPanel hasLyrics={false}><p>歌词内容</p></StageLyricsPanel>);
  expect(screen.getByRole("list")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(60_000));
  fireEvent.keyDown(screen.getByRole("list"), { key: "Escape" });
  expect(screen.getByRole("list")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "返回歌词" })).not.toBeInTheDocument();
  view.rerender(<StageLyricsPanel hasLyrics><p>歌词内容</p></StageLyricsPanel>);
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});
it("immediately follows the active song after next is triggered elsewhere", () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  fireEvent.click(screen.getByRole("button", { name: "展开歌曲列表" }));
  scroll.mockClear();
  act(() => playerActions.next());
  const songs = within(screen.getByRole("list")).getAllByRole("button");
  expect(songs[1]).toHaveAttribute("aria-current", "true");
  expect(songs[0]).not.toHaveAttribute("aria-current");
  expect(scroll).toHaveBeenCalledTimes(1);
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

it("opens after the last lyric plus 3 seconds, ignores idle timeout, and closes on next", () => {
  vi.useFakeTimers();
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  act(() => { playerActions.toggle(); playerActions.seek(218_999); });
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  act(() => playerActions.seek(219_000));
  expect(screen.getByRole("heading", { name: "即将播放" })).toBeInTheDocument();
  expect(within(screen.getByRole("list")).getAllByRole("button")[1]).toHaveAttribute("data-up-next", "true");
  act(() => vi.advanceTimersByTime(25_000));
  expect(screen.getByRole("list")).toBeInTheDocument();
  act(() => playerActions.next());
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});
it("does not open while paused and cancels on backward seek", () => {
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  act(() => playerActions.seek(219_000));
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  act(() => playerActions.toggle());
  expect(screen.getByRole("list")).toBeInTheDocument();
  act(() => playerActions.seek(100_000));
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});
it("keeps an explicitly dismissed outro closed for the current playback", () => {
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  act(() => { playerActions.toggle(); playerActions.seek(219_000); });
  fireEvent.click(screen.getByRole("button", { name: "返回歌词" }));
  act(() => playerActions.seek(225_000));
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

it("labels repeat-one and suppresses a nonexistent next song at queue end", () => {
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  act(() => { playerActions.cycleMode(); playerActions.cycleMode(); playerActions.toggle(); playerActions.seek(219_000); });
  expect(screen.getByRole("heading", { name: "即将重播" })).toBeInTheDocument();
  cleanup();
  resetPlayerFixture();
  render(<StageLyricsPanel><p>歌词内容</p></StageLyricsPanel>);
  act(() => {
    playerActions.next(); playerActions.next(); playerActions.next(); playerActions.next();
    playerActions.toggle(); playerActions.seek(getCurrentTrack()!.lyrics.at(-1)!.atMs + 3000);
  });
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

it("keeps settings above the outro and pinned queue until explicitly closed", () => {
  vi.useFakeTimers();
  const settings = <section aria-label="设置">设置内容</section>;
  const view = render(<StageLyricsPanel settings={settings}><p>歌词内容</p></StageLyricsPanel>);
  act(() => { playerActions.toggle(); playerActions.seek(219_000); });
  act(() => vi.advanceTimersByTime(30_000));
  expect(screen.getByRole("region", { name: "设置" })).toBeVisible();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  act(() => playerActions.next());
  view.rerender(<StageLyricsPanel hasLyrics={false} settings={settings}><p>歌词内容</p></StageLyricsPanel>);
  expect(screen.getByRole("region", { name: "设置" })).toBeVisible();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  view.rerender(<StageLyricsPanel hasLyrics={false}><p>歌词内容</p></StageLyricsPanel>);
  expect(screen.getByRole("list")).toBeInTheDocument();
});
