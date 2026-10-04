import { describe, expect, it } from "vitest";

import {
  SPECTRUM_BAND_COUNT,
  parseSpectrumFrame,
  SpectrumContractError,
} from "./spectrum";

const validFrame = () => ({
  epoch: 3,
  sequence: 7,
  state: "active" as const,
  bands: Array.from({ length: SPECTRUM_BAND_COUNT }, (_, index) => index / SPECTRUM_BAND_COUNT),
});

describe("spectrum contract", () => {
  it("accepts the exact 24-band wire shape", () => {
    const parsed = parseSpectrumFrame(validFrame());
    expect(parsed).toEqual(validFrame());
    expect(parsed.bands).not.toBe((validFrame() as { bands: number[] }).bands);
  });

  it.each([
    ["negative epoch", { epoch: -1 }],
    ["fractional sequence", { sequence: 1.5 }],
    ["unsafe integer", { epoch: Number.MAX_SAFE_INTEGER + 1 }],
    ["unknown state", { state: "capturing" }],
    ["short bands", { bands: Array(SPECTRUM_BAND_COUNT - 1).fill(0) }],
    ["long bands", { bands: Array(SPECTRUM_BAND_COUNT + 1).fill(0) }],
    ["NaN band", { bands: [NaN, ...Array(SPECTRUM_BAND_COUNT - 1).fill(0)] }],
    ["infinite band", { bands: [Infinity, ...Array(SPECTRUM_BAND_COUNT - 1).fill(0)] }],
    ["out of range band", { bands: [1.01, ...Array(SPECTRUM_BAND_COUNT - 1).fill(0)] }],
  ] as const)("rejects %s", (_label, change) => {
    expect(() => parseSpectrumFrame({ ...validFrame(), ...change })).toThrow(SpectrumContractError);
  });

  it("rejects extra, missing, inherited, and sparse fields", () => {
    expect(() => parseSpectrumFrame({ ...validFrame(), debug: false })).toThrow(SpectrumContractError);
    const nonEnumerableExtra = validFrame();
    Object.defineProperty(nonEnumerableExtra, "debug", { value: false });
    expect(() => parseSpectrumFrame(nonEnumerableExtra)).toThrow(SpectrumContractError);
    const { sequence: _sequence, ...missing } = validFrame();
    expect(() => parseSpectrumFrame(missing)).toThrow(SpectrumContractError);

    const inherited = Object.create({ sequence: 7 }) as Record<string, unknown>;
    Object.assign(inherited, validFrame());
    expect(() => parseSpectrumFrame(inherited)).toThrow(SpectrumContractError);

    const sparse = new Array<number>(SPECTRUM_BAND_COUNT);
    sparse.fill(0);
    delete sparse[4];
    expect(() => parseSpectrumFrame({ ...validFrame(), bands: sparse })).toThrow(SpectrumContractError);

    const bandsWithExtra = Array<number>(SPECTRUM_BAND_COUNT).fill(0) as number[] & { debug?: boolean };
    Object.defineProperty(bandsWithExtra, "debug", { value: false });
    expect(() => parseSpectrumFrame({ ...validFrame(), bands: bandsWithExtra })).toThrow(SpectrumContractError);
  });
});
