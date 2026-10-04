import type { UnlistenFn } from "@tauri-apps/api/event";

export const TRAY_MENU_COMMAND = "tray_menu_action" as const;

export const TRAY_MENU_ACTIONS = [
  "togglePlayback",
  "previous",
  "next",
  "showMain",
  "hide",
  "quit",
] as const;

export type TrayMenuAction = (typeof TRAY_MENU_ACTIONS)[number];

export const TRAY_MENU_EVENTS = {
  shown: "tray-menu://shown",
  hidden: "tray-menu://hidden",
} as const;

export type TrayMenuEvent = (typeof TRAY_MENU_EVENTS)[keyof typeof TRAY_MENU_EVENTS];

export class TrayMenuAdapterError extends Error {
  readonly code: "QMG-TRAY-001" | "QMG-TRAY-002";

  constructor(code: TrayMenuAdapterError["code"]) {
    super(code);
    this.name = "TrayMenuAdapterError";
    this.code = code;
  }
}

function invalid(): never {
  throw new TrayMenuAdapterError("QMG-TRAY-002");
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isTrayMenuAction(value: unknown): value is TrayMenuAction {
  return typeof value === "string" && (TRAY_MENU_ACTIONS as readonly string[]).includes(value);
}

function isTrayMenuEvent(value: unknown): value is TrayMenuEvent {
  return value === TRAY_MENU_EVENTS.shown || value === TRAY_MENU_EVENTS.hidden;
}

async function invokeAction(action: TrayMenuAction): Promise<void> {
  if (!isTauriRuntime()) throw new TrayMenuAdapterError("QMG-TRAY-001");

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(TRAY_MENU_COMMAND, { action });
  } catch (error) {
    if (error instanceof TrayMenuAdapterError) throw error;
    throw new TrayMenuAdapterError("QMG-TRAY-001");
  }
}

export async function sendTrayMenuAction(action: TrayMenuAction): Promise<void> {
  if (!isTrayMenuAction(action)) return invalid();
  return invokeAction(action);
}

export const trayMenuAction = sendTrayMenuAction;

const noop: UnlistenFn = () => undefined;

async function listenForTrayMenuEvent(
  event: TrayMenuEvent,
  handler: () => void,
): Promise<UnlistenFn> {
  if (!isTrayMenuEvent(event)) return invalid();
  if (!isTauriRuntime()) return noop;

  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<null>(event, () => handler());
    let cleaned = false;
    return () => {
      if (cleaned) return;
      cleaned = true;
      try {
        unlisten();
      } catch {
        // Listener cleanup is best effort when a WebView is already closing.
      }
    };
  } catch (error) {
    if (error instanceof TrayMenuAdapterError) throw error;
    throw new TrayMenuAdapterError("QMG-TRAY-001");
  }
}

export function listenTrayMenuShown(handler: () => void): Promise<UnlistenFn> {
  return listenForTrayMenuEvent(TRAY_MENU_EVENTS.shown, handler);
}

export function listenTrayMenuHidden(handler: () => void): Promise<UnlistenFn> {
  return listenForTrayMenuEvent(TRAY_MENU_EVENTS.hidden, handler);
}

export function listenTrayMenuEvent(
  event: TrayMenuEvent,
  handler: () => void,
): Promise<UnlistenFn> {
  return listenForTrayMenuEvent(event, handler);
}
