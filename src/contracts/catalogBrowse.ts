import type { ArtistDetail } from "./artist";

export type CatalogSearchType = "songs" | "artists" | "albums" | "playlists";
export interface CatalogAlbum {
  readonly id: string;
  readonly title: string;
  readonly publishDate: string;
  readonly description: string;
  readonly coverCacheKey?: string;
}
export interface CatalogPlaylist {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly songCount: number;
  readonly listenCount: number;
}
export type CatalogEntity =
  | (ArtistDetail & { readonly kind: "artist" })
  | (CatalogAlbum & { readonly kind: "album" })
  | (CatalogPlaylist & { readonly kind: "playlist" });
export interface CatalogEntityPage {
  readonly generation: number;
  readonly page: number;
  readonly hasMore: boolean;
  readonly total?: number;
  readonly warningCount: number;
  readonly items: readonly CatalogEntity[];
}
