import { coverPlaceholder } from "./cover-placeholder";

/** Front prints shared by the transport cassette and the recent-song array. */
export function drawCassetteCover(canvas: HTMLCanvasElement, cover: HTMLImageElement | null, title = "") {
  const context = canvas.getContext("2d")!;
  const size = canvas.width;
  context.fillStyle = "#d4c8b8";
  context.fillRect(0, 0, size, canvas.height);
  if (cover) {
    const side = Math.min(cover.naturalWidth, cover.naturalHeight);
    context.drawImage(cover, (cover.naturalWidth - side) / 2, (cover.naturalHeight - side) / 2,
      side, side, 0, 0, size, canvas.height);
  } else {
    const placeholder = coverPlaceholder(title);
    context.fillStyle = placeholder.color;
    context.fillRect(0, 0, size, canvas.height);
    context.strokeStyle = "#f1ede230";
    context.lineWidth = Math.max(1, size / 256);
    for (let ring = 1; ring <= 5; ring++) {
      context.beginPath();
      context.arc(size / 2, canvas.height / 2, size * ring / 11, 0, Math.PI * 2);
      context.stroke();
    }
    context.fillStyle = "#f1ede2";
    context.textAlign = "left";
    context.font = `bold ${size * .11}px sans-serif`;
    context.fillText("RHINE", size * .075, canvas.height * .16);
    context.font = `${size * .04}px sans-serif`;
    context.fillText("MUSIC ARCHIVE", size * .075, canvas.height * .235);
    context.font = `bold ${size * .3}px sans-serif`;
    context.fillText(placeholder.code, size * .075, canvas.height * .72);
    context.font = `${size * .045}px sans-serif`;
    context.fillText("NO COVER / 暂无封面", size * .075, canvas.height * .89);
  }
}

export function drawCassetteLabel(canvas: HTMLCanvasElement, title: string, artist: string) {
  const context = canvas.getContext("2d")!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.scale(canvas.width / 1024, canvas.height / 256);
  context.fillStyle = "#252321";
  context.textAlign = "left";
  context.font = "bold 118px sans-serif";
  context.fillText(title || "等待装载", 24, 124, 976);
  context.fillStyle = "#5c5650";
  context.font = "68px sans-serif";
  context.fillText(artist || "RHINE LAB", 24, 220, 976);
  context.restore();
}
