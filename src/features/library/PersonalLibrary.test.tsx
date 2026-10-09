import { cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { BookmarkButton,SavedQueues } from "./PersonalLibrary";
import { ListeningRecords as ListeningStatistics } from "./ListeningStatistics";
import { installPlaybackTransport } from "../../backend/playbackTransport";
import { resetPlayerFixture } from "../player/playerStore";
import { parseCollections,parseStatistics } from "../../backend/personalAdapter";
let collections={queues:[] as {name:string;count:number}[],bookmarks:[] as {kind:string;id:string;title:string}[],hasPrevious:true};
const stats={events:[],forgotten:[],startedMs:100,totalMs:9000,qualifiedPlays:1,storageAvailable:true,nextOverride:null,items:[{id:"a",title:"夜航",artist:"歌手",listenedMs:9000,qualifiedPlays:1,lastPlayedMs:Date.now(),recentMs:9000,recentPlays:1}],shuffle:{enabled:true,active:false,likesLoaded:true,items:[{id:"a",title:"夜航",artist:"歌手",weight:3,probability:1,lastPlayedMs:null,liked:true,recent:false}]}};
const transport=vi.fn(async (_command:string,payload?:Record<string,unknown>):Promise<unknown>=>{
  const r=payload!.request as Record<string,unknown>;
  if(r.action==="saveQueue")collections={...collections,queues:[{name:String(r.name),count:5}]};
  if(r.action==="bookmark")collections={...collections,bookmarks:r.saved?[{kind:String(r.kind),id:String(r.id),title:String(r.title)}]:[]};
  if(r.action==="statistics")return stats;
  return collections;
});
beforeEach(()=>{collections={queues:[],bookmarks:[],hasPrevious:true};resetPlayerFixture();installPlaybackTransport(transport);transport.mockClear();});
afterEach(()=>{cleanup();installPlaybackTransport(null);vi.restoreAllMocks();});
it("详情书签可保存、读回并移除",async()=>{
  render(<BookmarkButton kind="album" id="album1" title="专辑"/>);
  const button=screen.getByRole("button",{name:"加入我的资料库"});await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button);
  const saved=await screen.findByRole("button",{name:"已加入资料库"});expect(saved).toHaveAttribute("aria-pressed","true");fireEvent.click(saved);
  await waitFor(()=>expect(screen.getByRole("button",{name:"加入我的资料库"})).toBeEnabled());expect(collections.bookmarks).toEqual([]);
});
it("保存队列并明确标出同名更新，不启动播放",async()=>{
  render(<SavedQueues/>);await waitFor(()=>expect(transport).toHaveBeenCalled());
  fireEvent.change(screen.getByRole("textbox",{name:"队列名称"}),{target:{value:"通勤"}});
  const save=screen.getByRole("button",{name:"保存当前队列"});await waitFor(()=>expect(save).toBeEnabled());fireEvent.click(save);
  await screen.findByRole("button",{name:"更新同名队列"});expect(transport).toHaveBeenCalledWith("personal_library",{request:{action:"saveQueue",name:"通勤"}});
});
it("统计和实际权重说明显示生效状态与喜欢因素",async()=>{
  render(<ListeningStatistics/>);await screen.findByText("1 次");fireEvent.click(screen.getByRole("button",{name:"智能随机解释"}));
  expect(screen.getByText(/智能随机当前未生效/)).toBeInTheDocument();expect(screen.getByText(/喜欢加权/)).toBeInTheDocument();expect(screen.getByText(/权重 3.00/)).toBeInTheDocument();
});
it("拒绝越界队列、URL 书签和异常概率",()=>{
  expect(()=>parseCollections({...collections,queues:[{name:"a",count:1001}]})).toThrow();
  expect(()=>parseCollections({...collections,bookmarks:[{kind:"album",id:"https://bad",title:"bad"}]})).toThrow();
  expect(()=>parseStatistics({...stats,shuffle:{...stats.shuffle,items:[{...stats.shuffle.items[0],probability:2}]}})).toThrow();
});

it("有效收听记录显示逐次时间记录，不将累计曲目重复当作事件",async()=>{
  transport.mockImplementationOnce(async()=>({...stats,events:[{id:"a",title:"有效曲目",artist:"歌手",playedAtMs:1000}]}));
  render(<ListeningStatistics/>);await screen.findByText("1 次");fireEvent.click(screen.getByRole("button",{name:"有效收听记录"}));
  expect(screen.getByText("有效曲目")).toBeInTheDocument();expect(screen.getAllByRole("listitem")).toHaveLength(1);
});
