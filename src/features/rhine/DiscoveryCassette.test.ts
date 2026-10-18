import * as THREE from "three";
import { expect, it, vi } from "vitest";
import { CardAppearance } from "./vendor/appearance";
import { cloneDiscoveryCassette, disposeDiscoveryCassette } from "./vendor/discovery-cassette";
import { DiscoveryRack } from "./vendor/discovery-rack";
import { SHELL } from "./vendor/cassette-shell-2d";
import { archiveCameraTarget } from "./vendor/archive-camera-2d";

function mockCanvas() {
  const context=new Proxy({measureText:(text:string)=>({width:text.length*40}),createLinearGradient:()=>({addColorStop:()=>{}}),createRadialGradient:()=>({addColorStop:()=>{}})},{get:(target,key)=>key in target?target[key as keyof typeof target]:()=>{}});
  return vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockImplementation(
    ((kind: string) => kind === "2d" ? context as unknown as CanvasRenderingContext2D : null) as HTMLCanvasElement["getContext"]);
}

it("reuses the retreat wave without moving the camera or destroying prepared recommendation shells", () => {
 const getContext=mockCanvas(),rack=new DiscoveryRack(),camera=new THREE.PerspectiveCamera();
 camera.position.set(0,90,100);camera.lookAt(0,0,0);
 const origin=camera.clone();rack.begin(camera,[]);
 const state={open:true,ready:true,instant:true,key:"ready",entries:[],selected:null,hovered:null,scroll:0,top:166};
 try {
  rack.set(state);rack.update(0,1280,800,camera);
  const models=rack.root.children.slice(1);expect(models).toHaveLength(9);
  rack.begin(origin,[]);rack.set({...state,instant:false,surfaceOnly:true,key:"archive-page"});
  for(let i=0;i<60;i++)rack.update(.016,1280,800,camera);
  expect(rack.motion.retreat).toBe(1);expect(rack.count).toBe(0);expect(rack.root.visible).toBe(false);
  expect(camera.position.distanceTo(origin.position)).toBeLessThan(.0001);
  expect(camera.quaternion.angleTo(origin.quaternion)).toBeLessThan(.0001);
  expect(rack.root.children.slice(1)).toEqual(models);
  rack.begin(origin,[]);rack.set({...state,instant:false,surfaceOnly:true,open:false});
  rack.update(0,1280,800,camera);expect(rack.motion.retreat).toBe(1);
  for(let i=0;i<60;i++)rack.update(.016,1280,800,camera);
  expect(rack.motion.time).toBe(0);
  rack.begin(origin,[]);rack.set(state);rack.update(0,1280,800,camera);
  expect(rack.root.visible).toBe(true);expect(rack.count).toBe(9);expect(rack.root.children.slice(1)).toEqual(models);
 } finally {rack.dispose();getContext.mockRestore();}
});

it("shares original archive geometry, isolates materials and excludes the archive's mutable labels", () => {
  const appearance = new CardAppearance(), source = new THREE.Group();
  const geometry = new THREE.BoxGeometry(5,3.7,.336);
  const material = new THREE.MeshPhysicalMaterial({ color: "#fffdfa", transmission: .9 });
  appearance.register("Frosted_Polymer", material, material);
  const shell = new THREE.Mesh(geometry,material);shell.userData.surface="Frosted_Polymer";shell.position.y=1.85;
  source.add(shell, new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.MeshBasicMaterial()));
  const first=cloneDiscoveryCassette(source,appearance),second=cloneDiscoveryCassette(source,appearance);
  expect(first.children).toHaveLength(1);
  const copy=first.children[0] as THREE.Mesh;
  expect(copy.geometry).toBe(geometry);expect(copy.position).toEqual(shell.position);
  expect(copy.material).not.toBe(material);expect(copy.material).not.toBe((second.children[0] as THREE.Mesh).material);
  const geometryDispose=vi.spyOn(geometry,"dispose"),sourceDispose=vi.spyOn(material,"dispose");
  const copyDispose=vi.spyOn(copy.material as THREE.Material,"dispose");
  disposeDiscoveryCassette(first);expect(copyDispose).toHaveBeenCalledOnce();
  expect(geometryDispose).not.toHaveBeenCalled();expect(sourceDispose).not.toHaveBeenCalled();
  disposeDiscoveryCassette(second);appearance.disposeSources();geometry.dispose();
});

