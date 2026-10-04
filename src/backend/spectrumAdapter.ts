import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  parseSpectrumFrame,
  type SpectrumFrame,
} from "../contracts/spectrum";

export const SPECTRUM_COMMANDS = {
  setStageActive: "spectrum_set_stage_active",
} as const;

export const SPECTRUM_EVENT = "spectrum_frame" as const;

export type SpectrumAdapterErrorCode = "QMG-SPECTRUM-001" | "QMG-SPECTRUM-002";

export class SpectrumAdapterError extends Error {
  readonly code: SpectrumAdapterErrorCode;

  constructor(code: SpectrumAdapterErrorCode) {
    super(code);
    this.name = "SpectrumAdapterError";
    this.code = code;
  }
}

const noop: UnlistenFn = () => undefined;

function invalid(): never {
  throw new SpectrumAdapterError("QMG-SPECTRUM-002");
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Change the backend stage lifecycle without exposing any capture data. */
export async function spectrumSetStageActive(active: boolean): Promise<void> {
  if (typeof active !== "boolean") return invalid();
  if (!isTauriRuntime()) throw new SpectrumAdapterError("QMG-SPECTRUM-001");

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(SPECTRUM_COMMANDS.setStageActive, { active });
  } catch (error) {
    if (error instanceof SpectrumAdapterError) throw error;
    throw new SpectrumAdapterError("QMG-SPECTRUM-001");
  }
}

/**
 * Listen for frames and silently discard malformed payloads at the IPC edge.
 * The returned cleanup function is safe to call repeatedly.
 */
export async function listenSpectrumFrames(
  onFrame: (frame: SpectrumFrame) => void,
): Promise<UnlistenFn> {
  if (typeof onFrame !== "function") return invalid();
  if (!isTauriRuntime()) return noop;

  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<unknown>(SPECTRUM_EVENT, (event) => {
      try {
        onFrame(parseSpectrumFrame(event.payload));
      } catch {
        // Malformed event payloads are untrusted input and are dropped.
      }
    });

    let cleaned = false;
    return () => {
      if (cleaned) return;
      cleaned = true;
      try {
        unlisten();
      } catch {
        // A closing WebView can reject cleanup; this is intentionally best effort.
      }
    };
  } catch (error) {
    if (error instanceof SpectrumAdapterError) throw error;
    throw new SpectrumAdapterError("QMG-SPECTRUM-001");
  }
}
