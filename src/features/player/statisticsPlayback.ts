import { nativeQueueEnqueueMany, nativeQueueEnqueueNext, nativeQueueSnapshot } from "../../backend/nativeQueueAdapter";
import { playbackSessionIdentity } from "../../backend/playbackTransport";
import { playerActions } from "./playerStore";

export type StatisticsAction = "play" | "next" | "enqueue";
export async function actOnStatisticsTrack(row: { id: string; title: string; artist: string }, action: StatisticsAction) {
  const identity = playbackSessionIdentity();
  const current = await nativeQueueSnapshot();
  if (identity !== playbackSessionIdentity()) throw new Error("连接已变化");
  const track = current.items.find(item => item.id === row.id) ?? { id: row.id, title: row.title, artist: row.artist, album: "", durationMs: 0 };
  const queue = action === "next" ? await nativeQueueEnqueueNext(track) : await nativeQueueEnqueueMany([track]);
  if (identity !== playbackSessionIdentity()) throw new Error("连接已变化");
  await playerActions.hydrateNative(queue);
  if (identity !== playbackSessionIdentity()) throw new Error("连接已变化");
  if (action === "play" && await playerActions.playTrack(row.id) === false) throw new Error("播放未启动");
}
