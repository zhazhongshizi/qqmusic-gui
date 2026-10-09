import { afterEach, expect, it, vi } from "vitest";
import { enqueueMemoryTape, getMemoryTape, getMemoryTapes, parseTape, tapeMonth } from "./memoryTapeAdapter";
import { beginPlaybackSession, installPlaybackTransport } from "./playbackTransport";
const hydrate=vi.hoisted(()=>vi.fn());
vi.mock("../features/player/playerStore",()=>({playerActions:{hydrateNative:hydrate}}));
const tape={month:"2026-10",status:"recording",generatedMs:1,cutoffMs:2,totalMs:1000,qualifiedPlays:1,trackCount:1,topSong:"Song",topArtist:"Artist",dataStartDate:"2026-10-01",dataEndDate:"2026-10-09"};
const queue={generation:2,selectedIndex:0,items:[{id:"a",title:"Song",artist:"Artist",album:"",durationMs:0}]};
afterEach(()=>{installPlaybackTransport(null);hydrate.mockReset();});
it("月份、归档范围、页长和错月响应校验",async()=>{
  expect(parseTape(tape)).toEqual(tape);expect(()=>tapeMonth("2026-13")).toThrow();expect(()=>parseTape({...tape,dataStartDate:"2025-10-01"})).toThrow();
  installPlaybackTransport(async()=>({items:Array(13).fill(tape),hasMore:false}));await expect(getMemoryTapes(null)).rejects.toThrow();
  installPlaybackTransport(async()=>({tape,songs:[],offset:0,hasMore:false}));await expect(getMemoryTape("2026-09",0)).rejects.toThrow();
});
it("已确认入队才同步，跳过列表不能包含未请求曲目",async()=>{
  installPlaybackTransport(async()=>({queue,acceptedIds:["a"],skippedIds:["missing"]}));
  await expect(enqueueMemoryTape("2026-10",["a","missing"])).resolves.toEqual({acceptedIds:["a"],skippedIds:["missing"]});expect(hydrate).toHaveBeenCalledExactlyOnceWith(queue);
  await expect(enqueueMemoryTape("2026-10",["a"])).rejects.toThrow();expect(hydrate).toHaveBeenCalledTimes(1);
});
it("会话变更后不应用迟到写响应，也不重试",async()=>{
  let finish!:(value:unknown)=>void;const transport=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));installPlaybackTransport(transport);
  const pending=enqueueMemoryTape("2026-10",["a"]);beginPlaybackSession();finish({queue,acceptedIds:["a"],skippedIds:[]});
  await expect(pending).rejects.toThrow("连接已变化");expect(hydrate).not.toHaveBeenCalled();expect(transport).toHaveBeenCalledTimes(1);
});
