import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CatalogSong } from "../../contracts/catalog";
import type { CatalogEntity } from "../../contracts/catalogBrowse";
import { ArchiveDiscovery } from "./ArchiveDiscovery";

const mocks=vi.hoisted(()=>({songs:vi.fn(),lists:vi.fn(),play:vi.fn(),next:vi.fn(),enqueue:vi.fn()}));
vi.mock("../../backend/catalogDiscoveryAdapter",()=>({getRecommendedSongs:mocks.songs,getRecommendedPlaylists:mocks.lists}));
vi.mock("../player/catalogQueue",()=>({enqueueAndPlayCatalogTrack:mocks.play,enqueueNextCatalogTrack:mocks.next,enqueueCatalogTrack:mocks.enqueue}));
vi.mock("../catalog/CatalogDetails",()=>({
  CatalogDetails:({entity,onBack,onPlayback}:{entity:CatalogEntity;onBack:()=>void;onPlayback:()=>void})=><section aria-label="模拟详情"><h2>{entity.kind==="artist"?entity.name:entity.title}</h2><button onClick={onBack}>返回上一页</button><button onClick={onPlayback}>详情播放</button></section>,
  AlbumLink:({track,onOpen}:{track:CatalogSong;onOpen:(e:CatalogEntity)=>void})=><button onClick={()=>onOpen({kind:"album",id:track.albumId!,title:track.album,description:"",publishDate:""})}>{track.album}</button>,
}));
const songs:CatalogSong[]=[1,2,3,4].map(n=>({id:`song-${n}`,title:`曲目 ${n}`,artist:`歌手 ${n}`,artists:[{id:`artist-${n}`,name:`歌手 ${n}`}],album:`专辑 ${n}`,albumId:`album-${n}`,durationMs:183000,subtitle:"",qualityCandidates:[],availability:{status:"unknown",requiresSubscription:false}}));
const props={active:true,accountKey:"authenticated:a",onClose:vi.fn(),onDeck:vi.fn()};
beforeEach(()=>{
 vi.clearAllMocks();mocks.songs.mockImplementation((_kind:string,generation:number,page:number)=>Promise.resolve({generation,page,hasMore:page===1,warningCount:0,items:page===1?songs:[songs[3]]}));
 mocks.lists.mockImplementation((generation:number,page:number)=>Promise.resolve({generation,page,hasMore:page===1,warningCount:0,items:[{kind:"playlist",id:String(page),title:`歌单 ${page}`,coverCacheKey:`pl_${page}`,songCount:20,listenCount:100,description:"歌单简介"}]}));
 mocks.play.mockResolvedValue(undefined);mocks.next.mockResolvedValue(undefined);mocks.enqueue.mockResolvedValue(undefined);
});
afterEach(cleanup);
const button=(name:string)=>screen.getByRole("button",{name});
const dossier=()=>within(screen.getByRole("dialog",{name:"选中磁带档案"}));

it("shows at most nine real tapes per page and keeps all twenty playlists reachable",async()=>{
 const playlists=Array.from({length:20},(_,i)=>({kind:"playlist",id:String(i+1),title:`歌单 ${i+1}`,songCount:1,listenCount:0,description:""}));
 mocks.lists.mockImplementation((generation:number)=>Promise.resolve({generation,page:1,hasMore:false,warningCount:0,items:playlists}));
 const scene=vi.fn();render(<ArchiveDiscovery {...props} onSceneChange={scene}/>);fireEvent.click(button("推荐歌单"));
 await screen.findByRole("button",{name:"选择歌单 歌单 1"});expect(screen.getAllByRole("button",{name:/^选择歌单 /})).toHaveLength(9);
 await waitFor(()=>expect(scene.mock.lastCall?.[0].entries).toHaveLength(9));fireEvent.click(button("下一页"));
 await screen.findByRole("button",{name:"选择歌单 歌单 10"});expect(screen.getAllByRole("button",{name:/^选择歌单 /})).toHaveLength(9);fireEvent.click(button("下一页"));
 await screen.findByRole("button",{name:"选择歌单 歌单 19"});expect(screen.getAllByRole("button",{name:/^选择歌单 /})).toHaveLength(2);
 expect(button("下一页")).toBeDisabled();expect(mocks.lists).toHaveBeenCalledOnce();fireEvent.click(button("上一页"));
 await screen.findByRole("button",{name:"选择歌单 歌单 10"});expect(mocks.lists).toHaveBeenCalledOnce();
});

