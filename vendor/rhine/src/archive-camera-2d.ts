import { archiveFraming } from './viewport-layout';
import { settlingWave } from './motion';

export type Vector = { x: number; y: number; z: number };
export type ScreenPoint = { x: number; y: number };
export type CameraState = { eye: Vector; aim: Vector; fov: number };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const dot = (a: Vector, b: Vector) => a.x*b.x + a.y*b.y + a.z*b.z;
const sub = (a: Vector,b: Vector): Vector => ({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const unit = (a: Vector): Vector => {const n=Math.hypot(a.x,a.y,a.z);return {x:a.x/n,y:a.y/n,z:a.z/n}};
const add = (a: Vector, b: Vector, scale: number) => {a.x+=b.x*scale;a.y+=b.y*scale;a.z+=b.z*scale};
const blend = (a: Vector,b: Vector,t: number): Vector => ({x:mix(a.x,b.x,t),y:mix(a.y,b.y,t),z:mix(a.z,b.z,t)});
function axes(direction: Vector) {
 const right=unit({x:direction.z,y:0,z:-direction.x});
 const up={x:direction.y*right.z,y:direction.z*right.x-direction.x*right.z,z:-direction.y*right.x};
 return {right,up};
}
/** Targets from scene.ts's settled archive path; no Three/WebGL dependency. */
export function archiveCameraTarget(width: number,height: number,detail: number,selected: Vector,compact: boolean): CameraState {
 const yaw=59*Math.PI/180,elevation=19*Math.PI/180;
 const direction=unit(blend({x:-Math.sin(yaw)*Math.cos(elevation),y:Math.sin(elevation),z:Math.cos(yaw)*Math.cos(elevation)}, {x:-.277,y:.238,z:.931},detail));
 const {right,up}=axes(direction),framing=archiveFraming(width,height,7.33,detail,compact),scale=height/framing.span;
 const base={x:-1.091,y:-.045,z:.481};
 if(framing.portrait) {base.x=0;base.y=-4.6+settlingWave(0,26.56)+.4+1.85;base.z=-2.17;add(base,up,(framing.previewY-.5)*height/scale)}
 const target={x:selected.x,y:selected.y+1.85,z:selected.z};
 add(target,right,(.5-framing.detailX)*width/scale);add(target,up,(framing.detailY-.5)*height/scale);
 const aim=blend(base,target,detail),distance=mix(140,72,detail),eye={...aim};add(eye,direction,distance);
 return {eye,aim,fov:2*Math.atan(framing.span/(2*distance))};
}
export function advanceCamera(previous: CameraState|undefined,target: CameraState,dt: number,transition: boolean): CameraState {
 if(!previous||!transition)return target;
 const t=1-Math.exp(-5*dt),move=(a: number,b: number)=>Math.abs(a-b)<.00001?b:mix(a,b,t);
 const vector=(a: Vector,b: Vector)=>({x:move(a.x,b.x),y:move(a.y,b.y),z:move(a.z,b.z)});
 return {eye:vector(previous.eye,target.eye),aim:vector(previous.aim,target.aim),fov:move(previous.fov,target.fov)};
}
export function cameraSettled(a: CameraState,b: CameraState) {
 return Math.hypot(...Object.values(sub(a.eye,b.eye)))<.00002 && Math.hypot(...Object.values(sub(a.aim,b.aim)))<.00002 && Math.abs(a.fov-b.fov)<.00001;
}
export function perspectiveFrame(state: CameraState,width: number,height: number,detail: number) {
 const direction=unit(sub(state.eye,state.aim)),{right,up}=axes(direction),distance=Math.hypot(...Object.values(sub(state.eye,state.aim)));
 const focal=height/(2*Math.tan(state.fov/2)),near=distance+mix(5,-1,detail),far=distance+mix(25,12,detail);
 const depth=(p: Vector)=>-dot(sub(p,state.eye),direction);
 const project=(x: number,y: number,z: number): ScreenPoint=>{
  const dx=x-state.eye.x,dy=y-state.eye.y,dz=z-state.eye.z,d=Math.max(.1,-(dx*direction.x+dy*direction.y+dz*direction.z));
  return {x:width/2+focal*(dx*right.x+dz*right.z)/d,y:height/2-focal*(dx*up.x+dy*up.y+dz*up.z)/d};
 };
 const fog=(p: Vector)=>{const t=Math.max(0,Math.min(1,(depth(p)-near)/(far-near)));return t*t*(3-2*t)};
 const ground=(x: number,y: number,worldY: number): Vector|null=>{
  const ray={x:-direction.x,y:-direction.y,z:-direction.z};add(ray,right,(x-width/2)/focal);add(ray,up,(height/2-y)/focal);
  const t=(worldY-state.eye.y)/ray.y;if(t<=.1||!Number.isFinite(t))return null;
  const p={...state.eye};add(p,ray,t);return p;
 };
 return {project,depth,fog,ground,direction,right,up,scale:focal/distance,near,far,state};
}
