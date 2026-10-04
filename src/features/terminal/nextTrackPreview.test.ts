import { describe, expect, it } from "vitest";

import { FIXTURE_TRACKS } from "../player/fixtures";
import { deriveTerminalNextPreview, deriveTerminalUpNext } from "./nextTrackPreview";

const firstTrack = FIXTURE_TRACKS[0]!;
const secondTrack = FIXTURE_TRACKS[1]!;
const thirdTrack = FIXTURE_TRACKS[2]!;

describe("deriveTerminalUpNext", () => {
  it("按 sequence 返回当前歌曲之后的有限队列条目", () => {
    expect(deriveTerminalUpNext(firstTrack, FIXTURE_TRACKS, "sequence", 5)).toEqual({
      status: "ready",
      items: [
        { queueNumber: "02", trackId: secondTrack.id, title: secondTrack.title, artist: secondTrack.artist, isFirst: true },
        { queueNumber: "03", trackId: thirdTrack.id, title: thirdTrack.title, artist: thirdTrack.artist, isFirst: false },
        { queueNumber: "04", trackId: FIXTURE_TRACKS[3]!.id, title: FIXTURE_TRACKS[3]!.title, artist: FIXTURE_TRACKS[3]!.artist, isFirst: false },
        { queueNumber: "05", trackId: FIXTURE_TRACKS[4]!.id, title: FIXTURE_TRACKS[4]!.title, artist: FIXTURE_TRACKS[4]!.artist, isFirst: false },
      ],
    });
  });

  it("sequence 到队尾不循环", () => {
    expect(deriveTerminalUpNext(thirdTrack, FIXTURE_TRACKS.slice(0, 3), "sequence", 5)).toEqual({
      status: "end-of-queue",
      items: [],
    });
  });

  it("repeat-all 从队尾环回且不重复队列位置", () => {
    expect(deriveTerminalUpNext(thirdTrack, FIXTURE_TRACKS.slice(0, 3), "repeat-all", 5)).toEqual({
      status: "ready",
      items: [
        { queueNumber: "01", trackId: firstTrack.id, title: firstTrack.title, artist: firstTrack.artist, isFirst: true },
        { queueNumber: "02", trackId: secondTrack.id, title: secondTrack.title, artist: secondTrack.artist, isFirst: false },
        { queueNumber: "03", trackId: thirdTrack.id, title: thirdTrack.title, artist: thirdTrack.artist, isFirst: false },
      ],
    });
  });

  it("repeat-one 只返回当前歌曲一项", () => {
    expect(deriveTerminalUpNext(secondTrack, FIXTURE_TRACKS, "repeat-one", 5)).toEqual({
      status: "repeat-current",
      items: [{ queueNumber: "02", trackId: secondTrack.id, title: secondTrack.title, artist: secondTrack.artist, isFirst: true }],
    });
  });

  it("shuffle 返回待定状态而不伪造下一首", () => {
    expect(deriveTerminalUpNext(firstTrack, FIXTURE_TRACKS, "shuffle", 5)).toEqual({
      status: "shuffle-pending",
      items: [],
    });
  });

  it.each([
    ["没有当前歌曲", null, FIXTURE_TRACKS, "sequence"],
    ["空队列", firstTrack, [], "shuffle"],
    ["当前歌曲不在队列", { ...firstTrack, id: "missing-track" }, FIXTURE_TRACKS, "repeat-all"],
  ] as const)("%s 返回 END OF QUEUE 状态", (_label, currentTrack, queue, mode) => {
    expect(deriveTerminalUpNext(currentTrack, queue, mode, 5)).toEqual({
      status: "end-of-queue",
      items: [],
    });
  });

  it("非正 limit 返回空条目且不修改输入", () => {
    const queue = [...FIXTURE_TRACKS];
    expect(deriveTerminalUpNext(firstTrack, queue, "sequence", 0)).toEqual({ status: "ready", items: [] });
    expect(deriveTerminalUpNext(firstTrack, queue, "sequence", -1)).toEqual({ status: "ready", items: [] });
    expect(queue).toEqual(FIXTURE_TRACKS);
  });
});

describe("deriveTerminalNextPreview compatibility", () => {
  it("继续为现有单行调用方投影第一项", () => {
    expect(deriveTerminalNextPreview(firstTrack, FIXTURE_TRACKS, "sequence")).toEqual({
      label: "NEXT // 02",
      detail: "纸月光 · 方格岛",
    });
  });

  it("继续投影结束、shuffle 和 repeat-one 状态", () => {
    expect(deriveTerminalNextPreview(thirdTrack, FIXTURE_TRACKS.slice(0, 3), "sequence")).toEqual({ label: "NEXT //", detail: "END OF QUEUE" });
    expect(deriveTerminalNextPreview(firstTrack, FIXTURE_TRACKS, "shuffle")).toEqual({ label: "NEXT //", detail: "SHUFFLE PENDING" });
    expect(deriveTerminalNextPreview(secondTrack, FIXTURE_TRACKS, "repeat-one")).toEqual({ label: "REPEAT CURRENT //", detail: "纸月光 · 方格岛" });
  });
});
