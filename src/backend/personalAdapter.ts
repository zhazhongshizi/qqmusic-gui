import { invokePlayback, playbackSessionIdentity } from "./playbackTransport";
import { parsePlaybackSessionSnapshot, parseQueueTrack } from "./nativeQueueAdapter";
import { playerActions } from "../features/player/playerStore";

export interface Bookmark { kind: "album" | "artist"; id: string; title: string; coverCacheKey?: string | null; addedMs?: number; pinned?: boolean }
export interface Collections { queues: readonly { name: string; count: number; savedAtMs?: number }[]; bookmarks: readonly Bookmark[]; hasPrevious: boolean; previous?: { count: number; savedAtMs: number } | null; deletedQueue?: string | null }
export interface ListeningRow { id: string; title: string; artist: string; listenedMs: number; qualifiedPlays: number; lastPlayedMs: number; recentMs: number; recentPlays: number }
export interface ShuffleRow { id: string; title: string; artist: string; lastPlayedMs: number | null; liked: boolean; recent: boolean; weight: number; probability: number }
export interface Statistics {
  events: readonly { id: string; title: string; artist: string; playedAtMs: number }[];
  forgotten: readonly { id: string; title: string; artist: string; lastPlayedMs: number }[];
  startedMs: number | null; totalMs: number; qualifiedPlays: number; storageAvailable: boolean;
  items: readonly ListeningRow[]; nextOverride: string | null;
  shuffle: { enabled: boolean; active: boolean; likesLoaded: boolean; items: readonly ShuffleRow[] };
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error("本地资料响应无效");
  return value as Record<string, unknown>;
}
function extensible(value: unknown, required: readonly string[], optional: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本地资料响应无效");
  return record(value,[...required,...optional.filter(key=>key in value)]);
}
function text(value: unknown, limit = 512): string {
  if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).length > limit || /[\u0000-\u001f]/.test(value)) throw new Error("本地资料响应无效");
  return value;
}
function number(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("本地资料响应无效"); return value as number; }
function boolean(value: unknown): boolean {if (typeof value !== "boolean") throw new Error("本地资料响应无效");return value;}
function array(value: unknown, max: number): unknown[] {if (!Array.isArray(value) || value.length > max) throw new Error("本地资料响应无效");return value;}
async function request(request: Record<string, unknown>): Promise<unknown> {return invokePlayback("personal_library", { request });}
export function parseCollections(value: unknown): Collections {
  const data = extensible(value, ["queues", "bookmarks", "hasPrevious"], ["previous","deletedQueue"]);
  return {
    hasPrevious: boolean(data.hasPrevious),
    previous: data.previous == null ? null : (()=>{const r=record(data.previous,["count","savedAtMs"]);const count=number(r.count);if(count>1000)throw new Error("队列过长");return {count,savedAtMs:number(r.savedAtMs)};})(),
    deletedQueue: data.deletedQueue == null ? null : text(data.deletedQueue,128),
    queues: array(data.queues, 100).map(value => { const row = extensible(value, ["name", "count"], ["savedAtMs"]); const count=number(row.count);if(count>1000)throw new Error("队列过长");return {name:text(row.name,128),count,savedAtMs:row.savedAtMs===undefined?0:number(row.savedAtMs)}; }),
    bookmarks: array(data.bookmarks,500).map(value => {const row=extensible(value,["kind","id","title"],["addedMs","pinned","coverCacheKey"]);if(row.kind!=="album"&&row.kind!=="artist")throw new Error("书签类型无效");const id=text(row.id,128);if(!/^[A-Za-z0-9_-]+$/.test(id))throw new Error("书签 ID 无效");const cover=row.coverCacheKey==null?null:text(row.coverCacheKey,128);if(cover&&!/^[A-Za-z0-9_-]+$/.test(cover))throw new Error("封面键无效");return {kind:row.kind,id,title:text(row.title),coverCacheKey:cover,addedMs:row.addedMs===undefined?0:number(row.addedMs),pinned:row.pinned===undefined?false:boolean(row.pinned)}; }),
  };
}
const listeners=new Set<() => void>();
export function subscribeCollections(listener: () => void) {listeners.add(listener);return () => {listeners.delete(listener);};}
export const getCollections=async () => parseCollections(await request({action:"collections"}));
export async function changeCollections(args: Record<string,unknown>): Promise<Collections> {
  const identity=playbackSessionIdentity();
  const result=parseCollections(await request(args));
  if(identity!==playbackSessionIdentity())throw new Error("连接已变化");
  listeners.forEach(listener=>listener());return result;
}
export async function switchQueue(name?: string): Promise<void> {
  const identity=playbackSessionIdentity();
  const result=await request(name===undefined?{action:"restoreQueue"}:{action:"loadQueue",name});
  if(identity!==playbackSessionIdentity())return;
  await playerActions.hydrateNativeSession(parsePlaybackSessionSnapshot(result));
  listeners.forEach(listener=>listener());
}
export function parseStatistics(value: unknown): Statistics {
  const data=record(value,["startedMs","totalMs","qualifiedPlays","items","storageAvailable","shuffle","nextOverride","forgotten","events"]);
  const shuffle=record(data.shuffle,["enabled","active","likesLoaded","items"]);
  return {startedMs:data.startedMs===null?null:number(data.startedMs),totalMs:number(data.totalMs),qualifiedPlays:number(data.qualifiedPlays),storageAvailable:boolean(data.storageAvailable),nextOverride:data.nextOverride===null?null:text(data.nextOverride,128),
    forgotten:array(data.forgotten,1000).map(value=>{const row=record(value,["id","title","artist","lastPlayedMs"]);return {id:text(row.id,128),title:text(row.title),artist:text(row.artist),lastPlayedMs:number(row.lastPlayedMs)};}),
    events:array(data.events,5000).map(value=>{const row=record(value,["id","title","artist","playedAtMs"]);return {id:text(row.id,128),title:text(row.title),artist:text(row.artist),playedAtMs:number(row.playedAtMs)};}),
    items:array(data.items,5000).map(value=>{const r=record(value,["id","title","artist","listenedMs","qualifiedPlays","lastPlayedMs","recentMs","recentPlays"]);return {id:text(r.id,128),title:text(r.title),artist:text(r.artist),listenedMs:number(r.listenedMs),qualifiedPlays:number(r.qualifiedPlays),lastPlayedMs:number(r.lastPlayedMs),recentMs:number(r.recentMs),recentPlays:number(r.recentPlays)};}),
    shuffle:{enabled:boolean(shuffle.enabled),active:boolean(shuffle.active),likesLoaded:boolean(shuffle.likesLoaded),items:array(shuffle.items,1000).map(value=>{const r=record(value,["id","title","artist","lastPlayedMs","liked","recent","weight","probability"]);if(typeof r.weight!=="number"||!Number.isFinite(r.weight)||r.weight<0||typeof r.probability!=="number"||!Number.isFinite(r.probability)||r.probability<0||r.probability>1)throw new Error("随机权重无效");return {id:text(r.id,128),title:text(r.title),artist:text(r.artist),lastPlayedMs:r.lastPlayedMs===null?null:number(r.lastPlayedMs),liked:boolean(r.liked),recent:boolean(r.recent),weight:r.weight,probability:r.probability};})},
  };
}
export const getStatistics=async(sinceMs?: number)=>parseStatistics(await request({action:"statistics",...(sinceMs===undefined?{}:{sinceMs})}));
export async function previewQueue(name?: string) {
  const data=record(await request({action:"previewQueue",name:name??null}),["items","selectedIndex","savedAtMs"]);
  const items=array(data.items,1000).map(parseQueueTrack);
  const selectedIndex=data.selectedIndex===null?null:number(data.selectedIndex);
  if(selectedIndex!==null&&selectedIndex>=items.length)throw new Error("队列选中项无效");
  return {items,selectedIndex,savedAtMs:number(data.savedAtMs)};
}
