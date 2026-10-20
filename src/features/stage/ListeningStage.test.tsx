import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { playerActions, resetPlayerFixture } from "../player/playerStore";
import { ListeningStage } from "./ListeningStage";
import { ScrollingLyrics } from "./ScrollingLyrics";

describe("ListeningStage 播放音质选择", () => {
  beforeEach(() => resetPlayerFixture());
  afterEach(() => cleanup());

  it("fixture 模式提供三档键盘可访问选择并更新当前期望音质", async () => {
    const user = userEvent.setup();
    render(<ListeningStage />);

    const trigger = screen.getByRole("button", { name: "期望音质：无损优先" });
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "选择播放音质" });
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(3);
    expect(within(menu).getByRole("menuitemradio", { name: "标准 128k" })).not.toBeDisabled();

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(screen.getByRole("button", { name: "期望音质：标准 128k" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "选择播放音质" })).not.toBeInTheDocument();
  });

  it("同步舞台播放状态属性并在 scrollend 时提前释放自动滚屏锁", async () => {
    const view = render(<ListeningStage />);
    const main = view.container.querySelector("main.stage");
    expect(main).toHaveAttribute("data-playing", "false");
    await act(async () => {
      await playerActions.toggle();
    });
    expect(main).toHaveAttribute("data-playing", "true");
    cleanup();

    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const lyrics = [
      { atMs: 0, original: "第一行" },
      { atMs: 1000, original: "第二行" },
    ];
    const lyricView = render(<ScrollingLyrics activeIndex={0} lyrics={lyrics} />);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    const container = lyricView.container.querySelector(".lyrics-scroll__container")!;
    fireEvent(container, new Event("scrollend"));
    fireEvent.scroll(container);
    expect(screen.getByRole("button", { name: "回到当前" })).toBeInTheDocument();
  });
});
