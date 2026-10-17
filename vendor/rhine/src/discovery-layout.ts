export type DiscoveryEntry = { id: string; title: string; subtitle: string; kind: "song" | "playlist" | "blank"; coverCacheKey?: string; duration?: string };
export const DISCOVERY_PAGE_SIZE = 9;
export function discoverySlots(entries: readonly DiscoveryEntry[]): DiscoveryEntry[] {
  return Array.from({ length: DISCOVERY_PAGE_SIZE }, (_, index) => entries[index] ?? {
    id: `blank:${index}`, kind: "blank", title: "", subtitle: "",
  });
}
export type DiscoveryState = {
  open: boolean; ready: boolean; key: string; entries: readonly DiscoveryEntry[];
  selected: string | null; hovered: string | null; scroll: number; top: number;
  instant?: boolean; shortEntry?: boolean; reduced?: boolean;
};
export type DiscoveryRect = { id: string; x: number; y: number; width: number; height: number };
export type DiscoveryFrame = { phase: "flattening" | "waiting" | "moving" | "ready" | "closed"; progress: number; rects: DiscoveryRect[]; contentHeight: number };
export const discoveryEase = (n: number) => { const t = Math.max(0, Math.min(1, n)); return t * t * (3 - 2 * t); };
export const smootherstep = (n: number) => { const t = Math.max(0, Math.min(1, n)); return t * t * t * (t * (t * 6 - 15) + 10); };
export const DISCOVERY_DURATION = 1.5;
export const DISCOVERY_WAIT = .30;
/** Spatial delays are shared by both renderers and stay still at the data-wait anchor. */
export function discoveryRetreat(progress: number, normDistance: number) {
  const distance = Math.max(0, Math.min(1, normDistance));
  // The first local sink starts only when flattening has finished. Later
  // neighbours follow as a wave, while retained tapes stay put until .42s.
  const delay = (DISCOVERY_WAIT - .24) / .64 + .26 * distance;
  return discoveryEase((progress - delay) / (1 - delay));
}
export const discoverySinkScale = (progress: number) => 1 - smootherstep((progress - .45) / .55);
export const DISCOVERY_SINK_DEPTH = 36;
const advance = (n: number, target: number, amount: number) => n + Math.sign(target - n) * Math.min(Math.abs(target - n), amount);

/** Wall time is supplied by the existing scene loop; no independent RAF. */
export class DiscoveryMotion {
  time = 0;
  swap = 1;
  private swapTarget = 1;
  private pendingKey: string | null = null;
  key = "";
  step(dt: number, state: DiscoveryState) {
    const immediate = state.reduced || state.instant;
    const previousTime = this.time;
    if (state.shortEntry && state.open && this.time === 0) this.time = DISCOVERY_WAIT;
    const target = state.open ? state.ready || this.time > DISCOVERY_WAIT ? DISCOVERY_DURATION : DISCOVERY_WAIT : 0;
    this.time = immediate ? target : advance(this.time, target, Math.min(dt, .05) * (state.shortEntry && state.open ? 3 : 1));
    if (state.ready && state.key !== this.key) {
      if (previousTime <= DISCOVERY_WAIT || immediate) { this.key = state.key; this.pendingKey = null; this.swap = 1; this.swapTarget = 1; }
      else { this.pendingKey = state.key; this.swapTarget = 0; }
    }
    if (state.ready && state.key === this.key && this.pendingKey !== null) { this.pendingKey = null; this.swapTarget = 1; }
    this.swap = immediate ? this.swapTarget : advance(this.swap, this.swapTarget, Math.min(dt, .05) / .18);
    if (this.swap === 0 && this.pendingKey !== null) { this.key = this.pendingKey; this.pendingKey = null; this.swapTarget = 1; }
  }
  get flatten() { return smootherstep(this.time / DISCOVERY_WAIT); }
  get retreat() { return Math.max(0, Math.min(1, (this.time - .24) / .64)); }
  get spread() { return smootherstep((this.time - .42) / .86); }
  get labels() { return smootherstep((this.time - .85) / .60); }
  get camera() { return smootherstep((this.time - .28) / 1.02); }
  get boards() { return smootherstep((this.time - .65) / .60); }
  get handoff() { return this.flatten === 1 && this.retreat > 0; }
  tapeSpread(index: number, count: number) {
    const delay = count > 1 ? .09 * index / (count - 1) : 0;
    return smootherstep((this.time - .42 - delay) / (.86 - delay));
  }
  phase(state: DiscoveryState): DiscoveryFrame["phase"] {
    if (!state.open) return this.time === 0 ? "closed" : this.time < DISCOVERY_WAIT ? "flattening" : "moving";
    if (this.time < DISCOVERY_WAIT) return "flattening";
    if (!state.ready && (this.time === DISCOVERY_WAIT || this.time === DISCOVERY_DURATION)) return "waiting";
    return this.time === DISCOVERY_DURATION && this.swap === 1 && this.key === state.key && this.pendingKey === null ? "ready" : "moving";
  }
}

