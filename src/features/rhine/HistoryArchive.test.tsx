import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HistoryArchive from "./HistoryArchive";
import { qualityPresets } from "./vendor/render-quality";
const mocks = vi.hoisted(() => ({ read: vi.fn(), play: vi.fn(), array: vi.fn() }));
vi.mock("../../backend/historyAdapter", () => ({ getPlaybackHistory: mocks.read }));
vi.mock("../player/historyPlayback", () => ({ playHistoryEntry: mocks.play }));
vi.mock("./TapeDeck", () => ({ NowPlaying: () => null }));
vi.mock("./HistoryCassetteArray", () => ({ HistoryCassetteArray: (props: { tracks: { id: string; title: string }[]; onSelect: (index: number) => void; onOpen: (index: number) => void }) => {
  mocks.array(props);
  return <div>{props.tracks.map((track, index) => <button key={track.id} onClick={() => props.onSelect(index)} onDoubleClick={() => props.onOpen(index)}>{`磁带 ${track.title}`}</button>)}</div>;
} }));
const rows = Array.from({ length: 25 }, (_, i) => ({ id: `fixture-${i}`, title: `歌曲${i}`, artist: `歌手${i}`, playedAtUnixMs: 1700000000000 - i * 1000, coverCacheKey: `cover_${i}` }));
const props = { active: true, quality: qualityPresets.performance, superPerformance: false, onBack: () => {}, onDeck: () => {} };
beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  mocks.read.mockReset().mockResolvedValue(rows); mocks.play.mockReset().mockResolvedValue(undefined); mocks.array.mockClear();
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
it("limits each page to 8 real songs and searches across pages", async () => {
  render(<HistoryArchive {...props} />);
  await screen.findByRole("button", { name: "磁带 歌曲0" });
  expect(mocks.array.mock.lastCall![0].tracks).toHaveLength(8);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByRole("button", { name: "磁带 歌曲8" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "歌手24" } });
  expect(screen.getByRole("button", { name: "磁带 歌曲24" })).toBeInTheDocument();
  expect(mocks.array.mock.lastCall![0].tracks).toHaveLength(1);
});
it("selection and extraction never start playback; playing uses the selected metadata and returning preserves selection", async () => {
  render(<HistoryArchive {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "磁带 歌曲2" }));
  expect(mocks.play).not.toHaveBeenCalled();
  fireEvent.doubleClick(screen.getByRole("button", { name: "磁带 歌曲2" }));
  expect(screen.getByRole("region", { name: "历史歌曲档案" })).toBeInTheDocument();
  expect(mocks.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "播放 歌曲2" }));
  await waitFor(() => expect(mocks.play).toHaveBeenCalledWith(expect.objectContaining(rows[2]!)));
  fireEvent.click(screen.getByRole("button", { name: "← 返回最近播放阵列" }));
  expect(screen.getByRole("heading", { name: "歌曲2" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "选择 歌曲4" }));
  fireEvent.click(screen.getByRole("button", { name: "播放 歌曲4" }));
  await waitFor(() => expect(mocks.play).toHaveBeenLastCalledWith(expect.objectContaining(rows[4]!)));
});
it("does not fetch hidden history and recovers a read failure without leaking details", async () => {
  mocks.read.mockRejectedValueOnce(new Error("private file path"));
  const view = render(<HistoryArchive {...props} active={false} />);
  expect(mocks.read).not.toHaveBeenCalled();
  view.rerender(<HistoryArchive {...props} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("最近播放读取失败");
  expect(screen.queryByText(/private file path/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("button", { name: "磁带 歌曲0" });
});
