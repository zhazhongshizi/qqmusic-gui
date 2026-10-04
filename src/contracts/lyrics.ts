export interface TimedLyricLine {
  readonly atMs: number;
  readonly original: string;
  readonly translation?: string;
  readonly romanization?: string;
}

export interface LyricTimeline {
  readonly generation: number;
  readonly trackId: string;
  readonly lines: readonly TimedLyricLine[];
}
