import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  listenWindowMinimized,
  listenWindowRenderable,
  listenWindowResize,
  windowEnterMiniMode,
  windowClose,
  windowIsMaximized,
  windowMinimize,
  windowRestoreNormal,
  windowToggleMaximize,
} from "./windowAdapter";

describe("窗口控制适配器 (windowAdapter)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.doUnmock("@tauri-apps/api/window");
    vi.doUnmock("@tauri-apps/api/event");
    vi.resetModules();
  });

  describe("非 Tauri 浏览器环境回退", () => {
    it("查询最大化状态返回 false", async () => {
      const maximized = await windowIsMaximized();
      expect(maximized).toBe(false);
    });

    it("窗口最小化、最大化切换、关闭静默完成不抛错", async () => {
      await expect(windowMinimize()).resolves.toBeUndefined();
      await expect(windowToggleMaximize()).resolves.toBeUndefined();
      await expect(windowClose()).resolves.toBeUndefined();
    });

    it("监听窗口变化返回可安全调用的注销函数", async () => {
      const callback = vi.fn();
      const unlisten = await listenWindowResize(callback);
      const unlistenMinimized = await listenWindowMinimized(callback);
      expect(typeof unlisten).toBe("function");
      expect(typeof unlistenMinimized).toBe("function");
      unlisten();
      unlistenMinimized();
      expect(callback).not.toHaveBeenCalled();
    });

    it("只按 document 可见性发布浏览器环境的可绘制状态", async () => {
      const callback = vi.fn();
      const unlisten = await listenWindowRenderable(callback);
      expect(callback).toHaveBeenLastCalledWith(true);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(callback).toHaveBeenLastCalledWith(false);

      unlisten();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("Mini 进入和普通恢复在浏览器环境安全回退", async () => {
      await expect(windowEnterMiniMode()).resolves.toEqual({ snapshot: null, applied: false });
      await expect(windowRestoreNormal(null)).resolves.toBe(false);
    });
  });

  describe("Tauri 桌面运行时环境", () => {
    it("正确转发最小化、切换最大化和关闭指令", async () => {
      (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {};

      const mockMinimize = vi.fn().mockResolvedValue(undefined);
      const mockToggleMaximize = vi.fn().mockResolvedValue(undefined);
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockIsMaximized = vi.fn().mockResolvedValue(true);

      vi.doMock("@tauri-apps/api/window", () => ({
        getCurrentWindow: () => ({
          minimize: mockMinimize,
          toggleMaximize: mockToggleMaximize,
          close: mockClose,
          isMaximized: mockIsMaximized,
        }),
      }));

      const minimizedEvent = vi.fn();
      window.addEventListener("qqmusic:window-minimized", minimizedEvent);
      await windowMinimize();
      expect(mockMinimize).toHaveBeenCalledTimes(1);
      expect(minimizedEvent).toHaveBeenCalledTimes(1);
      window.removeEventListener("qqmusic:window-minimized", minimizedEvent);

      await windowToggleMaximize();
      expect(mockToggleMaximize).toHaveBeenCalledTimes(1);

      await windowClose();
      expect(mockClose).toHaveBeenCalledTimes(1);

      const isMax = await windowIsMaximized();
      expect(isMax).toBe(true);
      expect(mockIsMaximized).toHaveBeenCalledTimes(1);
    });

    it("监听 resize 事件并触发状态回调", async () => {
      (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {};

      let triggerResize: (() => Promise<void>) | undefined;
      const mockUnlisten = vi.fn();
      const mockIsMaximized = vi.fn().mockResolvedValue(true);

      vi.doMock("@tauri-apps/api/window", () => ({
        getCurrentWindow: () => ({
          isMaximized: mockIsMaximized,
          onResized: (handler: () => Promise<void>) => {
            triggerResize = handler;
            return Promise.resolve(mockUnlisten);
          },
        }),
      }));

      const onResize = vi.fn();
      const unlisten = await listenWindowResize(onResize);
      expect(typeof triggerResize).toBe("function");

      await triggerResize!();
      expect(mockIsMaximized).toHaveBeenCalled();
      expect(onResize).toHaveBeenCalledWith(true);

      unlisten();
      expect(mockUnlisten).toHaveBeenCalledTimes(1);
    });

    it("监听 resize 并发布最小化状态", async () => {
      (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {};

      let triggerResize: (() => Promise<void>) | undefined;
      let triggerFocus: ((event: { payload: boolean }) => void) | undefined;
      const mockUnlisten = vi.fn();
      const mockFocusUnlisten = vi.fn();
      const mockIsMinimized = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      vi.doMock("@tauri-apps/api/window", () => ({
        getCurrentWindow: () => ({
          isMinimized: mockIsMinimized,
          onResized: (handler: () => Promise<void>) => {
            triggerResize = handler;
            return Promise.resolve(mockUnlisten);
          },
          onFocusChanged: (handler: (event: { payload: boolean }) => void) => {
            triggerFocus = handler;
            return Promise.resolve(mockFocusUnlisten);
          },
        }),
      }));

      const onMinimized = vi.fn();
      const unlisten = await listenWindowMinimized(onMinimized);
      expect(onMinimized).toHaveBeenLastCalledWith(false);

      await triggerResize!();
      expect(onMinimized).toHaveBeenLastCalledWith(true);

      triggerFocus!({ payload: true });
      expect(onMinimized).toHaveBeenLastCalledWith(false);

      unlisten();
      expect(mockUnlisten).toHaveBeenCalledTimes(1);
      expect(mockFocusUnlisten).toHaveBeenCalledTimes(1);
    });

    it("合并原生显隐、最小化与 document 可见性且清理全部监听", async () => {
      (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {};

      let publishVisible: ((event: { payload: unknown }) => void) | undefined;
      const unlistenVisible = vi.fn();
      const unlistenResize = vi.fn();
      const unlistenFocus = vi.fn();
      vi.doMock("@tauri-apps/api/event", () => ({
        listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
          expect(event).toBe("qqmusic:main-window-visible");
          publishVisible = handler;
          return unlistenVisible;
        }),
      }));
      vi.doMock("@tauri-apps/api/window", () => ({
        getCurrentWindow: () => ({
          isVisible: vi.fn().mockResolvedValue(true),
          isMinimized: vi.fn().mockResolvedValue(false),
          onResized: vi.fn().mockResolvedValue(unlistenResize),
          onFocusChanged: vi.fn().mockResolvedValue(unlistenFocus),
        }),
      }));

      const callback = vi.fn();
      const unlisten = await listenWindowRenderable(callback);
      expect(callback.mock.calls.map(([value]) => value)).toEqual([false, true]);

      publishVisible?.({ payload: "false" });
      expect(callback).toHaveBeenCalledTimes(2);
      publishVisible?.({ payload: false });
      expect(callback).toHaveBeenLastCalledWith(false);
      publishVisible?.({ payload: true });
      expect(callback).toHaveBeenLastCalledWith(true);

      window.dispatchEvent(new CustomEvent("qqmusic:window-minimized", { detail: true }));
      expect(callback).toHaveBeenLastCalledWith(false);
      window.dispatchEvent(new CustomEvent("qqmusic:window-minimized", { detail: false }));
      expect(callback).toHaveBeenLastCalledWith(true);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(callback).toHaveBeenLastCalledWith(false);

      unlisten();
      expect(unlistenVisible).toHaveBeenCalledTimes(1);
      expect(unlistenResize).toHaveBeenCalledTimes(1);
      expect(unlistenFocus).toHaveBeenCalledTimes(1);
    });

    it("窗口状态监听初始化失败时保守保持不可绘制", async () => {
      (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {};
      vi.doMock("@tauri-apps/api/event", () => ({
        listen: vi.fn().mockRejectedValue(new Error("listen failed")),
      }));
      vi.doMock("@tauri-apps/api/window", () => ({
        getCurrentWindow: () => ({
          isVisible: vi.fn().mockResolvedValue(true),
          isMinimized: vi.fn().mockResolvedValue(false),
        }),
      }));

      const callback = vi.fn();
      const unlisten = await listenWindowRenderable(callback);
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenLastCalledWith(false);
      unlisten();
    });

    it("进入 Mini 保存普通窗口快照、调整尺寸并恢复尺寸位置", async () => {
      (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {};

      const mockOuterSize = vi.fn().mockResolvedValue({ width: 1440, height: 900 });
      const mockOuterPosition = vi.fn().mockResolvedValue({ x: 120, y: 80 });
      const mockIsMaximized = vi.fn().mockResolvedValue(false);
      const mockSetMinSize = vi.fn().mockResolvedValue(undefined);
      const mockSetSize = vi.fn().mockResolvedValue(undefined);
      const mockSetPosition = vi.fn().mockResolvedValue(undefined);
      const mockCenter = vi.fn().mockResolvedValue(undefined);

      vi.doMock("@tauri-apps/api/window", () => ({
        getCurrentWindow: () => ({
          outerSize: mockOuterSize,
          outerPosition: mockOuterPosition,
          isMaximized: mockIsMaximized,
          setMinSize: mockSetMinSize,
          setSize: mockSetSize,
          setPosition: mockSetPosition,
          center: mockCenter,
        }),
      }));

      const transition = await windowEnterMiniMode();

      expect(transition).toEqual({
        snapshot: {
          size: { width: 1440, height: 900 },
          position: { x: 120, y: 80 },
          maximized: false,
        },
        applied: true,
      });
      expect(mockOuterSize).toHaveBeenCalledTimes(1);
      expect(mockOuterPosition).toHaveBeenCalledTimes(1);
      expect(mockIsMaximized).toHaveBeenCalledTimes(1);
      expect(mockSetMinSize).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ type: "Logical", width: 320, height: 640 }),
      );
      expect(mockSetSize).toHaveBeenCalledWith(
        expect.objectContaining({ type: "Logical", width: 360, height: 700 }),
      );
      expect(mockCenter).toHaveBeenCalledTimes(1);

      const restored = await windowRestoreNormal(transition.snapshot);

      expect(restored).toBe(true);
      expect(mockSetSize).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "Physical", width: 1440, height: 900 }),
      );
      expect(mockSetPosition).toHaveBeenCalledWith(
        expect.objectContaining({ type: "Physical", x: 120, y: 80 }),
      );
      expect(mockSetMinSize).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "Logical", width: 960, height: 640 }),
      );
    });

    it("最大化窗口进入 Mini 时先取消最大化，恢复时重新最大化", async () => {
      (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {};

      const mockUnmaximize = vi.fn().mockResolvedValue(undefined);
      const mockMaximize = vi.fn().mockResolvedValue(undefined);
      const mockSetMinSize = vi.fn().mockResolvedValue(undefined);
      const mockSetSize = vi.fn().mockResolvedValue(undefined);
      const mockCenter = vi.fn().mockResolvedValue(undefined);

      vi.doMock("@tauri-apps/api/window", () => ({
        getCurrentWindow: () => ({
          outerSize: vi.fn().mockResolvedValue({ width: 1920, height: 1080 }),
          outerPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
          isMaximized: vi.fn().mockResolvedValue(true),
          setMinSize: mockSetMinSize,
          setSize: mockSetSize,
          center: mockCenter,
          unmaximize: mockUnmaximize,
          maximize: mockMaximize,
        }),
      }));

      const transition = await windowEnterMiniMode();
      expect(transition.snapshot?.maximized).toBe(true);
      expect(mockUnmaximize).toHaveBeenCalledTimes(1);
      expect(mockSetSize).toHaveBeenCalledWith(
        expect.objectContaining({ type: "Logical", width: 360, height: 700 }),
      );
      expect(mockCenter).toHaveBeenCalledTimes(1);

      await expect(windowRestoreNormal(transition.snapshot)).resolves.toBe(true);
      expect(mockSetMinSize).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "Logical", width: 960, height: 640 }),
      );
      expect(mockMaximize).toHaveBeenCalledTimes(1);
    });

    it("进入 Mini 中途失败时返回已捕获快照且不标记已应用", async () => {
      (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {};

      const mockSetSize = vi.fn().mockRejectedValue(new Error("resize failed"));
      vi.doMock("@tauri-apps/api/window", () => ({
        getCurrentWindow: () => ({
          outerSize: vi.fn().mockResolvedValue({ width: 1280, height: 720 }),
          outerPosition: vi.fn().mockResolvedValue({ x: 40, y: 50 }),
          isMaximized: vi.fn().mockResolvedValue(false),
          setMinSize: vi.fn().mockResolvedValue(undefined),
          setSize: mockSetSize,
          center: vi.fn().mockResolvedValue(undefined),
        }),
      }));

      await expect(windowEnterMiniMode()).resolves.toEqual({
        snapshot: {
          size: { width: 1280, height: 720 },
          position: { x: 40, y: 50 },
          maximized: false,
        },
        applied: false,
      });
    });

    it("普通恢复失败时仍尽力恢复 Normal 最小尺寸", async () => {
      (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {};

      const mockSetMinSize = vi.fn().mockResolvedValue(undefined);
      vi.doMock("@tauri-apps/api/window", () => ({
        getCurrentWindow: () => ({
          setSize: vi.fn().mockRejectedValue(new Error("restore failed")),
          setMinSize: mockSetMinSize,
        }),
      }));

      await expect(
        windowRestoreNormal({
          size: { width: 1280, height: 720 },
          position: { x: 40, y: 50 },
          maximized: false,
        }),
      ).resolves.toBe(false);
      expect(mockSetMinSize).toHaveBeenCalledWith(
        expect.objectContaining({ type: "Logical", width: 960, height: 640 }),
      );
    });
  });
});