export function discoveryLayout(width: number, height: number, count: number, top: number) {
  const columns = Math.max(1, Math.min(count || 1, 3, Math.floor((width - 48) / 320)));
  const tapeWidth = Math.min(318, (width - 48 - (columns - 1) * 34) / columns);
  const tapeHeight = tapeWidth * .46;
    // Expose the real top edge and a portion of the front cover behind the next tape.
  const rowStep = tapeWidth * .27;
  const rows = Math.ceil(count / columns);
  return { columns, tapeWidth, tapeHeight, rowStep, rows, contentHeight: Math.max(height - top - 48, rows ? (rows - 1) * rowStep + tapeHeight + 60 : 0),
    cell(index: number) {
      const column = index % columns;
      const columnCount = Math.floor((count - 1 - column) / columns) + 1;
      const row = rows - columnCount + Math.floor(index / columns);
      const rowWidth = columns * tapeWidth + (columns - 1) * 34;
      return { x: (width - rowWidth) / 2 + column * (tapeWidth + 34), y: top + 22 + row * rowStep, row };
    },
  };
}

/** Transparent information print; the archive asset supplies all shell/optical geometry. */
export function drawDiscoveryFace(canvas: HTMLCanvasElement, entry: DiscoveryEntry, cover?: HTMLImageElement, selected = false) {
  canvas.width = 1000; canvas.height = 740;
  const c = canvas.getContext("2d")!;
  c.clearRect(0, 0, 1000, 740);
  if (entry.kind === "blank") return;
  function lines(text: string, x: number, y: number, maxWidth: number, maxLines: number, lineHeight: number) {
    const chars = [...text]; let offset = 0;
    for (let line = 0; line < maxLines && offset < chars.length; line++) {
      let value = "";
      while (offset < chars.length && c.measureText(value + chars[offset] + "…").width <= maxWidth) value += chars[offset++];
      if (line === maxLines-1 && offset < chars.length) value += "…";
      c.fillText(value, x, y + line*lineHeight);
    }
  }
  c.fillStyle = "#f2eee5"; c.fillRect(76, 256, 338, 338);
  c.fillStyle = "#d7d2c7"; c.fillRect(90, 270, 310, 310);
  if (cover) {
    const size = Math.min(cover.naturalWidth, cover.naturalHeight);
    c.drawImage(cover, (cover.naturalWidth-size)/2, (cover.naturalHeight-size)/2, size, size, 90, 270, 310, 310);
  } else { c.fillStyle = "#bcb5a6"; c.font = "80px serif"; c.fillText("♪", 207, 462); }
  c.fillStyle = "#292a26"; c.font = '600 51px "Segoe UI", "Microsoft YaHei", sans-serif'; lines(entry.title, 445, 335, 468, 3, 59);
  c.fillStyle = "#6b6a60"; c.font = '36px "Segoe UI", "Microsoft YaHei", sans-serif'; lines(entry.subtitle, 445, 531, 468, 2, 43);
  c.fillStyle = "#777166"; c.font = "22px monospace"; c.textAlign = "right"; c.fillText(entry.duration || "QQ MUSIC", 920, 697);
}

/** One readable title on the original model's narrow horizontal top surface. */
export function drawDiscoveryTop(canvas: HTMLCanvasElement, entry: DiscoveryEntry, selected = false) {
  canvas.width=1573;canvas.height=100;
  const c=canvas.getContext("2d")!;
  c.clearRect(0,0,canvas.width,canvas.height);
  if (entry.kind === "blank") return;
  c.fillStyle=selected?"#a75f27":"#3c3933";
  c.font='600 82px "Segoe UI", "Microsoft YaHei", sans-serif';
  let title=entry.title;
  if(c.measureText(title).width>1517) {
    const chars=[...title];while(chars.length&&c.measureText(chars.join("")+"…").width>1517)chars.pop();
    title=chars.join("")+"…";
  }
  c.fillText(title,28,83);
}
