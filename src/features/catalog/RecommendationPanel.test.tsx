import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecommendationPanel } from "./RecommendationPanel";
const mocks = vi.hoisted(() => ({ songs: vi.fn(), lists: vi.fn(), play: vi.fn(), next: vi.fn(), enqueue: vi.fn() }));
vi.mock("../../backend/catalogDiscoveryAdapter", () => ({
  getRecommendedSongs: mocks.songs, getRecommendedPlaylists: mocks.lists,
}));
vi.mock("../player/catalogQueue", () => ({
  enqueueAndPlayCatalogTrack: mocks.play, enqueueNextCatalogTrack: mocks.next, enqueueCatalogTrack: mocks.enqueue,
}));
vi.mock("../stage/AlbumArtwork", () => ({ AlbumArtwork: () => <span /> }));
const song = { id: "song-1", title: "推荐曲目", subtitle: "", artists: [{ id: "artist-1", name: "歌手" }],
  artist: "歌手", album: "专辑", durationMs: 180000, qualityCandidates: [],
  availability: { status: "unknown", requiresSubscription: false } };
const playlist = { kind: "playlist", id: "123", title: "推荐歌单一", description: "安静的旋律", songCount: 20, listenCount: 1000 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.songs.mockImplementation((_kind: string, generation: number, page: number) =>
    Promise.resolve({ generation, page, hasMore: true, warningCount: 0, items: [song] }));
  mocks.lists.mockImplementation((generation: number, page: number) =>
    Promise.resolve({ generation, page, hasMore: false, warningCount: 0, items: [playlist] }));
  mocks.play.mockResolvedValue(undefined); mocks.next.mockResolvedValue(undefined); mocks.enqueue.mockResolvedValue(undefined);
});
afterEach(cleanup);
it("retains a named song credit as text and keeps the profiled artist link",async()=>{
 const credited={...song,artists:[{id:"0",name:"未建主页的署名"},...song.artists],artist:"未建主页的署名 / 歌手"};
 mocks.songs.mockImplementation((_kind:string,generation:number)=>Promise.resolve({generation,page:1,hasMore:false,warningCount:0,items:[credited]}));
 const open=vi.fn();render(<RecommendationPanel kind="radar" accountKey="authenticated:a" onOpen={open}/>);
 await screen.findByText("推荐曲目");expect(screen.getByText("未建主页的署名")).toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"未建主页的署名"})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:"歌手"}));expect(open).toHaveBeenCalledWith({kind:"artist",...song.artists[0]});
});
it("loads guessed songs and supports play, enqueue-next and refresh", async () => {
  render(<RecommendationPanel kind="guess" accountKey="authenticated:a" onOpen={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "播放 推荐曲目" }));
  await waitFor(() => expect(mocks.play).toHaveBeenCalledWith(song));
  fireEvent.click(screen.getByRole("button", { name: "下一首播放 推荐曲目" }));
  await waitFor(() => expect(mocks.next).toHaveBeenCalledWith(song));
  expect(screen.queryByRole("navigation", { name: "推荐分页" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "刷新推荐" }));
  await waitFor(() => expect(mocks.songs).toHaveBeenCalledTimes(2));
});
it("paginates radar recommendations and opens recommended playlist details", async () => {
  const open = vi.fn(); const view = render(<RecommendationPanel kind="radar" accountKey="signedOut:guest" onOpen={open} />);
  await screen.findByText("推荐曲目"); fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(mocks.songs).toHaveBeenLastCalledWith("radar", expect.any(Number), 2));
  view.rerender(<RecommendationPanel key="playlists" kind="playlists" accountKey="signedOut:guest" onOpen={open} />);
  fireEvent.click(await screen.findByRole("button", { name: /推荐歌单一/ }));
  expect(open).toHaveBeenCalledWith(playlist);
  expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
});
it("ignores old pages and stops fetching while inactive", async () => {
  let finish!: (value: unknown) => void;
  mocks.songs.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<RecommendationPanel kind="radar" accountKey="authenticated:a" onOpen={() => {}} />);
  view.rerender(<RecommendationPanel key="account-b" kind="radar" accountKey="authenticated:b" onOpen={() => {}} />);
  await screen.findByText("推荐曲目");
  await act(async () => finish({ generation: 1, page: 1, hasMore: false, warningCount: 0, items: [{ ...song, title: "旧账号结果" }] }));
  expect(screen.queryByText("旧账号结果")).not.toBeInTheDocument();
  view.rerender(<RecommendationPanel key="account-b" kind="radar" accountKey="authenticated:b" active={false} onOpen={() => {}} />);
  expect(mocks.songs).toHaveBeenCalledTimes(2);
});
it("shows failure and empty states without inventing recommendations", async () => {
  mocks.songs.mockRejectedValueOnce(new Error("unavailable"));
  render(<RecommendationPanel kind="guess" accountKey="signedOut:guest" onOpen={() => {}} />);
  await screen.findByRole("alert");
  mocks.songs.mockImplementation((_kind: string, generation: number) => Promise.resolve({ generation, page: 1, hasMore: false, warningCount: 0, items: [] }));
  fireEvent.click(screen.getByRole("button", { name: "刷新推荐" }));
  await screen.findByText("暂时没有推荐内容，稍后刷新试试。");
});
