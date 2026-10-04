import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlayerSnapshot as NativePlayerSnapshot } from "../../contracts/appSnapshot";
import type { QueueSnapshot } from "../../contracts/queue";
import { QueueDrawer } from "./QueueDrawer";
import { playerActions, resetPlayerFixture } from "./playerStore";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.classList.remove("queue-drag-active");
  resetPlayerFixture();
});

function rect(top: number, height = 62): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 360,
    bottom: top + height,
    left: 0,
    width: 360,
    height,
    toJSON: () => ({}),
  };
}

function prepareDragGeometry(container: HTMLElement) {
  const drawer = container.querySelector<HTMLElement>(".queue-drawer");
  if (!drawer) throw new Error("queue drawer missing");
  vi.spyOn(drawer, "getBoundingClientRect").mockReturnValue(rect(0, 420));
  const items = Array.from(container.querySelectorAll<HTMLElement>(".queue-list__item"));
  items.forEach((item, index) => {
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(rect(90 + index * 62));
  });
  return { drawer, items };
}

function firePointer(
  target: Window | Document | Node | Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  values: { clientX: number; clientY: number; pointerId: number },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: values.clientX },
    clientY: { value: values.clientY },
    isPrimary: { value: true },
    pointerId: { value: values.pointerId },
  });
  fireEvent(target, event);
}

function largeQueue(size: number, selectedIndex = 0, generation = 20) {
  const items = Array.from({ length: size }, (_, index) => ({
    id: `fixture-large-${index + 1}`,
    title: index === size - 1 ? "跨页命中歌曲" : `长队列歌曲 ${index + 1}`,
    artist: `歌手 ${index + 1}`,
    album: `专辑 ${index + 1}`,
    durationMs: 180_000,
  }));
  const selected = items[selectedIndex] ?? null;
  const queue: QueueSnapshot = { generation, selectedIndex, items };
  const player: NativePlayerSnapshot = {
    state: "paused",
    generation,
    positionMs: 0,
    durationMs: selected?.durationMs ?? null,
    volume: 0.72,
    muted: false,
    currentTrack: selected ? { id: selected.id, title: selected.title, artist: selected.artist } : null,
    failure: null,
  };
  return { queue, player };
}

async function hydrateLargeQueue(size: number, selectedIndex = 0, generation = 20) {
  const value = largeQueue(size, selectedIndex, generation);
  await act(async () => {
    await playerActions.hydrateNative(value.queue, value.player);
  });
  return value;
}

function prepareRhineDragGeometry(container: HTMLElement) {
  const drawer = container.querySelector<HTMLElement>(".rhine-queue-document");
  if (!drawer) throw new Error("Rhine queue document missing");
  vi.spyOn(drawer, "getBoundingClientRect").mockReturnValue(rect(0, 420));
  const items = Array.from(container.querySelectorAll<HTMLElement>(".rhine-queue-list .queue-list__item"));
  items.forEach((item, index) => {
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(rect(90 + index * 62));
  });
  return { drawer, items };
}

