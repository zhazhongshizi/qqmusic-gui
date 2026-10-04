import { parsePlaybackSessionSnapshot, parseQueueSnapshot } from "../backend/nativeQueueAdapter";
import { beginPlaybackSession, installPlaybackTransport, notifyPlaybackReconnected } from "../backend/playbackTransport";
import { mergePlaybackSession, newestQueue } from "../backend/sessionSnapshots";
import type { PlaybackSessionSnapshot } from "../contracts/queue";

type Connection = "disconnected" | "connecting" | "online" | "offline";
let connection: Connection = "disconnected";
let secret = "";
let epoch = 0;
let latest: PlaybackSessionSnapshot | undefined;
const covers = new Map<string, Promise<unknown>>();
let coverReaders = 0;
const waitingCovers: Array<() => void> = [];
const listeners = new Set<() => void>();
export const subscribeRemote = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const remoteStatus = () => connection;
function status(value: Connection) {
  if (connection === value) return;
  const recovered = connection === "offline" && value === "online";
  connection = value;
  listeners.forEach((listener) => listener());
  if (recovered) notifyPlaybackReconnected();
}
export function disconnectRemote() {
  epoch++;
  beginPlaybackSession();
  secret = "";
  latest = undefined;
  covers.clear();
  sessionStorage.removeItem("qmg-remote-code");
  status("disconnected");
}
async function request(path: string, body?: unknown): Promise<Response> {
  const requestEpoch = epoch;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (requestEpoch !== epoch) throw new Error("连接已变化");
    if (response.status === 401) disconnectRemote();
    if (!response.ok) {
      if (response.status >= 500) status("offline");
      throw await response.json().catch(() => new Error("请求未完成"));
    }
    return response;
  } catch (error) {
    if (requestEpoch === epoch && error instanceof Error) status("offline");
    throw error;
  } finally { window.clearTimeout(timeout); }
}
async function readJson(path: string, body?: unknown): Promise<unknown> {
  const requestEpoch = epoch;
  const value: unknown = await (await request(path, body)).json();
  if (requestEpoch !== epoch) throw new Error("连接已变化");
  return value;
}
async function readState(known?: unknown) {
  const requestEpoch = epoch;
  const value: unknown = await (await request(`/api/state${typeof known === "number" ? `?known=${known}` : ""}`)).json();
  if (requestEpoch !== epoch) throw new Error("连接已变化");
  latest = mergePlaybackSession(latest, parsePlaybackSessionSnapshot(value, latest?.queue));
  status("online");
  return latest;
}
export async function invokeRemote(command: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const requestEpoch = epoch;
  const value = await dispatchRemote(command, payload);
  if (requestEpoch !== epoch) throw new Error("连接已变化");
  return value;
}
async function dispatchRemote(command: string, payload: Record<string, unknown>): Promise<unknown> {
  if (!secret) throw new Error("尚未连接电脑");
  if (command === "personal_library") {
    if (connection !== "online") throw new Error("连接已断开，请等待恢复");
    const value = await readJson("/api/library", { command, ...payload });
    const action = (payload.request as { action?: string }).action;
    if (action === "loadQueue" || action === "restoreQueue") latest = mergePlaybackSession(latest, parsePlaybackSessionSnapshot(value));
    return value;
  }
  if (command === "catalog_song_artists") {
    if (connection !== "online") throw new Error("连接已断开，请等待恢复");
    return readJson("/api/library", { command, ...payload });
  }
  if (["auth_status", "catalog_discover_new_songs", "catalog_search_songs", "catalog_search_entities", "catalog_album_detail", "catalog_album_songs", "catalog_artist_detail", "catalog_artist_songs", "catalog_artist_albums", "library_liked_songs", "library_set_liked", "library_playlists", "catalog_playlist_songs", "local_music_list", "queue_replace", "queue_enqueue_many", "queue_enqueue", "queue_enqueue_next"].includes(command)) {
    if (connection !== "online") throw new Error("连接已断开，请等待恢复");
    const args = command === "queue_enqueue" || command === "queue_enqueue_next" ? { id: (payload.item as { id: string }).id } : (command === "queue_replace" || command === "queue_enqueue_many") ? { ids: (payload.items as Array<{ id: string }>).map(item => item.id) } : payload;
    const value = await readJson("/api/library", { command, ...args });
    // Queue adapters immediately use the new index to play an enqueued song.
    if ((command === "queue_enqueue" || command === "queue_enqueue_next" || command === "queue_replace" || command === "queue_enqueue_many") && latest) {
      latest = { ...latest, queue: newestQueue(latest.queue, parseQueueSnapshot(value)) };
      return latest.queue;
    }
    return value;
  }
  if (command === "playback_session_snapshot") return readState(payload.knownQueueGeneration);
  if (command === "queue_snapshot" || command === "player_snapshot") {
    await readState();
    return command === "queue_snapshot" ? latest!.queue : latest!.player;
  }
  if (!latest) throw new Error("等待播放状态");
  if (command === "queue_preview_next") return readJson("/api/preview");
  if (command === "lyrics_get") return readJson(`/api/lyrics?track=${encodeURIComponent(String(payload.trackId))}&generation=${payload.generation}`);
  if (command === "cover_get") {
    const kind = payload.kind === "artist" ? "artist" : "album";
    const track = kind === "album" ? latest.queue.items.find((item) => item.coverCacheKey === payload.cacheKey) : undefined;
    const cacheKey = String(payload.cacheKey);
    const key = `${kind}:${cacheKey}`;
    const existing = covers.get(key);
    if (existing) return existing;
    const coverEpoch = epoch;
    const pending = (async () => {
      if (coverReaders >= 2) await new Promise<void>(resolve => waitingCovers.push(resolve));
      else coverReaders++;
      try {
        if (coverEpoch !== epoch || !latest) throw new Error("连接已变化");
        const response = await request(track
          ? `/api/cover?track=${encodeURIComponent(track.id)}&generation=${latest.player.generation}`
          : `/api/library-cover?key=${encodeURIComponent(cacheKey)}&kind=${kind}`);
        return { mimeType: response.headers.get("content-type"), bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
      } finally {
        const next = waitingCovers.shift();
        if (next) next(); else coverReaders--;
      }
    })();
    if (covers.size >= 64) covers.delete(covers.keys().next().value!);
    covers.set(key, pending);
    void pending.catch(() => { if (covers.get(key) === pending) covers.delete(key); });
    return pending;
  }
  if (connection !== "online") throw new Error("连接已断开，请等待恢复");
  let body: Record<string, unknown>;
  switch (command) {
    case "player_play": body = { action: "play" }; break;
    case "player_pause": body = { action: "pause" }; break;
    case "queue_next": body = { action: "next" }; break;
    case "queue_previous": body = { action: "previous" }; break;
    case "player_seek": body = { action: "seek", position_ms: payload.positionMs, generation: latest.player.generation }; break;
    case "player_set_volume": body = { action: "volume", value: payload.volume }; break;
    case "player_set_muted": body = { action: "muted", value: payload.muted }; break;
    case "playback_set_mode": body = { action: "mode", value: payload.mode }; break;
    case "playback_change_quality": body = { action: "quality", value: payload.preferredQuality }; break;
    case "playback_set_mv_lyric_offset": body = { action: "mvLyricOffset", id: payload.trackId, generation: payload.generation, offset_ms: payload.offsetMs }; break;
    case "queue_play": {
      const track = latest.queue.items[Number(payload.index)];
      if (!track) throw new Error("队列已变化");
      body = { action: "playTrack", id: track.id, queue_generation: latest.queue.generation }; break;
    }
    default: throw new Error("此操作请在电脑端完成");
  }
  return readJson("/api/command", body);
}
export async function connectRemote(code: string): Promise<PlaybackSessionSnapshot> {
  epoch++;
  const connectionEpoch = epoch;
  beginPlaybackSession();
  secret = code.trim();
  latest = undefined;
  covers.clear();
  status("connecting");
  installPlaybackTransport(invokeRemote);
  try {
    await readState();
    sessionStorage.setItem("qmg-remote-code", secret);
    return latest!;
  } catch (error) {
    if (connectionEpoch === epoch && connection !== "disconnected") status("disconnected");
    throw error;
  }
}