it("preserves unindexed song credits as text while valid artists still open",async()=>{
 const credited={...songs[0]!,artists:[{id:"0",name:"未建主页的署名"},songs[0]!.artists[0]!],artist:"未建主页的署名 / 歌手 1"};
 mocks.songs.mockImplementation((_kind:string,generation:number)=>Promise.resolve({generation,page:1,hasMore:false,warningCount:0,items:[credited]}));
 render(<ArchiveDiscovery {...props}/>);fireEvent.click(await screen.findByRole("button",{name:"选择歌曲 曲目 1"}));
 expect(dossier().getByText(/未建主页的署名/)).toBeInTheDocument();
 expect(dossier().queryByRole("button",{name:"未建主页的署名"})).not.toBeInTheDocument();
 fireEvent.click(dossier().getByRole("button",{name:"歌手 1"}));
 expect(screen.getByRole("heading",{name:"歌手 1"})).toBeInTheDocument();
});

it("hovers without selecting or playing, extracts on click and exposes explicit actions",async()=>{
 const scene=vi.fn();render(<ArchiveDiscovery {...props} onSceneChange={scene}/>);
 const tape=await screen.findByRole("button",{name:"选择歌曲 曲目 2"});
 expect(screen.queryByRole("dialog")).not.toBeInTheDocument();fireEvent.pointerEnter(tape);
 await waitFor(()=>expect(scene.mock.lastCall?.[0].hovered).toBe("song:song-2"));expect(mocks.play).not.toHaveBeenCalled();
 fireEvent.click(tape);expect(dossier().getByRole("heading",{name:"曲目 2"})).toBeInTheDocument();
 fireEvent.click(button("下一首播放"));await waitFor(()=>expect(mocks.next).toHaveBeenCalledWith(songs[1]));
 await waitFor(()=>expect(button("加入队列")).toBeEnabled());fireEvent.click(button("加入队列"));
 await waitFor(()=>expect(mocks.enqueue).toHaveBeenCalledWith(songs[1]));expect(props.onDeck).not.toHaveBeenCalled();
});

it("navigates only after successful playback, retaining extraction on failure",async()=>{
 render(<ArchiveDiscovery {...props}/>);fireEvent.click(await screen.findByRole("button",{name:"选择歌曲 曲目 2"}));
 mocks.play.mockRejectedValueOnce(new Error("offline"));fireEvent.click(button("播放"));
 await screen.findByText("操作失败，请重试");expect(props.onDeck).not.toHaveBeenCalled();expect(screen.getByRole("dialog")).toBeInTheDocument();
 fireEvent.click(button("播放"));await waitFor(()=>expect(props.onDeck).toHaveBeenCalledOnce());
});

