import * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";
import { DISCOVERY_DURATION, DISCOVERY_WAIT, DISCOVERY_SINK_DEPTH, DiscoveryMotion, discoveryRetreat, discoverySinkScale, type DiscoveryState } from "./discovery-layout";
import { DiscoveryBackdrop, DiscoveryRack, discoveryCluster, discoveryClusterDistance, type DiscoverySource } from "./discovery-rack";
import { archiveCameraTarget } from "./archive-camera-2d";
import { COLUMN_SPACING, ROW_SPACING } from "./archive-loop";
import { ArchiveScene2D } from "./scene-2d";
import { fullMotion } from "./motion-preferences";

const state:DiscoveryState={open:true,ready:true,key:"a",entries:Array.from({length:5},(_,i)=>({id:String(i),title:"Tape",subtitle:"Artist",kind:"song"})),selected:null,hovered:null,scroll:0,top:150};
const run=(motion:DiscoveryMotion,next:DiscoveryState,n=120)=>{for(let i=0;i<n;i++)motion.step(1/60,next);};
afterEach(()=>vi.restoreAllMocks());

function mockCanvas() {
  const gradient={addColorStop:()=>{}};
  const context=new Proxy({measureText:(text:string)=>({width:text.length*20}),createLinearGradient:()=>gradient,createRadialGradient:()=>gradient},{get:(target,key)=>key in target?target[key as keyof typeof target]:()=>{}});
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockImplementation(
    ((kind:string)=>kind==="2d"?context as unknown as CanvasRenderingContext2D:null) as HTMLCanvasElement["getContext"]);
}

it("selects the safe-view peak and a compact grid neighbourhood, with a flat-array fallback",()=>{
  const camera=new THREE.OrthographicCamera(-40,40,20,-20,.1,200);camera.position.set(0,-2.75,50);camera.lookAt(0,-2.75,0);camera.updateMatrixWorld();
  const candidates:DiscoverySource[]=[];
  for(let lane=-3;lane<=3;lane++)for(let row=-8;row<=8;row++)candidates.push({position:new THREE.Vector3(lane*COLUMN_SPACING,-4.6,row*ROW_SPACING)});
  const peak=candidates.find(c=>c.position.x===COLUMN_SPACING&&c.position.z===2*ROW_SPACING)!;peak.position.y=1;
  candidates.push({position:new THREE.Vector3(200,50,0)});
  const cluster=discoveryCluster(candidates,camera);
  expect(cluster.sources[0]).toBe(peak);
  for(const source of cluster.sources.slice(0,5))expect(discoveryClusterDistance(source.position.x-peak.position.x,source.position.z-peak.position.z)).toBeLessThanOrEqual(1.00001);
  expect(cluster.sources.some(c=>c.position.x===200)).toBe(false);
  peak.position.y=-4.57;
  const fallback=discoveryCluster(candidates,camera).sources[0];
  expect(fallback.position.x).toBe(0);expect(fallback.position.y).toBe(-4.6);
  const center=fallback.position.clone().add(new THREE.Vector3(0,1.85,0)).project(camera);
  expect(Math.hypot(center.x,center.y)).toBeLessThan(1e-10);
  peak.position.y=-4.498;
  const opposite=candidates.find(c=>c.position.x===-COLUMN_SPACING)!;opposite.position.y=-4.702;
  expect(discoveryCluster(candidates,camera).sources[0].position.x).toBe(0);
});

it("separates stationary retained tapes from the sink before takeoff and uses the requested windows",()=>{
  const motion=new DiscoveryMotion();
  motion.time=.3;expect(motion.flatten).toBe(1);expect(motion.handoff).toBe(true);
  motion.time=.40;expect(motion.spread).toBe(0);expect(motion.tapeSpread(0,5)).toBe(0);
  expect(discoveryRetreat(motion.retreat,0)).toBeGreaterThan(0);
  expect(discoveryRetreat(motion.retreat,0)).toBeGreaterThan(discoveryRetreat(motion.retreat,1));
  motion.time=.65;expect(motion.boards).toBe(0);expect(motion.labels).toBe(0);
  motion.time=1.25;expect(motion.boards).toBe(1);
  motion.time=1.30;expect(motion.camera).toBe(1);
  motion.time=1.45;expect(motion.labels).toBe(1);
  expect(discoverySinkScale(.45)).toBe(1);expect(discoverySinkScale(.75)).toBeLessThan(1);expect(discoverySinkScale(1)).toBe(0);
});

