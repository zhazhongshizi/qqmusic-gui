import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getCurrentTrack,
  playerActions,
  resetPlayerFixture,
  usePlayerSelector,
} from "../features/player/playerStore";
import { App } from "./App";

describe("应用外壳键盘与状态契约", () => {
  beforeEach(() => {
    resetPlayerFixture();
  });

  afterEach(() => {
    cleanup();
  });

  it("纯浏览器启动呈现安全回退且保留现有音乐 fixture", async () => {
    render(<App />);

    expect(await screen.findByText("浏览器预览")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "暮色温室" })).toBeInTheDocument();
  });

  it("把播放队列作为模态对话框约束焦点，并用 Escape 关闭后恢复触发点", async () => {
    const user = userEvent.setup();
    render(<App />);

    const opener = screen.getByRole("button", { name: "打开播放队列" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "播放队列" });
    const close = within(dialog).getByRole("button", { name: "关闭播放队列" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(close).toHaveFocus();

    await user.tab({ shift: true });
    const enabledButtons = within(dialog)
      .getAllByRole("button")
      .filter((button) => !button.hasAttribute("disabled"));
    expect(enabledButtons.at(-1)).toHaveFocus();

    close.focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "播放队列" })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("支持设置面板的方向键、Escape、外部操作保持和焦点恢复", async () => {
    const user = userEvent.setup();
    render(<App />);

    const trigger = screen.getByRole("button", { name: "更多" });
    await user.click(trigger);
    const normal = screen.getByRole("menuitemradio", { name: "正常" });
    await waitFor(() => expect(normal).toHaveFocus());

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "载入中" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByText("QQ Music GUI"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(trigger).toHaveFocus();
  });

  it("在更多菜单选择并保留确认后的默认音质", async () => {
    const user = userEvent.setup();
    render(<App />);

    const trigger = screen.getByRole("button", { name: "更多" });
    await user.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: "高品质 320k" }))
      .toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("menuitemradio", { name: "标准 128k" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "标准 128k" }))
      .toHaveAttribute("aria-checked", "true");
  });

  it("阻塞状态使背景 inert，并让空状态动作真正进入搜索", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("menuitemradio", { name: "空内容" }));

    const content = container.querySelector<HTMLElement>(".app-shell__content");
    const searchAction = screen.getByRole("button", { name: "前往搜索" });
    expect(content).toHaveAttribute("inert");
    expect(content).toHaveAttribute("aria-hidden", "true");
    await waitFor(() => expect(searchAction).toHaveFocus());

    await user.click(searchAction);
    expect(await screen.findByRole("heading", { name: "搜索音乐" })).toBeInTheDocument();
    const searchbox = screen.getByRole("searchbox", { name: "搜索歌曲、歌手或专辑" });
    await waitFor(() => expect(searchbox).toHaveFocus());
    expect(content).not.toHaveAttribute("inert");
  });

  it("账号入口打开扫码模态层，约束背景并在关闭后恢复焦点", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    const opener = screen.getByRole("button", { name: "账号" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "安全扫码登录" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(container.querySelector(".app-shell")).toHaveAttribute("inert");
    expect(within(dialog).getByRole("button", { name: "关闭登录窗口" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "安全扫码登录" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(screen.getByRole("heading", { name: "暮色温室" })).toBeInTheDocument();
  });

  it("让检查器始终跟随可见结果，并在喜欢页应用同一搜索词", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    const searchbox = await screen.findByRole("searchbox", { name: "搜索歌曲、歌手或专辑" });
    await user.type(searchbox, "不存在");
    expect(screen.getByText("没有找到匹配的音乐")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "当前选中曲目" })).not.toBeInTheDocument();

    await user.clear(searchbox);
    await user.type(searchbox, "潮汐");
    const inspector = screen.getByRole("complementary", { name: "当前选中曲目" });
    expect(within(inspector).getByRole("heading", { name: "潮汐来信" })).toBeInTheDocument();

    const sidebar = screen.getByRole("complementary", { name: "曲库导航" });
    await user.click(within(sidebar).getByRole("button", { name: /喜欢/ }));
    expect(screen.getByText("没有找到匹配的音乐")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "当前选中曲目" })).not.toBeInTheDocument();
  });

  it("可从曲库重新播放已移出队列的目录曲目", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "打开播放队列" }));
    let dialog = screen.getByRole("dialog", { name: "播放队列" });
    await user.click(within(dialog).getByRole("button", { name: "从队列移除《纸月光》" }));
    await user.click(within(dialog).getByRole("button", { name: "关闭播放队列" }));

    await user.click(screen.getByRole("button", { name: "曲库" }));
    await screen.findByRole("heading", { name: "今日唱片目录" });
    await user.click(screen.getByRole("button", { name: /纸月光/ }));
    const inspector = screen.getByRole("complementary", { name: "当前选中曲目" });
    await user.click(within(inspector).getByRole("button", { name: "立即播放" }));

    await user.click(screen.getByRole("button", { name: "打开播放队列" }));
    dialog = screen.getByRole("dialog", { name: "播放队列" });
    expect(within(dialog).getByText("5 首 · 本地队列")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "纸月光" })).toHaveAttribute("aria-current", "true");
  }, 10_000);

  it("让音量轨道与真实音量和静音状态同步", async () => {
    const user = userEvent.setup();
    render(<App />);

    const volume = screen.getByRole("slider", { name: "音量" });
    expect(volume.style.getPropertyValue("--range-progress")).toBe("72%");

    fireEvent.change(volume, { target: { value: "0.25" } });
    expect(volume).toHaveValue("0.25");
    expect(volume.style.getPropertyValue("--range-progress")).toBe("25%");

    await user.click(screen.getByRole("button", { name: "静音" }));
    expect(volume).toHaveValue("0");
    expect(volume.style.getPropertyValue("--range-progress")).toBe("0%");
  });

  it("只把当前歌词设为 live region", () => {
    render(<App />);

    const lyrics = screen.getByRole("region", { name: "同步歌词" });
    expect(lyrics).not.toHaveAttribute("aria-live");
    expect(within(lyrics).getByText("把没有寄出的晚风，留在这一面窗")).toHaveAttribute("aria-live", "polite");
  });

  it("窄订阅不会因纯进度变化重渲染当前曲目消费者", () => {
    let renderCount = 0;

    function CurrentTrackProbe() {
      const track = usePlayerSelector(getCurrentTrack);
      renderCount += 1;
      return <span>{track?.title}</span>;
    }

    render(<CurrentTrackProbe />);
    const initialRenderCount = renderCount;

    act(() => playerActions.seekBy(1_000));
    expect(renderCount).toBe(initialRenderCount);

    act(() => playerActions.next());
    expect(renderCount).toBeGreaterThan(initialRenderCount);
  });
});
