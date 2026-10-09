import { invokePlayback } from "./playbackTransport";

export type ImportMode = "reference" | "copy";
export type CatalogRequest = { action: "status" | "cancel" }
  | { action: "add"; mode: ImportMode }
  | { action: "scan" | "remove" | "relocate"; id: string };
export interface MusicDirectory {
  id: string; path: string; mode: ImportMode; available: boolean;
  trackCount: number; missingCount: number; lastScanMs: number | null;
}
export interface CatalogStatus {
  directories: MusicDirectory[];
  scan: { running: boolean; cancelled: boolean; directoryId: string; processed: number;
    added: number; existing: number; errors: number; failures: { fileName: string; code: string }[] };
}
function invalid(): never { throw new Error("local_catalog_invalid_response"); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 32768): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f]/u.test(value)) return invalid();
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}
function bool(value: unknown): boolean { if (typeof value !== "boolean") return invalid(); return value; }
export function parseCatalogStatus(value: unknown): CatalogStatus {
  const r = record(value, ["directories", "scan"]);
  if (!Array.isArray(r.directories)) return invalid();
  const directories = r.directories.map((item): MusicDirectory => {
    const d = record(item, ["id", "path", "mode", "available", "trackCount", "missingCount", "lastScanMs"]);
    if (d.mode !== "reference" && d.mode !== "copy") return invalid();
    return { id: text(d.id, 36), path: text(d.path), mode: d.mode, available: bool(d.available),
      trackCount: count(d.trackCount), missingCount: count(d.missingCount), lastScanMs: d.lastScanMs === null ? null : count(d.lastScanMs) };
  });
  if (new Set(directories.map(d => d.id)).size !== directories.length) return invalid();
  const s = record(r.scan, ["running", "cancelled", "directoryId", "processed", "added", "existing", "errors", "failures"]);
  if (!Array.isArray(s.failures) || s.failures.length > 101) return invalid();
  return { directories, scan: { running: bool(s.running), cancelled: bool(s.cancelled), directoryId: text(s.directoryId, 36),
    processed: count(s.processed), added: count(s.added), existing: count(s.existing), errors: count(s.errors),
    failures: s.failures.map(item => { const f = record(item, ["fileName", "code"]); return { fileName: text(f.fileName, 512), code: text(f.code, 80) }; }) } };
}
export async function localCatalog(request: CatalogRequest): Promise<CatalogStatus> {
  return parseCatalogStatus(await invokePlayback("local_music_catalog", { request }));
}
