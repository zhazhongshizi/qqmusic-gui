import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetPlayerFixture } from "../player/playerStore";
import { ListeningStage } from "./ListeningStage";

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
});
