import * as THREE from "three";
import { expect, it, vi } from "vitest";
import { CardAppearance } from "./vendor/appearance";
import { cloneDiscoveryCassette, disposeDiscoveryCassette } from "./vendor/discovery-cassette";
import { DiscoveryRack } from "./vendor/discovery-rack";
import { SHELL } from "./vendor/cassette-shell-2d";
import { archiveCameraTarget } from "./vendor/archive-camera-2d";

function mockCanvas() {
  const context=new Proxy({measureText:(text:string)=>({width:text.length*40})},{get:(target,key)=>key in target?target[key as keyof typeof target]:()=>{}});
  return vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockImplementation(
    ((kind: string) => kind === "2d" ? context as unknown as CanvasRenderingContext2D : null) as HTMLCanvasElement["getContext"]);
}

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