it("retains the original geometry in economical rendering while disabling transmission", () => {
  const appearance=new CardAppearance(),source=new THREE.Group();
  const material=new THREE.MeshPhysicalMaterial({transmission:.9,clearcoat:.6});
  appearance.register("Frosted_Polymer",material,material);
  const shell=new THREE.Mesh(new THREE.BoxGeometry(),material);shell.userData.surface="Frosted_Polymer";source.add(shell);
  const copy=cloneDiscoveryCassette(source,appearance,true),mesh=copy.children[0] as THREE.Mesh<THREE.BufferGeometry,THREE.MeshPhysicalMaterial>;
  expect(mesh.geometry).toBe(shell.geometry);expect(mesh.material.transmission).toBe(0);expect(mesh.material.clearcoat).toBe(0);
  disposeDiscoveryCassette(copy);appearance.disposeSources();shell.geometry.dispose();
});

it("places titles on the physical top surface and views the stacks from above",()=>{
  const getContext=mockCanvas();
  const rack=new DiscoveryRack(()=>new THREE.Group()),camera=new THREE.PerspectiveCamera();
  camera.position.set(0,90,100);camera.lookAt(0,0,0);rack.begin(camera,[]);
  rack.set({open:true,ready:true,instant:true,key:"a",entries:Array.from({length:6},(_,i)=>({id:String(i),kind:"song",title:`歌曲 ${i}`,subtitle:"歌手"})),selected:null,hovered:null,scroll:0,top:150});
  try {
    rack.update(0,1280,900,camera);
    const labels:THREE.Mesh[]=[];rack.root.traverse(o=>{if(o instanceof THREE.Mesh&&o.name==="discovery-title-on-top")labels.push(o);});
    expect(rack.count).toBe(9);expect(labels).toHaveLength(9);
    expect(labels.filter(label=>(label.material as THREE.MeshBasicMaterial).opacity>0)).toHaveLength(6);
    expect(Math.asin(camera.position.y/camera.position.length())).toBeGreaterThan(Math.PI/3);
    expect(camera.position.x).toBe(0);
    for(const label of labels) {
      expect(new THREE.Vector3(0,0,1).applyQuaternion(label.getWorldQuaternion(new THREE.Quaternion())).y).toBeGreaterThan(.95);
      expect(label.position.y).toBeGreaterThan(SHELL.height);
      expect((label.geometry as THREE.PlaneGeometry).parameters.height).toBeLessThanOrEqual(SHELL.front-SHELL.back);
    }
  } finally {rack.dispose();getContext.mockRestore();}
});

