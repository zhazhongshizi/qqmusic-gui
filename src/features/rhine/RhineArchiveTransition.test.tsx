import { useContext } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RhineMode from "./RhineMode";
import { ArchivePageTransitionContext, type ArchivePageTransition } from "./ArchivePageTransition";

const mocks = vi.hoisted(() => ({ lists: vi.fn(), transition: null as ArchivePageTransition | null }));
vi.mock("../../backend/libraryAdapter", () => ({ getLibraryPlaylists: mocks.lists }));
vi.mock("./RhineBoot", () => ({ RhineBoot: ({ onComplete }: { onComplete: () => void }) => <button onClick={onComplete}>跳过动画</button> }));
vi.mock("./ArchiveCanvas", () => ({ ArchiveCanvas: ({ active, titles }: { active: boolean; titles: string[] }) => {
  mocks.transition = useContext(ArchivePageTransitionContext);
  return <div className="rhine-scene" data-active={active} data-ready="true" data-testid="source">{titles.join(",")}</div>;
} }));
vi.mock("./ArchiveSearch", () => ({ ArchiveSearch: () => <p>搜索页面</p> }));
vi.mock("../library/LocalMusicLibrary", () => ({ default: ({ rhine }: { rhine: { onBack: () => void } }) => <section aria-label="本地音乐测试"><button onClick={rhine.onBack}>返回档案</button></section> }));
vi.mock("./HistoryArchive", () => ({ default: () => <section aria-label="最近播放测试" /> }));
const props = { auth: { state: "authenticated" as const, account: { musicId: "123", loginMethod: "qq" as const } }, authRecovering: false, active: true, onExit: vi.fn(), onAccount: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); mocks.transition = null;
  mocks.lists.mockImplementation(async (kind: string) => ({ kind, page: 1, hasMore: false, total: 1, warningCount: 0,
    items: [{ id: kind, title: kind === "created" ? "我的原歌单" : "目标收藏歌单", description: "", songCount: 1 }] }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function start() {
  render(<RhineMode {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "跳过动画" }));
  await screen.findByRole("heading", { name: "我的原歌单" });
}
it("keeps the source playlist until the retreat finishes, then enters favorites", async () => {
  await start(); fireEvent.click(screen.getByRole("button", { name: "收藏的歌单" }));
  expect(mocks.transition?.phase).toBe("leaving");
  expect(mocks.lists).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("source")).toHaveTextContent("我的原歌单");
  act(() => mocks.transition!.onExited());
  await screen.findByRole("heading", { name: "目标收藏歌单" });
  expect(mocks.transition?.phase).toBe("entering");
  act(() => mocks.transition!.onEntered()); expect(mocks.transition).toBeNull();
});
it("uses the last requested page during departure and can return from an empty local page", async () => {
  await start(); fireEvent.click(screen.getByRole("button", { name: "收藏的歌单" }));
  const leaving = mocks.transition!;
  fireEvent.click(screen.getByRole("button", { name: "本地音乐" }));
  expect(mocks.transition).toBe(leaving); act(() => leaving.onExited());
  await screen.findByRole("region", { name: "本地音乐测试" });
  expect(mocks.lists).toHaveBeenCalledTimes(1);
  fireEvent(document.querySelector(".rhine-page-entry-clock")!, new Event("webkitAnimationEnd", { bubbles: true }));
  expect(mocks.transition).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "返回档案" }));
  expect(mocks.transition?.phase).toBe("entering");
  expect(screen.getByRole("heading", { name: "我的原歌单" })).toBeInTheDocument();
});
it("cancels stale completion callbacks when search supersedes the transition", async () => {
  await start(); fireEvent.click(screen.getByRole("button", { name: "收藏的歌单" }));
  const stale = mocks.transition!;
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  act(() => stale.onExited());
  expect(mocks.transition).toBeNull(); expect(screen.getByText("搜索页面")).toBeInTheDocument();
  expect(mocks.lists).toHaveBeenCalledTimes(1);
});
it("includes recent playback in the same transition", async () => {
  await start(); fireEvent.click(screen.getByRole("button", { name: "最近播放" }));
  expect(mocks.transition?.phase).toBe("leaving"); act(() => mocks.transition!.onExited());
  await screen.findByRole("region", { name: "最近播放测试" });
});
it("switches immediately with reduced motion", async () => {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: true, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }));
  await start(); fireEvent.click(screen.getByRole("button", { name: "收藏的歌单" }));
  await screen.findByRole("heading", { name: "目标收藏歌单" });
  expect(mocks.transition).toBeNull();
});
