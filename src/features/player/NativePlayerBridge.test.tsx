import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ListeningStage } from "../stage/ListeningStage";
import type { PlayerSnapshot as NativePlayerSnapshot } from "../../contracts/appSnapshot";
import { NativePlayerBridge } from "./NativePlayerBridge";
import { PlayerBar } from "./PlayerBar";
import { QueueDrawer } from "./QueueDrawer";
import { TapeDeck } from "../rhine/TapeDeck";
import {
  getCurrentTrack,
  playerActions,
  resetPlayerFixture,
  usePlayerSelector,
  usePlayerSnapshot,
} from "./playerStore";

const mocks = vi.hoisted(() => ({
  playerSnapshot: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  seek: vi.fn(),
  setMuted: vi.fn(),
  setVolume: vi.fn(),
  stop: vi.fn(),
  queueSnapshot: vi.fn(),
  sessionSnapshot: vi.fn(),
  queuePlay: vi.fn(),
  queueReplace: vi.fn(),
  queueMove: vi.fn(),
  queueRemove: vi.fn(),
  queueNext: vi.fn(),
  queuePrevious: vi.fn(),
  setMode: vi.fn(),
  lyrics: vi.fn(),
  PlayerAdapterError: class PlayerAdapterError extends Error {
    code = "QMG-PLAYER-001" as const;
    constructor(readonly reason = "unknown") { super("QMG-PLAYER-001"); }
  },
}));

vi.mock("../../backend/nativePlayerAdapter", () => ({
  PlayerAdapterError: mocks.PlayerAdapterError,
  nativePlayerSnapshot: mocks.playerSnapshot,
  nativePlay: mocks.play,
  nativePause: mocks.pause,
  nativeSeek: mocks.seek,
  nativeSetMuted: mocks.setMuted,
  nativeSetVolume: mocks.setVolume,
  nativeStop: mocks.stop,
}));

vi.mock("../../backend/nativeQueueAdapter", () => ({
  nativeQueueSnapshot: mocks.queueSnapshot,
  nativePlaybackSessionSnapshot: mocks.sessionSnapshot,
  nativeQueuePlay: mocks.queuePlay,
  nativeQueueReplace: mocks.queueReplace,
  nativeQueueMove: mocks.queueMove,
  nativeQueueRemove: mocks.queueRemove,
  nativeQueueNext: mocks.queueNext,
  nativeQueuePreviewNext: vi.fn().mockResolvedValue(null),
  nativeQueuePrevious: mocks.queuePrevious,
  nativeSetPlaybackMode: mocks.setMode,
}));

vi.mock("../../backend/lyricsAdapter", () => ({ getTimedLyrics: mocks.lyrics }));

const QUEUE = {
  generation: 4,
  selectedIndex: 0,
  items: [{
    id: "0039MnYb0qxYhV",
    title: "晴天",
    artist: "周杰伦",
    album: "叶惠美",
    durationMs: 269_000,
  }],
} as const;

const PLAYER = {
  state: "playing",
  generation: 7,
  positionMs: 1_200,
  durationMs: 269_000,
  volume: 0.72,
  muted: false,
  currentTrack: { id: "0039MnYb0qxYhV", title: "晴天", artist: "周杰伦" },
  failure: null,
} as const;

const EMPTY_QUEUE = { generation: 5, selectedIndex: null, items: [] } as const;

const LOCAL_ID = `local_${"a".repeat(64)}_ogg`;
const LOCAL_QUEUE = {
  generation: 6,
  selectedIndex: 0,
  items: [{ id: LOCAL_ID, title: "本地测试", artist: "本地艺术家", album: "本地专辑", durationMs: 8_000 }],
} as const;
const LOCAL_PLAYER = {
  ...PLAYER,
  generation: 9,
  durationMs: 8_000,
  currentTrack: { id: LOCAL_ID, title: "本地测试", artist: "本地艺术家" },
} as const;

const MULTI_TRACK_QUEUE = {
  generation: 4,
  selectedIndex: 1,
  items: [
    { id: "native-a", title: "A", artist: "Artist A", album: "Album", durationMs: 100_000 },
    { id: "native-b", title: "B", artist: "Artist B", album: "Album", durationMs: 110_000 },
    { id: "native-c", title: "C", artist: "Artist C", album: "Album", durationMs: 120_000 },
    { id: "native-d", title: "D", artist: "Artist D", album: "Album", durationMs: 130_000 },
  ],
} as const;