it.each([[1280,900],[900,800],[480,800]])("extracts like the transport cassette within a %i × %i viewport and releases its artwork on return",(width,height)=>{
  const getContext=mockCanvas(),rack=new DiscoveryRack(()=>new THREE.Group()),camera=new THREE.PerspectiveCamera();
  camera.position.set(0,90,100);camera.lookAt(0,0,0);rack.begin(camera,[]);
  const state={open:true,ready:true,instant:true,reduced:true,key:"inspection",entries:[{id:"a",kind:"song" as const,title:"歌曲",subtitle:"歌手"}],selected:"a",hovered:null,scroll:0,top:166};
  const frame=vi.fn();rack.onFrame=frame;rack.set(state);
  try {
    rack.update(0,width,height,camera);
    const artwork=rack.root.getObjectByName("discovery-inspection-cover") as THREE.Mesh<THREE.PlaneGeometry,THREE.MeshBasicMaterial>;
    expect(artwork).toBeDefined();expect(artwork.material.opacity).toBe(1);
    const transport=archiveCameraTarget(width,height,1,{x:0,y:0,z:0},false),view=new THREE.PerspectiveCamera();
    view.position.set(transport.eye.x-transport.aim.x,transport.eye.y-transport.aim.y,transport.eye.z-transport.aim.z);view.lookAt(0,0,0);
    const normal=new THREE.Vector3(0,0,1).applyQuaternion(artwork.getWorldQuaternion(new THREE.Quaternion())).applyQuaternion(camera.quaternion.clone().invert());
    const reference=new THREE.Vector3(0,0,1).applyQuaternion(view.quaternion.clone().invert());
    expect(normal.dot(reference)).toBeCloseTo(1,5);
    const rect=frame.mock.lastCall![0].rects[0];
    expect(rect.height/rect.width).toBeGreaterThan(.65);
    expect(rect.x).toBeGreaterThan(8);expect(rect.y).toBeGreaterThan(state.top+4);
    expect(rect.x+rect.width).toBeLessThan(width>=800?width*.55:width-8);
    expect(rect.y+rect.height).toBeLessThan(width>=800?height-48:state.top+Math.min((height-state.top)*.38,225)+8);
    const dispose=vi.spyOn(artwork.material.map!,"dispose");
    rack.set({...state,selected:null});rack.update(0,width,height,camera);
    expect(rack.root.getObjectByName("discovery-inspection-cover")).toBeUndefined();expect(dispose).toHaveBeenCalledOnce();
  } finally {rack.dispose();getContext.mockRestore();}
});

it.each(["webgl","canvas2d"])("keeps %s tape geometry and camera still while replacing the fading print",renderer=>{
 const getContext=mockCanvas(),create=vi.fn(()=>new THREE.Group());
 const rack=new DiscoveryRack(renderer==="webgl"?create:undefined),camera=new THREE.PerspectiveCamera();
 camera.position.set(0,90,100);camera.lookAt(0,0,0);rack.begin(camera,[]);
 const initial={open:true,ready:true,key:"guess",entries:[{id:"a",kind:"song" as const,title:"歌曲",subtitle:"歌手"}],selected:null,hovered:null,scroll:0,top:166};
 const frame=vi.fn();rack.onFrame=frame;
 try {
  rack.set({...initial,instant:true});rack.update(0,1280,800,camera);
  const tapes=rack.root.children.slice(1),matrices=tapes.map(t=>t.matrixWorld.clone()),cameraMatrix=camera.matrixWorld.clone();
  const labels=tapes.map(t=>t.getObjectByName("discovery-title-on-top") as THREE.Mesh<THREE.PlaneGeometry,THREE.MeshBasicMaterial>);
  const disposed=labels.map(label=>vi.spyOn(label.material.map!,"dispose"));
  const next={...initial,key:"radar",entries:Array.from({length:9},(_,i)=>({id:`radar-${i}`,kind:"song" as const,title:`雷达 ${i}`,subtitle:"歌手"}))};
  rack.set(next);let hiddenPrint=false,partialPrint=false;
  for(let i=0;i<24;i++) {
   rack.update(.016,1280,800,camera);
   expect(rack.root.children.slice(1)).toEqual(tapes);expect(camera.matrixWorld).toEqual(cameraMatrix);
   tapes.forEach((t,index)=>{expect(t.visible).toBe(true);expect(t.matrixWorld).toEqual(matrices[index]);});
   hiddenPrint ||= labels[0]!.material.opacity===0;
   partialPrint ||= labels[0]!.material.opacity>0&&labels[0]!.material.opacity<1;
  }
  expect(hiddenPrint).toBe(true);expect(partialPrint).toBe(true);expect(rack.motion.phase(next)).toBe("ready");
  expect(frame.mock.lastCall![0].rects.map((r:{id:string})=>r.id)).toEqual(next.entries.map(e=>e.id));
  expect(labels.every(label=>label.material.opacity===1)).toBe(true);
  disposed.forEach(dispose=>expect(dispose).not.toHaveBeenCalled());
  if(renderer==="webgl")expect(create).toHaveBeenCalledTimes(9);
 }finally{rack.dispose();getContext.mockRestore();}
});

