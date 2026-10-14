import { hasPlaybackTransport, invokePlayback } from "./playbackTransport";
import { CatalogAdapterError, parseCatalogSongPage } from "./catalogAdapter";
import { parseCatalogEntityPage } from "./catalogBrowseAdapter";

export type RecommendationKind = "guess" | "radar" | "playlists";
export interface CatalogSuggestions {
  readonly generation: number;
  readonly keyword: string;
  readonly items: readonly string[];
  readonly warningCount: number;
}

function invalid(): never { throw new CatalogAdapterError("QMG-CATALOG-002"); }
function generationValue(generation: number) {
  if (!Number.isSafeInteger(generation) || generation < 0) return invalid();
  return generation;
}
function keywordValue(keyword: unknown): string {
  if (typeof keyword !== "string") return invalid();
  const value = keyword.trim();
  if (!value || [...value].length > 100 || /[\r\n\0]/.test(value)) return invalid();
  return value;
}
function pageValue(page: number) {
  if (!Number.isInteger(page) || page < 1 || page > 100) return invalid();
  return page;
}
async function invoke(command: string, params: Record<string, unknown>) {
  if (!hasPlaybackTransport()) throw new CatalogAdapterError("QMG-CATALOG-001");
  try { return await invokePlayback(command, params); }
  catch (error) {
    if (error instanceof CatalogAdapterError) throw error;
    throw new CatalogAdapterError("QMG-CATALOG-001");
  }
}
export function parseCatalogSuggestions(value: unknown): CatalogSuggestions {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const record = value as Record<string, unknown>;
  const keys = ["generation", "keyword", "items", "warningCount"];
  if (Object.keys(record).length !== keys.length ||
      Object.keys(record).some(key => !keys.includes(key)) ||
      !Array.isArray(record.items) || record.items.length > 20) return invalid();
  const warningCount = generationValue(record.warningCount as number);
  if (warningCount > 128) return invalid();
  return {
    generation: generationValue(record.generation as number),
    keyword: keywordValue(record.keyword),
    items: record.items.map(keywordValue), warningCount,
  };
}
export async function getSearchSuggestions(keyword: string, generation: number) {
  const normalized = keywordValue(keyword);
  const result = parseCatalogSuggestions(await invoke("catalog_search_suggestions", {
    keyword: normalized, generation: generationValue(generation),
  }));
  if (result.keyword !== normalized || result.generation !== generation) return invalid();
  return result;
}
export function getRecommendedSongs(kind: "guess" | "radar", generation: number, page = 1) {
  if (!["guess", "radar"].includes(kind) || (kind === "guess" && page !== 1)) return invalid();
  return invoke("catalog_recommend_songs", {
    kind, generation: generationValue(generation), page: pageValue(page),
  }).then(parseCatalogSongPage);
}
export function getRecommendedPlaylists(generation: number, page = 1, pageSize = 20) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) return invalid();
  return invoke("catalog_recommend_playlists", {
    generation: generationValue(generation), page: pageValue(page), pageSize,
  }).then(parseCatalogEntityPage);
}
