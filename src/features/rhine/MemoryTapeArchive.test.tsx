import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MemoryTapeArchive, { memoryMotion } from "./MemoryTapeArchive";
import { defaultRhineSettings } from "./rhineSettings";
import { beginPlaybackSession, installPlaybackTransport, notifyPlaybackReconnected } from "../../backend/playbackTransport";
const player=vi.hoisted(()=>({hydrateNative:vi.fn(),playTrack:vi.fn()}));
vi.mock("../player/playerStore",()=>({playerActions:player}));
const tape=(month="2026-10")=>({month,status:month==="2026-10"?"recording":"partial",generatedMs:100,cutoffMs:200,totalMs:60000,qualifiedPlays:2,trackCount:2,topSong:"月光",topArtist:"歌手",dataStartDate:`${month}-01`,dataEndDate:`${month}-08`});
const songs=[{id:"a",title:"月光",artist:"歌手",listenedMs:60000,qualifiedPlays:2,availability:"online"},{id:"missing",title:"旧录音",artist:"本地",listenedMs:1000,qualifiedPlays:0,availability:"unavailable"}];
const queue={generation:2,selectedIndex:0,items:[{id:"a",title:"月光",artist:"歌手",album:"",durationMs:0}]};
const transport=vi.fn(async(_c:string,p?:Record<string,unknown>):Promise<unknown>=>{
  const r=p!.request as {action:string;month:string;offset:number;ids:string[]};
  if(r.action==="memoryTapes")return {items:[tape(),tape("2026-09")],hasMore:false};
  if(r.action==="memoryTape")return {tape:tape(r.month),songs,offset:r.offset,hasMore:false};
  return {queue,acceptedIds:r.ids,skippedIds:[]};
});
beforeEach(()=>{transport.mockClear();player.hydrateNative.mockReset().mockResolvedValue(undefined);player.playTrack.mockReset().mockResolvedValue(true);installPlaybackTransport(transport);});
afterEach(()=>{cleanup();installPlaybackTransport(null);vi.restoreAllMocks();vi.useRealTimers();});
async function open(){fireEvent.click(await screen.findByRole("button",{name:/打开 2026-10/}));await screen.findByRole("button",{name:"回放 月光"});}
it("月份状态、翻面与重复打开不丢失档案，缺失曲目不可回放",async()=>{
  render(<MemoryTapeArchive settings={defaultRhineSettings()}/>);await open();
  expect(screen.getByRole("button",{name:"回放 旧录音"})).toBeDisabled();expect(screen.getByText(/本月尚未结束/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"翻面查看编号"}));expect(screen.getByRole("button",{name:"翻面查看编号"})).toHaveAttribute("aria-pressed","true");
  await open();expect(screen.getByRole("button",{name:"回放 月光"})).toBeEnabled();
  fireEvent.click(screen.getByRole("button",{name:"取出磁带"}));expect(screen.getByText("从档案柜取出一张磁带")).toBeInTheDocument();
});
it("本页入队排除失效曲目且不启动播放，回放等待队列确认",async()=>{
  render(<MemoryTapeArchive settings={defaultRhineSettings()}/>);await open();
  fireEvent.click(screen.getByRole("button",{name:"本页加入队列"}));await screen.findByText(/1 首已在队列中/);
  expect(transport).toHaveBeenCalledWith("personal_library",{request:{action:"memoryTapeEnqueue",month:"2026-10",ids:["a"]}});expect(player.playTrack).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"回放 月光"}));await screen.findByText("正在回放：月光");expect(player.playTrack).toHaveBeenCalledExactlyOnceWith("a");
});
it("重复点击不重放写请求，播放失败显示可重试状态",async()=>{
  render(<MemoryTapeArchive settings={defaultRhineSettings()}/>);await open();
  let finish!:(v:unknown)=>void;transport.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  player.playTrack.mockResolvedValueOnce(false);const button=screen.getByRole("button",{name:"回放 月光"});
  fireEvent.click(button);fireEvent.click(button);expect(button).toBeDisabled();
  await act(async()=>finish({queue,acceptedIds:["a"],skippedIds:[]}));await screen.findByText("暂时无法播放 · 可重试");expect(player.playTrack).toHaveBeenCalledTimes(1);
});
it("切换月份忽略迟到详情，断线换会话清空旧档案",async()=>{
  render(<MemoryTapeArchive settings={defaultRhineSettings()}/>);
  await screen.findByRole("button",{name:/打开 2026-10/});
  let resolveOld!:(v:unknown)=>void;
  const original=transport.getMockImplementation()!;
  transport.mockImplementation(async(c,p)=>{const r=p!.request as {action:string;month?:string};if(r.action==="memoryTape"&&r.month==="2026-10")return new Promise(resolve=>{resolveOld=resolve;});return original(c,p);});
  fireEvent.click(screen.getByRole("button",{name:/打开 2026-10/}));
  fireEvent.click(screen.getByRole("button",{name:/打开 2026-09/}));await screen.findByRole("heading",{name:"2026-09 / 回忆档案"});
  await act(async()=>resolveOld({tape:tape(),songs,offset:0,hasMore:false}));expect(screen.queryByRole("heading",{name:"2026-10 / 回忆档案"})).toBeNull();
  act(()=>{beginPlaybackSession();notifyPlaybackReconnected();});expect(screen.queryByRole("heading",{name:"2026-09 / 回忆档案"})).toBeNull();
  transport.mockImplementation(original);
});
it("空档案、读取失败和手动重试",async()=>{
  transport.mockRejectedValueOnce(new Error("offline"));render(<MemoryTapeArchive settings={defaultRhineSettings()}/>);
  const retry=await screen.findByRole("button",{name:"重试档案"});transport.mockResolvedValueOnce({items:[],hasMore:false});fireEvent.click(retry);await screen.findByText("还没有回忆磁带");
});
it("遵循减少、禁用、2D与超级性能设置",()=>{
  const settings=defaultRhineSettings();expect(memoryMotion(settings)).toBe("full");
  expect(memoryMotion({...settings,reduceCassetteMotionWhilePlaying:true})).toBe("reduced");
  for(const change of [{superPerformance:true},{disableCassetteMotionWhilePlaying:true},{renderer:"canvas2d" as const}])expect(memoryMotion({...settings,...change})).toBe("off");
  const view=render(<MemoryTapeArchive settings={{...settings,superPerformance:true}}/>);expect(screen.getByRole("region",{name:"回忆磁带"})).toHaveAttribute("data-motion","off");view.unmount();
});
it("页面隐藏或入队处理中不自动刷新",async()=>{
  vi.useFakeTimers();const visibility=vi.spyOn(document,"visibilityState","get").mockReturnValue("hidden");
  const view=render(<MemoryTapeArchive settings={defaultRhineSettings()}/>);await act(async()=>{});const count=transport.mock.calls.length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});expect(transport).toHaveBeenCalledTimes(count);
  visibility.mockReturnValue("visible");await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});expect(transport).toHaveBeenCalledTimes(count+1);
  view.unmount();
});
