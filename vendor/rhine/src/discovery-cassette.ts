import * as THREE from "three";
import { CardAppearance } from "./appearance";

/** Reuse the loaded archive asset, including its optical assembly and fasteners.
 * Geometry belongs to ArchiveScene; only the cloned materials belong to the rack. */
export function cloneDiscoveryCassette(source: THREE.Group, appearance: CardAppearance, economical = false) {
  const group = new THREE.Group();
  group.name = "discovery-archive-cassette";
  for (const child of source.children) {
    if (!(child instanceof THREE.Mesh) || !child.userData.surface) continue;
    const mesh = new THREE.Mesh(child.geometry, child.material);
    mesh.userData.surface = child.userData.surface;
    mesh.castShadow = child.castShadow;
    mesh.receiveShadow = child.receiveShadow;
    mesh.position.copy(child.position);
    mesh.quaternion.copy(child.quaternion);
    mesh.scale.copy(child.scale);
    group.add(mesh);
  }
  appearance.prepare(group);
  appearance.apply(group, 1);
  appearance.setClarity(group, 0);
  if (economical) group.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    const material = child.material as THREE.MeshPhysicalMaterial;
    material.transmission = 0;
    material.clearcoat = 0;
  });
  return group;
}

export function disposeDiscoveryCassette(group: THREE.Group) {
  group.traverse(child => {
    if (child instanceof THREE.Mesh) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => material.dispose());
    }
  });
}