it.each(["webgl","canvas2d"])("animates nine blank %s tapes before data and fills the same models on arrival",renderer=>{
 const getContext=mockCanvas(),rack=new DiscoveryRack(renderer==="webgl"?()=>new THREE.Group():undefined),camera=new THREE.PerspectiveCamera();
 camera.position.set(0,90,100);camera.lookAt(0,0,0);rack.begin(camera,[]);
 const loading={open:true,ready:false,key:"",entries:[],selected:null,hovered:null,scroll:0,top:166};
 const frame=vi.fn();rack.onFrame=frame;rack.set(loading);
 try {
  rack.update(0,1280,800,camera);const models=rack.root.children.slice(1);expect(models).toHaveLength(9);
  for(let i=0;i<50;i++)rack.update(.016,1280,800,camera);
  expect(rack.motion.spread).toBeGreaterThan(0);expect(frame.mock.lastCall![0]).toMatchObject({phase:"moving",rects:[]});
  expect(models.every(model=>model.visible)).toBe(true);
  const entries=Array.from({length:5},(_,i)=>({id:`song:${i}`,kind:"song" as const,title:`歌曲 ${i}`,subtitle:"歌手"}));
  rack.set({...loading,ready:true,key:"loaded",entries});rack.update(0,1280,800,camera);
  expect(rack.root.children.slice(1)).toEqual(models);expect(rack.motion.contentOpacity).toBe(0);
  for(let i=0;i<60;i++)rack.update(.016,1280,800,camera);
  expect(frame.mock.lastCall![0].phase).toBe("ready");expect(frame.mock.lastCall![0].rects).toHaveLength(5);
  expect(rack.root.children.slice(1)).toEqual(models);
 }finally{rack.dispose();getContext.mockRestore();}
});

it("reuses prepared shells on re-entry while clearing interrupted inspection and label transitions",()=>{
 const getContext=mockCanvas(),create=vi.fn(()=>new THREE.Group()),clarity=vi.fn();
 const rack=new DiscoveryRack(create,clarity),camera=new THREE.PerspectiveCamera();
 camera.position.set(0,90,100);camera.lookAt(0,0,0);rack.begin(camera,[]);
 const state={open:true,ready:true,instant:true,key:"first",entries:[{id:"a",kind:"song" as const,title:"歌曲",subtitle:"歌手"}],selected:"a",hovered:null,scroll:0,top:166};
 rack.set(state);rack.update(0,1280,800,camera);
 const models=rack.root.children.slice(1),artwork=rack.root.getObjectByName("discovery-inspection-cover") as THREE.Mesh<THREE.PlaneGeometry,THREE.MeshBasicMaterial>;
 const dispose=vi.spyOn(artwork.material,"dispose");
 try {
  rack.set({...state,instant:false,key:"other",selected:null});rack.update(.04,1280,800,camera);
  expect(rack.motion.contentOpacity).toBeLessThan(1);
  const origin=new THREE.PerspectiveCamera();origin.position.set(-40,45,80);origin.lookAt(0,0,0);
  rack.begin(origin,[]);
  expect(rack.motion.time).toBe(0);expect(rack.motion.key).toBe("");expect(rack.motion.contentOpacity).toBe(1);
  expect(rack.root.getObjectByName("discovery-inspection-cover")).toBeUndefined();expect(dispose).toHaveBeenCalledOnce();
  const frame=vi.fn();rack.onFrame=frame;
  const loading={...state,ready:false,instant:false,key:"",entries:[],selected:null};rack.set(loading);rack.update(0,1280,800,camera);
  expect(camera.position.distanceTo(origin.position)).toBeLessThan(.0001);expect(frame.mock.lastCall![0].rects).toEqual([]);
  expect(rack.root.children.slice(1)).toEqual(models);expect(create).toHaveBeenCalledTimes(9);
  for(let i=0;i<110;i++)rack.update(.016,1280,800,camera);
  expect(rack.motion.phase(loading)).toBe("waiting");expect(rack.motion.key).toBe("");
  expect(clarity.mock.calls.slice(-9).every(([,amount])=>amount===0)).toBe(true);
 }finally{rack.dispose();getContext.mockRestore();}
});
