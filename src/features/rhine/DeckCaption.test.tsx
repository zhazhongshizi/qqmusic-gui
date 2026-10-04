import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeckCaption } from "./DeckCaption";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const song = (id: string) => ({ id, title: `歌曲 ${id}`, artist: "歌手", album: "专辑" });

it("快速切歌丢弃更早文字并清理离场副本", () => {
  vi.useFakeTimers();
  const { container, rerender } = render(<DeckCaption track={song("1")} direction={() => 1} />);
  rerender(<DeckCaption track={song("2")} direction={() => 1} />);
  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent("歌曲 1");
  act(() => { vi.advanceTimersByTime(100); });
  rerender(<DeckCaption track={song("3")} direction={() => -1} />);
  expect(container).not.toHaveTextContent("歌曲 1");
  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent("歌曲 2");
  expect(container.querySelector('.rhine-caption-in')).toHaveTextContent("歌曲 3");
  act(() => { vi.advanceTimersByTime(340); });
  expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  expect(container).toHaveTextContent("歌曲 3");
});

it("同曲元数据更新不重启动画，歌单只在变化时过渡", () => {
  const direction = vi.fn(() => 0);
  const { container, rerender } = render(<DeckCaption track={song("1")} playlistTitle="收藏" direction={direction} />);
  rerender(<DeckCaption track={{ ...song("1"), album: "新专辑" }} playlistTitle="收藏" direction={direction} />);
  expect(direction).not.toHaveBeenCalled();
  expect(container).toHaveTextContent("新专辑");
  expect(container.querySelector('.rhine-caption-in')).toBeNull();
  expect(container.querySelector('.rhine-caption-label')).toBeNull();
  rerender(<DeckCaption track={song("1")} playlistTitle="新歌单" direction={direction} />);
  expect(container.querySelector('.rhine-caption-label')).toHaveTextContent("新歌单");
});
