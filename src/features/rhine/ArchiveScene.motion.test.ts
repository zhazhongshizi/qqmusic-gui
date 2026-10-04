import { expect, it } from "vitest";
import { ArchiveScene } from "./vendor/scene";

it("仅在磁带机上下文停用播放起伏，不暂停播放器或浏览态动画", () => {
  const scene = Object.create(ArchiveScene.prototype) as ArchiveScene;
  const state = scene as unknown as {
    archivePlayback: boolean;
    archivePlaying: boolean;
    archiveWaveGain: number;
    disableCassetteMotionWhilePlaying: boolean;
    idleGain: number;
  };

  Object.assign(state, {
    archivePlayback: true,
    archivePlaying: true,
    archiveWaveGain: 0.42,
    disableCassetteMotionWhilePlaying: false,
    idleGain: 0.68,
  });
  scene.setDisableCassetteMotionWhilePlaying(true);

  expect(scene.playbackCassetteMotionSuppressed).toBe(true);
  expect(state.archiveWaveGain).toBe(0);
  expect(state.idleGain).toBe(0);
  expect(state.archivePlaying).toBe(true);

  state.archivePlayback = false;
  state.idleGain = 0.35;
  expect(scene.playbackCassetteMotionSuppressed).toBe(false);
  expect(state.idleGain).toBe(0.35);
});
