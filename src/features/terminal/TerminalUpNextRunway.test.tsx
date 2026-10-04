import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { TerminalUpNext } from "./nextTrackPreview";
import { TerminalUpNextRunway } from "./TerminalUpNextRunway";

const readyModel: TerminalUpNext = {
  status: "ready",
  items: [
    { queueNumber: "02", trackId: "track-2", title: "纸月光", artist: "方格岛", isFirst: true },
    { queueNumber: "03", trackId: "track-3", title: "潮汐信号", artist: "雾灯电台", isFirst: false },
  ],
};

afterEach(() => cleanup());

describe("TerminalUpNextRunway", () => {
  it("以只读终端列表展示序号、歌曲名和歌手", () => {
    render(<TerminalUpNextRunway model={readyModel} />);

    const runway = screen.getByRole("region", { name: "后续播放" });
    expect(runway).not.toHaveClass("terminal-up-next--status");
    expect(runway).toHaveTextContent("UP NEXT //");
    expect(runway).toHaveTextContent("02 TRACKS");
    expect(within(runway).getByText("02")).toBeInTheDocument();
    expect(within(runway).getByText("纸月光")).toHaveAttribute("title", "纸月光");
    expect(within(runway).getByText("方格岛")).toHaveAttribute("title", "方格岛");
    expect(within(runway).queryByRole("button")).not.toBeInTheDocument();
  });

  it("不为 shuffle 伪造下一首", () => {
    render(<TerminalUpNextRunway model={{ status: "shuffle-pending", items: [] }} />);

    expect(screen.getByTestId("terminal-up-next")).toHaveClass("terminal-up-next--status");
    expect(screen.getByTestId("terminal-up-next")).toHaveTextContent("SHUFFLE PENDING");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
