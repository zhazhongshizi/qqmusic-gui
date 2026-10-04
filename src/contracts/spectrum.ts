/** Public, bounded data exchanged by the live spectrum event bridge. */
export const SPECTRUM_BAND_COUNT = 24 as const;

export const SPECTRUM_STATES = [
  "active",
  "idle",
  "unavailable",
  "failed",
] as const;

export type SpectrumState = (typeof SPECTRUM_STATES)[number];

export interface SpectrumFrame {
  readonly epoch: number;
  readonly sequence: number;
  readonly state: SpectrumState;
  readonly bands: readonly number[];
}

export class SpectrumContractError extends Error {
  constructor() {
    super("invalid spectrum frame");
    this.name = "SpectrumContractError";
  }
}

const SPECTRUM_FRAME_KEYS = ["epoch", "sequence", "state", "bands"] as const;

function invalid(): never {
  throw new SpectrumContractError();
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) return invalid();

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== SPECTRUM_FRAME_KEYS.length ||
    keys.some((key) =>
      typeof key !== "string" ||
      !SPECTRUM_FRAME_KEYS.includes(key as (typeof SPECTRUM_FRAME_KEYS)[number])
    )
  ) return invalid();

  return value as Record<string, unknown>;
}

function safeUnsignedInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}

export function isSpectrumState(value: unknown): value is SpectrumState {
  return typeof value === "string" &&
    (SPECTRUM_STATES as readonly string[]).includes(value);
}

function parseBands(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length !== SPECTRUM_BAND_COUNT) return invalid();

  // JSON arrays have only their length and the 24 indexed elements. Reject
  // custom enumerable/non-enumerable/symbol properties as part of exactness.
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== SPECTRUM_BAND_COUNT + 1 ||
    ownKeys.some((key) => {
      if (key === "length") return false;
      if (typeof key !== "string" || !/^\d+$/.test(key)) return true;
      const index = Number(key);
      return index >= SPECTRUM_BAND_COUNT || String(index) !== key;
    })
  ) return invalid();

  // Do not use Array#every here: it skips sparse array holes.
  const bands = new Array<number>(SPECTRUM_BAND_COUNT);
  for (let index = 0; index < SPECTRUM_BAND_COUNT; index += 1) {
    const band = value[index];
    if (typeof band !== "number" || !Number.isFinite(band) || band < 0 || band > 1) {
      return invalid();
    }
    bands[index] = band;
  }
  return bands;
}

/** Parse a wire frame and reject every shape outside the exact public contract. */
export function parseSpectrumFrame(value: unknown): SpectrumFrame {
  const record = exactRecord(value);
  const state = record.state;
  if (!isSpectrumState(state)) return invalid();

  return {
    epoch: safeUnsignedInteger(record.epoch),
    sequence: safeUnsignedInteger(record.sequence),
    state,
    bands: parseBands(record.bands),
  };
}
