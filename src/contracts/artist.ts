export interface ArtistRef {
  readonly id: string;
  readonly name: string;
}

export interface ArtistDetail extends ArtistRef {
  readonly avatarCacheKey?: string;
  readonly description?: string;
}
