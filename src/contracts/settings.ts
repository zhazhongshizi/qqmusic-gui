/** The quality values exposed by the playback/session contract. */
export type PlaybackQuality = "flac" | "320k" | "128k";

export interface SettingsSnapshot {
  readonly mvFallbackEnabled?: boolean;
  readonly preferredQuality: PlaybackQuality;
  readonly liveSpectrumEnabled: boolean;
}

export const PLAYBACK_QUALITY_OPTIONS: readonly {
  readonly value: PlaybackQuality;
  readonly label: string;
}[] = [
  { value: "flac", label: "无损优先" },
  { value: "320k", label: "高品质 320k" },
  { value: "128k", label: "标准 128k" },
];

export function isPlaybackQuality(value: unknown): value is PlaybackQuality {
  return value === "flac" || value === "320k" || value === "128k";
}
