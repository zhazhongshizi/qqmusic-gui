import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { hasPlaybackTransport } from "../../backend/playbackTransport";
import { discoverCatalogSongs, searchCatalogSongs } from "../../backend/catalogAdapter";
import { getLikedSongs } from "../../backend/libraryAdapter";
import type { LibrarySection } from "../../app/uiModes";
import type { CatalogSongPage } from "../../contracts/catalog";
import type { CatalogSearchType } from "../../contracts/catalogBrowse";

type LiveCatalogState =
  | { readonly state: "preview" | "idle" | "loading" | "error" }
  | { readonly state: "ready"; readonly page: CatalogSongPage };

/** Own catalog read generations and retire replies when the view/account changes. */
export function useLibraryCatalog({ section, query, searchType, discoveryTab, accountKey, authenticated, authRecovering, retry, page, onSelect }: {
  section: LibrarySection; query: string; searchType: CatalogSearchType; discoveryTab: string;
  accountKey: string; authenticated: boolean; authRecovering: boolean; retry: number; page: number;
  onSelect: Dispatch<SetStateAction<string>>;
}) {
  const [catalog, setCatalog] = useState<LiveCatalogState>(() => ({ state: hasPlaybackTransport() ? "idle" : "preview" }));
  const generationRef = useRef(0);
  useEffect(() => {
    if (!hasPlaybackTransport()) return;
    const normalized = query.trim();
    const liked = section === "liked";
    if ((liked && (authRecovering || !authenticated))
      || (!liked && section !== "discover" && section !== "search")
      || (!liked && !normalized && (section === "search" || discoveryTab !== "newSongs"))
      || (!liked && (section === "search" || normalized) && searchType !== "songs")) {
      setCatalog({ state: "idle" }); return;
    }
    const generation = ++generationRef.current;
    let active = true;
    const read = () => {
      setCatalog({ state: "loading" });
      const request = liked ? getLikedSongs(page, 20, generation)
        : normalized ? searchCatalogSongs(normalized, generation, page) : discoverCatalogSongs(generation);
      void request.then(result => {
        if (!active || generation !== generationRef.current || result.generation !== generation) return;
        setCatalog({ state: "ready", page: result });
        onSelect(current => !liked && result.items.some(song => song.id === current) ? current : result.items[0]?.id ?? "");
      }, () => { if (active && generation === generationRef.current) setCatalog({ state: "error" }); });
    };
    if (liked) read();
    const timer = liked ? undefined : window.setTimeout(read, normalized ? 300 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [accountKey, authenticated, authRecovering, retry, query, section, page, searchType, discoveryTab, onSelect]);
  return catalog;
}
