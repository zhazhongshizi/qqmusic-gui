// Adapter replacing upstream static lore records with the current playlist page.
let count = 1;
export const archiveColumns = ["歌单"];
export function setArchiveCount(next: number) { count = Math.max(1, next); }
export function columnFiles(_lane: number) { return Array.from({ length: count }, (_, i) => i); }
export function fileLocation(index: number) { return { lane: 0, row: 12 + index, slot: 12 + index }; }
export function fileAtSlot(slot: number) { return ((slot % 32 - 12) % count + count) % count; }

let titles: readonly string[] = [];
export function setArchiveTitles(value: readonly string[]) { titles = value; }
export function archiveTitle(index: number) { return titles[index] ?? "音乐档案"; }
