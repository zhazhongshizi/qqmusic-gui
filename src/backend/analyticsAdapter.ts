import { invokePlayback } from "./playbackTransport";

export interface Metrics { listenedMs: number; qualifiedPlays: number }
export interface Analytics {
  startDate: string; endDate: string; totalMs: number; qualifiedPlays: number; tracks: number;
  lifetimeMs: number; lifetimePlays: number; upgradedMs: number; retainedFromMs: number; storageAvailable: boolean;
  days: readonly (Metrics & { date: string })[];
  hours: readonly (Metrics & { hour: number })[];
  songs: readonly (Metrics & { id: string; title: string; artist: string })[];
  artists: readonly (Metrics & { artist: string; tracks: number })[];
  likes: (Metrics & { tracks: number }) | null;
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("统计数据无效");
  return v as Record<string, unknown>;
}
function number(v: unknown) { if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error("统计数值无效"); return v as number; }
function text(v: unknown, max = 512) { if (typeof v !== "string" || !v.trim() || v.length > max || /[\u0000-\u001f]/.test(v)) throw new Error("统计文本无效"); return v; }
function date(v: unknown) { const s = text(v, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)) || new Date(s).toISOString().slice(0,10) !== s) throw new Error("统计日期无效"); return s; }
function rows<T>(v: unknown, max: number, parse: (r: Record<string, unknown>) => T): T[] { if (!Array.isArray(v) || v.length > max) throw new Error("统计列表无效"); return v.map(r => parse(object(r))); }
function metrics(r: Record<string, unknown>): Metrics { return { listenedMs: number(r.listenedMs), qualifiedPlays: number(r.qualifiedPlays) }; }
export function parseAnalytics(value: unknown): Analytics {
  const r = object(value);
  if (typeof r.storageAvailable !== "boolean") throw new Error("统计状态无效");
  const startDate = date(r.startDate), endDate = date(r.endDate);
  if (startDate > endDate || Date.parse(endDate) - Date.parse(startDate) > 365 * 86400000) throw new Error("统计区间无效");
  return { startDate, endDate, totalMs: number(r.totalMs), qualifiedPlays: number(r.qualifiedPlays), tracks: number(r.tracks),
    lifetimeMs: number(r.lifetimeMs), lifetimePlays: number(r.lifetimePlays), upgradedMs: number(r.upgradedMs), retainedFromMs: number(r.retainedFromMs), storageAvailable: r.storageAvailable,
    days: rows(r.days,366,d => { const day = date(d.date); if (day < startDate || day > endDate) throw new Error("统计日期越界"); return { date: day, ...metrics(d) }; }),
    hours: rows(r.hours,24,d => { const hour = number(d.hour); if (hour > 23) throw new Error("统计小时无效"); return { hour, ...metrics(d) }; }),
    songs: rows(r.songs,30,d => ({ id: text(d.id,128), title: text(d.title), artist: text(d.artist), ...metrics(d) })),
    artists: rows(r.artists,30,d => ({ artist: text(d.artist), tracks: number(d.tracks), ...metrics(d) })),
    likes: r.likes === null ? null : (() => { const d=object(r.likes); return { ...metrics(d), tracks: number(d.tracks) }; })(),
  };
}
export async function getAnalytics(startDate: string, endDate: string): Promise<Analytics> {
  const result = parseAnalytics(await invokePlayback("personal_library", { request: { action: "listeningAnalytics", startDate, endDate } }));
  if (result.startDate !== startDate || result.endDate !== endDate) throw new Error("统计区间不匹配");
  return result;
}
