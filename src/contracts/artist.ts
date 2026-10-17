export interface ArtistRef {
  /** QQ uses "0" for a named song credit without a navigable artist profile. */
  readonly id: string;
  readonly name: string;
}

export interface ArtistDetail extends ArtistRef {
  readonly avatarCacheKey?: string;
  readonly description?: string;
}
