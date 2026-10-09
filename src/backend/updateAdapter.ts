import { invokePlayback } from "./playbackTransport";
export interface AppRelease { version: string; name: string; notes: string; url: string; publishedAt: string | null }
export interface UpdateSnapshot {
  currentVersion: string; buildChannel: "Debug" | "Release"; automatic: boolean;
  state: "idle" | "checking" | "available" | "upToDate" | "unavailable" | "rateLimited" | "noRelease";
  release: AppRelease | null; checkedMs: number | null;
  applicationData: string; localMusic: string; smartShuffle: string; migrationBackups: string;
}
export type UpdateRequest = { action: "status" | "check" | "openRelease" | "openReleases" } | { action: "setAutomatic"; enabled: boolean };
function invalid(): never { throw new Error("update_invalid_response"); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const actual = Object.keys(value); if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 32768): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) return invalid(); return value;
}
function nullableTime(value: unknown): number | null { if (value === null) return null; if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid(); return value as number; }
export function parseUpdateSnapshot(value: unknown): UpdateSnapshot {
  const r = record(value, ["currentVersion", "buildChannel", "automatic", "state", "release", "checkedMs", "applicationData", "localMusic", "smartShuffle", "migrationBackups"]);
  if (r.buildChannel !== "Debug" && r.buildChannel !== "Release" || typeof r.automatic !== "boolean") return invalid();
  if (!["idle", "checking", "available", "upToDate", "unavailable", "rateLimited", "noRelease"].includes(r.state as string)) return invalid();
  let release: AppRelease | null = null;
  if (r.release !== null) {
    const v = record(r.release, ["version", "name", "notes", "url", "publishedAt"]);
    const url = text(v.url, 512);
    if (!/^https:\/\/github\.com\/zhazhongshizi\/qqmusic-gui\/releases\/tag\/v?\d+\.\d+\.\d+(?:\+[\w.%+-]+)?$/u.test(url)) return invalid();
    release = { version: text(v.version, 128), name: text(v.name, 512), notes: text(v.notes, 128 * 1024), url, publishedAt: v.publishedAt === null ? null : text(v.publishedAt, 64) };
  }
  if (r.state === "available" && !release) return invalid();
  return { currentVersion: text(r.currentVersion, 128), buildChannel: r.buildChannel, automatic: r.automatic,
    state: r.state as UpdateSnapshot["state"], release, checkedMs: nullableTime(r.checkedMs),
    applicationData: text(r.applicationData), localMusic: text(r.localMusic), smartShuffle: text(r.smartShuffle), migrationBackups: text(r.migrationBackups) };
}
export async function updatesControl(request: UpdateRequest): Promise<UpdateSnapshot> {
  const result = parseUpdateSnapshot(await invokePlayback("updates_control", { request }));
  if (request.action !== "status") window.dispatchEvent(new Event("updates-changed"));
  return result;
}
