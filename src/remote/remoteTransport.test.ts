import { afterEach, expect, it, vi } from "vitest";
import { connectRemote, disconnectRemote, invokeRemote, remoteStatus } from "./remoteTransport";
import { installPlaybackTransport } from "../backend/playbackTransport";

const state = {
  requestedQuality: "320k", mode: "sequence",
  queue: { generation: 7, selectedIndex: 0, items: [{ id: "songA", title: "A", artist: "Artist", album: "", durationMs: 10000 }] },
  player: { state: "paused", generation: 4, currentTrack: { id: "songA", title: "A", artist: "Artist" }, positionMs: 10, durationMs: 10000, volume: .5, muted: false, failure: null },
};
afterEach(() => { disconnectRemote(); installPlaybackTransport(null); vi.unstubAllGlobals(); });

it("routes entity browsing and separates artist and album cover caches", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("test-code");
  for (const [command, payload] of [
    ["catalog_search_entities", { kind: "albums", keyword: "test", page: 1, pageSize: 20, generation: 1 }],
    ["catalog_album_detail", { albumId: "same-mid" }],
    ["catalog_album_songs", { albumId: "same-mid", page: 1, pageSize: 20, generation: 1 }],
    ["catalog_artist_detail", { artistId: "same-mid" }],
    ["catalog_song_artists", { songId: "song-mid-1" }],
    ["catalog_artist_songs", { artistId: "same-mid", page: 1, pageSize: 20, generation: 1 }],
    ["catalog_artist_albums", { artistId: "same-mid", page: 1, pageSize: 20, generation: 1 }],
  ] as const) {
    fetcher.mockResolvedValueOnce(new Response("{}"));
    await invokeRemote(command, payload);
    expect(fetcher.mock.calls.at(-1)![0]).toBe("/api/library");
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ command, ...payload });
  }
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
  await invokeRemote("cover_get", { cacheKey: "same-mid", kind: "artist" });
  expect(fetcher.mock.calls.at(-1)![0]).toBe("/api/library-cover?key=same-mid&kind=artist");
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array([2]), { headers: { "content-type": "image/png" } }));
  await invokeRemote("cover_get", { cacheKey: "same-mid" });
  expect(fetcher.mock.calls.at(-1)![0]).toBe("/api/library-cover?key=same-mid&kind=album");
});

it("next insertion sends only a catalog ID and preserves authoritative MV quality and offset", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ...state, actualQuality: "qq-mv", lyricOffsetMs: -1500 })));
  vi.stubGlobal("fetch", fetcher);
  const session = await connectRemote("test-code");
  expect(session.actualQuality).toBe("qq-mv");
  expect(session.lyricOffsetMs).toBe(-1500);
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(state.queue)));
  await invokeRemote("queue_enqueue_next", { item: state.queue.items[0] });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ command: "queue_enqueue_next", id: "songA" });
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(state)));
  await invokeRemote("playback_set_mv_lyric_offset", { trackId: "songA", generation: 4, offsetMs: 500 });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ action: "mvLyricOffset", id: "songA", generation: 4, offset_ms: 500 });
});

it("enqueues by catalog ID and uses the returned queue generation for immediate play", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("test-code");
  const item = { id: "songB", title: "B", artist: "Artist", album: "", durationMs: 20000 };
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...state.queue, generation: 8, items: [...state.queue.items, item] })));
  await invokeRemote("queue_enqueue", { item });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ command: "queue_enqueue", id: "songB" });
  fetcher.mockResolvedValueOnce(new Response("null"));
  await invokeRemote("queue_play", { index: 1 });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ action: "playTrack", id: "songB", queue_generation: 8 });
});

it("saved queue switching updates remote state before the next track command", async () => {
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch",fetcher);await connectRemote("test-code");
  const switched={...state,queue:{generation:12,selectedIndex:0,items:[{id:"savedSong",title:"Saved",artist:"Artist",album:"",durationMs:20_000}]},player:{...state.player,generation:5,state:"idle",currentTrack:null}};
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(switched)));
  await invokeRemote("personal_library",{request:{action:"loadQueue",name:"work"}});
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({command:"personal_library",request:{action:"loadQueue",name:"work"}});
  fetcher.mockResolvedValueOnce(new Response("null"));await invokeRemote("queue_play",{index:0});
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({action:"playTrack",id:"savedSong",queue_generation:12});
});
it("batch enqueue sends stable IDs once and updates the queue used for playback",async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch",fetcher);await connectRemote("test-code");
  const queue={generation:13,selectedIndex:0,items:[...state.queue.items,{id:"batchSong",title:"Batch",artist:"Artist",album:"",durationMs:1000}]};
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(queue)));
  await invokeRemote("queue_enqueue_many",{items:[queue.items.at(-1)!]});
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({command:"queue_enqueue_many",ids:["batchSong"]});
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(new Response("null"));await invokeRemote("queue_play",{index:queue.items.length-1});
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({action:"playTrack",id:"batchSong",queue_generation:13});
});

it("uses stable queue IDs and player generations for writes", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("test-code");
  fetcher.mockResolvedValue(new Response(JSON.stringify(state.player)));
  await invokeRemote("player_seek", { positionMs: 99 });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ action: "seek", position_ms: 99, generation: 4 });
  fetcher.mockResolvedValue(new Response("null"));
  await invokeRemote("queue_play", { index: 0 });
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ action: "playTrack", id: "songA", queue_generation: 7 });
  await expect(invokeRemote("auth_logout")).rejects.toThrow("此操作请在电脑端完成");
});

it("never replays a failed write, and rejects controls until state recovers", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(state)));
  vi.stubGlobal("fetch", fetcher);
  await connectRemote("test-code");
  fetcher.mockRejectedValue(new TypeError("offline"));
  await expect(invokeRemote("player_play")).rejects.toThrow();
  expect(remoteStatus()).toBe("offline");
  await expect(invokeRemote("player_play")).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValue(new Response(JSON.stringify(state)));
  await invokeRemote("playback_session_snapshot");
  expect(remoteStatus()).toBe("online");
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("does not hydrate a response whose connection was closed while its body was pending", async () => {
  let resolve!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(r => { resolve = r; }) }));
  const connecting = connectRemote("test-code");
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  disconnectRemote();
  resolve(state);
  await expect(connecting).rejects.toThrow("连接已变化");
  expect(remoteStatus()).toBe("disconnected");
});
