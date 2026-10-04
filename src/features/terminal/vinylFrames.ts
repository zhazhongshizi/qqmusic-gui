export type VinylPixel =
  | "transparent"
  | "deep"
  | "groove-dark"
  | "groove-mid"
  | "groove-light"
  | "glint-low"
  | "glint-mid"
  | "glint-high"
  | "label"
  | "label-detail"
  | "hole";

export type NeedleState = "engaged" | "resting" | "parked";

export type NeedlePixel =
  | "transparent"
  | "needle-metal"
  | "needle-shadow"
  | "cartridge"
  | "stylus";

export interface VinylCell {
  readonly material: VinylPixel;
  readonly color: string;
}

export const VINYL_WIDTH = 62;
export const VINYL_HEIGHT = 18;
export const VINYL_CENTER_X = 31;
export const VINYL_CENTER_Y = 9;
export const VINYL_HORIZONTAL_DISTANCE_SCALE = 0.4;
export const VINYL_RADIUS_SCALE = 0.92;
export const VINYL_LABEL_RADIUS_RATIO = 0.32;
export const VINYL_HOLE_RADIUS_RATIO = 0.055;
export const VINYL_RADIUS = Math.min(
  (VINYL_WIDTH / 2) * VINYL_HORIZONTAL_DISTANCE_SCALE,
  VINYL_HEIGHT / 2,
) * VINYL_RADIUS_SCALE;
export const VINYL_LABEL_RADIUS = VINYL_RADIUS * VINYL_LABEL_RADIUS_RATIO;
export const VINYL_HOLE_RADIUS = VINYL_RADIUS * VINYL_HOLE_RADIUS_RATIO;
export const VINYL_TICK_MS = 50;
export const VINYL_ANGLE_INCREMENT = 0.05;

export const VINYL_GROOVE_BRIGHTNESS = Object.freeze([14, 21, 28, 35] as const);

type GridPoint = readonly [column: number, row: number];
type NeedleMark = readonly [row: number, column: number, pixel: Exclude<NeedlePixel, "transparent">];
type CellGeometry = Readonly<{
  distance: number;
  normalizedRadius: number;
  theta: number;
}>;

const TAU = Math.PI * 2;
const OUTER_RADIUS = VINYL_RADIUS * 1.1;
const NEEDLE_PIVOT: GridPoint = [56, 1];
const TRANSPARENT_CELL: VinylCell = Object.freeze({ material: "transparent", color: "transparent" });

