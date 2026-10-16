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