it("waits with a flat, stationary array and accepts delayed entries before moving",()=>{
  const motion=new DiscoveryMotion(),waiting={...state,ready:false};run(motion,waiting);
  expect(motion.time).toBe(DISCOVERY_WAIT);expect(motion.flatten).toBe(1);expect(motion.spread).toBe(0);
  expect(motion.phase(waiting)).toBe("waiting");
  for(const distance of [0,.5,1])expect(discoveryRetreat(motion.retreat,distance)).toBe(0);
  motion.step(1/60,state);expect(motion.key).toBe(state.key);expect(motion.swap).toBe(1);
  run(motion,state);expect(motion.time).toBe(DISCOVERY_DURATION);expect(motion.phase(state)).toBe("ready");
});

it.each([.19,.29,.30,.35,.42,.6,.83,1.24,1.49])("retraces every channel after interruption at %f seconds",(time:number)=>{
  const motion=new DiscoveryMotion();motion.key=state.key;motion.time=time;
  const sample=()=>[motion.time,motion.flatten,motion.retreat,motion.spread,motion.camera,motion.labels,motion.boards,...state.entries.map((_,i)=>motion.tapeSpread(i,5))];
  const before=sample();motion.step(.01,{...state,open:false});expect(motion.time).toBeLessThan(time);
  motion.step(.01,state);sample().forEach((value,i)=>expect(value).toBeCloseTo(before[i],12));
  run(motion,{...state,open:false});expect(motion.time).toBe(0);
});

it("overlaps camera movement with flattening and staggers tapes and retreat",()=>{
  const motion=new DiscoveryMotion();motion.time=.29;
  expect(motion.flatten).toBeLessThan(1);expect(motion.camera).toBeGreaterThan(0);
  const velocity=(time:number)=>{motion.time=time-.00001;const a=motion.camera;motion.time=time+.00001;return (motion.camera-a)/.00002;};
  expect(velocity(.2999)).toBeCloseTo(velocity(.3001),2);
  motion.time=.7;expect(motion.tapeSpread(0,5)).toBeGreaterThan(motion.tapeSpread(4,5));
  expect(discoveryRetreat(motion.retreat,0)).not.toBeCloseTo(discoveryRetreat(motion.retreat,1),3);
  motion.time=1.28;for(let i=0;i<5;i++)expect(motion.tapeSpread(i,5)).toBe(1);
});

it("retains short entry, instant and reduced modes, including reverse",()=>{
  const motion=new DiscoveryMotion();run(motion,{...state,shortEntry:true},25);
  expect(motion.time).toBe(DISCOVERY_DURATION);
  motion.step(.016,{...state,shortEntry:true,open:false});expect(motion.time).toBeCloseTo(DISCOVERY_DURATION-.016);
  for(const mode of [{instant:true},{reduced:true}]) {
    motion.step(0,{...state,...mode,open:false});expect(motion.time).toBe(0);
    motion.step(0,{...state,...mode});expect(motion.time).toBe(DISCOVERY_DURATION);
  }
});

it("replaces categories, cancels pending replacements and keeps unfinished travel awake",()=>{
  const motion=new DiscoveryMotion();run(motion,state);
  motion.step(.03,{...state,key:"b"});expect(motion.swap).toBeLessThan(1);
  run(motion,state);expect(motion.key).toBe("a");expect(motion.phase(state)).toBe("ready");
  run(motion,{...state,key:"c"});expect(motion.key).toBe("c");expect(motion.swap).toBe(1);
  motion.time=.6;expect(motion.phase({...state,ready:false})).toBe("moving");
});

