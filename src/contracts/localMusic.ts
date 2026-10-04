export const LOCAL_MUSIC_FORMATS = ["mp3", "flac", "ogg"] as const;
export type LocalMusicFormat = (typeof LOCAL_MUSIC_FORMATS)[number];

const LOCAL_MUSIC_ID = /^local_[a-f0-9]{64}_(mp3|flac|ogg)$/;

export function localMusicFormatFromId(value: string): LocalMusicFormat | null {
  const match = LOCAL_MUSIC_ID.exec(value);
  return match ? match[1] as LocalMusicFormat : null;
}

export interface LocalMusicTrack {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly durationMs: number;
  readonly format: LocalMusicFormat;
}

export type LocalMusicImportFailureCode =
  | "local_music_invalid_file"
  | "local_music_unsupported_format"
  | "local_music_file_too_large"
  | "local_music_metadata_unreadable"
  | "local_music_codec_unavailable"
  | "local_music_copy_failed"
  | "local_music_storage_conflict";

export interface LocalMusicImportFailure {
  readonly fileName: string;
  readonly code: LocalMusicImportFailureCode;
}

export interface LocalMusicImportResult {
  readonly imported: readonly LocalMusicTrack[];
  readonly existingCount: number;
  readonly failures: readonly LocalMusicImportFailure[];
}

export interface LocalMusicListResult {
  readonly tracks: readonly LocalMusicTrack[];
  readonly warningCount: number;
}

export interface LocalMusicDeleteResult {
  readonly deletedId: string;
  readonly session: import("./queue").PlaybackSessionSnapshot;
  readonly autoPlayStarted: boolean;
}
