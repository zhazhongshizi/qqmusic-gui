import * as THREE from "three";
import { drawTextureQuad } from "./texture-quad-2d";
import { SHELL, clearShellTexture, shellTexture } from "./cassette-shell-2d";
import { disposeDiscoveryCassette } from "./discovery-cassette";
import { drawCassetteCover, drawCassetteLabel } from "./cassette-print";
import { archiveCameraTarget } from "./archive-camera-2d";
import { COLUMN_SPACING, ROW_SPACING } from "./archive-loop";
import { DiscoveryMotion, DISCOVERY_DURATION, DISCOVERY_SINK_DEPTH, discoverySinkScale, discoveryRetreat, discoveryEase, discoveryLayout, discoverySlots, drawDiscoveryFace, drawDiscoveryTop, type DiscoveryState, type DiscoveryFrame, type DiscoveryEntry } from "./discovery-layout";

type Print = THREE.Mesh<THREE.PlaneGeometry,THREE.MeshBasicMaterial>;
type Inspection = { group: THREE.Group; cover: HTMLCanvasElement; label: HTMLCanvasElement; coverPrint: Print; labelPrint: Print };
type Tape = { group: THREE.Group; shell: THREE.Group | null; print: Print; topPrint: Print; top: HTMLCanvasElement; topTexture: THREE.CanvasTexture; face: HTMLCanvasElement; texture: THREE.CanvasTexture; id: string; lift: number; extraction: number; selected?: boolean; inspection?: Inspection };
export type DiscoverySource = { position: THREE.Vector3; rotation?: THREE.Euler; flattenedRotation?: THREE.Euler; scale?: THREE.Vector3; texture?: HTMLCanvasElement };
const mix = THREE.MathUtils.lerp;
const settle = (a: number,b: number,dt: number) => Math.abs(a-b)<.001?b:mix(a,b,1-Math.exp(-dt*14));

/** Grid-normalised horizontal distance avoids choosing a long, compressed row. */
export const discoveryClusterDistance = (x:number,z:number) => Math.hypot(x/COLUMN_SPACING,z/ROW_SPACING);

/** Shared by WebGL instances/standalone models and the Canvas2D card snapshot. */
export function discoveryCluster<T extends DiscoverySource>(candidates:readonly T[],camera:THREE.Camera) {
  const projected=candidates.map(source=>{
    const center=new THREE.Vector3(0,1.85,0).multiply(source.scale??new THREE.Vector3(1,1,1));
    if(source.rotation)center.applyEuler(source.rotation);
    const p=center.add(source.position).project(camera);
    return {source,p,screen:p.x*p.x+p.y*p.y};
  }).filter(c=>c.p.z>=-1&&c.p.z<=1&&Math.abs(c.p.x)<1.1&&Math.abs(c.p.y)<1.1);
  const safe=projected.filter(c=>Math.abs(c.p.x)<.88&&Math.abs(c.p.y)<.88);
  const pool=safe.length?safe:projected;
  if(!pool.length)return {sources:[] as T[],anchor:new THREE.Vector3(),radius:1};
  const byScreen=[...pool].sort((a,b)=>a.screen-b.screen);
  const highest=Math.max(...pool.map(c=>c.source.position.y)),lowest=Math.min(...pool.map(c=>c.source.position.y));
  // idleWave alone spans up to .204 units; it is a flat array, not a raised file.
  const peak=highest-lowest>.22?byScreen.find(c=>highest-c.source.position.y<.001)!:byScreen[0];
  const anchor=peak.source.position.clone();
  const distance=(source:T)=>discoveryClusterDistance(source.position.x-anchor.x,source.position.z-anchor.z);
  projected.sort((a,b)=>{
    const first=Number(b.source===peak.source)-Number(a.source===peak.source),delta=distance(a.source)-distance(b.source);
    return first||(Math.abs(delta)>1e-5?delta:a.screen-b.screen);
  });
  return {sources:projected.map(c=>c.source),anchor,radius:Math.max(1,...projected.map(c=>distance(c.source)))};
}

