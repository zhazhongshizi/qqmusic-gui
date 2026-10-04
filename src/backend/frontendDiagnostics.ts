import { invoke } from "@tauri-apps/api/core";

export function reportFrontendFailure(kind: "error" | "unhandled_rejection" | "react_error") {
  if (!("__TAURI_INTERNALS__" in window)) return;
  // Never send exception messages, URLs, stacks, or rejection payloads.
  void invoke("logging_frontend_error", { kind }).catch(() => {});
}

export function installFrontendDiagnostics() {
  window.addEventListener("error", () => reportFrontendFailure("error"));
  window.addEventListener("unhandledrejection", () => reportFrontendFailure("unhandled_rejection"));
}
