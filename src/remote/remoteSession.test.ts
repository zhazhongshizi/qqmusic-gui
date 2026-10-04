import { afterEach, expect, it, vi } from "vitest";
import { connectRemote, disconnectRemote, invokeRemote, remoteStatus } from "./remoteTransport";
import { installPlaybackTransport } from "../backend/playbackTransport";
import { playerActions, resetPlayerFixture, getCurrentTrack } from "../features/player/playerStore";
const item = (id: string) => ({ id, title: id, artist: "artist", album: "", durationMs: 1000 });
const state = (generation: number, id: string) => ({
  requestedQuality: "320k", mode: "sequence",
  queue: { generation, selectedIndex: 0, items: [item(id)] },
  player: { state: "paused", generation, currentTrack: { id, title: id, artist: "artist" }, positionMs: 0, durationMs: 1000, volume: .5, muted: false, failure: null },
});
afterEach(() => { disconnectRemote(); installPlaybackTransport(null); resetPlayerFixture(); vi.unstubAllGlobals(); });
it("accepts reset generations on a new connection", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state(40, "a"))));
  vi.stubGlobal("fetch", fetcher);
  playerActions.applyAuthoritativeSession(await connectRemote("old"));
  disconnectRemote();
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(state(1, "b"))));
  playerActions.applyAuthoritativeSession(await connectRemote("new"));
  expect(getCurrentTrack()?.id).toBe("b");
});
it("preserves an enqueued track when an older poll finishes", async () => {
  const initial = state(7, "a");
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(initial)));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("code");
  let resolve!: (value: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
  const poll = invokeRemote("playback_session_snapshot");
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...initial.queue, generation: 8, items: [item("a"), item("b")] })));
  await invokeRemote("queue_enqueue", { item: item("b") });
  resolve(new Response(JSON.stringify(initial)));
  expect((await poll as ReturnType<typeof state>).queue.generation).toBe(8);
  fetcher.mockResolvedValueOnce(new Response("null"));
  await expect(invokeRemote("queue_play", { index: 1 })).resolves.toBeNull();
});

it("rejects an old library body before it can overwrite a new connection", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state(7, "a"))));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("old");
  let resolve!: (value: unknown) => void;
  fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => new Promise(r => { resolve = r; }) });
  const old = invokeRemote("queue_enqueue", { item: item("b") });
  const rejected = expect(old).rejects.toThrow("连接已变化");
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(state(1, "new"))));
  await connectRemote("new");
  resolve({ ...state(8, "a").queue, items: [item("a"), item("b")] });
  await rejected;
  fetcher.mockResolvedValueOnce(new Response("null"));
  await invokeRemote("queue_play", { index: 0 });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ action: "playTrack", id: "new", queue_generation: 1 });
});

it("does not disconnect a successful newer connection when the older one finishes", async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
  vi.stubGlobal("fetch", fetcher);
  const old = connectRemote("old");
  const rejected = expect(old).rejects.toThrow("连接已变化");
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(state(1, "new"))));
  await connectRemote("new");
  resolve(new Response(JSON.stringify(state(40, "old"))));
  await rejected;
  expect(remoteStatus()).toBe("online");
});
