import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AlbumArtwork } from "./AlbumArtwork";

const { getCoverImageMock } = vi.hoisted(() => ({ getCoverImageMock: vi.fn() }));

vi.mock("../../backend/coverAdapter", () => ({ getCoverImage: getCoverImageMock }));

const TRACK = {
  id: "song-1",
  title: "纸月光",
  artist: "方格岛",
  accent: "#9f9878",
  artworkVariant: "moon" as const,
  coverCacheKey: "album-mid-1",
};

describe("AlbumArtwork", () => {
  const createObjectUrl = vi.fn((_blob: Blob) => "blob:cover-1");
  const revokeObjectUrl = vi.fn();

  beforeEach(() => {
    getCoverImageMock.mockReset();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    createObjectUrl.mockClear();
    revokeObjectUrl.mockClear();
  });

  afterEach(() => cleanup());

  it("成功读取本地封面后显示 Blob 图片，并在卸载时撤销 URL", async () => {
    getCoverImageMock.mockResolvedValue({ mimeType: "image/jpeg", bytes: new Uint8Array([255, 216, 255, 217]) });
    const view = render(<AlbumArtwork track={TRACK} />);

    expect(screen.getByRole("img", { name: "纸月光专辑封面" })).toBeInTheDocument();
    expect(await screen.findByAltText("纸月光专辑封面")).toHaveAttribute("src", "blob:cover-1");
    view.unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:cover-1");
  });

  it("无封面键或读取失败时保留 SVG fallback", async () => {
    const noKey = { ...TRACK, coverCacheKey: undefined };
    const view = render(<AlbumArtwork track={noKey} />);
    expect(getCoverImageMock).not.toHaveBeenCalled();
    expect(view.container.querySelector("svg")).toBeInTheDocument();
    view.unmount();

    getCoverImageMock.mockRejectedValueOnce(new Error("unavailable"));
    const failed = render(<AlbumArtwork track={TRACK} />);
    await waitFor(() => expect(failed.container.querySelector("svg")).toBeInTheDocument());
    expect(failed.container.querySelector("img")).not.toBeInTheDocument();
  });

  it("歌曲切换后丢弃旧响应，不让旧封面污染新歌曲", async () => {
    let resolveFirst!: (value: { mimeType: "image/jpeg"; bytes: Uint8Array }) => void;
    let resolveSecond!: (value: { mimeType: "image/jpeg"; bytes: Uint8Array }) => void;
    getCoverImageMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const view = render(<AlbumArtwork track={TRACK} />);
    const nextTrack = { ...TRACK, id: "song-2", coverCacheKey: "album-mid-2" };
    view.rerender(<AlbumArtwork track={nextTrack} />);

    resolveFirst({ mimeType: "image/jpeg", bytes: new Uint8Array([1]) });
    await Promise.resolve();
    expect(createObjectUrl).not.toHaveBeenCalled();
    resolveSecond({ mimeType: "image/jpeg", bytes: new Uint8Array([2]) });
    expect(await screen.findByAltText("纸月光专辑封面")).toHaveAttribute("src", "blob:cover-1");
  });
});

