import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { playerActions, resetPlayerFixture } from "../player/playerStore";
import { ListeningStage } from "./ListeningStage";
import { ScrollingLyrics } from "./ScrollingLyrics";

vi.mock("./ScrollingLyrics", () => ({
  ScrollingLyrics: vi.fn(({ activeIndex }: { activeIndex: number }) => <output data-testid="line-index">{activeIndex}</output>),
}));

beforeEach(() => { resetPlayerFixture(); vi.clearAllMocks(); });
afterEach(cleanup);

it("does not rerender the lyric list within a line but follows forward and backward seeks", () => {
  render(<ListeningStage />);
  expect(screen.getByTestId("line-index")).toHaveTextContent("2");
  const initialRenders = vi.mocked(ScrollingLyrics).mock.calls.length;
  for (const position of [132_500, 133_000, 134_000]) {
    act(() => playerActions.seek(position));
  }
  expect(vi.mocked(ScrollingLyrics).mock.calls.length).toBe(initialRenders);
  act(() => playerActions.seek(161_000));
  expect(screen.getByTestId("line-index")).toHaveTextContent("3");
  act(() => playerActions.seek(46_000));
  expect(screen.getByTestId("line-index")).toHaveTextContent("1");
});
