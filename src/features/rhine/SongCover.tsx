import { useEffect, useState } from "react";
import { getCoverImage } from "../../backend/coverAdapter";
import { coverPlaceholder } from "./vendor/cover-placeholder";

export function SongCover({ cacheKey, title }: { cacheKey?: string; title: string }) {
  const placeholder = coverPlaceholder(title);
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    let alive = true;
    let url: string | undefined;
    setImage(null);
    if (cacheKey) void getCoverImage(cacheKey).then(payload => {
      if (!alive) return;
      const bytes = new Uint8Array(payload.bytes).buffer;
      url = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }));
      setImage({ key: cacheKey, url });
    }).catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [cacheKey]);
  return <span className="rhine-song-cover">{image && image.key === cacheKey
    ? <img src={image.url} alt={`${title}封面`} onError={() => setImage(null)} />
    : <span className="rhine-cover-placeholder" style={{ backgroundColor: placeholder.color }} role="img" aria-label={`${title}暂无封面`}><strong aria-hidden="true">{placeholder.code}</strong></span>}</span>;
}
