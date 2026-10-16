export type DiscoveryEntry = { id: string; title: string; subtitle: string; kind: "song" | "playlist"; coverCacheKey?: string; duration?: string };
export type DiscoveryState = {
  open: boolean; ready: boolean; key: string; entries: readonly DiscoveryEntry[];
  selected: string | null; hovered: string | null; scroll: number; top: number;
  instant?: boolean; shortEntry?: boolean; reduced?: boolean;
};
export type DiscoveryRect = { id: string; x: number; y: number; width: number; height: number };
export type DiscoveryFrame = { phase: "flattening" | "waiting" | "moving" | "ready" | "closed"; progress: number; rects: DiscoveryRect[]; contentHeight: number };
export const discoveryEase = (n: number) => { const t = Math.max(0, Math.min(1, n)); return t * t * (3 - 2 * t); };
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
    if (state.shortEntry && state.open && this.time === 0) this.time = .3;
    const target = state.open ? state.ready || this.time > .3 ? 1.35 : .3 : 0;
    this.time = immediate ? target : advance(this.time, target, Math.min(dt, .05) * (state.shortEntry && state.open ? 3 : 1));
    if (state.ready && state.key !== this.key) {
      if (this.time <= .3 || immediate) { this.key = state.key; this.pendingKey = null; this.swap = 1; this.swapTarget = 1; }
      else { this.pendingKey = state.key; this.swapTarget = 0; }
    }
    this.swap = immediate ? this.swapTarget : advance(this.swap, this.swapTarget, Math.min(dt, .05) / .18);
    if (this.swap === 0 && this.pendingKey !== null) { this.key = this.pendingKey; this.pendingKey = null; this.swapTarget = 1; }
  }
  get flatten() { return discoveryEase(this.time / .3); }
  get spread() { return discoveryEase((this.time - .3) / .75); }
  get labels() { return discoveryEase((this.time - .65) / .7); }
  phase(state: DiscoveryState): DiscoveryFrame["phase"] {
    if (!state.open) return this.time === 0 ? "closed" : this.time < .3 ? "flattening" : "moving";
    if (this.time < .3) return "flattening";
    if (!state.ready && state.open) return "waiting";
    return this.time === 1.35 && this.swap === 1 && this.key === state.key && this.pendingKey === null ? "ready" : "moving";
  }
}

export function discoveryLayout(width: number, height: number, count: number, top: number) {
  const columns = Math.max(1, Math.min(count || 1, 4, Math.floor((width - 48) / 320)));
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
  c.fillStyle=selected?"#a75f27":"#3c3933";
  c.font='600 82px "Segoe UI", "Microsoft YaHei", sans-serif';
  let title=entry.title;
  if(c.measureText(title).width>1517) {
    const chars=[...title];while(chars.length&&c.measureText(chars.join("")+"…").width>1517)chars.pop();
    title=chars.join("")+"…";
  }
  c.fillText(title,28,83);
}
