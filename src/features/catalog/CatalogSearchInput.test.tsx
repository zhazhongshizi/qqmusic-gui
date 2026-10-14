import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CatalogSearchInput } from "./CatalogSearchInput";
const { suggestions } = vi.hoisted(() => ({ suggestions: vi.fn() }));
vi.mock("../../backend/catalogDiscoveryAdapter", () => ({ getSearchSuggestions: suggestions }));
function Harness({ submit = () => {}, active = true }: { submit?: (value: string) => void; active?: boolean }) {
  const [value, setValue] = useState("");
  return <CatalogSearchInput value={value} onChange={setValue} onSubmit={submit} active={active} />;
}
beforeEach(() => {
  vi.useFakeTimers(); suggestions.mockReset().mockImplementation((keyword: string, generation: number) =>
    Promise.resolve({ keyword, generation, items: [`${keyword} 推荐`, `${keyword} 现场`], warningCount: 0 }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function type(value: string) {
  const input = screen.getByRole("combobox");
  fireEvent.focus(input); fireEvent.change(input, { target: { value } });
  await act(async () => { vi.advanceTimersByTime(251); });
  return input;
}
it("debounces requests and selects a suggestion with arrows and Enter", async () => {
  const submit = vi.fn(); render(<Harness submit={submit} />);
  const input = screen.getByRole("combobox"); fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "晴" } });
  await act(async () => { vi.advanceTimersByTime(100); });
  fireEvent.change(input, { target: { value: "晴天" } });
  await act(async () => { vi.advanceTimersByTime(251); });
  expect(suggestions).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("option")).toHaveLength(2);
  fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" });
  expect(submit).toHaveBeenCalledWith("晴天 推荐");
  expect(input).toHaveValue("晴天 推荐");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});
it("suppresses suggestions during IME composition and closes on Escape", async () => {
  render(<Harness />); const input = screen.getByRole("combobox"); fireEvent.focus(input);
  fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: "晴天" } });
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(suggestions).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  await act(async () => { vi.advanceTimersByTime(251); });
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(input).toHaveValue("晴天");
});
it("discards old results after typing or hiding the search", async () => {
  let finish!: (value: unknown) => void;
  suggestions.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<Harness />); await type("旧词");
  await type("新词");
  await act(async () => finish({ keyword: "旧词", generation: 1, items: ["旧词结果"], warningCount: 0 }));
  expect(screen.queryByText("旧词结果")).not.toBeInTheDocument();
  expect(screen.getByText("新词 推荐")).toBeInTheDocument();
  view.rerender(<Harness active={false} />);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});
it("chooses by pointer and allows plain searching when suggestions fail", async () => {
  const submit = vi.fn(); render(<Harness submit={submit} />);
  const input = await type("晴天");
  fireEvent.click(screen.getByRole("button", { name: "晴天 现场" }));
  expect(submit).toHaveBeenCalledWith("晴天 现场");
  suggestions.mockRejectedValue(new Error("unavailable")); await type("夜曲");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(submit).toHaveBeenLastCalledWith("夜曲");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});
