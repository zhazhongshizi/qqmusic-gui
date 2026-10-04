import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { easuShader, rcasShader } from "./fsr1-shaders";

/** Presentation pass: receives display-encoded OutputPass pixels, then EASU/RCAS. */
export class Fsr1Pass extends Pass {
  private intermediate = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false, type: THREE.UnsignedByteType });
  private easu = this.material(easuShader);
  private rcas = this.material(rcasShader);
  private quad = new FullScreenQuad(this.easu);
  constructor() { super(); this.enabled = false; this.needsSwap = false; }
  private material(fragmentShader: string) {
    return new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, toneMapped: false,
      depthTest: false, depthWrite: false,
      uniforms: { inputTexture: { value: null }, inputSize: { value: new THREE.Vector2(1, 1) }, outputSize: { value: new THREE.Vector2(1, 1) } },
      vertexShader: "void main(){gl_Position=vec4(position.xy,0.0,1.0);}", fragmentShader });
  }
  configure(enabled: boolean, inputWidth: number, inputHeight: number, outputWidth: number, outputHeight: number) {
    this.enabled = enabled;
    this.intermediate.setSize(enabled ? outputWidth : 1, enabled ? outputHeight : 1);
    this.easu.uniforms.inputSize.value.set(inputWidth, inputHeight);
    this.easu.uniforms.outputSize.value.set(outputWidth, outputHeight);
    this.rcas.uniforms.inputSize.value.set(outputWidth, outputHeight);
    this.rcas.uniforms.outputSize.value.set(outputWidth, outputHeight);
  }
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const previous = renderer.getRenderTarget();
    try {
      this.easu.uniforms.inputTexture.value = readBuffer.texture;
      this.quad.material = this.easu;
      renderer.setRenderTarget(this.intermediate);
      this.quad.render(renderer);
      this.rcas.uniforms.inputTexture.value = this.intermediate.texture;
      this.quad.material = this.rcas;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.quad.render(renderer);
    } finally { renderer.setRenderTarget(previous); }
  }
  override dispose() { this.intermediate.dispose(); this.easu.dispose(); this.rcas.dispose(); this.quad.dispose(); }
}
