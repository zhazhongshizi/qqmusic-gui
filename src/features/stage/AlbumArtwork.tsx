import { useEffect, useId, useState, type CSSProperties } from "react";

import { getCoverImage } from "../../backend/coverAdapter";

export type ArtworkVariant = "fern" | "moon" | "tide" | "train" | "mist";

export interface ArtworkTrack {
  id: string;
  title: string;
  artist: string;
  accent: string;
  artworkVariant: ArtworkVariant;
  coverCacheKey?: string;
}

interface AlbumArtworkProps {
  track: ArtworkTrack;
  compact?: boolean;
}

export function AlbumArtwork({ track, compact = false }: AlbumArtworkProps) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const artworkId = useId().replaceAll(":", "");
  const gradientId = `cover-wash-${artworkId}`;
  const grainId = `cover-grain-${artworkId}`;
  const variantOffset = {
    fern: 0,
    moon: 22,
    tide: 44,
    train: 66,
    mist: 88,
  }[track.artworkVariant];

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setCoverUrl(null);
    if (!track.coverCacheKey) {
      return () => { active = false; };
    }
    void getCoverImage(track.coverCacheKey).then(
      (payload) => {
        if (!active) return;
        try {
          const blobBytes = new ArrayBuffer(payload.bytes.byteLength);
          new Uint8Array(blobBytes).set(payload.bytes);
          objectUrl = URL.createObjectURL(new Blob([blobBytes], { type: payload.mimeType }));
          setCoverUrl(objectUrl);
        } catch {
          setCoverUrl(null);
        }
      },
      () => { if (active) setCoverUrl(null); },
    );
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [track.coverCacheKey]);

  return (
    <div
      className={compact ? "album-artwork album-artwork--compact" : "album-artwork"}
      style={{ "--album-accent": track.accent } as CSSProperties}
    >
      {coverUrl ? (
        <img
          alt={`${track.title}专辑封面`}
          className="album-artwork__image"
          onError={() => setCoverUrl(null)}
          src={coverUrl}
        />
      ) : (
        <svg aria-label={`${track.title}专辑封面`} role="img" viewBox="0 0 500 500">
          <defs>
            <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stopColor="#1a231c" />
              <stop offset="1" stopColor={track.accent} stopOpacity=".78" />
            </linearGradient>
            <filter id={grainId}>
              <feTurbulence baseFrequency=".75" numOctaves="2" seed={variantOffset + 7} type="fractalNoise" />
              <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 .09 0" />
            </filter>
          </defs>
          <rect fill={`url(#${gradientId})`} height="500" width="500" />
          <circle cx={146 + variantOffset} cy="148" fill="none" r="104" stroke="#e8e0cf" strokeOpacity=".22" strokeWidth="2" />
          <circle cx={146 + variantOffset} cy="148" fill="#e8e0cf" fillOpacity=".08" r="79" />
          <path
            d={`M${100 + variantOffset} 408 C${92 + variantOffset} 315, ${235 + variantOffset} 286, ${212 + variantOffset} 189 C${314 + variantOffset} 233, ${341 + variantOffset} 349, ${291 + variantOffset} 443`}
            fill="none"
            stroke="#e8e0cf"
            strokeOpacity=".7"
            strokeWidth="3"
          />
          <path
            d={`M${164 + variantOffset} 323 C${81 + variantOffset} 307, ${82 + variantOffset} 253, ${94 + variantOffset} 222 C${165 + variantOffset} 231, ${192 + variantOffset} 274, ${164 + variantOffset} 323Z`}
            fill="#b8c77a"
            fillOpacity=".48"
          />
          <path
            d={`M${217 + variantOffset} 277 C${243 + variantOffset} 203, ${306 + variantOffset} 215, ${331 + variantOffset} 230 C${303 + variantOffset} 294, ${258 + variantOffset} 310, ${217 + variantOffset} 277Z`}
            fill="#f1ebdd"
            fillOpacity=".18"
          />
          <rect fill="#fff" filter={`url(#${grainId})`} height="500" width="500" />
          {!compact ? (
            <>
              <text fill="#f1ebdd" fontFamily="Georgia, serif" fontSize="34" x="38" y="64">{track.title}</text>
              <text fill="#f1ebdd" fillOpacity=".68" fontFamily="sans-serif" fontSize="15" letterSpacing="4" x="40" y="91">GREENHOUSE SESSION</text>
              <text fill="#f1ebdd" fillOpacity=".8" fontFamily="sans-serif" fontSize="17" x="40" y="462">{track.artist}</text>
            </>
          ) : null}
        </svg>
      )}
    </div>
  );
}