it("does not navigate from a pending playback after the discovery page becomes inactive",async()=>{
 let finish!:()=>void;mocks.play.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const view=render(<ArchiveDiscovery {...props}/>);fireEvent.click(await screen.findByRole("button",{name:"选择歌曲 曲目 1"}));fireEvent.click(button("播放"));
 view.rerender(<ArchiveDiscovery {...props} active={false}/>);await act(async()=>finish());expect(props.onDeck).not.toHaveBeenCalled();
 view.rerender(<ArchiveDiscovery {...props}/>);expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("restores category, page, scroll, extracted item and detail focus without fetching again",async()=>{
 const {container}=render(<ArchiveDiscovery {...props}/>);
 await screen.findByRole("button",{name:"选择歌曲 曲目 1"});fireEvent.click(button("雷达推荐"));
 fireEvent.click(await screen.findByRole("button",{name:"下一页"}));
 const tape=await screen.findByRole("button",{name:"选择歌曲 曲目 4"});
 const scroll=container.querySelector<HTMLElement>('[data-rack-tab="radar"] .discovery-rack-scroll')!;
 scroll.scrollTop=160;fireEvent.scroll(scroll);fireEvent.click(tape);
 const opener=button("专辑 4");opener.focus();fireEvent.click(opener);
 expect(screen.getByRole("region",{name:"模拟详情"})).toBeInTheDocument();const calls=mocks.songs.mock.calls.length;
 fireEvent.click(button("返回上一页"));await waitFor(()=>expect(opener).toHaveFocus());
 expect(scroll.scrollTop).toBe(160);expect(screen.getByText("第 2 页")).toBeInTheDocument();
 fireEvent.click(button("猜你喜欢"));fireEvent.click(button("雷达推荐"));
 expect(screen.getByRole("dialog")).toBeInTheDocument();expect(scroll.scrollTop).toBe(160);expect(mocks.songs).toHaveBeenCalledTimes(calls);
});

it("uses real playlist covers, opens its tracks and restores the selected playlist",async()=>{
 const scene=vi.fn();render(<ArchiveDiscovery {...props} onSceneChange={scene}/>);fireEvent.click(button("推荐歌单"));
 await screen.findByRole("button",{name:"选择歌单 歌单 1"});fireEvent.click(button("下一页"));
 fireEvent.click(await screen.findByRole("button",{name:"选择歌单 歌单 2"}));
 expect(scene.mock.lastCall?.[0].entries[0]).toMatchObject({kind:"playlist",coverCacheKey:"pl_2"});
 fireEvent.click(button("查看歌单 ↗"));fireEvent.click(button("详情播放"));expect(props.onDeck).toHaveBeenCalledOnce();
 fireEvent.click(button("返回上一页"));expect(screen.getByRole("dialog")).toBeInTheDocument();expect(button("下一页")).toBeDisabled();expect(mocks.lists).toHaveBeenCalledTimes(2);
});

it("refreshes locally and closes an extracted item rather than inventing a replacement selection",async()=>{
 render(<ArchiveDiscovery {...props}/>);fireEvent.click(await screen.findByRole("button",{name:"选择歌曲 曲目 2"}));
 fireEvent.click(button("刷新推荐"));await screen.findByRole("button",{name:"选择歌曲 曲目 2"});expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("discards old account responses and does not request while inactive",async()=>{
 let finish!:(value:unknown)=>void;mocks.songs.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const view=render(<ArchiveDiscovery {...props}/>);view.rerender(<ArchiveDiscovery {...props} accountKey="authenticated:b"/>);
 await screen.findByRole("button",{name:"选择歌曲 曲目 1"});await act(async()=>finish({generation:1,page:1,warningCount:0,hasMore:false,items:[{...songs[0],title:"旧账号"}]}));
 expect(screen.queryByText("旧账号")).not.toBeInTheDocument();view.rerender(<ArchiveDiscovery {...props} accountKey="authenticated:c" active={false}/>);expect(mocks.songs).toHaveBeenCalledTimes(2);
});

it("supports empty/error recovery and Escape first returns the tape then exits",async()=>{
 mocks.songs.mockRejectedValueOnce(new Error("offline"));render(<ArchiveDiscovery {...props}/>);await screen.findByRole("alert");
 mocks.songs.mockImplementationOnce((_kind:string,generation:number)=>Promise.resolve({generation,page:1,warningCount:0,hasMore:false,items:[]}));
 fireEvent.click(button("刷新推荐"));await screen.findByText("暂时没有推荐内容，稍后刷新试试。");fireEvent.click(button("刷新推荐"));
 const tape=await screen.findByRole("button",{name:"选择歌曲 曲目 2"});tape.focus();await userEvent.keyboard("{Enter}");expect(screen.getByRole("dialog")).toBeInTheDocument();
 await userEvent.keyboard("{Escape}");expect(props.onClose).not.toHaveBeenCalled();await waitFor(()=>expect(tape).toHaveFocus());
 await userEvent.keyboard("{Escape}");expect(props.onClose).toHaveBeenCalledOnce();
});

it("keeps the dossier mounted with data-exiting during tape return and unmounts after 480ms",async()=>{
 const {container}=render(<ArchiveDiscovery {...props}/>);
 fireEvent.click(await screen.findByRole("button",{name:"选择歌曲 曲目 1"}));
 expect(screen.getByRole("dialog",{name:"选中磁带档案"})).toBeInTheDocument();
 vi.useFakeTimers();
 try {
  fireEvent.click(button("收回磁带"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const exiting=container.querySelector(".discovery-rack-dossier");
  expect(exiting).toHaveAttribute("data-exiting","true");
  act(()=>vi.advanceTimersByTime(479));
  expect(container.querySelector(".discovery-rack-dossier")).toHaveAttribute("data-exiting","true");
  act(()=>vi.advanceTimersByTime(1));
  expect(container.querySelector(".discovery-rack-dossier")).toBeNull();
 } finally {
  vi.useRealTimers();
 }
});
