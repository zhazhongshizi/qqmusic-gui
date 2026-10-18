import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DiscoveryFrame, DiscoveryState } from "./vendor/discovery-layout";
import RhineMode from "./RhineMode";
import { resetPlayerFixture } from "../player/playerStore";

const mocks=vi.hoisted(()=>({lists:vi.fn(),songs:vi.fn(),play:vi.fn(),
 scene:null as null|{discovery:DiscoveryState|null;deck:boolean;onDiscoveryFrame:(frame:DiscoveryFrame)=>void}}));
vi.mock("./ArchiveSearch",()=>({ArchiveSearch:()=>null}));
vi.mock("../../backend/libraryAdapter",()=>({getLibraryPlaylists:mocks.lists}));
vi.mock("../../backend/catalogDiscoveryAdapter",()=>({getRecommendedSongs:mocks.songs,getRecommendedPlaylists:vi.fn()}));
vi.mock("../player/catalogQueue",async original=>({...await original<object>(),enqueueAndPlayCatalogTrack:mocks.play}));
vi.mock("./ArchiveCanvas",()=>({ArchiveCanvas:(props:NonNullable<typeof mocks.scene>)=>{mocks.scene=props;return <div data-testid="scene"/>;}}));
vi.mock("./TapeDeck",()=>({NowPlaying:({onOpen}:{onOpen:()=>void})=><button onClick={onOpen}>打开播放界面</button>,
 TapeDeck:({onBack}:{onBack:()=>void})=><section aria-label="磁带机"><button onClick={onBack}>返回发现页</button></section>}));
const props={auth:{state:"authenticated" as const,account:{musicId:"123",loginMethod:"qq" as const}},authRecovering:false,active:true,onExit:vi.fn(),onAccount:vi.fn()};
const song={id:"song-a",title:"过渡测试",artist:"歌手",artists:[],album:"专辑",subtitle:"",durationMs:180000,qualityCandidates:[],availability:{status:"unknown",requiresSubscription:false}};
function frame(phase:DiscoveryFrame["phase"]){act(()=>mocks.scene!.onDiscoveryFrame({phase,progress:phase==="ready"?1:0,rects:[],contentHeight:800}));}
async function discover(){fireEvent.click(screen.getByRole("button",{name:"发现音乐"}));await screen.findByRole("button",{name:"选择歌曲 过渡测试"});frame("ready");}
async function play(){fireEvent.click(screen.getByRole("button",{name:"选择歌曲 过渡测试"}));fireEvent.click(screen.getByRole("button",{name:"播放"}));await waitFor(()=>expect(mocks.play).toHaveBeenCalled());}
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal("ResizeObserver",class{observe(){}disconnect(){}});localStorage.clear();resetPlayerFixture();mocks.scene=null;
 mocks.lists.mockResolvedValue({kind:"created",page:1,hasMore:false,total:1,warningCount:0,items:[{id:"p1",title:"歌单",description:"",songCount:1}]});
 mocks.songs.mockImplementation(async(_kind,generation,page)=>({generation,page,hasMore:false,warningCount:0,items:[song]}));
 mocks.play.mockResolvedValue(undefined);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it("uses the full discovery entry from playback and completes the reverse movement before showing playback again",async()=>{
 render(<RhineMode {...props}/>);fireEvent.click(screen.getByRole("button",{name:/跳过动画/}));
 fireEvent.click(await screen.findByRole("button",{name:"打开播放界面"}));expect(mocks.scene!.deck).toBe(true);
 await discover();expect(mocks.scene!.discovery).toMatchObject({open:true,shortEntry:false,instant:false});
 await play();await waitFor(()=>expect(mocks.scene!.discovery?.open).toBe(false));
 expect(mocks.scene!.deck).toBe(false);expect(screen.queryByRole("region",{name:"磁带机"})).not.toBeInTheDocument();
 frame("moving");expect(screen.queryByRole("region",{name:"磁带机"})).not.toBeInTheDocument();
 frame("closed");expect(await screen.findByRole("region",{name:"磁带机"})).toBeInTheDocument();expect(mocks.scene!.discovery).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"返回发现页"}));
 expect(mocks.scene!.discovery).toMatchObject({open:true,shortEntry:false,instant:false});
});
it("starts the same reverse transition for playback opened from an archive discovery visit",async()=>{
 render(<RhineMode {...props}/>);fireEvent.click(screen.getByRole("button",{name:/跳过动画/}));await discover();await play();
 await waitFor(()=>expect(mocks.scene!.discovery?.open).toBe(false));expect(mocks.scene!.discovery?.instant).toBe(false);
 frame("closed");expect(await screen.findByRole("region",{name:"磁带机"})).toBeInTheDocument();
});
it("keeps the recommendation shelf when playback fails",async()=>{
 mocks.play.mockRejectedValueOnce(Error("play failed"));render(<RhineMode {...props}/>);fireEvent.click(screen.getByRole("button",{name:/跳过动画/}));await discover();await play();
 await screen.findByText("操作失败，请重试");expect(mocks.scene!.discovery?.open).toBe(true);expect(mocks.scene!.deck).toBe(false);
});
it("cancels the pending playback destination when navigating elsewhere during the reverse animation",async()=>{
 render(<RhineMode {...props}/>);fireEvent.click(screen.getByRole("button",{name:/跳过动画/}));await discover();await play();
 await waitFor(()=>expect(mocks.scene!.discovery?.open).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"本地音乐"}));
 expect(mocks.scene!.discovery).toBeNull();frame("closed");expect(mocks.scene!.deck).toBe(false);
});
it("keeps full entry when the playback page was opened over search",async()=>{
 render(<RhineMode {...props}/>);fireEvent.click(screen.getByRole("button",{name:/跳过动画/}));
 fireEvent.click(screen.getByRole("button",{name:"搜索"}));
 fireEvent.click(screen.getByRole("button",{name:"打开播放界面"}));await discover();
 expect(mocks.scene!.discovery).toMatchObject({open:true,shortEntry:false,instant:false});
});