const MULTI_TRACK_PLAYER = {
  ...PLAYER,
  currentTrack: { id: "native-b", title: "B", artist: "Artist B" },
} as const;

function PlayerStateProbe() {
  const state = usePlayerSnapshot();
  return (
    <>
      <output data-testid="player-queue">{state.queue.map((track) => track.id).join(",")}</output>
      <output data-testid="player-current">
        {`${getCurrentTrack(state)?.id ?? "none"}:${state.currentIndex}`}
      </output>
    </>
  );
}

function PlayerReferenceProbe({ onRender }: { onRender: (track: ReturnType<typeof getCurrentTrack>, queue: readonly unknown[]) => void }) {
  const track = usePlayerSelector(getCurrentTrack);
  const queue = usePlayerSelector((state) => state.queue);
  onRender(track, queue);
  return null;
}

function setDocumentVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("native player bridge", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    mocks.queueSnapshot.mockReset().mockResolvedValue(QUEUE);
    mocks.playerSnapshot.mockReset().mockResolvedValue(PLAYER);
    mocks.sessionSnapshot.mockReset().mockResolvedValue({
      mode: "sequence",
      queue: QUEUE,
      player: PLAYER,
      requestedQuality: "320k",
    });
    mocks.seek.mockReset().mockImplementation((positionMs: number) =>
      Promise.resolve({ ...PLAYER, positionMs }),
    );
    mocks.play.mockReset().mockResolvedValue(PLAYER);
    mocks.pause.mockReset().mockResolvedValue({ ...PLAYER, state: "paused" });
    mocks.setMuted.mockReset().mockResolvedValue(PLAYER);
    mocks.setVolume.mockReset().mockResolvedValue(PLAYER);
    mocks.stop.mockReset().mockResolvedValue({ ...PLAYER, state: "idle", currentTrack: null });
    mocks.queuePlay.mockReset();
    mocks.queueReplace.mockReset();
    mocks.queueMove.mockReset();
    mocks.queueRemove.mockReset();
    mocks.queueNext.mockReset();
    mocks.queuePrevious.mockReset();
    mocks.setMode.mockReset().mockImplementation((mode: string) =>
      Promise.resolve({ mode, queue: QUEUE, player: PLAYER, requestedQuality: "320k" }),
    );
    mocks.lyrics.mockReset().mockResolvedValue({
      generation: 7,
      trackId: "0039MnYb0qxYhV",
      lines: [{ atMs: 0, original: "故事的小黄花" }],
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setDocumentVisibility("visible");
    resetPlayerFixture();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it.each(["normal", "rhine"])("loads on a startup seek in %s and then pauses the loaded source", async (mode) => {
    const idle = { ...PLAYER, state: "idle", generation: 0, positionMs: 0, durationMs: null, currentTrack: null };
    mocks.sessionSnapshot.mockResolvedValue({ mode: "sequence", queue: QUEUE, player: idle, requestedQuality: "320k" });
    const pending = deferred<NativePlayerSnapshot>();
    mocks.seek.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<>
      <NativePlayerBridge />
      <PlayerStateProbe />
      {mode === "rhine"
        ? <TapeDeck onBack={() => undefined} onQueue={() => undefined} onLyrics={() => undefined} />
        : <PlayerBar onOpenQueue={() => undefined} queueOpen={false} />}
    </>);
    await waitFor(() => expect(screen.getByTestId("player-current")).toHaveTextContent(`${PLAYER.currentTrack.id}:0`));
    expect(screen.getByRole("button", { name: "播放" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("播放进度"), { target: { value: "60000" } });
    expect(mocks.seek).toHaveBeenCalledWith(60_000);
    await act(async () => pending.resolve({ ...PLAYER, generation: 1, state: "loading", positionMs: 60_000 }));
    expect(screen.getByLabelText("播放进度")).toHaveValue("60000");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    mocks.pause.mockResolvedValueOnce({ ...PLAYER, generation: 1, state: "paused", positionMs: 60_000 });
    await user.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(mocks.pause).toHaveBeenCalledOnce());
    expect(mocks.queuePlay).not.toHaveBeenCalled();
    expect(screen.getByLabelText("播放进度")).toHaveValue("60000");
  });

  it("keeps a visible bridge poll at the 500ms interval", async () => {
    vi.useFakeTimers();
    render(<NativePlayerBridge />);

    expect(mocks.sessionSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => vi.advanceTimersByTime(499));
    expect(mocks.sessionSnapshot).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(mocks.sessionSnapshot).toHaveBeenCalledTimes(2);
  });

  it("a delayed seek reply does not undo a newer pause on an already loaded source", async () => {
    const pending = deferred<NativePlayerSnapshot>();
    mocks.seek.mockReturnValueOnce(pending.promise);
    render(<><NativePlayerBridge /><PlayerBar onOpenQueue={() => undefined} queueOpen={false} /><PlayerStateProbe /></>);
    await waitFor(() => expect(screen.getByTestId("player-current")).toHaveTextContent(`${PLAYER.currentTrack.id}:0`));
    act(() => playerActions.seek(60_000));
    act(() => playerActions.toggle());
    await screen.findByRole("button", { name: "播放" });
    await act(async () => pending.resolve({ ...PLAYER, positionMs: 60_000 }));
    expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument();
    expect(screen.getByLabelText("播放进度")).toHaveValue("60000");
  });

  it("stops hidden polling and immediately refreshes once when visible again", async () => {
    vi.useFakeTimers();
    setDocumentVisibility("hidden");
    render(<NativePlayerBridge />);

    expect(mocks.sessionSnapshot).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2_000));
    expect(mocks.sessionSnapshot).not.toHaveBeenCalled();

    setDocumentVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.sessionSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(499));
    expect(mocks.sessionSnapshot).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(mocks.sessionSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("deduplicates a visible refresh while a hidden-to-visible request is in flight", async () => {
    const pending = deferred<{
      mode: "sequence";
      queue: typeof QUEUE;
      player: typeof PLAYER;
      requestedQuality: "320k";
    }>();
    mocks.sessionSnapshot.mockReturnValueOnce(pending.promise);
    render(<NativePlayerBridge />);

    expect(mocks.sessionSnapshot).toHaveBeenCalledTimes(1);
    setDocumentVisibility("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    setDocumentVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.sessionSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ mode: "sequence", queue: QUEUE, player: PLAYER, requestedQuality: "320k" });
      await pending.promise;
    });
  });

  it("reuses native track and queue references across position-only refreshes without losing lyrics", async () => {
    let latestTrack: ReturnType<typeof getCurrentTrack> = null;
    let latestQueue: readonly unknown[] = [];
    const readLatestTrack = (): ReturnType<typeof getCurrentTrack> => latestTrack;
    render(<PlayerReferenceProbe onRender={(track, queue) => {
      latestTrack = track;
      latestQueue = queue;
    }} />);

    await act(async () => {
      await playerActions.hydrateNativeSession({
        mode: "sequence",
        queue: QUEUE,
        player: PLAYER,
        requestedQuality: "320k",
      });
    });
    playerActions.applyTimedLyrics("0039MnYb0qxYhV", 7, [{ atMs: 0, original: "保留这行歌词" }]);
    await waitFor(() => expect(readLatestTrack()?.lyrics).toHaveLength(1));
    const firstTrack = readLatestTrack();
    const firstQueue = latestQueue;

    await act(async () => {
      await playerActions.hydrateNativeSession({
        mode: "sequence",
        queue: QUEUE,
        player: { ...PLAYER, positionMs: 2_200 },
        requestedQuality: "320k",
      });
    });

    expect(latestTrack).toBe(firstTrack);
    expect(latestQueue).toBe(firstQueue);
    expect(readLatestTrack()?.lyrics[0]?.original).toBe("保留这行歌词");
  });

  it("skips unchanged queue metadata and suppresses identical snapshot renders", async () => {
    const readTitle = vi.fn(() => QUEUE.items[0].title);
    const queue = { ...QUEUE, items: [{ ...QUEUE.items[0], get title() { return readTitle(); } }] };
    const session = { mode: "sequence" as const, queue, player: PLAYER, requestedQuality: "320k" as const };
    const rendered = vi.fn();
    function Probe() {
      const state = usePlayerSnapshot();
      rendered(state.positionMs);
      return null;
    }
    render(<Probe />);
    await act(async () => playerActions.hydrateNativeSession(session));
    const reads = readTitle.mock.calls.length;
    const renders = rendered.mock.calls.length;
    await act(async () => playerActions.hydrateNativeSession(session));
    expect(rendered).toHaveBeenCalledTimes(renders);
    expect(readTitle).toHaveBeenCalledTimes(reads);
    mocks.sessionSnapshot.mockResolvedValueOnce({ ...session, player: { ...PLAYER, positionMs: 2_000 } });
    await act(async () => playerActions.hydrateNativeSession());
    expect(mocks.sessionSnapshot).toHaveBeenLastCalledWith(queue);
    expect(rendered).toHaveBeenLastCalledWith(2_000);
    expect(readTitle).toHaveBeenCalledTimes(reads);
  });

  it("hydrates the stage from native snapshots and applies generation-bound lyrics", async () => {
    render(<><NativePlayerBridge /><ListeningStage /></>);

    expect(await screen.findByRole("heading", { name: "晴天" })).toBeInTheDocument();
    expect(await screen.findByText("故事的小黄花")).toBeInTheDocument();
    expect(screen.getByText("QQ LIVE")).toBeInTheDocument();
    expect(mocks.lyrics).toHaveBeenCalledWith("0039MnYb0qxYhV", 7);

    playerActions.seekBy(5_000);
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledWith(6_200));
  });

  it("hydrates local music through the same native session without requesting online lyrics", async () => {
    mocks.sessionSnapshot.mockResolvedValue({
      mode: "sequence",
      queue: LOCAL_QUEUE,
      player: LOCAL_PLAYER,
      requestedQuality: "320k",
    });
    render(<><NativePlayerBridge /><ListeningStage /></>);

    expect(await screen.findByRole("heading", { name: "本地测试" })).toBeInTheDocument();
    expect(screen.getByText("LOCAL MUSIC")).toBeInTheDocument();
    expect(screen.getByText("实际 OGG")).toBeInTheDocument();
    expect(screen.getByText("本地文件")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /期望音质/u })).not.toBeInTheDocument();
    expect(mocks.lyrics).not.toHaveBeenCalled();
  });

  it("stops native playback before removing the active final queue item", async () => {
    const idlePlayer = {
      ...PLAYER,
      state: "idle" as const,
      generation: 8,
      positionMs: 0,
      durationMs: null,
      currentTrack: null,
    };
    mocks.stop.mockImplementationOnce(() => {
      mocks.playerSnapshot.mockResolvedValue(idlePlayer);
      mocks.sessionSnapshot.mockResolvedValue({
        mode: "sequence",
        queue: { generation: 5, selectedIndex: null, items: [] },
        player: idlePlayer,
        requestedQuality: "320k",
      });
      return Promise.resolve(idlePlayer);
    });
    mocks.queueRemove.mockResolvedValue({ generation: 5, selectedIndex: null, items: [] });
    render(<><NativePlayerBridge /><ListeningStage /></>);
    await screen.findByRole("heading", { name: "晴天" });

    playerActions.removeTrack("0039MnYb0qxYhV");

    await waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1));
    expect(mocks.queueRemove).toHaveBeenCalledWith(0);
    expect(await screen.findByText("队列是空的")).toBeInTheDocument();
  });

  it("清空队列前停止原生播放并持久化空队列", async () => {
    const idlePlayer = {
      ...PLAYER,
      state: "idle" as const,
      generation: 8,
      positionMs: 0,
      durationMs: null,
      currentTrack: null,
    };

    render(<><NativePlayerBridge /><QueueDrawer onClose={vi.fn()} open /></>);
    expect(await screen.findByText("晴天")).toBeInTheDocument();

    mocks.stop.mockResolvedValue(idlePlayer);
    mocks.playerSnapshot.mockResolvedValue(idlePlayer);
    mocks.queueReplace.mockResolvedValue(EMPTY_QUEUE);
    mocks.sessionSnapshot.mockResolvedValue({
      mode: "sequence",
      queue: EMPTY_QUEUE,
      player: idlePlayer,
      requestedQuality: "320k",
    });

    playerActions.clearQueue();

    await waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.queueReplace).toHaveBeenCalledWith([]));
    expect(await screen.findByRole("status")).toHaveTextContent("播放队列为空");
  });

  it("moves a native track to an arbitrary index using the latest track id mapping", async () => {
    const movedQueue = {
      ...MULTI_TRACK_QUEUE,
      generation: 5,
      selectedIndex: 3,
      items: [
        MULTI_TRACK_QUEUE.items[0],
        MULTI_TRACK_QUEUE.items[2],
        MULTI_TRACK_QUEUE.items[3],
        MULTI_TRACK_QUEUE.items[1],
      ],
    } as const;
    mocks.queueSnapshot.mockResolvedValue(MULTI_TRACK_QUEUE);
    mocks.playerSnapshot.mockResolvedValue(MULTI_TRACK_PLAYER);
    mocks.sessionSnapshot.mockResolvedValue({
      mode: "sequence",
      queue: MULTI_TRACK_QUEUE,
      player: MULTI_TRACK_PLAYER,
      requestedQuality: "320k",
    });
    mocks.queueMove.mockResolvedValue(movedQueue);

    render(<><NativePlayerBridge /><PlayerStateProbe /></>);
    expect(await screen.findByTestId("player-current")).toHaveTextContent("native-b:1");

    await playerActions.moveTrackTo("native-b", 3);

    expect(mocks.queueMove).toHaveBeenCalledWith(1, 3);
    await waitFor(() => expect(screen.getByTestId("player-queue")).toHaveTextContent(
      "native-a,native-c,native-d,native-b",
    ));
    expect(screen.getByTestId("player-current")).toHaveTextContent("native-b:3");
    expect(mocks.queuePlay).not.toHaveBeenCalled();
    expect(mocks.queueRemove).not.toHaveBeenCalled();
    expect(mocks.queueReplace).not.toHaveBeenCalled();
  });

  it("keeps the same current fixture track selected when a non-native track moves", async () => {
    render(<PlayerStateProbe />);

    playerActions.playTrack("fixture-tidal-letter");
    await playerActions.moveTrackTo("fixture-dusk-greenhouse", 3);

    await waitFor(() => expect(screen.getByTestId("player-queue")).toHaveTextContent(
      "fixture-paper-moon,fixture-tidal-letter,fixture-after-rain-train,fixture-dusk-greenhouse,fixture-south-window-mist",
    ));
    expect(screen.getByTestId("player-current")).toHaveTextContent("fixture-tidal-letter:1");
  });

  it("ignores missing, non-integer, out-of-range, and unchanged move targets", async () => {
    render(<PlayerStateProbe />);
    const originalQueue = screen.getByTestId("player-queue").textContent;
    const originalCurrent = screen.getByTestId("player-current").textContent;

    await playerActions.moveTrackTo("missing", 1);
    await playerActions.moveTrackTo("fixture-dusk-greenhouse", 1.5);
    await playerActions.moveTrackTo("fixture-dusk-greenhouse", -1);
    await playerActions.moveTrackTo("fixture-dusk-greenhouse", 99);
    await playerActions.moveTrackTo("fixture-dusk-greenhouse", 0);

    expect(screen.getByTestId("player-queue")).toHaveTextContent(originalQueue ?? "");
    expect(screen.getByTestId("player-current")).toHaveTextContent(originalCurrent ?? "");
    expect(mocks.queueMove).not.toHaveBeenCalled();
  });

  it("keeps the authoritative native order when a move fails", async () => {
    mocks.queueSnapshot.mockResolvedValue(MULTI_TRACK_QUEUE);
    mocks.playerSnapshot.mockResolvedValue(MULTI_TRACK_PLAYER);
    mocks.sessionSnapshot.mockResolvedValue({
      mode: "sequence",
      queue: MULTI_TRACK_QUEUE,
      player: MULTI_TRACK_PLAYER,
      requestedQuality: "320k",
    });
    mocks.queueMove.mockRejectedValue(new Error("move failed"));

    render(<><NativePlayerBridge /><PlayerStateProbe /></>);
    expect(await screen.findByTestId("player-current")).toHaveTextContent("native-b:1");

    await playerActions.moveTrackTo("native-b", 3);

    expect(mocks.queueMove).toHaveBeenCalledWith(1, 3);
    expect(screen.getByTestId("player-queue")).toHaveTextContent("native-a,native-b,native-c,native-d");
    expect(screen.getByTestId("player-current")).toHaveTextContent("native-b:1");
  });

  it("sends playback mode changes to the authoritative native session", async () => {
    const user = userEvent.setup();
    render(<><NativePlayerBridge /><PlayerBar onOpenQueue={() => undefined} queueOpen={false} /></>);
    const modeButton = await screen.findByRole("button", { name: "顺序播放，点击切换模式" });

    await user.click(modeButton);

    await waitFor(() => expect(mocks.setMode).toHaveBeenCalledWith("repeat-all"));
    expect(await screen.findByRole("button", { name: "列表循环，点击切换模式" })).toBeInTheDocument();
  });

  it("shows a stable playback error and retries the last native action", async () => {
    const user = userEvent.setup();
    mocks.pause.mockRejectedValueOnce(new mocks.PlayerAdapterError("network"));
    render(<><NativePlayerBridge /><PlayerBar onOpenQueue={() => undefined} queueOpen={false} /></>);
    expect((await screen.findAllByText("晴天")).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "暂停" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("网络暂不可用");

    await user.click(screen.getByRole("button", { name: "重试播放" }));
    await waitFor(() => expect(mocks.pause).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("replays the selected queue item when retrying an asynchronous native failure", async () => {
    const user = userEvent.setup();
    const failedPlayer = {
      ...PLAYER,
      state: "failed" as const,
      failure: { code: "unavailable" as const, recoverable: false, generation: PLAYER.generation },
    };
    mocks.sessionSnapshot.mockResolvedValue({
      mode: "sequence",
      queue: QUEUE,
      player: failedPlayer,
      requestedQuality: "320k",
    });
    mocks.queuePlay.mockResolvedValue({
      requestedQuality: "320k",
      queue: QUEUE,
      playback: { quality: "320k", expiresInSeconds: 90, player: PLAYER },
    });
    render(<><NativePlayerBridge /><PlayerBar onOpenQueue={() => undefined} queueOpen={false} /></>);

    expect(await screen.findByRole("alert")).toHaveTextContent("当前歌曲暂时无法播放");
    await user.click(screen.getByRole("button", { name: "重试播放" }));

    await waitFor(() => expect(mocks.queuePlay).toHaveBeenCalledWith(0));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it.each(["retry", "play"])("reloads a failed source via %s after another control fails", async (action) => {
    const user = userEvent.setup();
    mocks.sessionSnapshot.mockResolvedValue({
      mode: "sequence",
      queue: QUEUE,
      player: {
        ...PLAYER,
        state: "failed",
        failure: { code: "unavailable", recoverable: false, generation: PLAYER.generation },
      },
      requestedQuality: "320k",
    });
    mocks.seek.mockRejectedValue(new mocks.PlayerAdapterError("network"));
    mocks.queuePlay.mockRejectedValueOnce(new mocks.PlayerAdapterError("network"));
    mocks.queuePlay.mockResolvedValueOnce({
      requestedQuality: "320k",
      queue: QUEUE,
      playback: { quality: "320k", expiresInSeconds: 90, player: PLAYER },
    });
    render(<><NativePlayerBridge /><PlayerBar onOpenQueue={() => undefined} queueOpen={false} /></>);
    expect(await screen.findByRole("alert")).toHaveTextContent("当前歌曲暂时无法播放");

    act(() => playerActions.seek(5_000));
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledTimes(1));
    await act(async () => { await playerActions.hydrateNativeSession(); });
    expect(screen.getByRole("alert")).toHaveTextContent("当前歌曲暂时无法播放");

    await user.click(screen.getByRole("button", { name: action === "retry" ? "重试播放" : "播放" }));
    await waitFor(() => expect(mocks.queuePlay).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试播放" }));
    await waitFor(() => expect(mocks.queuePlay).toHaveBeenCalledTimes(2));
    expect(mocks.queuePlay).toHaveBeenLastCalledWith(0);
    expect(mocks.seek).toHaveBeenCalledTimes(1);
    expect(mocks.play).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("ignores an older command result after a newer native operation wins", async () => {
    const oldPause = deferred<NativePlayerSnapshot>();
    mocks.pause.mockReturnValueOnce(oldPause.promise);
    mocks.seek.mockResolvedValueOnce({ ...PLAYER, generation: 9, positionMs: 6_200 });
    render(<><NativePlayerBridge /><PlayerBar onOpenQueue={() => undefined} queueOpen={false} /></>);
    expect((await screen.findAllByText("晴天")).length).toBeGreaterThan(0);

    playerActions.toggle();
    playerActions.seekBy(5_000);
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledWith(6_200));
    oldPause.resolve({ ...PLAYER, generation: 8, state: "paused" });

    await waitFor(() => expect(screen.getByLabelText("播放进度")).toHaveValue("6200"));
  });

  it("does not let an older polled generation overwrite a newer command snapshot", async () => {
    render(<><NativePlayerBridge /><ListeningStage /></>);
    await screen.findByRole("heading", { name: "晴天" });

    await playerActions.hydrateNative(
      QUEUE,
      { ...PLAYER, generation: 12, state: "playing", positionMs: 8_000 },
    );
    await playerActions.hydrateNativeSession({
      mode: "sequence",
      queue: QUEUE,
      player: { ...PLAYER, generation: 7, state: "paused", positionMs: 1_200 },
      requestedQuality: "320k",
    });

    playerActions.seekBy(1_000);
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledWith(9_000));
  });
});
