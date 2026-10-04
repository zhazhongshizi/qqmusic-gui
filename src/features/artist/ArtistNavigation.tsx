import { createContext, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type { ArtistRef } from "../../contracts/artist";
const CatalogDetails = lazy(() => import("../catalog/CatalogDetails").then(module => ({ default: module.CatalogDetails })));

export const ArtistNavigationContext = createContext<((artist: ArtistRef) => void) | null>(null);

export function useArtistNavigation() {
  const [artist, setArtist] = useState<ArtistRef | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  function openArtist(next: ArtistRef) {
    if (!artist) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setArtist(next);
  }
  function closeArtist(restoreFocus = true) {
    if (!artist) return;
    setArtist(null);
    if (!restoreFocus) return;
    queueMicrotask(() => {
      const target = returnFocus.current;
      if (target?.isConnected && !target.closest("[hidden], [inert]")) target.focus();
    });
  }
  return { artist, openArtist, closeArtist };
}

export function ArtistNavigationContent({ artist, onBack, children, rhine = false }: {
  artist: ArtistRef | null; onBack: () => void; children: ReactNode; rhine?: boolean;
}) {
  const page = useRef<HTMLElement>(null);
  useEffect(() => { if (artist) queueMicrotask(() => page.current?.focus()); }, [artist]);
  return <>
    <div className="artist-navigation-content" hidden={artist !== null}>{children}</div>
    {artist && <section ref={page} tabIndex={-1} className={`artist-navigation-page${rhine ? " rhine-search rhine-search--detail" : ""}`} aria-label="歌手档案"
      onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); onBack(); } }}>
      <Suspense fallback={<p role="status">正在打开歌手详情…</p>}><CatalogDetails key={artist.id} entity={{ kind: "artist", ...artist }} onBack={onBack} /></Suspense>
    </section>}
  </>;
}
