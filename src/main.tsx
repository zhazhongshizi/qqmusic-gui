import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { WindowRoot } from "./app/WindowRoot";
import { installFrontendDiagnostics, reportFrontendFailure } from "./backend/frontendDiagnostics";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/tray-menu.css";

type RuntimeWindowLabel = "main" | "tray-menu" | string | undefined;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function markWindow(label: RuntimeWindowLabel): void {
  const value = label === undefined ? "main" : label;
  document.documentElement.dataset.window = value;
  document.body.dataset.window = value;
  document.getElementById("root")?.setAttribute("data-window", value);
}

async function currentWindowLabel(): Promise<RuntimeWindowLabel> {
  if (!isTauriRuntime()) return undefined;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().label;
  } catch {
    return "unknown";
  }
}

if (typeof document !== "undefined") {
  markWindow("pending");
}

async function bootstrap() {
  installFrontendDiagnostics();
  if (import.meta.env.MODE === "e2e") {
    await import("@wdio/tauri-plugin");
  }

  const rootElement = document.getElementById("root");

  if (!rootElement) {
    throw new Error("应用挂载点不存在");
  }

  const windowLabel = await currentWindowLabel();
  markWindow(windowLabel);

  createRoot(rootElement, { onUncaughtError: () => reportFrontendFailure("react_error"), onCaughtError: () => reportFrontendFailure("react_error") }).render(
    <StrictMode>
      <WindowRoot windowLabel={windowLabel} />
    </StrictMode>,
  );
}

void bootstrap();
