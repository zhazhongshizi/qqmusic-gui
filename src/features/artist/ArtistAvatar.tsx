import { useEffect, useId, useState } from "react";

import { getArtistImage } from "../../backend/coverAdapter";
import type { ArtistDetail, ArtistRef } from "../../contracts/artist";

export interface ArtistAvatarProps {
  readonly artist: ArtistRef | ArtistDetail;
  readonly size?: "hero" | "compact";
}

function placeholderCharacter(name: string): string {
  return Array.from(name.trim())[0] ?? "?";
}

export function ArtistAvatar({ artist, size = "hero" }: ArtistAvatarProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const gradientId = `artist-avatar-${useId().replaceAll(":", "")}`;
  const avatarCacheKey = "avatarCacheKey" in artist ? artist.avatarCacheKey : undefined;

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setImageUrl(null);
    setFailed(false);

    if (!avatarCacheKey) return () => { active = false; };

    void getArtistImage(avatarCacheKey).then(
      (payload) => {
        if (!active) return;
        try {
          const bytes = new Uint8Array(payload.bytes.byteLength);
          bytes.set(payload.bytes);
          if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
            setFailed(true);
            return;
          }
          objectUrl = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }));
          setImageUrl(objectUrl);
        } catch {
          setFailed(true);
        }
      },
      () => { if (active) setFailed(true); },
    );

    return () => {
      active = false;
      if (objectUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [avatarCacheKey]);

  const className = size === "compact" ? "artist-avatar artist-avatar--compact" : "artist-avatar";
  return (
    <div aria-label={`${artist.name}头像`} className={className} role="img">
      {imageUrl && !failed ? (
        <img
          alt=""
          className="artist-avatar__image"
          onError={() => { setFailed(true); setImageUrl(null); }}
          src={imageUrl}
        />
      ) : (
        <svg aria-hidden="true" className="artist-avatar__placeholder" viewBox="0 0 100 100">
          <defs>
            <radialGradient id={gradientId} cx="35%" cy="30%" r="85%">
              <stop offset="0" stopColor="var(--lichen)" stopOpacity=".72" />
              <stop offset="1" stopColor="var(--canopy)" />
            </radialGradient>
          </defs>
          <circle cx="50" cy="50" fill={`url(#${gradientId})`} r="48" />
          <circle cx="50" cy="50" fill="none" r="38" stroke="var(--paper)" strokeOpacity=".2" />
          <text dominantBaseline="middle" fill="var(--paper)" fontFamily="var(--font-display)" fontSize="38" textAnchor="middle" x="50" y="53">
            {placeholderCharacter(artist.name)}
          </text>
        </svg>
      )}
    </div>
  );
}
