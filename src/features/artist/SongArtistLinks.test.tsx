import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginPlaybackSession } from "../../backend/playbackTransport";
import { SongArtistLinks } from "./SongArtistLinks";
import { ArtistNavigationContext, ArtistNavigationContent, useArtistNavigation } from "./ArtistNavigation";
import { ListeningStage } from "../stage/ListeningStage";
import { PlayerBar } from "../player/PlayerBar";
import { QueueDrawer } from "../player/QueueDrawer";
import { TapeDeck } from "../rhine/TapeDeck";
import { playerActions, resetPlayerFixture } from "../player/playerStore";

const mocks = vi.hoisted(() => ({ artists: vi.fn() }));
vi.mock("../../backend/artistAdapter", () => ({ getSongArtists: mocks.artists }));
vi.mock("../catalog/CatalogDetails", () => ({ CatalogDetails: ({ entity, onBack }: { entity: { name: string }; onBack: () => void }) =>
  <><h1>{entity.name}详情</h1><button onClick={onBack}>返回上一页</button></> }));
const artists = [{ id: "same-name-correct-id", name: "歌手甲" }, { id: "guest-artist-id", name: "歌手乙" }];
const track = { id: "song-one", title: "合作歌曲", artist: "歌手甲 / 歌手乙", album: "专辑", durationMs: 100_000 };
beforeEach(() => { resetPlayerFixture(); mocks.artists.mockReset().mockResolvedValue(artists); });
afterEach(() => { cleanup(); resetPlayerFixture(); vi.restoreAllMocks(); });

it.each(["stage", "bar", "rhine", "queue"])("opens the clicked singer in %s without starting playback or a drag", async mode => {
  playerActions.applyAuthoritativeSession({ mode: "sequence", requestedQuality: "320k", queue: { generation: 1, selectedIndex: 0, items: [track] },
    player: { state: "paused", generation: 1, currentTrack: track, positionMs: 0, durationMs: track.durationMs, volume: .5, muted: false, failure: null } });
  const play = vi.spyOn(playerActions, "playTrack");
  const open = vi.fn();
  const ui = mode === "stage" ? <ListeningStage /> : mode === "bar" ? <PlayerBar queueOpen={false} onOpenQueue={() => {}} />
    : mode === "rhine" ? <TapeDeck onBack={() => {}} onQueue={() => {}} onLyrics={() => {}} /> : <QueueDrawer open onClose={() => {}} />;
  render(<ArtistNavigationContext.Provider value={open}>{ui}</ArtistNavigationContext.Provider>);
  await userEvent.setup().click(screen.getByRole("button", { name: "查看歌手 歌手乙" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith(artists[1]));
  expect(mocks.artists).toHaveBeenCalledWith(track.id);
  expect(play).not.toHaveBeenCalled();
  expect(document.body).not.toHaveClass("queue-drag-active");
});

it.each([true, false])("restores the original page, input and keyboard focus with known IDs: %s", async known => {
  function Harness() {
    const navigation = useArtistNavigation();
    return <ArtistNavigationContext.Provider value={navigation.openArtist}>
      <ArtistNavigationContent artist={navigation.artist} onBack={navigation.closeArtist}>
        <input aria-label="原页面搜索" defaultValue="保留搜索" /><SongArtistLinks track={{ ...track, ...(known ? { artists } : {}) }} />
      </ArtistNavigationContent>
      <button>暂停</button>
    </ArtistNavigationContext.Provider>;
  }
  render(<Harness />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "查看歌手 歌手甲" });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("heading", { name: "歌手甲详情" })).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "暂停" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "返回上一页" }));
  expect(screen.getByLabelText("原页面搜索")).toHaveValue("保留搜索");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(mocks.artists).toHaveBeenCalledTimes(known ? 0 : 1);
});

it("retries failed reads and uses resolved IDs on later clicks", async () => {
  mocks.artists.mockRejectedValueOnce(new Error("offline"));
  const open = vi.fn();
  render(<SongArtistLinks track={track} onOpenArtist={open} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "查看歌手 歌手甲" }));
  await screen.findByText("歌手资料读取失败，请再点击重试。");
  expect(open).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "查看歌手 歌手甲" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith(artists[0]));
  await user.click(screen.getByRole("button", { name: "查看歌手 歌手乙" }));
  expect(open).toHaveBeenLastCalledWith(artists[1]);
  expect(mocks.artists).toHaveBeenCalledTimes(2);
});

it.each(["track", "connection"])("ignores a late artist lookup after the %s changes", async change => {
  let resolve!: (value: typeof artists) => void;
  mocks.artists.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const open = vi.fn();
  const view = render(<SongArtistLinks track={track} onOpenArtist={open} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "查看歌手 歌手甲" }));
  if (change === "track") view.rerender(<SongArtistLinks track={{ ...track, id: "song-two" }} onOpenArtist={open} />);
  else { beginPlaybackSession(); view.rerender(<SongArtistLinks track={track} onOpenArtist={open} />); }
  await act(async () => resolve(artists));
  expect(open).not.toHaveBeenCalled();
});

it("shows authoritative choices instead of guessing an artist when old names no longer match", async () => {
  const open = vi.fn();
  render(<SongArtistLinks track={{ ...track, artist: "旧名字" }} onOpenArtist={open} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "查看歌手 旧名字" }));
  await screen.findByText("请选择对应的歌手。");
  expect(open).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "查看歌手 歌手乙" }));
  expect(open).toHaveBeenCalledWith(artists[1]);
});

it.each(["local_test", "fixture-test"])("keeps %s as text without an online artist ID", id => {
  render(<SongArtistLinks track={{ ...track, id }} onOpenArtist={vi.fn()} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByText(track.artist)).toBeInTheDocument();
  expect(mocks.artists).not.toHaveBeenCalled();
});
