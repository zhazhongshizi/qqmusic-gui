import type { Track } from "./fixtures";
import type { QueueSnapshot } from "../../contracts/queue";
import type { PlaybackQuality } from "../../contracts/settings";
import type { PlaybackLoadResult } from "../../backend/nativePlayerAdapter";
import { localMusicFormatFromId } from "../../contracts/localMusic";

const ARTWORK_VARIANTS: readonly Track["artworkVariant"][] = ["fern", "moon", "tide", "train", "mist"];
const ACCENTS = ["#789575", "#9f9878", "#61858b", "#8c765e", "#72847c"] as const;
const DEFAULT_ARTWORK_VARIANT: Track["artworkVariant"] = "fern";
const DEFAULT_ACCENT = "#789575";

export function nativeTrack(track: QueueSnapshot["items"][number], previous?: Track): Track {
  if (
    previous?.id === track.id &&
    previous.title === track.title &&
    previous.artist === track.artist &&
    previous.album === track.album &&
    previous.durationMs === track.durationMs &&
    previous.coverCacheKey === track.coverCacheKey
  ) {
    return previous;
  }

  const seed = [...track.id].reduce((value, character) => value + character.codePointAt(0)!, 0);
  const variant = seed % ARTWORK_VARIANTS.length;
  const localFormat = localMusicFormatFromId(track.id);
  const next: Track = previous?.id === track.id
    ? {
        ...previous,
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: track.durationMs,
      }
    : {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: track.durationMs,
        actualQuality: localFormat === "ogg"
          ? "OGG"
          : localFormat === "mp3"
            ? "MP3"
            : localFormat === "flac"
              ? "FLAC"
              : "未知音质",
        expectedQuality: "无损",
        accent: ACCENTS[variant] ?? DEFAULT_ACCENT,
        artworkVariant: ARTWORK_VARIANTS[variant] ?? DEFAULT_ARTWORK_VARIANT,
        lyrics: [],
      };

  if (track.coverCacheKey === undefined) delete next.coverCacheKey;
  else next.coverCacheKey = track.coverCacheKey;
  return next;
}

export function actualQuality(value: PlaybackLoadResult["quality"], trackId?: string): Track["actualQuality"] {
  if (value === "qq-mv") return "QQ MV 音轨";
  if (value === "local") {
    const format = trackId ? localMusicFormatFromId(trackId) : null;
    if (format === "ogg") return "OGG";
    if (format === "mp3") return "MP3";
    return "FLAC";
  }
  if (value === "flac") return "FLAC";
  if (value === "320k") return "MP3 320k";
  return "MP3 128k";
}

export function expectedQuality(value: PlaybackQuality): Track["expectedQuality"] {
  if (value === "flac") return "无损";
  if (value === "320k") return "高品质";
  return "标准";
}

export function qualityFromExpected(value: Track["expectedQuality"]): PlaybackQuality {
  if (value === "无损") return "flac";
  if (value === "标准") return "128k";
  return "320k";
}
