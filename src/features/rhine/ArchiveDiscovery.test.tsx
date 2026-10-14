import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CatalogSong } from "../../contracts/catalog";
import type { CatalogEntity } from "../../contracts/catalogBrowse";
import { ArchiveDiscovery } from "./ArchiveDiscovery";

const mocks = vi.hoisted(() => ({ songs: vi.fn(), lists: vi.fn(), play: vi.fn(), next: vi.fn(), enqueue: vi.fn() }));
vi.mock("../../backend/catalogDiscoveryAdapter", () => ({ getRecommendedSongs: mocks.songs, getRecommendedPlaylists: mocks.lists }));
vi.mock("../player/catalogQueue", () => ({ enqueueAndPlayCatalogTrack: mocks.play, enqueueNextCatalogTrack: mocks.next, enqueueCatalogTrack: mocks.enqueue }));
vi.mock("../catalog/CatalogDetails", () => ({
  CatalogDetails: ({ entity, onBack }: { entity: CatalogEntity; onBack: () => void }) => <section aria-label="模拟详情"><h2>{entity.kind === "artist" ? entity.name : entity.title}</h2><button onClick={onBack}>返回上一页</button></section>,
  AlbumLink: ({ track, onOpen }: { track: CatalogSong; onOpen: (entity: CatalogEntity) => void }) => <button onClick={() => onOpen({ kind: "album", id: track.albumId!, title: track.album, description: "", publishDate: "" })}>{track.album}</button>,
}));
const songs: CatalogSong[] = [1, 2, 3, 4].map(n => ({ id: `song-${n}`, title: `曲目 ${n}`, artist: `歌手 ${n}`, artists: [{ id: `artist-${n}`, name: `歌手 ${n}` }], album: `专辑 ${n}`, albumId: `album-${n}`, durationMs: 183000, subtitle: "", qualityCandidates: [], availability: { status: "unknown", requiresSubscription: false } }));
const props = { active: true, accountKey: "authenticated:a", onClose: vi.fn(), onDeck: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.songs.mockImplementation((_kind: string, generation: number, page: number) => Promise.resolve({ generation, page, hasMore: page === 1, warningCount: 0, items: page === 1 ? songs : [songs[3]] }));
  mocks.lists.mockImplementation((generation: number, page: number) => Promise.resolve({ generation, page, hasMore: page === 1, warningCount: 0, items: [{ kind: "playlist", id: `list-${page}`, title: `歌单 ${page}`, songCount: 20, listenCount: 100, description: "歌单简介" }] }));
  mocks.play.mockResolvedValue(undefined); mocks.next.mockResolvedValue(undefined); mocks.enqueue.mockResolvedValue(undefined);
});
afterEach(cleanup);
const dossier = (container: HTMLElement) => within(container.querySelector<HTMLElement>(".discovery-recommendations:not([hidden]) .discovery-dossier-desktop")!);

it("selects without playing and uses the existing play/next/enqueue actions", async () => {
  const { container } = render(<ArchiveDiscovery {...props} />);
  expect(await screen.findByRole("button", { name: "选择歌曲 曲目 1" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "选择歌曲 曲目 2" }));
  expect(mocks.play).not.toHaveBeenCalled();
  expect(dossier(container).getByRole("heading", { name: "曲目 2" })).toBeInTheDocument();
  fireEvent.click(dossier(container).getByRole("button", { name: "下一首播放" }));
  await waitFor(() => expect(mocks.next).toHaveBeenCalledWith(songs[1]));
  await waitFor(() => expect(dossier(container).getByRole("button", { name: "加入队列" })).toBeEnabled());
  fireEvent.click(dossier(container).getByRole("button", { name: "加入队列" }));
  await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledWith(songs[1]));
  await waitFor(() => expect(screen.getByRole("button", { name: "播放 曲目 3" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "播放 曲目 3" }));
  await waitFor(() => expect(mocks.play).toHaveBeenCalledWith(songs[2]));
  expect(screen.queryByRole("navigation", { name: "推荐分页" })).not.toBeInTheDocument();
});