it("hands off exact position, rotation and scale, hides every matrix basis, then restores",()=>{
  const context=new Proxy({measureText:(text:string)=>({width:text.length*20})},{get:(target,key)=>key in target?target[key as keyof typeof target]:()=>{}});
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockImplementation(
    ((kind:string)=>kind==="2d"?context as unknown as CanvasRenderingContext2D:null) as HTMLCanvasElement["getContext"]);
  const camera=new THREE.PerspectiveCamera(45,1280/800,.1,500);camera.position.set(10,30,45);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial(),12);
  const quaternion=new THREE.Quaternion().setFromEuler(new THREE.Euler(.12,.2,-.06));
  for(let i=0;i<12;i++)mesh.setMatrixAt(i,new THREE.Matrix4().compose(new THREE.Vector3(i%4*5-7.5,-3+i*.1,Math.floor(i/4)*.7),quaternion,new THREE.Vector3(.98,1.02,1)));
  const original=Array.from(mesh.instanceMatrix.array),backdrop=new DiscoveryBackdrop([mesh],[],camera);
  const rack=new DiscoveryRack(()=>new THREE.Group());rack.begin(camera,backdrop.sources);rack.set(state);rack.update(0,1280,800,camera);
  try {
    rack.motion.time=DISCOVERY_WAIT;rack.update(0,1280,800,camera);backdrop.update(rack.motion,rack.count);
    const tapes=rack.root.children.slice(1);
    expect(tapes).toHaveLength(9);
    tapes.forEach((tape,i)=>{
      const source=backdrop.sources[i];expect(tape.visible).toBe(true);
      expect(tape.position.distanceTo(source.position.clone().setY(-4.6))).toBeLessThan(1e-7);
      expect(tape.quaternion.angleTo(new THREE.Quaternion().setFromEuler(source.rotation!))).toBeLessThan(1e-7);
      expect(tape.scale.distanceTo(source.scale!)).toBeLessThan(1e-7);
    });
    const hidden=Array.from({length:12},(_,i)=>new THREE.Matrix4().fromArray(mesh.instanceMatrix.array,i*16)).filter(m=>m.determinant()===0);
    expect(hidden).toHaveLength(9);
    for(const m of hidden)for(let column=0;column<3;column++)for(let row=0;row<3;row++)expect(m.elements[column*4+row]).toBe(0);
    expect(rack.root.children[0].visible).toBe(false);
    rack.motion.time=.7;rack.update(0,1280,800,camera);backdrop.update(rack.motion,rack.count);
    expect(rack.root.children[0].visible).toBe(true);
    rack.motion.time=.88;backdrop.update(rack.motion,rack.count);expect(mesh.visible).toBe(false);
    rack.motion.time=0;rack.update(0,1280,800,camera);backdrop.update(rack.motion,rack.count);
    expect(tapes.every(t=>!t.visible)).toBe(true);expect(Array.from(mesh.instanceMatrix.array)).toEqual(original);
    backdrop.restore();expect(Array.from(mesh.instanceMatrix.array)).toEqual(original);
  } finally {rack.dispose();mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}
});

it("keeps the retained tapes in frame throughout the long-lens camera orbit",()=>{
  const context=new Proxy({measureText:(text:string)=>({width:text.length*20})},{get:(target,key)=>key in target?target[key as keyof typeof target]:()=>{}});
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockImplementation(
    ((kind:string)=>kind==="2d"?context as unknown as CanvasRenderingContext2D:null) as HTMLCanvasElement["getContext"]);
  const view=archiveCameraTarget(1280,900,0,{x:0,y:0,z:0},false);
  const camera=new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(view.fov),1280/900,.1,500);
  camera.position.set(view.eye.x,view.eye.y,view.eye.z);camera.lookAt(view.aim.x,view.aim.y,view.aim.z);camera.updateMatrixWorld();
  const initial=camera.clone(),mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial(),9*51);
  let index=0;for(let lane=-4;lane<=4;lane++)for(let row=-25;row<=25;row++)mesh.setMatrixAt(index++,new THREE.Matrix4().makeTranslation(lane*5.4,-4.6,row*.62-2.17));
  const backdrop=new DiscoveryBackdrop([mesh],[],camera),rack=new DiscoveryRack(()=>new THREE.Group());
  rack.begin(camera,backdrop.sources);rack.set(state);rack.update(0,1280,900,camera);
  try {
    expect(camera.position.distanceTo(initial.position)).toBeLessThan(1e-10);
    expect(camera.quaternion.angleTo(initial.quaternion)).toBeLessThan(1e-7);
    for(const time of [.32,.45,.6,.8,.95,1.25,1.5]) {
      rack.motion.time=time;rack.update(0,1280,900,camera);
      for(const tape of rack.root.children.slice(1)) {
        const center=tape.localToWorld(new THREE.Vector3(0,1.85,0)).project(camera);
        expect(Math.abs(center.x)).toBeLessThan(1);expect(Math.abs(center.y)).toBeLessThan(1);
      }
      expect(new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion).y).toBeCloseTo(0,10);
    }
  } finally {rack.dispose();mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}
});