export class DiscoveryBackdrop {
  readonly sources: DiscoverySource[];
  readonly anchor: THREE.Vector3;
  readonly radius: number;
  private matrices: Float32Array;
  private models: { object: THREE.Object3D; position: THREE.Vector3; rotation: THREE.Euler; scale:THREE.Vector3; visible: boolean }[];
  private sourceIndices: number[];
  private visibility: boolean[];
  constructor(private instances: THREE.InstancedMesh[], objects: THREE.Object3D[], camera: THREE.Camera) {
    this.visibility=instances.map(mesh=>mesh.visible);
    this.matrices=new Float32Array(instances[0]?.instanceMatrix.array??[]);
    this.models=objects.map(object=>({object,position:object.position.clone(),rotation:object.rotation.clone(),scale:object.scale.clone(),visible:object.visible}));
    const candidates:(DiscoverySource&{index:number})[]=[];
    for(let i=0;i<(instances[0]?.visible?instances[0].count:0);i++) {
      const position=new THREE.Vector3(),quaternion=new THREE.Quaternion(),scale=new THREE.Vector3();
      new THREE.Matrix4().fromArray(this.matrices,i*16).decompose(position,quaternion,scale);
      candidates.push({position,rotation:new THREE.Euler().setFromQuaternion(quaternion),scale,index:i});
    }
    this.models.forEach((model,i)=>{if(model.visible)candidates.push({position:model.position,rotation:model.rotation,flattenedRotation:new THREE.Euler(),scale:model.scale,index:-i-1});});
    const cluster=discoveryCluster(candidates,camera);
    this.sources=cluster.sources;this.sourceIndices=cluster.sources.map(c=>c.index);this.anchor=cluster.anchor;this.radius=cluster.radius;
  }
  update(motion:DiscoveryMotion,count:number) {
    const {flatten,retreat,handoff}=motion;
    const drop=(x:number,z:number)=>discoveryRetreat(retreat,discoveryClusterDistance(x-this.anchor.x,z-this.anchor.z)/this.radius);
    this.instances.forEach((mesh,i)=>{mesh.visible=this.visibility[i]&&retreat<1;});
    const hidden=new Set(this.sourceIndices.slice(0,count));
    const attribute=this.instances[0]?.instanceMatrix;
    if(attribute) {
      const data=attribute.array as Float32Array;data.set(this.matrices);
      for(let i=0;i<this.instances[0].count;i++) {
        const n=i*16,selected=hidden.has(i),progress=selected?0:drop(data[n+12],data[n+14]);
        data[n+13]=mix(this.matrices[n+13],-4.6,flatten)-progress*DISCOVERY_SINK_DEPTH;
        const scale=selected&&handoff?0:discoverySinkScale(progress);
        // Zero every basis component: tilted instances retain off-diagonal terms.
        for(let column=0;column<3;column++)for(let row=0;row<3;row++) {
          const offset=n+column*4+row;data[offset]=scale===0?0:data[offset]*scale;
        }
      }
      attribute.needsUpdate=true;this.instances[0].computeBoundingSphere();
    }
    for(const [i,{object,position,rotation,scale,visible}] of this.models.entries()) {
      const selected=hidden.has(-i-1),progress=selected?0:drop(position.x,position.z);
      object.visible=visible&&!(selected&&handoff)&&progress<1;
      object.position.copy(position);object.position.y=mix(position.y,-4.6,flatten)-progress*DISCOVERY_SINK_DEPTH;
      object.rotation.set(rotation.x*(1-flatten),rotation.y*(1-flatten),rotation.z*(1-flatten));
      object.scale.copy(scale).multiplyScalar(discoverySinkScale(progress));
      // ArchiveScene disables automatic scene world-matrix updates. The
      // standalone tape and its prints must reach the renderer in this frame.
      object.updateMatrixWorld(true);
    }
  }
  restore() {
    this.instances.forEach((mesh,i)=>{mesh.visible=this.visibility[i];});
    const attribute=this.instances[0]?.instanceMatrix;
    if(attribute){(attribute.array as Float32Array).set(this.matrices);attribute.needsUpdate=true;this.instances[0].computeBoundingSphere();}
    for(const {object,position,rotation,scale,visible} of this.models){object.position.copy(position);object.rotation.copy(rotation);object.scale.copy(scale);object.visible=visible;object.updateMatrixWorld(true);}
  }
}