it("preserves selection on refresh and chooses the first remaining item when it disappears", async () => {
  render(<ArchiveDiscovery {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "选择歌曲 曲目 2" }));
  fireEvent.click(screen.getByRole("button", { name: "刷新推荐" }));
  expect(await screen.findByRole("button", { name: "选择歌曲 曲目 2" })).toHaveAttribute("aria-pressed", "true");
  mocks.songs.mockImplementation((_kind: string, generation: number, page: number) => Promise.resolve({ generation, page, hasMore: false, warningCount: 1, items: [songs[2], songs[3]] }));
  fireEvent.click(screen.getByRole("button", { name: "刷新推荐" }));
  expect(await screen.findByRole("button", { name: "选择歌曲 曲目 3" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("部分内容暂时不可用，已显示可用推荐。")).toBeInTheDocument();
});

it("returns from details and category switches with page, selection, scroll and focus intact", async () => {
  const { container } = render(<div className="rhine-local-page"><ArchiveDiscovery {...props} /></div>);
  await screen.findByRole("button", { name: "选择歌曲 曲目 1" });
  fireEvent.click(screen.getByRole("button", { name: "雷达推荐" }));
  fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
  await screen.findByRole("button", { name: "选择歌曲 曲目 4" });
  const host = container.querySelector<HTMLElement>(".rhine-local-page")!; host.scrollTop = 160;
  const opener = dossier(container).getByRole("button", { name: "专辑 4" }); opener.focus(); fireEvent.click(opener);
  expect(screen.getByRole("region", { name: "模拟详情" })).toBeInTheDocument();
  expect(host.scrollTop).toBe(0);
  const count = mocks.songs.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "返回上一页" }));
  expect(host.scrollTop).toBe(160); expect(opener).toHaveFocus();
  expect(screen.getByText("第 2 页")).toBeInTheDocument();
  expect(mocks.songs).toHaveBeenCalledTimes(count);
  fireEvent.click(screen.getByRole("button", { name: "猜你喜欢" }));
  fireEvent.click(screen.getByRole("button", { name: "雷达推荐" }));
  expect(screen.getByText("第 2 页")).toBeInTheDocument(); expect(host.scrollTop).toBe(160);
  expect(mocks.songs).toHaveBeenCalledTimes(count);
});

it("opens playlist details and retains its page after returning", async () => {
  render(<ArchiveDiscovery {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "推荐歌单" }));
  await screen.findByRole("button", { name: "打开歌单 歌单 1" });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开歌单 歌单 2" }));
  fireEvent.click(screen.getByRole("button", { name: "返回上一页" }));
  expect(screen.getByRole("button", { name: "选择歌单 歌单 2" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
  expect(mocks.lists).toHaveBeenCalledTimes(2);
});

it("discards stale account responses and does not request while inactive", async () => {
  let finish!: (value: unknown) => void;
  mocks.songs.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<ArchiveDiscovery {...props} />);
  view.rerender(<ArchiveDiscovery {...props} accountKey="authenticated:b" />);
  await screen.findByRole("button", { name: "选择歌曲 曲目 1" });
  await act(async () => finish({ generation: 1, page: 1, warningCount: 0, hasMore: false, items: [{ ...songs[0], title: "旧账号" }] }));
  expect(screen.queryByText("旧账号")).not.toBeInTheDocument();
  view.rerender(<ArchiveDiscovery {...props} accountKey="authenticated:c" active={false} />);
  expect(mocks.songs).toHaveBeenCalledTimes(2);
});

it("recovers from failure, shows an empty page and supports keyboard selection/navigation", async () => {
  mocks.songs.mockRejectedValueOnce(new Error("offline"));
  render(<ArchiveDiscovery {...props} />);
  await screen.findByRole("alert");
  mocks.songs.mockImplementationOnce((_kind: string, generation: number) => Promise.resolve({ generation, page: 1, warningCount: 0, hasMore: false, items: [] }));
  fireEvent.click(screen.getByRole("button", { name: "刷新推荐" }));
  await screen.findByText("暂时没有推荐内容，稍后刷新试试。");
  fireEvent.click(screen.getByRole("button", { name: "刷新推荐" }));
  const button = await screen.findByRole("button", { name: "选择歌曲 曲目 2" }); button.focus();
  await userEvent.keyboard("{Enter}"); expect(button).toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("{Escape}"); expect(props.onClose).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "进入磁带机 ↗" })); expect(props.onDeck).toHaveBeenCalledOnce();
});