it("retains a standalone peak, shrinks the surrounding wave, and restores its original pose in reverse",()=>{
  mockCanvas();
  const camera=new THREE.OrthographicCamera(-40,40,20,-20,.1,200);camera.position.set(0,-2.75,50);camera.lookAt(0,-2.75,0);camera.updateMatrixWorld();
  const mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial(),7*17-1);
  const peak=new THREE.Group();peak.position.set(COLUMN_SPACING,1.2,ROW_SPACING);peak.rotation.set(.1,.3,0);peak.scale.set(.98,1.02,1);
  let index=0;for(let lane=-3;lane<=3;lane++)for(let row=-8;row<=8;row++) {
    if(lane===1&&row===1)continue;
    mesh.setMatrixAt(index++,new THREE.Matrix4().makeTranslation(lane*COLUMN_SPACING,-4.6,row*ROW_SPACING));
  }
  const original=Array.from(mesh.instanceMatrix.array),rotation=peak.rotation.clone(),scale=peak.scale.clone(),position=peak.position.clone();
  const backdrop=new DiscoveryBackdrop([mesh],[peak],camera),motion=new DiscoveryMotion();
  try {
    expect(backdrop.sources[0].position).toEqual(position);expect(backdrop.sources[0].rotation).toEqual(rotation);
    expect(backdrop.sources[0].flattenedRotation).toEqual(new THREE.Euler());
    motion.time=.4;backdrop.update(motion,5);expect(peak.visible).toBe(false);
    const hidden=Array.from({length:mesh.count},(_,i)=>new THREE.Matrix4().fromArray(mesh.instanceMatrix.array,i*16)).filter(m=>m.determinant()===0);
    expect(hidden).toHaveLength(4);
    motion.time=.65;backdrop.update(motion,5);
    const sinking=Array.from({length:mesh.count},(_,i)=>new THREE.Matrix4().fromArray(mesh.instanceMatrix.array,i*16)).filter(m=>m.determinant()>0);
    expect(sinking.every(m=>m.elements[13]<-4.6&&m.elements[13]>-4.6-DISCOVERY_SINK_DEPTH)).toBe(true);
    expect(sinking.some(m=>m.elements[0]<.99)).toBe(true);
    expect(Math.max(...sinking.map(m=>m.elements[13]))-Math.min(...sinking.map(m=>m.elements[13]))).toBeGreaterThan(1);
    motion.time=.88;backdrop.update(motion,5);expect(mesh.visible).toBe(false);
    motion.time=.4;backdrop.update(motion,5);expect(mesh.visible).toBe(true);expect(peak.visible).toBe(false);
    motion.time=.29;backdrop.update(motion,5);expect(peak.visible).toBe(true);expect(peak.position.y).toBeGreaterThan(-4.6);
    motion.time=0;backdrop.update(motion,5);
    expect(peak.position).toEqual(position);expect(peak.rotation.toArray()).toEqual(rotation.toArray());expect(peak.scale).toEqual(scale);
    expect(Array.from(mesh.instanceMatrix.array)).toEqual(original);
    backdrop.restore();expect(peak.visible).toBe(true);
  } finally {mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}
});