/** Shared geometry, camera and projection for WebGL and Canvas2D. */
export class DiscoveryRack {
  readonly root = new THREE.Group();
  readonly motion = new DiscoveryMotion();
  onFrame?: (frame: DiscoveryFrame) => void;
  state: DiscoveryState | null = null;
  get count() { return this.tapes.length; }
  private tapes: Tape[] = [];
  private boards = new THREE.Group();
  private entriesKey = "";
  private covers = new Map<string,HTMLImageElement>();
  private origins: DiscoverySource[] = [];
  private initialCamera?: THREE.PerspectiveCamera;
  private initialFocus = new THREE.Vector3();
  private initialDistance = 140;
  private targetCamera = new THREE.PerspectiveCamera();
  private displayed: DiscoveryState["entries"] = [];
  private boardKey = "";
  private box?: THREE.BoxGeometry;
  private faceGeometry = new THREE.PlaneGeometry(4.96,3.66);
  private topGeometry = new THREE.PlaneGeometry(4.72,.30);
  private inspectionCoverGeometry = new THREE.PlaneGeometry(2.9,2.9);
  private inspectionLabelGeometry = new THREE.PlaneGeometry(1.85,.46);
  private inspectionView = new THREE.PerspectiveCamera();
  private inspectionSpan = new THREE.Vector2();
  private inspectionCenter = new THREE.Vector3(0,SHELL.height/2,(SHELL.front+SHELL.back)/2);
  private shell = new THREE.MeshStandardMaterial({color: "#e3ded4", roughness:.55, metalness:.03});
  private shellFront?: HTMLCanvasElement;
  private shellSide?: HTMLCanvasElement;
  private shellTop?: HTMLCanvasElement;
  private boardMaterial = new THREE.MeshStandardMaterial({color:"#e5e1d7",roughness:.7});
  constructor(private createCassette?: () => THREE.Group, private setClarity?: (shell: THREE.Group, amount: number) => void) {
    this.root.add(this.boards);
    // Use the transport's settled inspection bearing without moving the rack camera.
    const view=archiveCameraTarget(1280,800,1,{x:0,y:0,z:0},false);
    this.inspectionView.position.set(view.eye.x-view.aim.x,view.eye.y-view.aim.y,view.eye.z-view.aim.z);
    this.inspectionView.lookAt(0,0,0);
    const inverse=this.inspectionView.quaternion.clone().invert();
    const bounds=new THREE.Box3().setFromPoints([SHELL.back,SHELL.front].flatMap(z=>[-2.5,2.5].flatMap(x=>[0,SHELL.height].map(y=>new THREE.Vector3(x,y,z).sub(this.inspectionCenter).applyQuaternion(inverse)))));
    this.inspectionSpan.set(bounds.max.x-bounds.min.x,bounds.max.y-bounds.min.y);
    if (!createCassette) {
      // The existing Canvas2D archive uses these same measured shell dimensions
      // and cached textures; it never needs to create a WebGL context.
      this.box=new THREE.BoxGeometry(SHELL.halfWidth*2,SHELL.height,SHELL.front-SHELL.back);
      this.shellFront=clearShellTexture();this.shellSide=shellTexture("side");this.shellTop=shellTexture("top");
    }
  }
  begin(camera: THREE.PerspectiveCamera, origins: DiscoverySource[]) {
    this.initialCamera = camera.clone();
    this.origins = origins;
    const forward=camera.getWorldDirection(new THREE.Vector3());
    const center=origins[0]?.position.clone().add(new THREE.Vector3(0,1.85,0));
    this.initialDistance=center?Math.max(1,center.sub(camera.position).dot(forward)):140;
    this.initialFocus.copy(camera.position).addScaledVector(forward,this.initialDistance);
  }
  set(state: DiscoveryState) { this.state = state; }
  cover(id: string, image: HTMLImageElement) {
    this.covers.set(id,image);
    const tape=this.tapes.find(t=>t.id===id),entry=this.displayed.find(t=>t.id===id);
    if(tape&&entry) {
      drawDiscoveryFace(tape.face,entry,image,this.state?.selected===id); tape.texture.needsUpdate=true;
      if(tape.inspection){drawCassetteCover(tape.inspection.cover,image,entry.title);tape.inspection.coverPrint.material.map!.needsUpdate=true;}
    }
  }
  private createInspection(tape: Tape, entry: DiscoveryEntry) {
    const group=new THREE.Group();group.name="discovery-inspection";
    const cover=document.createElement("canvas"),label=document.createElement("canvas");
    cover.width=cover.height=1024;label.width=1024;label.height=256;
    drawCassetteCover(cover,this.covers.get(tape.id)??null,entry.title);
    drawCassetteLabel(label,entry.title,entry.subtitle);
    const print=(canvas:HTMLCanvasElement,geometry:THREE.PlaneGeometry,name:string)=>{
      const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=8;
      const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({map:texture,toneMapped:false,transparent:true,depthWrite:false,opacity:0}));
      mesh.name=name;group.add(mesh);return mesh;
    };
    const coverPrint=print(cover,this.inspectionCoverGeometry,"discovery-inspection-cover");coverPrint.position.set(0,1.73,.255);
    const labelPrint=print(label,this.inspectionLabelGeometry,"discovery-inspection-label");labelPrint.position.set(1.05,3.41,.255);
    tape.inspection={group,cover,label,coverPrint,labelPrint};tape.group.add(group);
  }
  private clearInspection(tape: Tape) {
    if(!tape.inspection)return;
    for(const mesh of [tape.inspection.coverPrint,tape.inspection.labelPrint]){mesh.material.map?.dispose();mesh.material.dispose();}
    tape.inspection.group.removeFromParent();tape.inspection=undefined;
  }
  private clearTapes() {
    for(const tape of this.tapes) { this.clearInspection(tape);this.root.remove(tape.group); tape.texture.dispose(); tape.topTexture.dispose(); tape.print.material.dispose();tape.topPrint.material.dispose();if(tape.shell)disposeDiscoveryCassette(tape.shell); }
    this.tapes=[];
  }
  private syncEntries() {
    if(!this.state||this.entriesKey===this.motion.key)return;
    this.entriesKey=this.motion.key;
    this.clearTapes(); this.displayed=discoverySlots(this.state.entries);
    const ids=new Set(this.displayed.map(e=>e.id)); for(const id of this.covers.keys())if(!ids.has(id))this.covers.delete(id);
    for(const entry of this.displayed) {
      const face=document.createElement("canvas");drawDiscoveryFace(face,entry,this.covers.get(entry.id));
      const texture=new THREE.CanvasTexture(face);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4;
      const group=new THREE.Group(),shell=this.createCassette?.()??null;
      if(shell)group.add(shell);
      else {
        const body=new THREE.Mesh(this.box!,this.shell);body.position.set(0,SHELL.height/2,(SHELL.front+SHELL.back)/2);
        body.userData.discoveryArchiveShell=true;group.add(body);
      }
      const print=new THREE.Mesh(this.faceGeometry,new THREE.MeshBasicMaterial({map:texture,toneMapped:false,transparent:true,depthWrite:false})); print.position.set(0,1.85,.26);
      const top=document.createElement("canvas");drawDiscoveryTop(top,entry);
      const topTexture=new THREE.CanvasTexture(top);topTexture.colorSpace=THREE.SRGBColorSpace;topTexture.anisotropy=8;
      const topPrint=new THREE.Mesh(this.topGeometry,new THREE.MeshBasicMaterial({map:topTexture,toneMapped:false,transparent:true,depthWrite:false}));
      topPrint.name="discovery-title-on-top";topPrint.rotation.x=-Math.PI/2;topPrint.position.set(0,SHELL.height+.012,(SHELL.front+SHELL.back)/2);
      group.add(print,topPrint);this.root.add(group);
      this.tapes.push({group,shell,print,topPrint,top,topTexture,face,texture,id:entry.id,lift:0,extraction:0});
    }
  }
  private disposeBoards() {for(const o of this.boards.children)(o as THREE.Mesh).geometry.dispose();this.boards.clear();}
  update(dt: number, width: number, height: number, camera: THREE.PerspectiveCamera): boolean {
    const state=this.state;if(!state||!this.initialCamera)return false;
    this.motion.step(dt,state);this.syncEntries();
    const layout=discoveryLayout(width,height,this.tapes.length,state.top);
    const scale=layout.tapeWidth/5, cameraProgress=this.motion.camera;
    const target=this.targetCamera;target.aspect=width/height;target.near=.1;target.far=500;
    target.fov=THREE.MathUtils.radToDeg(2*Math.atan(height/(2*scale*140)));
    target.position.set(0,125,Math.sqrt(140*140-125*125));target.lookAt(0,0,0);target.updateProjectionMatrix();target.updateMatrixWorld();
    camera.quaternion.copy(this.initialCamera.quaternion).slerp(target.quaternion,cameraProgress);
    // Orbit the interpolated focus: lerping the eye along a chord while slerping
    // its bearing makes a long-lens camera look past the tapes mid-transition.
    const distance=mix(this.initialDistance,140,cameraProgress);
    camera.position.copy(this.initialFocus).multiplyScalar(1-cameraProgress)
      .addScaledVector(new THREE.Vector3(0,0,1).applyQuaternion(camera.quaternion),distance);
    // Canvas2D's perspective frame also uses world-up; keep both views roll-free.
    camera.lookAt(this.initialFocus.clone().multiplyScalar(1-cameraProgress));
    const span=mix(2*this.initialDistance*Math.tan(THREE.MathUtils.degToRad(this.initialCamera.fov)/2),height/scale,cameraProgress);
    camera.fov=THREE.MathUtils.radToDeg(2*Math.atan(span/(2*distance)));camera.aspect=width/height;camera.updateProjectionMatrix();camera.updateMatrixWorld();
    const up=new THREE.Vector3(0,1,0).applyQuaternion(target.quaternion);
    const right=new THREE.Vector3(1,0,0).applyQuaternion(target.quaternion);
    const depth=new THREE.Vector3(0,0,1).applyQuaternion(target.quaternion);
    const world=(x:number,y:number,z=0)=>new THREE.Vector3().addScaledVector(right,(x-width/2)/scale).addScaledVector(up,(height/2-y)/scale).addScaledVector(depth,z);
    const wide=width>=800;
    const inspectionTop=state.top+18,inspectionBottom=wide?height-64:state.top+Math.min((height-state.top)*.38,225)-8;
    const inspectionLeft=wide?24:width*.08,inspectionRight=wide?width*.53:width*.92;
    const inspectionPerspective=(140-8)/140;
    const inspectionScale=Math.max(.1,Math.min((inspectionRight-inspectionLeft)/(scale*this.inspectionSpan.x),(inspectionBottom-inspectionTop)/(scale*this.inspectionSpan.y)))*inspectionPerspective*.97;
    const inspectionRotation=target.quaternion.clone().multiply(this.inspectionView.quaternion.clone().invert());
    const inspectionPosition=world(width/2+((inspectionLeft+inspectionRight)/2-width/2)*inspectionPerspective,height/2+((inspectionTop+inspectionBottom)/2-height/2)*inspectionPerspective,8)
      .sub(this.inspectionCenter.clone().applyQuaternion(inspectionRotation).multiplyScalar(inspectionScale));
    const boardKey=`${layout.columns}:${layout.rows}:${layout.tapeWidth}`;
    if(boardKey!==this.boardKey) {
      this.boardKey=boardKey;this.disposeBoards();
      for(let row=0;row<layout.rows;row++) {
        const inRow=layout.columns;
        const w=(inRow*layout.tapeWidth+(inRow-1)*34+32)/scale;
        const board=new THREE.Mesh(new THREE.BoxGeometry(w,.1,.8),this.boardMaterial);
        const lip=new THREE.Mesh(new THREE.BoxGeometry(w,.16,.07),this.boardMaterial);
        board.receiveShadow=true;board.castShadow=true;this.boards.add(board,lip);
      }
    }
    const boardProgress=this.motion.boards;
    this.boards.visible=boardProgress>0;
    for(let row=0;row<layout.rows;row++) {
      const z=-(layout.rows-1-row)*.8;
      const base=world(width/2,state.top+22+row*layout.rowStep+layout.tapeHeight+9-state.scroll,z);
      for(let j=0;j<2;j++) {const b=this.boards.children[row*2+j];b.position.copy(base);b.position.y-=8*(1-boardProgress);b.position.z+=j?.36:0;b.scale.set(boardProgress,boardProgress,boardProgress);}
    }
    const phase=this.motion.phase(state);
    let animating=phase!=="ready"&&phase!=="closed"&&phase!=="waiting";
    const rects:DiscoveryFrame["rects"]=[];
    for(let i=0;i<this.tapes.length;i++) {
      const tape=this.tapes[i],cell=layout.cell(i),blank=this.displayed[i].kind==="blank",selected=!blank&&state.selected===tape.id;
      if(tape.selected!==selected) {tape.selected=selected;drawDiscoveryFace(tape.face,this.displayed[i],this.covers.get(tape.id),selected);tape.texture.needsUpdate=true;drawDiscoveryTop(tape.top,this.displayed[i],selected);tape.topTexture.needsUpdate=true;}
      const lift=!blank&&state.hovered===tape.id&&!state.selected&&!state.reduced ? .16 : 0;
      tape.lift=state.reduced?0:settle(tape.lift,lift,dt);
      const previousExtraction=tape.extraction;
      tape.extraction=state.reduced?Number(selected):settle(tape.extraction,Number(selected),dt);
      if(selected&&!tape.inspection)this.createInspection(tape,this.displayed[i]);
      if(!selected&&tape.extraction===0)this.clearInspection(tape);
      if(tape.shell&&previousExtraction!==tape.extraction)this.setClarity?.(tape.shell,tape.extraction);
      animating ||= tape.lift!==lift||tape.extraction!==Number(selected);
      const end=world(cell.x+layout.tapeWidth/2,cell.y+layout.tapeHeight-state.scroll,-(layout.rows-1-cell.row)*.8);
      const s=this.motion.tapeSpread(i,this.tapes.length);
      const pose=discoveryEase((tape.extraction-.1)/.9)*s,clearance=discoveryEase(tape.extraction/.35)*s;
      end.lerp(inspectionPosition,pose).addScaledVector(depth,(clearance-pose)*10);
      end.y+=tape.lift-(1-this.motion.swap)*.65;
      const source=this.origins[i];
      const origin=source?.position.clone()??new THREE.Vector3((i%5-2)*5.4,-4.6,(Math.floor(i/5)-4)*.7);
      origin.y=-4.6;
      const arc=Math.sin(s*Math.PI);
      tape.group.position.copy(origin).lerp(end,s);
      tape.group.position.y+=arc*1.2;tape.group.position.addScaledVector(depth,arc*.3);
      tape.group.quaternion.setFromEuler(source?.flattenedRotation??source?.rotation??new THREE.Euler()).slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(-.08*s,0,0)),s).slerp(inspectionRotation,pose);
      const endScale=mix(1,inspectionScale,pose)*(1-.08*(1-this.motion.swap));
      tape.group.scale.copy(source?.scale??new THREE.Vector3(1,1,1)).lerp(new THREE.Vector3(endScale,endScale,endScale),s);
      tape.group.visible=this.motion.handoff&&this.motion.swap>0;
      const mat=tape.print.material;
      mat.color.setScalar(state.selected && !selected ? .72 : .94+.06*this.motion.labels);
      const artwork=discoveryEase((tape.extraction-.18)/.64);
      mat.opacity=blank?0:this.motion.labels*(1-artwork);
      tape.topPrint.material.opacity=blank?0:this.motion.labels*(1-artwork);
      if(tape.inspection)for(const mesh of [tape.inspection.coverPrint,tape.inspection.labelPrint])mesh.material.opacity=this.motion.labels*artwork;
      tape.group.updateMatrixWorld(true);
      const corners=[SHELL.back,.27].flatMap(z=>[[-2.5,3.72],[2.5,3.72],[2.5,0],[-2.5,0]].map(([x,y])=>new THREE.Vector3(x,y,z).applyMatrix4(tape.group.matrixWorld).project(camera)));
      const xs=corners.map(p=>(p.x+1)*width/2),ys=corners.map(p=>(1-p.y)*height/2);
      rects.push({id:tape.id,x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)});
    }
    // Only the exposed label of a rear cassette is clickable. Hidden portions
    // must not steal pointer events from a cassette in front of them.
    if(!state.selected)for(let i=0;i+layout.columns<rects.length;i++) {
      rects[i].height=Math.max(18,Math.min(rects[i].height,rects[i+layout.columns].y-rects[i].y-4));
    }
    this.root.updateMatrixWorld(true);
    this.onFrame?.({phase:this.motion.phase(state),progress:this.motion.time/DISCOVERY_DURATION,rects:rects.filter((_,i)=>this.displayed[i].kind!=="blank"),contentHeight:layout.contentHeight});
    return animating;
  }
  /** Canvas2D projects the same boxes and label quads, with depth sorting. */
  paint(context:CanvasRenderingContext2D,camera:THREE.PerspectiveCamera,width:number,height:number) {
    const project=(v:THREE.Vector3)=>{v.project(camera);return{x:(v.x+1)*width/2,y:(1-v.y)*height/2};};
    const polygon=(points:{x:number;y:number}[],color:string)=>{context.beginPath();points.forEach((p,i)=>i?context.lineTo(p.x,p.y):context.moveTo(p.x,p.y));context.closePath();context.fillStyle=color;context.fill();};
    const meshes:THREE.Mesh[]=[];this.root.traverseVisible(o=>{if(o instanceof THREE.Mesh)meshes.push(o);});
    meshes.sort((a,b)=>new THREE.Vector3().setFromMatrixPosition(a.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z-new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z);
    for(const mesh of meshes) {
      const geometry=mesh.geometry;
      if(geometry instanceof THREE.BoxGeometry) {
        const {width:w,height:h,depth:d}=geometry.parameters;
        const p=(x:number,y:number,z:number)=>project(new THREE.Vector3(x*w/2,y*h/2,z*d/2).applyMatrix4(mesh.matrixWorld));
        if(mesh.userData.discoveryArchiveShell) {
          const face=(image:HTMLCanvasElement,point:(u:number,v:number)=>{x:number;y:number})=>drawTextureQuad(context,image,[point(0,0),point(1,0),point(1,1),point(0,1)],point,true);
          face(this.shellTop!,(u,v)=>p(u*2-1,1,v*2-1));
          face(this.shellSide!,(u,v)=>p(-1,1-v*2,u*2-1));
          face(this.shellFront!,(u,v)=>p(u*2-1,1-v*2,1));
          continue;
        }
        polygon([p(-1,1,-1),p(1,1,-1),p(1,1,1),p(-1,1,1)],"#f0ede6");
        polygon([p(-1,1,1),p(1,1,1),p(1,-1,1),p(-1,-1,1)],"#d6d0c5");
        polygon([p(1,1,1),p(1,1,-1),p(1,-1,-1),p(1,-1,1)],"#bdb6a8");
      } else if(geometry instanceof THREE.PlaneGeometry) {
        const texture=(mesh.material as THREE.MeshBasicMaterial).map;
        if(!texture?.image||(mesh.material as THREE.MeshBasicMaterial).opacity===0)continue;
        const {width:w,height:h}=geometry.parameters;
        const p=(u:number,v:number)=>project(new THREE.Vector3((u-.5)*w,(.5-v)*h,0).applyMatrix4(mesh.matrixWorld));
        context.save();context.globalAlpha=(mesh.material as THREE.MeshBasicMaterial).opacity;
        drawTextureQuad(context,texture.image as HTMLCanvasElement,[p(0,0),p(1,0),p(1,1),p(0,1)],p,true);
        context.restore();
        const dim=1-(mesh.material as THREE.MeshBasicMaterial).color.r;
        if(dim>0){context.save();context.globalAlpha=dim;polygon([p(0,0),p(1,0),p(1,1),p(0,1)],"#000");context.restore();}
      }
    }
  }
  dispose() {this.clearTapes();this.disposeBoards();this.box?.dispose();this.faceGeometry.dispose();this.topGeometry.dispose();this.inspectionCoverGeometry.dispose();this.inspectionLabelGeometry.dispose();this.shell.dispose();this.boardMaterial.dispose();this.covers.clear();this.root.removeFromParent();}
}
