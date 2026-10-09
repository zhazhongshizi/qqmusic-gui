import { invokePlayback, playbackSessionIdentity } from "./playbackTransport";
import { parseQueueSnapshot } from "./nativeQueueAdapter";
import { playerActions } from "../features/player/playerStore";

export type TapeStatus = "recording" | "complete" | "partial";
export interface MemoryTape {
  month: string; generatedMs: number; cutoffMs: number; totalMs: number; qualifiedPlays: number; trackCount: number;
  topSong: string | null; topArtist: string | null; dataStartDate: string | null; dataEndDate: string | null; status: TapeStatus;
}
export interface TapeSong {
  id: string; title: string; artist: string; listenedMs: number; qualifiedPlays: number; availability: "local" | "online" | "unavailable";
}
export interface TapePage { items: MemoryTape[]; hasMore: boolean }
export interface TapeDetail { tape: MemoryTape; songs: TapeSong[]; offset: number; hasMore: boolean }
function object(value: unknown): Record<string,unknown> { if (!value || typeof value!=="object" || Array.isArray(value)) throw new Error("磁带响应无效"); return value as Record<string,unknown>; }
function text(value: unknown,max=512) { if(typeof value!=="string" || !value.trim() || new TextEncoder().encode(value).length>max || /[\u0000-\u001f]/.test(value)) throw new Error("磁带文本无效");return value; }
function number(value:unknown) { if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error("磁带数值无效");return value as number; }
function boolean(value:unknown) { if(typeof value!=="boolean")throw new Error("磁带状态无效");return value; }
function rows(value:unknown,max:number) { if(!Array.isArray(value)||value.length>max)throw new Error("磁带列表无效");return value as unknown[]; }
export function tapeMonth(value:unknown) { const month=text(value,7);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<"1970-01")throw new Error("磁带月份无效");return month; }
function date(value:unknown) { if(value===null)return null;const s=text(value,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw new Error("磁带日期无效");return s; }
export function parseTape(value:unknown): MemoryTape {
  const r=object(value),month=tapeMonth(r.month);
  if(r.status!=="recording"&&r.status!=="complete"&&r.status!=="partial")throw new Error("磁带状态无效");
  const dataStartDate=date(r.dataStartDate),dataEndDate=date(r.dataEndDate);
  if((dataStartDate!==null&&dataStartDate.slice(0,7)!==month)||(dataEndDate!==null&&dataEndDate.slice(0,7)!==month)||(dataStartDate&&dataEndDate&&dataStartDate>dataEndDate))throw new Error("磁带范围无效");
  return {month,status:r.status,generatedMs:number(r.generatedMs),cutoffMs:number(r.cutoffMs),totalMs:number(r.totalMs),qualifiedPlays:number(r.qualifiedPlays),trackCount:number(r.trackCount),topSong:r.topSong===null?null:text(r.topSong),topArtist:r.topArtist===null?null:text(r.topArtist),dataStartDate,dataEndDate};
}
async function request(request:Record<string,unknown>){return invokePlayback("personal_library",{request});}
export async function getMemoryTapes(before:string|null):Promise<TapePage>{
  if(before!==null)tapeMonth(before);
  const r=object(await request({action:"memoryTapes",before})),items=rows(r.items,12).map(parseTape);
  if(items.some((t,i)=>(before!==null&&t.month>=before)||(i>0&&t.month>=items[i-1]!.month)))throw new Error("磁带排序无效");
  return {items,hasMore:boolean(r.hasMore)};
}
export async function getMemoryTape(month:string,offset:number):Promise<TapeDetail>{
  tapeMonth(month);number(offset);if(offset%50!==0)throw new Error("磁带页码无效");
  const r=object(await request({action:"memoryTape",month,offset})),tape=parseTape(r.tape);
  if(tape.month!==month||r.offset!==offset)throw new Error("磁带响应已过期");
  const songs=rows(r.songs,50).map(value=>{const row=object(value);if(row.availability!=="local"&&row.availability!=="online"&&row.availability!=="unavailable")throw new Error("曲目状态无效");return {id:text(row.id,128),title:text(row.title),artist:text(row.artist),listenedMs:number(row.listenedMs),qualifiedPlays:number(row.qualifiedPlays),availability:row.availability} as TapeSong;});
  if(new Set(songs.map(s=>s.id)).size!==songs.length)throw new Error("磁带曲目重复");
  return {tape,songs,offset,hasMore:boolean(r.hasMore)};
}
export async function enqueueMemoryTape(month:string,ids:readonly string[]) {
  tapeMonth(month);if(!ids.length||ids.length>50||new Set(ids).size!==ids.length)throw new Error("磁带曲目数量无效");
  const identity=playbackSessionIdentity();
  const r=object(await request({action:"memoryTapeEnqueue",month,ids}));
  if(identity!==playbackSessionIdentity())throw new Error("连接已变化");
  const queue=parseQueueSnapshot(r.queue),acceptedIds=rows(r.acceptedIds,50).map(id=>text(id,128)),skippedIds=rows(r.skippedIds,50).map(id=>text(id,128));
  const returned=[...acceptedIds,...skippedIds];
  if(returned.length!==ids.length||new Set(returned).size!==ids.length||returned.some(id=>!ids.includes(id))||acceptedIds.some(id=>!queue.items.some(t=>t.id===id)))throw new Error("磁带入队响应无效");
  await playerActions.hydrateNative(queue);
  if(identity!==playbackSessionIdentity())throw new Error("连接已变化");
  return {acceptedIds,skippedIds};
}
