import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModeLoadBoundary } from "./ModeLoadBoundary";
const report = vi.hoisted(() => vi.fn());
vi.mock("../backend/frontendDiagnostics", () => ({ reportFrontendFailure: report }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); report.mockClear(); });
it("reports only the failure kind and keeps the mode exit available", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.fn();
  function Broken(): never { throw new Error("Cookie=PRIVATE; private path; private stack"); }
  render(<ModeLoadBoundary onExit={exit}><Broken /></ModeLoadBoundary>);
  expect(screen.getByRole("alert")).toHaveTextContent("当前播放继续");
  expect(report).toHaveBeenCalledExactlyOnceWith("react_error");
  fireEvent.click(screen.getByRole("button", { name: "返回主界面" }));
  expect(exit).toHaveBeenCalledTimes(1);
});