function clampChannel(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgb(red: number, green: number, blue: number) {
  return `rgb(${clampChannel(red)}, ${clampChannel(green)}, ${clampChannel(blue)})`;
}

function cell(material: VinylPixel, red: number, green: number, blue: number): VinylCell {
  return { material, color: rgb(red, green, blue) };
}

function normalizeAngle(angle: number) {
  if (!Number.isFinite(angle)) return 0;
  const normalized = angle % TAU;
  return normalized < 0 ? normalized + TAU : normalized;
}

function positiveCosinePower(value: number, power: number) {
  return Math.max(0, value) ** power;
}

const VINYL_GEOMETRY: readonly CellGeometry[] = Object.freeze(Array.from(
  { length: VINYL_WIDTH * VINYL_HEIGHT },
  (_, index) => {
    const column = index % VINYL_WIDTH;
    const row = Math.floor(index / VINYL_WIDTH);
    const dx = (column - VINYL_CENTER_X) * VINYL_HORIZONTAL_DISTANCE_SCALE;
    const dy = row - VINYL_CENTER_Y;
    const distance = Math.hypot(dx, dy);
    return Object.freeze({
      distance,
      normalizedRadius: distance / VINYL_RADIUS,
      theta: Math.atan2(dy, dx),
    });
  },
));

function renderOuterEdge(distance: number, angle: number) {
  const fade = 1 - (distance - VINYL_RADIUS) / (VINYL_RADIUS * 0.1);
  const pulse = 1 + Math.sin(angle * 0.23) * 0.1;
  const brightness = clampChannel(fade * 30 * pulse);
  return cell("groove-dark", brightness * 0.55, brightness * 0.4, brightness);
}

function renderLabel(distance: number, theta: number, angle: number) {
  const ring = Math.min(6, Math.floor((distance / VINYL_LABEL_RADIUS) * 7));
  const detail = ring % 2 === 1;
  const base: readonly [number, number, number] = detail
    ? [111, 149, 79]
    : [155, 198, 108];
  const highlight = positiveCosinePower(Math.cos(theta * 1.8 - angle * 0.38 - 0.9), 11) * 28;
  const shimmer = Math.sin(theta * 8 - angle * 0.5) * 0.04;
  return cell(
    detail ? "label-detail" : "label",
    base[0] * (1 + shimmer) + highlight,
    base[1] + highlight,
    base[2] + highlight * 0.55,
  );
}

function renderVinylMaterial(normalizedRadius: number, theta: number, angle: number) {
  const grooveIndex = Math.floor(normalizedRadius * 36) % VINYL_GROOVE_BRIGHTNESS.length;
  const base = VINYL_GROOVE_BRIGHTNESS[grooveIndex] ?? VINYL_GROOVE_BRIGHTNESS[0];
  const lightingAngle = angle - Math.PI / 2;
  const primary = positiveCosinePower(Math.cos(theta - lightingAngle), 6) * 72;
  const secondary = positiveCosinePower(Math.cos(theta - lightingAngle + Math.PI), 9) * 45;
  const redRipple = Math.sin(normalizedRadius * 24 - lightingAngle * 1.3) * 6;
  const blueRipple = Math.cos(normalizedRadius * 19 + lightingAngle * 0.85) * 10;
  const highlight = primary + secondary;
  const material: VinylPixel = highlight >= 48
    ? "glint-high"
    : highlight >= 18
      ? "glint-mid"
      : highlight >= 5
        ? "glint-low"
        : (["deep", "groove-dark", "groove-mid", "groove-light"] as const)[grooveIndex] ?? "deep";
  return cell(material, base + highlight + redRipple, base + highlight, base + highlight + blueRipple);
}

/** Render one complete 62x18 true-color vinyl raster at any rotation angle. */
export function renderVinylFrame(angle = 0): readonly VinylCell[] {
  const normalizedAngle = normalizeAngle(angle);
  return Object.freeze(VINYL_GEOMETRY.map(({ distance, normalizedRadius, theta }) => {
    if (distance > OUTER_RADIUS) return TRANSPARENT_CELL;
    if (distance > VINYL_RADIUS) return renderOuterEdge(distance, normalizedAngle);
    if (distance <= VINYL_HOLE_RADIUS) return cell("hole", 2, 3, 2);
    if (distance <= VINYL_LABEL_RADIUS) return renderLabel(distance, theta, normalizedAngle);
    return renderVinylMaterial(normalizedRadius, theta, normalizedAngle);
  }));
}

/** Advance by one 50ms terminal tick without allowing an unbounded angle value. */
export function advanceVinylAngle(angle: number) {
  return normalizeAngle((Number.isFinite(angle) ? angle : 0) + VINYL_ANGLE_INCREMENT);
}

export const VINYL_BASE_FRAME = renderVinylFrame(0);

function indexOf(row: number, column: number) {
  return row * VINYL_WIDTH + column;
}

function isInsideGrid(row: number, column: number) {
  return row >= 0 && row < VINYL_HEIGHT && column >= 0 && column < VINYL_WIDTH;
}

function rasterizeSegment(start: GridPoint, end: GridPoint) {
  const points: GridPoint[] = [];
  let x0 = start[0];
  let y0 = start[1];
  const [x1, y1] = end;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;

  while (true) {
    points.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const doubledError = 2 * error;
    if (doubledError >= dy) {
      error += dy;
      x0 += sx;
    }
    if (doubledError <= dx) {
      error += dx;
      y0 += sy;
    }
  }
  return points;
}

function createNeedleFrame(marks: readonly NeedleMark[]): readonly NeedlePixel[] {
  const cells: NeedlePixel[] = Array.from(
    { length: VINYL_WIDTH * VINYL_HEIGHT },
    () => "transparent",
  );
  for (const [row, column, pixel] of marks) {
    if (isInsideGrid(row, column)) cells[indexOf(row, column)] = pixel;
  }
  return Object.freeze(cells);
}

function paintSegment(marks: NeedleMark[], start: GridPoint, end: GridPoint) {
  for (const [column, row] of rasterizeSegment(start, end)) {
    marks.push([row, column, "needle-metal"]);
    if (isInsideGrid(row + 1, column)) marks.push([row + 1, column, "needle-shadow"]);
  }
}

const NEEDLE_STATE_TARGETS: Readonly<Record<NeedleState, GridPoint>> = Object.freeze({
  engaged: [47, 4],
  resting: [51, 3],
  parked: [55, 2],
});

/** Rasterize the warm-copper arm, cartridge and stylus for a needle state. */
export function renderNeedleFrame(state: NeedleState): readonly NeedlePixel[] {
  const target = NEEDLE_STATE_TARGETS[state] ?? NEEDLE_STATE_TARGETS.parked;
  const marks: NeedleMark[] = [];
  paintSegment(marks, NEEDLE_PIVOT, target);

  const [column, row] = target;
  marks.push(
    [row, column, "cartridge"],
    [row, column - 1, "cartridge"],
    [row + 1, column, "cartridge"],
    [row + 1, column - 1, "stylus"],
  );

  const [pivotColumn, pivotRow] = NEEDLE_PIVOT;
  marks.push(
    [pivotRow, pivotColumn, "needle-metal"],
    [pivotRow, pivotColumn - 1, "needle-shadow"],
    [pivotRow + 1, pivotColumn, "needle-metal"],
    [pivotRow + 1, pivotColumn - 1, "needle-shadow"],
  );
  return createNeedleFrame(marks);
}

export const NEEDLE_FRAMES: Readonly<Record<NeedleState, readonly NeedlePixel[]>> = Object.freeze({
  engaged: renderNeedleFrame("engaged"),
  resting: renderNeedleFrame("resting"),
  parked: renderNeedleFrame("parked"),
});
