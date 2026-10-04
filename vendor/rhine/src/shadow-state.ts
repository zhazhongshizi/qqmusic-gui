import * as THREE from "three";
import { RenderState } from "./render-state";

/** Depth dependencies only: colour, artwork and beauty camera do not cast shadows. */
export class ShadowState {
  private state = new RenderState();
  invalidate() { this.state.invalidate(); }
  changed(scene: THREE.Scene, light: THREE.DirectionalLight, renderer: THREE.WebGLRenderer) {
    const state = this.state;
    state.begin();
    const shadow = light.shadow;
    state.add(Number(renderer.shadowMap.enabled), renderer.shadowMap.type, Number(light.castShadow));
    state.floats(...light.matrixWorld.elements, ...light.target.matrixWorld.elements,
      ...shadow.camera.projectionMatrix.elements, shadow.mapSize.x, shadow.mapSize.y,
      shadow.bias, shadow.normalBias, shadow.radius);
    scene.traverseVisible(object => {
      if (!(object instanceof THREE.Mesh) || !object.castShadow) return;
      state.add(object.id, object.geometry.id, object.geometry.index?.version);
      state.floats(...object.matrixWorld.elements);
      for (const [name, attribute] of Object.entries(object.geometry.attributes) as [string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute][]) state.add(name, attribute instanceof THREE.BufferAttribute ? attribute.version : attribute.data.version);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        const mat = material as THREE.MeshStandardMaterial;
        state.add(Number(mat.visible), mat.side, mat.shadowSide ?? undefined,
          mat.alphaMap?.uuid, mat.alphaMap?.version, mat.displacementMap?.uuid, mat.displacementMap?.version);
        state.floats(mat.alphaTest, mat.displacementScale, mat.displacementBias);
        if (mat.alphaTest > 0 || mat.alphaHash) state.add(mat.map?.uuid, mat.map?.version, Number(mat.alphaHash));
        if (renderer.shadowMap.type === THREE.VSMShadowMap) state.floats(mat.opacity, Number(mat.transparent));
      }
      if (object instanceof THREE.InstancedMesh) state.add(object.count, object.instanceMatrix.version);
    });
    return state.end();
  }
}
