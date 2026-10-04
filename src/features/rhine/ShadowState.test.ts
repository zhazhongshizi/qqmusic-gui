import * as THREE from "three";
import { expect, it } from "vitest";
import { ShadowState } from "./vendor/shadow-state";

function fixture() {
  const scene = new THREE.Scene();
  const light = new THREE.DirectionalLight(); light.castShadow = true;
  const caster = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); caster.castShadow = true;
  const artwork = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: new THREE.Texture() }));
  scene.add(light, light.target, caster, artwork);
  const state = new ShadowState();
  const renderer = { shadowMap: { enabled: true, type: THREE.PCFSoftShadowMap } } as THREE.WebGLRenderer;
  const changed = () => { scene.updateMatrixWorld(); return state.changed(scene, light, renderer); };
  expect(changed()).toBe(true); expect(changed()).toBe(false);
  return { scene, light, caster, artwork, state, renderer, changed };
}

it("beauty-only colour, artwork and camera changes reuse the shadow", () => {
  const { caster, artwork, changed } = fixture();
  caster.material.color.set("red"); caster.material.roughness = .8;
  artwork.material.map!.needsUpdate = true; artwork.position.x = 2;
  expect(changed()).toBe(false);
});

it("caster transforms, geometry edits and ancestor visibility invalidate depth", () => {
  const { scene, caster, changed } = fixture();
  caster.position.x = 1; expect(changed()).toBe(true); expect(changed()).toBe(false);
  caster.geometry.attributes.position!.needsUpdate = true; expect(changed()).toBe(true);
  const parent = new THREE.Group(); scene.add(parent); parent.add(caster);
  changed(); parent.visible = false; expect(changed()).toBe(true); expect(changed()).toBe(false);
  parent.visible = true; expect(changed()).toBe(true);
  caster.castShadow = false; expect(changed()).toBe(true);
});

it("packed caster membership, instance transforms, light and quality changes invalidate depth", () => {
  const { scene, light, renderer, changed } = fixture();
  const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 4);
  instances.castShadow = true; scene.add(instances); expect(changed()).toBe(true); expect(changed()).toBe(false);
  instances.count = 3; expect(changed()).toBe(true);
  instances.instanceMatrix.needsUpdate = true; expect(changed()).toBe(true);
  light.position.y = 8; expect(changed()).toBe(true);
  light.target.position.x = 1; expect(changed()).toBe(true);
  light.shadow.camera.left = -4; light.shadow.camera.updateProjectionMatrix(); expect(changed()).toBe(true);
  light.shadow.mapSize.set(1024, 1024); expect(changed()).toBe(true);
  renderer.shadowMap.enabled = false; expect(changed()).toBe(true);
  renderer.shadowMap.enabled = true; expect(changed()).toBe(true);
});

it("alpha-tested textures invalidate shadows while ordinary printed maps do not", () => {
  const { caster, changed } = fixture();
  caster.material.map = new THREE.Texture(); expect(changed()).toBe(false);
  caster.material.alphaTest = .5; expect(changed()).toBe(true);
  caster.material.map.needsUpdate = true; expect(changed()).toBe(true);
});
