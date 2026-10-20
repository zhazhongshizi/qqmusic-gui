import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import PlaylistPicker, { type PlaylistPickerOption } from "./PlaylistPicker";

const OPTIONS: PlaylistPickerOption[] = [
  { id: "one", title: "工作歌单" },
  { id: "two", title: "夜航精选" },
  { id: "three", title: "长标题不会挤压右侧状态标记的歌单" },
];

afterEach(() => cleanup());

function renderPicker(value = "one", onChange = vi.fn()) {
  return {
    onChange,
    ...render(<PlaylistPicker label="目标歌单" options={OPTIONS} value={value} onChange={onChange} />),
  };
}

describe("PlaylistPicker", () => {
  it("显示当前值并暴露触发器 ARIA", () => {
    renderPicker("two");

    const trigger = screen.getByRole("combobox", { name: "目标歌单：夜航精选" });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("夜航精选");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger.closest(".playlist-picker")).toHaveAttribute("data-variant", "default");
  });

  it("支持鼠标打开、选择、外部关闭并恢复触发器焦点", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();
    const trigger = screen.getByRole("combobox", { name: "目标歌单：工作歌单" });

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox", { name: "目标歌单" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "夜航精选" }));
    expect(onChange).toHaveBeenCalledWith("two");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("支持方向键、Home/End、Enter/Space 与 Escape", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();
    const trigger = screen.getByRole("combobox", { name: "目标歌单：工作歌单" });

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-activedescendant", expect.stringContaining("one"));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(trigger).toHaveAttribute("aria-activedescendant", expect.stringContaining("three"));
    await user.keyboard("{End}");
    expect(trigger).toHaveAttribute("aria-activedescendant", expect.stringContaining("three"));
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("three");
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-activedescendant", expect.stringContaining("one"));
    await user.keyboard("{Home}");
    expect(trigger).toHaveAttribute("aria-activedescendant", expect.stringContaining("one"));
    await user.keyboard("{Space}");
    expect(onChange).toHaveBeenLastCalledWith("one");
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.keyboard("{ArrowDown}{Escape}");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("为失效值回退显示第一项，并在长列表内滚动与空间不足时向上定位", async () => {
    const user = userEvent.setup();
    const options = Array.from({ length: 12 }, (_, index) => ({ id: `playlist-${index}`, title: `歌单 ${index}` }));
    const view = render(
      <PlaylistPicker label="目标歌单" options={options} value="missing" onChange={() => undefined} />,
    );
    const trigger = screen.getByRole("combobox", { name: "目标歌单：歌单 0" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      top: 680, bottom: 720, left: 1100, right: 1250, width: 150, height: 40,
      x: 1100, y: 680, toJSON: () => ({}),
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });

    await user.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "目标歌单" });
    expect(listbox).toHaveAttribute("data-placement", "top");
    expect(listbox).toHaveAttribute("data-scrollable", "true");
    expect(listbox).toHaveStyle({ maxHeight: "240px", width: "150px" });
    expect(view.container).toBeInTheDocument();
  });

  it("莱茵主题随菜单传递到 body，切回普通主题不会残留", async () => {
    const user = userEvent.setup();
    const props = { label: "目标歌单", options: OPTIONS, value: "one", onChange: vi.fn() };
    const view = render(<PlaylistPicker {...props} variant="rhine" />);
    const trigger = screen.getByRole("combobox");
    await user.click(trigger);
    const menu = screen.getByRole("listbox");
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveAttribute("data-variant", "rhine");
    expect(trigger.closest(".playlist-picker")).toHaveAttribute("data-variant", "rhine");
    view.rerender(<PlaylistPicker {...props} />);
    expect(menu).toHaveAttribute("data-variant", "default");
    expect(trigger.closest(".playlist-picker")).toHaveAttribute("data-variant", "default");
  });

  it("关闭时可用方向键打开，Tab 收起菜单并移动焦点", async () => {
    const user = userEvent.setup();
    render(<><PlaylistPicker label="目标歌单" options={OPTIONS} value="one" onChange={vi.fn()} /><button>确认添加</button></>);
    screen.getByRole("combobox").focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.tab();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认添加" })).toHaveFocus();
  });

  it("莱茵长列表限制高度，窄屏菜单不会溢出视口", async () => {
    const user = userEvent.setup();
    const oldWidth = window.innerWidth;
    const oldHeight = window.innerHeight;
    try {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
      render(<PlaylistPicker variant="rhine" label="目标歌单" options={Array.from({ length: 20 }, (_, index) => ({ id: `${index}`, title: `歌单 ${index}` }))} value="19" onChange={vi.fn()} />);
      const trigger = screen.getByRole("combobox");
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        top: 450, bottom: 490, left: 16, right: 416, width: 400, height: 40,
        x: 16, y: 450, toJSON: () => ({}),
      });
      await user.click(trigger);
      expect(screen.getByRole("listbox")).toHaveStyle({ width: "304px", left: "8px", maxHeight: "250px" });
      expect(screen.getByRole("listbox")).toHaveAttribute("data-placement", "top");
      expect(screen.getByRole("option", { name: "歌单 19" })).toHaveAttribute("data-active", "true");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: oldWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: oldHeight });
    }
  });
});
