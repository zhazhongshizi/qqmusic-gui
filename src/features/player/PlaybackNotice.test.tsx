import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PlayerBar } from "./PlayerBar";
import { TapeDeck } from "../rhine/TapeDeck";
import { playerActions, resetPlayerFixture } from "./playerStore";
import type { PlaybackSessionSnapshot } from "../../contracts/queue";

const track = { id: "one", title: "下一首", artist: "歌手", album: "专辑", durationMs: 10000 };
const session: PlaybackSessionSnapshot = {
  mode: "sequence", requestedQuality: "128k",
  queue: { generation: 1, selectedIndex: 0, items: [track] },
  player: { state: "playing", generation: 1, currentTrack: track, positionMs: 0, durationMs: 10000, volume: .5, muted: false, failure: null },
  skipNotice: { title: "おじゃま虫Ⅱ", exhausted: false },
};

beforeEach(resetPlayerFixture);
afterEach(cleanup);

it.each(["normal", "rhine"])("shows the failed title inside the %s player and preserves notice after the next song starts", (mode) => {
  playerActions.applyAuthoritativeSession(session);
  render(mode === "normal" ? <PlayerBar onOpenQueue={() => {}} queueOpen={false} /> : <TapeDeck onBack={() => {}} onQueue={() => {}} onLyrics={() => {}} />);
  expect(screen.getByRole("status")).toHaveTextContent("歌曲《おじゃま虫Ⅱ》无法播放，将切换下一首");
  expect(screen.queryByRole("button", { name: "重试播放" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
});

it("replaces the old error while skipping, shows exhaustion, and removes the expired notice", async () => {
  playerActions.applyAuthoritativeSession(session);
  render(<PlayerBar onOpenQueue={() => {}} queueOpen={false} />);
  const { act } = await import("@testing-library/react");
  act(() => playerActions.applyAuthoritativeSession({ ...session, skipNotice: { title: "最后一首", exhausted: true } }));
  expect(screen.getByRole("status")).toHaveTextContent("歌曲《最后一首》无法播放，已停止自动切换，请稍后重试");
  act(() => playerActions.applyAuthoritativeSession({ ...session, skipNotice: undefined }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
