import { afterEach, expect, it, vi } from "vitest";
import { reportFrontendFailure } from "./frontendDiagnostics";
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); invoke.mockClear(); });
it("reports only the allowed event kind", () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  reportFrontendFailure("unhandled_rejection");
  expect(invoke).toHaveBeenCalledWith("logging_frontend_error", { kind: "unhandled_rejection" });
});
it("does not call desktop commands in the browser", () => {
  reportFrontendFailure("error");
  expect(invoke).not.toHaveBeenCalled();
});
