import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OrganizerPanel } from "./OrganizerPanel";

const { previewMock, executeMock } = vi.hoisted(() => ({
  previewMock: vi.fn(),
  executeMock: vi.fn(),
}));

vi.mock("../../backend/libraryAdapter", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("../../backend/libraryAdapter")>();
  return { ...original, previewOrganizer: previewMock, executeOrganizer: executeMock };
});

const PLAYLISTS = [
  { id: "991", editableId: "88", title: "夜航", description: "", songCount: 2 },
  { id: "992", editableId: "89", title: "晨雾", description: "", songCount: 0 },
] as const;
const PLAN_ID = "plan-0123456789abcdef0123456789abcdef";

describe("organizer panel", () => {
  beforeEach(() => {
    previewMock.mockReset().mockResolvedValue({
      planId: PLAN_ID,
      operation: "copy",
      sourceTitle: "夜航",
      targetTitle: "晨雾",
      itemCount: 2,
      previewTruncated: false,
      expiresAtUnixMs: 2_000_000_000_000,
      items: [
        { id: "song-a", title: "纸月光", artist: "林间电台", album: "温室唱片" },
        { id: "song-b", title: "潮汐", artist: "林间电台", album: "温室唱片" },
      ],
    });
    executeMock.mockReset().mockResolvedValue({
      planId: PLAN_ID,
      state: "complete",
      itemCount: 2,
      completedCount: 2,
      failedCount: 0,
      pendingVerificationCount: 0,
    });
  });
  afterEach(cleanup);

  it("必须先预览、勾选二次确认，执行时不回传曲目列表", async () => {
    const user = userEvent.setup();
    render(<OrganizerPanel playlists={PLAYLISTS} previewRuntime={false} />);

    await user.click(screen.getByRole("button", { name: "生成整理预览" }));
    expect(await screen.findByRole("heading", { name: "将处理 2 首歌曲" })).toBeInTheDocument();
    const execute = screen.getByRole("button", { name: "确认执行 2 项" });
    expect(execute).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /我已核对/ }));
    await user.click(execute);

    expect(executeMock).toHaveBeenCalledWith(PLAN_ID);
    expect(await screen.findByText("整理完成")).toBeInTheDocument();
  });

  it("浏览器预览不生成可执行计划", () => {
    render(<OrganizerPanel playlists={PLAYLISTS} previewRuntime />);
    expect(screen.getByText("本地预览不会生成可执行计划")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成整理预览" })).not.toBeInTheDocument();
  });
});
