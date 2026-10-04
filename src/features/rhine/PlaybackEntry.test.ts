import { expect, it } from "vitest";
import { PlaybackEntry, playbackRipple } from "./vendor/playback-entry";

it("reduced playback keeps the initial ripple then blends into a much smaller slow wave", () => {
  expect(playbackRipple(1, .8, 1)).not.toBe(0);
  expect(playbackRipple(0, 8, 1)).toBeCloseTo(0);
  const values = Array.from({ length: 120 }, (_, i) => playbackRipple(2, 8 + i / 10, 1));
  expect(Math.max(...values)).toBeGreaterThan(.01);
  expect(Math.min(...values)).toBeLessThan(-.01);
  expect(Math.max(...values.map(Math.abs))).toBeLessThan(.035);
  expect(playbackRipple(2, 8, 1)).toBeCloseTo(playbackRipple(2, 8 + 2 * Math.PI / 1.2, 1));
  expect(playbackRipple(1, .8, 1)).toBeCloseTo(playbackRipple(1, .8, 0));
  expect(playbackRipple(1, 8, 0)).not.toBe(0);
});

it("starts the ripple during late descent and raises immediately after seating without resetting it", () => {
  const entry = new PlaybackEntry(); entry.start();
  for (let i = 0; i < 180; i++) entry.update(1 / 60, false, true, false);
  expect(entry.phase).toBe("inserting");
  expect(entry.rise).toBe(0); expect(entry.waveTime).toBe(0);
  entry.update(1 / 60, false, true, false, true);
  expect(entry.phase).toBe("inserting"); expect(entry.waveStarted).toBe(true);
  expect(entry.waveTime).toBeGreaterThan(0); expect(entry.rise).toBe(0);
  const descentTime = entry.waveTime;
  entry.update(1 / 60, true, true, false);
  expect(entry.phase).toBe("rising"); expect(entry.shape).toBe(0);
  expect(entry.waveTime).toBeGreaterThan(descentTime);
  entry.update(1 / 60, true, true, false);
  expect(entry.rise).toBeGreaterThan(0);
  for (let i = 0; i < 20; i++) entry.update(1 / 60, true, true, false);
  expect(entry.rise).toBeGreaterThan(0); expect(entry.rise).toBeLessThan(1);
  expect(entry.waveTime).toBeGreaterThan(.3);
  for (let i = 0; i < 60; i++) entry.update(1 / 60, false, true, false);
  expect(entry.phase).toBe("playing"); expect(entry.waveTime).toBeGreaterThan(0);
  const time = entry.waveTime; entry.update(.05, false, false, false);
  expect(entry.waveTime).toBe(time);
  entry.stop(); entry.start(); expect(entry.waveTime).toBe(0); expect(entry.rise).toBe(0);
});

it("boosts the first trough by 1.6 while retaining the later wave strength", () => {
  const distance = 1;
  const previous = (age: number) => (1 - Math.exp(-distance * .9)) * Math.sin(-age * 4.5)
    * Math.exp(-distance * .16) * .42 * (1 + .55 * Math.exp(-age * 1.8));
  expect(playbackRipple(distance, distance / (4.5 / 1.7) + .35)).toBeCloseTo(previous(.35) * 1.6);
  expect(playbackRipple(distance, distance / (4.5 / 1.7) + 2)).toBeCloseTo(previous(2));
});

it("propagates a signed wave outwards with no displacement ahead of the front", () => {
  expect(playbackRipple(0, 3)).toBeCloseTo(0);
  expect(playbackRipple(8, 1)).toBe(0);
  expect(playbackRipple(1, 1)).not.toBe(0);
  const values = Array.from({ length: 100 }, (_, i) => playbackRipple(2, i / 20));
  expect(Math.min(...values)).toBeLessThan(0); expect(Math.max(...values)).toBeGreaterThan(0);
});

it("reduced motion immediately resolves the entry without running the wave clock", () => {
  const entry = new PlaybackEntry(); entry.start(); entry.update(.016, false, true, true);
  expect(entry.phase).toBe("playing"); expect(entry.rise).toBe(1); expect(entry.waveTime).toBe(0);
});

it("restores the browsing shoulder after an interrupted insertion and can enter again", () => {
  const entry = new PlaybackEntry(); entry.start();
  entry.update(.5, false, true, false); expect(entry.shape).toBeLessThan(.1);
  entry.stop();
  for (let i = 0; i < 100; i++) entry.update(.02, false, false, false);
  expect(entry.shape).toBeCloseTo(1, 4);
  entry.start(); expect(entry.phase).toBe("inserting"); expect(entry.rise).toBe(0);
});
