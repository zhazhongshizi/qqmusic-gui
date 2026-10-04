import * as THREE from "three";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArchiveArtwork } from "./vendor/archive-artwork";
import { setArchiveCount } from "./vendor/data";
const drawing = { clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(), save: vi.fn(), restore: vi.fn(), scale: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn() };
const tracks = Array.from({ length: 8 }, (_, index) => ({ id: `song-${index}`, title: `Song ${index}`, artist: "Artist" }));
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(drawing as never);
  setArchiveCount(8);
});
afterEach(() => vi.restoreAllMocks());
it("maps compacted and rebased cells to their song prints using the shell's shared matrix", () => {
  const artwork = new ArchiveArtwork(tracks, 2048);
  const matrix = new THREE.InstancedBufferAttribute(new Float32Array(16 * 4), 16);
  artwork.update(matrix, [{ lane: 2, row: 12 }, { lane: -3, row: 15 }, { lane: 8, row: 20 }]);
  expect(artwork.mesh.instanceMatrix).toBe(matrix);
  expect(artwork.mesh.count).toBe(3);
  expect(Array.from(artwork.mesh.geometry.getAttribute("archiveArtworkIndex").array).slice(0,3)).toEqual([0,3,0]);
  const larger = new THREE.InstancedBufferAttribute(new Float32Array(16 * 16), 16);
  artwork.update(larger, [{ lane: 2, row: 11 }, { lane: 2, row: 28 }]);
  expect(artwork.mesh.instanceMatrix).toBe(larger);
  expect(artwork.mesh.geometry.getAttribute("archiveArtworkIndex").count).toBe(16);
  expect(Array.from(artwork.mesh.geometry.getAttribute("archiveArtworkIndex").array).slice(0,2)).toEqual([7,0]);
  artwork.dispose();
});
it("keeps selected cover identity and disposes page resources without disposing the shared shell matrix", () => {
  const artwork = new ArchiveArtwork(tracks, 1024);
  const cover = { naturalWidth: 640, naturalHeight: 320 } as HTMLImageElement;
  artwork.setCover(4, cover);
  expect(artwork.cover(4)).toBe(cover); expect(artwork.cover(3)).toBeNull();
  const atlas = (artwork.mesh.material as THREE.MeshBasicMaterial).map as THREE.CanvasTexture;
  const image = atlas.image as HTMLCanvasElement;
  expect(image.width).toBeLessThanOrEqual(1024);
  expect(image.height).toBeLessThanOrEqual(1024);
  const dispose = vi.spyOn(atlas, "dispose");
  artwork.dispose(); expect(dispose).toHaveBeenCalledOnce();
});
