import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";

export interface WindowSnapshot {
  size: {
    width: number;
    height: number;
  };
  position: {
    x: number;
    y: number;
  };
  maximized: boolean;
}

export interface MiniWindowTransition {
  snapshot: WindowSnapshot | null;
  applied: boolean;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const MINI_MIN_SIZE = new LogicalSize(320, 640);
const MINI_SIZE = new LogicalSize(360, 700);
const NORMAL_MIN_SIZE = new LogicalSize(960, 640);
const WINDOW_MINIMIZED_EVENT = "qqmusic:window-minimized";
const MAIN_WINDOW_VISIBLE_EVENT = "qqmusic:main-window-visible";

function publishWindowMinimized(minimized: boolean): void {
  window.dispatchEvent(new CustomEvent<boolean>(WINDOW_MINIMIZED_EVENT, { detail: minimized }));
}

export async function windowMinimize(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().minimize();
    publishWindowMinimized(true);
  } catch {
    // Ignore window action errors in non-standard runtimes.
  }
}

export async function windowToggleMaximize(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().toggleMaximize();
  } catch {
    // Ignore window action errors in non-standard runtimes.
  }
}

export async function windowClose(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch {
    // Ignore window action errors in non-standard runtimes.
  }
}

export async function windowIsMaximized(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await getCurrentWindow().isMaximized();
  } catch {
    return false;
  }
}

export async function windowEnterMiniMode(): Promise<MiniWindowTransition> {
  if (!isTauriRuntime()) return { snapshot: null, applied: false };

  let snapshot: WindowSnapshot | null = null;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWin = getCurrentWindow();
    const [size, position, maximized] = await Promise.all([
      currentWin.outerSize(),
      currentWin.outerPosition(),
      currentWin.isMaximized(),
    ]);

    snapshot = {
      size: { width: size.width, height: size.height },
      position: { x: position.x, y: position.y },
      maximized,
    };

    await currentWin.setMinSize(MINI_MIN_SIZE);
    if (maximized) await currentWin.unmaximize();
    await currentWin.setSize(MINI_SIZE);
    await currentWin.center();

    return { snapshot, applied: true };
  } catch {
    return { snapshot, applied: false };
  }
}

export async function windowRestoreNormal(snapshot: WindowSnapshot | null): Promise<boolean> {
  if (!snapshot || !isTauriRuntime()) return false;

  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWin = getCurrentWindow();

    if (snapshot.maximized) {
      await currentWin.setMinSize(NORMAL_MIN_SIZE);
      await currentWin.maximize();
    } else {
      await currentWin.setSize(new PhysicalSize(snapshot.size.width, snapshot.size.height));
      await currentWin.setPosition(new PhysicalPosition(snapshot.position.x, snapshot.position.y));
      await currentWin.setMinSize(NORMAL_MIN_SIZE);
    }

    return true;
  } catch {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setMinSize(NORMAL_MIN_SIZE);
    } catch {
      // Best effort only: the original failure still determines the result.
    }
    return false;
  }
}

export async function listenWindowResize(
  onResize: (maximized: boolean) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWin = getCurrentWindow();
    return await currentWin.onResized(async () => {
      try {
        const maximized = await currentWin.isMaximized();
        onResize(maximized);
      } catch {
        // Ignore resize query errors.
      }
    });
  } catch {
    return () => undefined;
  }
}

export async function listenWindowMinimized(
  onMinimized: (minimized: boolean) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  const onExplicitState = (event: Event) => {
    if (event instanceof CustomEvent && typeof event.detail === "boolean") {
      onMinimized(event.detail);
    }
  };
  window.addEventListener(WINDOW_MINIMIZED_EVENT, onExplicitState);
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWin = getCurrentWindow();
    const publish = async () => {
      try {
        onMinimized(await currentWin.isMinimized());
      } catch {
        // Ignore window-state query errors; document visibility remains active.
      }
    };
    await publish();
    const [unlistenResize, unlistenFocus] = await Promise.all([
      currentWin.onResized(publish),
      currentWin.onFocusChanged(({ payload: focused }) => {
        if (focused) onMinimized(false);
      }),
    ]);
    return () => {
      window.removeEventListener(WINDOW_MINIMIZED_EVENT, onExplicitState);
      unlistenResize();
      unlistenFocus();
    };
  } catch {
    window.removeEventListener(WINDOW_MINIMIZED_EVENT, onExplicitState);
    return () => undefined;
  }
}

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

export async function listenWindowRenderable(
  onRenderable: (renderable: boolean) => void,
): Promise<() => void> {
  let disposed = false;
  let windowVisible = !isTauriRuntime();
  let minimized = false;
  let lastPublished: boolean | undefined;
  let unlistenVisible: () => void = () => undefined;
  let unlistenMinimized: () => void = () => undefined;

  const publish = () => {
    if (disposed) return;
    const renderable = windowVisible && !minimized && documentIsVisible();
    if (renderable === lastPublished) return;
    lastPublished = renderable;
    onRenderable(renderable);
  };
  const onDocumentVisibility = () => publish();
  document.addEventListener("visibilitychange", onDocumentVisibility);

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("visibilitychange", onDocumentVisibility);
    unlistenVisible();
    unlistenMinimized();
  };

  if (!isTauriRuntime()) {
    publish();
    return cleanup;
  }

  windowVisible = false;
  minimized = true;
  publish();

  try {
    const [{ listen }, { getCurrentWindow }] = await Promise.all([
      import("@tauri-apps/api/event"),
      import("@tauri-apps/api/window"),
    ]);
    const currentWin = getCurrentWindow();
    unlistenVisible = await listen<unknown>(MAIN_WINDOW_VISIBLE_EVENT, ({ payload }) => {
      if (typeof payload !== "boolean") return;
      windowVisible = payload;
      publish();
    });
    unlistenMinimized = await listenWindowMinimized((nextMinimized) => {
      minimized = nextMinimized;
      publish();
    });
    const [initialVisible, initialMinimized] = await Promise.all([
      currentWin.isVisible(),
      currentWin.isMinimized(),
    ]);
    windowVisible = initialVisible;
    minimized = initialMinimized;
    publish();
  } catch {
    windowVisible = false;
    minimized = true;
    publish();
    unlistenVisible();
    unlistenVisible = () => undefined;
    unlistenMinimized();
    unlistenMinimized = () => undefined;
  }

  return cleanup;
}