describe("播放队列抽屉", () => {
  it("普通界面队列每页最多三十行并定位当前曲目所在页", async () => {
    const user = userEvent.setup();
    await hydrateLargeQueue(65, 64);
    const play = vi.spyOn(playerActions, "playTrack").mockResolvedValue(true);
    const view = render(<QueueDrawer onClose={vi.fn()} open />);
    expect(view.container.querySelectorAll(".queue-list__item")).toHaveLength(5);
    expect(screen.getByRole("navigation", { name: "队列分页" })).toHaveTextContent("3 / 3");
    await user.click(screen.getByRole("button", { name: "上一页" }));
    expect(view.container.querySelectorAll(".queue-list__item")).toHaveLength(30);
    await user.click(view.container.querySelector<HTMLButtonElement>('.queue-list__item[data-queue-track-id="fixture-large-31"] .queue-list__track')!);
    expect(play).toHaveBeenCalledWith("fixture-large-31");
  });
  it("保持封面、歌曲信息和操作按钮处于同一行的三个网格列", () => {
    const view = render(<QueueDrawer onClose={vi.fn()} open />);
    const items = Array.from(view.container.querySelectorAll(".queue-list__item"));

    expect(items).toHaveLength(5);
    expect(view.container.querySelector('[aria-label="播放队列分页"]')).toBeNull();
    for (const item of items) {
      expect(Array.from(item.children).map((child) => child.className)).toEqual([
        "album-artwork album-artwork--compact",
        "queue-list__info",
        "queue-list__actions",
      ]);
    }
  });

  it("莱茵详情布局显示同一播放队列并可从曲目切歌", async () => {
    const play = vi.spyOn(playerActions, "playTrack");
    const onClose = vi.fn();
    const view = render(<QueueDrawer onClose={onClose} open presentation="rhine-detail" />);
    const items = Array.from(view.container.querySelectorAll(".rhine-queue-list .queue-list__item"));
    const firstTrack = items[0]?.querySelector<HTMLButtonElement>(".queue-list__track");

    expect(view.container.querySelector(".rhine-queue-document")).toBeInTheDocument();
    expect(screen.getByText("5 首 · 本地队列")).toBeInTheDocument();
    expect(items).toHaveLength(5);
    expect(screen.getByRole("navigation", { name: "播放队列分页" })).toHaveTextContent("第 1 / 1 页 · 共 5 首");
    expect(firstTrack).not.toBeNull();
    if (firstTrack) fireEvent.click(firstTrack);
    expect(play).toHaveBeenCalledWith("fixture-dusk-greenhouse");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("一键清空整个播放队列并显示空状态", async () => {
    const user = userEvent.setup();
    render(<QueueDrawer onClose={vi.fn()} open />);

    const clearButton = screen.getByRole("button", { name: "清空播放队列" });
    expect(clearButton).toBeEnabled();

    await user.click(clearButton);

    expect(screen.getByText("0 首 · 本地队列")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("播放队列为空");
    expect(document.querySelectorAll(".queue-list__item")).toHaveLength(0);
    expect(clearButton).toBeDisabled();
  });

  it("短按歌曲仍播放且不会提交队列移动", () => {
    const play = vi.spyOn(playerActions, "playTrack");
    const move = vi.spyOn(playerActions, "moveTrackTo").mockResolvedValue();
    const view = render(<QueueDrawer onClose={vi.fn()} open />);
    const firstItem = view.container.querySelector<HTMLElement>(".queue-list__item");
    if (!firstItem) throw new Error("queue item missing");
    const trackButton = firstItem.querySelector<HTMLButtonElement>(".queue-list__track");
    if (!trackButton) throw new Error("queue track button missing");

    firePointer(trackButton, "pointerdown", { clientX: 100, clientY: 110, pointerId: 1 });
    firePointer(window, "pointerup", { clientX: 100, clientY: 110, pointerId: 1 });
    fireEvent.click(trackButton);

    expect(play).toHaveBeenCalledWith("fixture-dusk-greenhouse");
    expect(move).not.toHaveBeenCalled();
    expect(screen.queryByText("已拾取《暮色温室》")).not.toBeInTheDocument();
  });

  it("长按整行后拖到新位置并抑制释放产生的点歌 click", async () => {
    vi.useFakeTimers();
    const play = vi.spyOn(playerActions, "playTrack");
    const move = vi.spyOn(playerActions, "moveTrackTo").mockResolvedValue();
    const view = render(<QueueDrawer onClose={vi.fn()} open />);
    const { items } = prepareDragGeometry(view.container);
    const firstItem = items[0];
    const trackButton = firstItem?.querySelector<HTMLButtonElement>(".queue-list__track");
    if (!firstItem || !trackButton) throw new Error("queue item missing");

    firePointer(trackButton, "pointerdown", { clientX: 100, clientY: 110, pointerId: 2 });
    await act(async () => vi.advanceTimersByTime(250));

    expect(document.body).toHaveClass("queue-drag-active");
    expect(document.querySelector(".queue-drag-preview")).toBeInTheDocument();
    expect(firstItem).toHaveClass("queue-list__item--dragging");

    firePointer(window, "pointermove", { clientX: 130, clientY: 375, pointerId: 2 });
    firePointer(window, "pointerup", { clientX: 130, clientY: 375, pointerId: 2 });
    fireEvent.click(trackButton);

    await act(async () => Promise.resolve());
    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith("fixture-dusk-greenhouse", 4);
    expect(play).not.toHaveBeenCalled();
    expect(document.body).not.toHaveClass("queue-drag-active");
  });

  it("长按前移动超出容差会取消，操作按钮也不会激活拖动", () => {
    vi.useFakeTimers();
    const move = vi.spyOn(playerActions, "moveTrackTo").mockResolvedValue();
    const view = render(<QueueDrawer onClose={vi.fn()} open />);
    const { items } = prepareDragGeometry(view.container);
    const firstItem = items[0];
    const trackButton = firstItem?.querySelector<HTMLButtonElement>(".queue-list__track");
    if (!firstItem || !trackButton) throw new Error("queue item missing");

    firePointer(trackButton, "pointerdown", { clientX: 100, clientY: 110, pointerId: 3 });
    firePointer(window, "pointermove", { clientX: 109, clientY: 110, pointerId: 3 });
    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector(".queue-drag-preview")).not.toBeInTheDocument();

    const upButton = screen.getByRole("button", { name: "上移《纸月光》" });
    firePointer(upButton, "pointerdown", { clientX: 300, clientY: 170, pointerId: 4 });
    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector(".queue-drag-preview")).not.toBeInTheDocument();
    expect(move).not.toHaveBeenCalled();
  });

  it("Escape 取消已激活拖动且不会提交位置", async () => {
    vi.useFakeTimers();
    const move = vi.spyOn(playerActions, "moveTrackTo").mockResolvedValue();
    const view = render(<QueueDrawer onClose={vi.fn()} open />);
    const { items } = prepareDragGeometry(view.container);
    const secondItem = items[1];
    if (!secondItem) throw new Error("queue item missing");

    firePointer(secondItem, "pointerdown", { clientX: 100, clientY: 170, pointerId: 5 });
    await act(async () => vi.advanceTimersByTime(250));
    expect(document.querySelector(".queue-drag-preview")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(document.querySelector(".queue-drag-preview")).not.toBeInTheDocument();
    expect(document.body).not.toHaveClass("queue-drag-active");
    expect(move).not.toHaveBeenCalled();
  });

  it("拖到抽屉底部热区会自动向下滚动并在释放后停止", async () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(playerActions, "moveTrackTo").mockResolvedValue();
    const view = render(<QueueDrawer onClose={vi.fn()} open />);
    const { drawer, items } = prepareDragGeometry(view.container);
    const secondItem = items[1];
    if (!secondItem) throw new Error("queue item missing");

    firePointer(secondItem, "pointerdown", { clientX: 100, clientY: 170, pointerId: 6 });
    await act(async () => vi.advanceTimersByTime(250));
    firePointer(window, "pointermove", { clientX: 120, clientY: 414, pointerId: 6 });

    expect(frames).toHaveLength(1);
    act(() => frames.shift()?.(16));
    expect(drawer.scrollTop).toBeGreaterThan(0);

    firePointer(window, "pointerup", { clientX: 120, clientY: 414, pointerId: 6 });
    expect(cancelFrame).toHaveBeenCalled();
  });

  it("莱茵队列每页最多挂载 30 首，翻页保留全局序号与歌曲 ID", async () => {
    const user = userEvent.setup();
    await hydrateLargeQueue(65);
    const play = vi.spyOn(playerActions, "playTrack").mockResolvedValue(true);
    const onClose = vi.fn();
    const view = render(<QueueDrawer onClose={onClose} open presentation="rhine-detail" />);

    expect(view.container.querySelectorAll(".rhine-queue-list .queue-list__item")).toHaveLength(30);
    expect(view.container.querySelectorAll(".rhine-queue-list .album-artwork--compact")).toHaveLength(30);
    expect(screen.getByRole("navigation", { name: "播放队列分页" })).toHaveTextContent("第 1 / 3 页 · 共 65 首");

    await user.click(screen.getByRole("button", { name: "下一页" }));
    const secondPageRows = Array.from(view.container.querySelectorAll<HTMLElement>(".rhine-queue-list .queue-list__item"));
    expect(secondPageRows).toHaveLength(30);
    expect(secondPageRows[0]?.dataset.queueTrackId).toBe("fixture-large-31");
    expect(secondPageRows[0]?.querySelector(".queue-list__index")).toHaveTextContent("31");

    const track = secondPageRows[0]?.querySelector<HTMLButtonElement>(".queue-list__track");
    if (!track) throw new Error("second page track missing");
    await user.click(track);
    expect(play).toHaveBeenCalledWith("fixture-large-31");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("打开莱茵队列时定位当前歌曲页，播放进度更新不会把手动翻页拉回去", async () => {
    const user = userEvent.setup();
    const { queue, player } = await hydrateLargeQueue(65, 45);
    const view = render(<QueueDrawer onClose={vi.fn()} open={false} presentation="rhine-detail" />);
    view.rerender(<QueueDrawer onClose={vi.fn()} open presentation="rhine-detail" />);

    expect(screen.getByRole("navigation", { name: "播放队列分页" })).toHaveTextContent("第 2 / 3 页 · 共 65 首");
    expect(view.container.querySelector('[data-queue-track-id="fixture-large-46"]')).toHaveAttribute("data-playing", "true");

    await user.click(screen.getByRole("button", { name: "上一页" }));
    await act(async () => {
      await playerActions.hydrateNative(queue, { ...player, positionMs: 1_000 });
    });
    expect(screen.getByRole("navigation", { name: "播放队列分页" })).toHaveTextContent("第 1 / 3 页 · 共 65 首");
  });

  it("莱茵队列搜索全队列并将跨页结果从第一页展示", async () => {
    const user = userEvent.setup();
    await hydrateLargeQueue(65);
    const view = render(<QueueDrawer onClose={vi.fn()} open presentation="rhine-detail" />);
    await user.type(screen.getByRole("searchbox", { name: "在播放队列搜索" }), "跨页命中");
    await user.click(screen.getByRole("button", { name: "搜索" }));

    const rows = view.container.querySelectorAll(".rhine-queue-list .queue-list__item");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-queue-track-id", "fixture-large-65");
    expect(rows[0]?.querySelector(".queue-list__index")).toHaveTextContent("65");
    expect(screen.getByRole("navigation", { name: "播放队列分页" })).toHaveTextContent("第 1 / 1 页 · 共 1 首");
  });

  it("移除末页最后一首后将页码钳制到最后可用页", async () => {
    const user = userEvent.setup();
    const { queue, player } = await hydrateLargeQueue(61);
    let removalUpdate: Promise<void> | undefined;
    const remove = vi.spyOn(playerActions, "removeTrack").mockImplementation((trackId) => {
      const nextQueue = largeQueue(60, 0, queue.generation + 1);
      const remaining = queue.items.filter((track) => track.id !== trackId);
      removalUpdate = playerActions.hydrateNative(
        { ...nextQueue.queue, items: remaining },
        { ...nextQueue.player, currentTrack: player.currentTrack },
      );
    });
    const view = render(<QueueDrawer onClose={vi.fn()} open presentation="rhine-detail" />);
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(view.container.querySelectorAll(".rhine-queue-list .queue-list__item")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "从队列移除《跨页命中歌曲》" }));
    expect(remove).toHaveBeenCalledWith("fixture-large-61");
    if (removalUpdate) await act(async () => { await removalUpdate; });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "播放队列分页" })).toHaveTextContent("第 2 / 2 页 · 共 60 首"));
    expect(view.container.querySelectorAll(".rhine-queue-list .queue-list__item")).toHaveLength(30);
  });

  it("莱茵分页中拖动第二页的曲目时区分无移动并提交队列全局目标序号", async () => {
    vi.useFakeTimers();
    await hydrateLargeQueue(65);
    const move = vi.spyOn(playerActions, "moveTrackTo").mockResolvedValue();
    const view = render(<QueueDrawer onClose={vi.fn()} open presentation="rhine-detail" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    });
    const { items } = prepareRhineDragGeometry(view.container);
    const firstItem = items[0];
    if (!firstItem) throw new Error("second page row missing");

    firePointer(firstItem, "pointerdown", { clientX: 100, clientY: 110, pointerId: 20 });
    await act(async () => vi.advanceTimersByTime(250));
    firePointer(window, "pointermove", { clientX: 120, clientY: 110, pointerId: 20 });
    firePointer(window, "pointerup", { clientX: 120, clientY: 110, pointerId: 20 });
    await act(async () => Promise.resolve());
    expect(move).not.toHaveBeenCalled();

    const firstRowAgain = view.container.querySelector<HTMLElement>('.rhine-queue-list [data-queue-track-id="fixture-large-31"]');
    if (!firstRowAgain) throw new Error("second page first row missing after no-op drag");
    firePointer(firstRowAgain, "pointerdown", { clientX: 100, clientY: 110, pointerId: 21 });
    await act(async () => vi.advanceTimersByTime(250));
    firePointer(window, "pointermove", { clientX: 120, clientY: 370, pointerId: 21 });
    firePointer(window, "pointerup", { clientX: 120, clientY: 370, pointerId: 21 });
    await act(async () => Promise.resolve());

    expect(move).toHaveBeenCalledWith("fixture-large-31", 34);
    expect(view.container).toHaveTextContent("已将《长队列歌曲 31》移动到第 35 位");
  });
});