it("updates the rendered standalone tape transform when scene world-matrix updates are manual",()=>{
  const scene=new THREE.Scene();scene.matrixWorldAutoUpdate=false;
  const tape=new THREE.Group(),print=new THREE.Object3D();print.position.set(0,3.04,.255);tape.add(print);
  tape.position.set(0,1.2,0);tape.rotation.y=.3;scene.add(tape);scene.updateMatrixWorld(true);
  const original=tape.matrixWorld.clone(),originalPrint=print.matrixWorld.clone();
  const camera=new THREE.PerspectiveCamera(45,1,.1,200);camera.position.set(0,10,40);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const backdrop=new DiscoveryBackdrop([],[tape],camera),motion=new DiscoveryMotion();
  motion.time=.15;backdrop.update(motion,1);
  expect(tape.position.y).toBeCloseTo(-1.7);
  expect(new THREE.Vector3().setFromMatrixPosition(tape.matrixWorld).y).toBeCloseTo(tape.position.y);
  expect(new THREE.Vector3().setFromMatrixPosition(print.matrixWorld).y).toBeCloseTo(tape.position.y+3.04);
  motion.time=.3;backdrop.update(motion,1);
  expect(new THREE.Vector3().setFromMatrixPosition(tape.matrixWorld).y).toBeCloseTo(-4.6);expect(tape.visible).toBe(false);
  motion.time=.15;backdrop.update(motion,1);expect(tape.visible).toBe(true);
  expect(new THREE.Vector3().setFromMatrixPosition(tape.matrixWorld).y).toBeCloseTo(tape.position.y);
  backdrop.restore();expect(tape.visible).toBe(true);
  expect(tape.matrixWorld.elements).toEqual(original.elements);expect(print.matrixWorld.elements).toEqual(originalPrint.elements);
});

it("gives Canvas2D and WebGL the same peak cluster from the same visible card snapshot",()=>{
  mockCanvas();
  const host=document.createElement("div");document.body.append(host);
  Object.defineProperties(host,{clientWidth:{value:1280},clientHeight:{value:900}});
  const scene=new ArchiveScene2D(host,8,["A","B"]);scene.revealImmediately();scene.setMotion(fullMotion());
  type SnapshotCard={cell:{lane:number;row:number};selected:boolean;position:{x:number;y:number;z:number};rotation:number};
  const snapshot=scene as unknown as {lift:number;rotation:number;paint:()=>void;drawnCards:SnapshotCard[]};
  let backdrop:DiscoveryBackdrop|undefined,mesh:THREE.InstancedMesh|undefined;
  try {
    for(let i=0;i<120;i++)scene.update(1+i/60);
    snapshot.lift=2;snapshot.rotation=.23;snapshot.paint();
    const cards=[...snapshot.drawnCards],begin=vi.spyOn(DiscoveryRack.prototype,"begin");scene.setDiscovery(state);
    const [camera,origins]=begin.mock.lastCall!;
    const array=cards.filter(c=>!c.selected),models:THREE.Group[]=[];
    mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial(),array.length);
    array.forEach((card,i)=>mesh!.setMatrixAt(i,new THREE.Matrix4().compose(new THREE.Vector3(card.position.x,card.position.y,card.position.z),new THREE.Quaternion().setFromEuler(new THREE.Euler(0,card.rotation,0)),new THREE.Vector3(1,1,1))));
    for(const card of cards.filter(c=>c.selected)) {const object=new THREE.Group();object.position.set(card.position.x,card.position.y,card.position.z);object.rotation.y=card.rotation;models.push(object);}
    backdrop=new DiscoveryBackdrop([mesh],models,camera);
    expect(origins[0].position.distanceTo(backdrop.sources[0].position)).toBeLessThan(1e-5);
    const positions=(sources:DiscoverySource[])=>sources.slice(0,5).map(s=>s.position.toArray().map(n=>n.toFixed(4)).join(",")).sort();
    expect(positions(origins)).toEqual(positions(backdrop.sources));
    const selected=cards.find(c=>c.selected)!;expect(origins[0].position.y).toBe(selected.position.y);
    expect(origins[0].rotation!.y).toBe(selected.rotation);expect(origins[0].flattenedRotation).toEqual(new THREE.Euler());
  } finally {backdrop?.restore();if(mesh){mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}scene.dispose();host.remove();}
});
