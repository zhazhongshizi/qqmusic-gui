import * as THREE from "three";
import { drawCassetteCover, drawCassetteLabel } from "./cassette-print";
import { wrap, type ArchiveCell } from "./archive-loop";
import { InstanceUpdates } from "./instance-updates";

export type ArchiveTrack = { id: string; title: string; artist: string; coverCacheKey?: string };

/** A bounded page atlas follows the exact transforms of the archive shells. */
export class ArchiveArtwork {
  readonly mesh: THREE.InstancedMesh;
  private canvas = document.createElement("canvas");
  private coverCanvas = document.createElement("canvas");
  private labelCanvas = document.createElement("canvas");
  private texture: THREE.CanvasTexture;
  private indices?: InstanceUpdates;
  private columns: number;
  private rows: number;
  private tileWidth: number;
  private tileHeight: number;
  private covers: (HTMLImageElement | null)[];

  constructor(readonly tracks: readonly ArchiveTrack[], maxTextureSize: number) {
    this.columns = Math.ceil(Math.sqrt(tracks.length));
    this.rows = Math.ceil(tracks.length / this.columns);
    this.tileWidth = Math.min(512, Math.floor(maxTextureSize / Math.max(this.columns, this.rows)));
    this.tileHeight = Math.floor(this.tileWidth * 3.76 / 5);
    this.canvas.width = this.columns * this.tileWidth;
    this.canvas.height = this.rows * this.tileHeight;
    this.coverCanvas.width = this.coverCanvas.height = 512;
    this.labelCanvas.width = 1024; this.labelCanvas.height = 256;
    this.covers = tracks.map(() => null);
    tracks.forEach((_, index) => this.draw(index));
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    const material = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false, transparent: true, depthWrite: false, alphaTest: .01 });
    material.onBeforeCompile = shader => {
      shader.vertexShader = "attribute float archiveArtworkIndex;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace("#include <uv_vertex>",
        `#include <uv_vertex>\nvMapUv = vec2((vMapUv.x + mod(archiveArtworkIndex, ${this.columns}.0)) / ${this.columns}.0, (vMapUv.y + ${this.rows - 1}.0 - floor(archiveArtworkIndex / ${this.columns}.0)) / ${this.rows}.0);`);
    };
    material.customProgramCacheKey = () => `archive-artwork-${this.columns}-${this.rows}`;
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(5, 3.76).translate(0, 1.88, .26), material, 1);
    this.mesh.name = "archive-song-fronts";
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  cover(index: number) { return this.covers[index] ?? null; }
  setCover(index: number, cover: HTMLImageElement) {
    if (!this.tracks[index]) return;
    this.covers[index] = cover;
    this.draw(index);
    this.texture.needsUpdate = true;
  }
  private draw(index: number) {
    const track = this.tracks[index];
    const context = this.canvas.getContext("2d")!;
    const x = index % this.columns * this.tileWidth, y = Math.floor(index / this.columns) * this.tileHeight;
    context.clearRect(x, y, this.tileWidth, this.tileHeight);
    drawCassetteCover(this.coverCanvas, this.covers[index], track.title);
    drawCassetteLabel(this.labelCanvas, track.title, track.artist);
    context.drawImage(this.coverCanvas, x + this.tileWidth * 1.05 / 5, y + this.tileHeight * .58 / 3.76,
      this.tileWidth * 2.9 / 5, this.tileHeight * 2.9 / 3.76);
    // Quiet repeated labels; the extracted cassette keeps its full contrast.
    context.globalAlpha = .48;
    context.drawImage(this.labelCanvas, x + this.tileWidth * 2.775 / 5, y + this.tileHeight * .16 / 3.76,
      this.tileWidth * 1.55 / 5, this.tileHeight * .385 / 3.76);
    context.globalAlpha = 1;
  }
  update(matrix: THREE.InstancedBufferAttribute, cells: readonly ArchiveCell[]) {
    this.mesh.instanceMatrix = matrix;
    if (!this.indices || this.indices.attribute.count < matrix.count) {
      this.indices = new InstanceUpdates(new THREE.InstancedBufferAttribute(new Float32Array(matrix.count), 1).setUsage(THREE.DynamicDrawUsage));
      this.mesh.geometry.setAttribute("archiveArtworkIndex", this.indices.attribute);
    }
    // The app repeats this page in every lane; avoid allocating a column list
    // for each visible cassette on every drag frame.
    cells.forEach((cell, index) => this.indices!.scalar(index, wrap(cell.row - 12, this.tracks.length)));
    this.indices.commit();
    this.mesh.count = cells.length;
  }
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.dispose(); this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose(); this.texture.dispose();
    this.covers = [];
  }
}
