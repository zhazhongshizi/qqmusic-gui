import type { ArtistRef } from "./artist";

export type CatalogQuality = "flac" | "320k" | "128k";

export interface CatalogQualityCandidate {
  readonly quality: CatalogQuality;
  readonly available: boolean;
  readonly requiresSubscription: boolean;
}

export interface CatalogAvailability {
  readonly status: "unknown" | "unavailable";
  readonly requiresSubscription: boolean;
}

export interface CatalogSong {
  readonly id: string;
  readonly mediaMid?: string;
  readonly coverCacheKey?: string;
  readonly title: string;
  readonly subtitle: string;
  readonly artists: readonly ArtistRef[];
  readonly artist: string;
  readonly album: string;
  readonly albumId?: string;
  readonly albumPublishDate?: string;
  readonly durationMs: number;
  readonly qualityCandidates: readonly CatalogQualityCandidate[];
  readonly availability: CatalogAvailability;
}

export interface CatalogSongPage {
  readonly generation: number;
  readonly page: number;
  readonly hasMore: boolean;
  readonly total?: number;
  readonly warningCount: number;
  readonly items: readonly CatalogSong[];
}
