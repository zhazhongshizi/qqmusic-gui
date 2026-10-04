import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addSongsToPlaylist,
  createPlaylist,
  executeOrganizer,
  getLibraryPlaylists,
  getLikedSongs,
  LIBRARY_COMMANDS,
  LibraryAdapterError,
  parsePlaylistPage,
  previewOrganizer,
} from "./libraryAdapter";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const CREATED_PAGE = {
  kind: "created", page: 1, hasMore: false, total: 1, warningCount: 0,
  items: [{ id: "991", editableId: "88", title: "夜航", description: "", songCount: 12 }],
} as const;
const PREVIEW = {
  planId: "plan-0123456789abcdef0123456789abcdef",
  operation: "move",
  sourceTitle: "夜航",
  targetTitle: "晨雾",
  itemCount: 1,
  previewTruncated: false,
  expiresAtUnixMs: 2_000_000_000_000,
  items: [{ id: "song-mid", title: "纸月光", artist: "林间电台", album: "温室唱片" }],
} as const;

function setTauriRuntime(enabled: boolean) {
  if (enabled) Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

describe("library adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriRuntime(true);
  });
  afterEach(() => setTauriRuntime(false));

  it("严格区分展示 ID 与自建歌单可写 ID", () => {
    expect(parsePlaylistPage(CREATED_PAGE)).toEqual(CREATED_PAGE);
    expect(() => parsePlaylistPage({
      ...CREATED_PAGE,
      items: [{ id: "991", title: "缺少可写 ID", description: "", songCount: 1 }],
    })).toThrow(LibraryAdapterError);
    expect(() => parsePlaylistPage({ ...CREATED_PAGE, cookie: "SENTINEL" })).toThrow();
  });

  it("读取与写入只调用固定命令和规范化 payload", async () => {
    invokeMock
      .mockResolvedValueOnce(CREATED_PAGE)
      .mockResolvedValueOnce({
        generation: 0, page: 1, hasMore: false, warningCount: 0, items: [],
      })
      .mockResolvedValueOnce({
        status: "applied",
        playlist: { id: "993", editableId: "90", title: "晨雾" },
      })
      .mockResolvedValueOnce({ status: "applied", affectedCount: 1 });
    await getLibraryPlaylists("created");
    await getLikedSongs();
    await createPlaylist(" 晨雾 ");
    await addSongsToPlaylist("991", "88", ["song-mid"]);
    expect(invokeMock.mock.calls).toEqual([
      [LIBRARY_COMMANDS.playlists, { kind: "created", page: 1, pageSize: 20 }],
      [LIBRARY_COMMANDS.likedSongs, { page: 1, pageSize: 20, generation: 0 }],
      [LIBRARY_COMMANDS.createPlaylist, { name: "晨雾" }],
      [LIBRARY_COMMANDS.addSongs, {
        playlistId: "991", editableId: "88", songIds: ["song-mid"],
      }],
    ]);
  });

  it("整理器执行只发送 opaque planId 与 confirm", async () => {
    invokeMock
      .mockResolvedValueOnce(PREVIEW)
      .mockResolvedValueOnce({
        planId: PREVIEW.planId,
        state: "complete",
        itemCount: 1,
        completedCount: 1,
        failedCount: 0,
        pendingVerificationCount: 0,
      });
    await previewOrganizer({
      operation: "move",
      source: { id: "991", editableId: "88" },
      target: { id: "992", editableId: "89" },
      selection: "all",
      selectedSongIds: [],
    });
    await executeOrganizer(PREVIEW.planId);
    expect(invokeMock.mock.calls[1]).toEqual([
      LIBRARY_COMMANDS.organizerExecute,
      { planId: PREVIEW.planId, confirm: true },
    ]);
  });

  it("只公开稳定的待核对错误，不外显原始异常", async () => {
    invokeMock.mockRejectedValue({
      code: "write_outcome_unknown",
      cause: "Cookie=SENTINEL; raw upstream response",
    });
    await expect(createPlaylist("夜航")).rejects.toEqual(
      new LibraryAdapterError("QMG-LIBRARY-UNKNOWN"),
    );
  });
});
