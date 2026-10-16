import * as THREE from "three";
import { drawTextureQuad } from "./texture-quad-2d";
import { SHELL, clearShellTexture, shellTexture } from "./cassette-shell-2d";
import { disposeDiscoveryCassette } from "./discovery-cassette";
import { drawCassetteCover, drawCassetteLabel } from "./cassette-print";
import { archiveCameraTarget } from "./archive-camera-2d";
import { DiscoveryMotion, discoveryEase, discoveryLayout, drawDiscoveryFace, drawDiscoveryTop, type DiscoveryState, type DiscoveryFrame, type DiscoveryEntry } from "./discovery-layout";

type Print = THREE.Mesh<THREE.PlaneGeometry,THREE.MeshBasicMaterial>;
type Inspection = { group: THREE.Group; cover: HTMLCanvasElement; label: HTMLCanvasElement; coverPrint: Print; labelPrint: Print };
type Tape = { group: THREE.Group; shell: THREE.Group | null; print: Print; topPrint: Print; top: HTMLCanvasElement; topTexture: THREE.CanvasTexture; face: HTMLCanvasElement; texture: THREE.CanvasTexture; id: string; lift: number; extraction: number; selected?: boolean; inspection?: Inspection };
export type DiscoverySource = { position: THREE.Vector3; rotation?: THREE.Euler; texture?: HTMLCanvasElement };
const mix = THREE.MathUtils.lerp;
const settle = (a: number,b: number,dt: number) => Math.abs(a-b)<.001?b:mix(a,b,1-Math.exp(-dt*14));

export class DiscoveryBackdrop {
  readonly sources: DiscoverySource[];
  private matrices: Float32Array;
  private models: { object: THREE.Object3D; position: THREE.Vector3; rotation: THREE.Euler; visible: boolean }[];
  private sourceIndices: number[];
  private visibility: boolean[];
  constructor(private instances: THREE.InstancedMesh[], objects: THREE.Object3D[], camera: THREE.Camera) {
    this.visibility=instances.map(mesh=>mesh.visible);
    this.matrices=new Float32Array(instances[0]?.instanceMatrix.array??[]);
    this.models=objects.map(object=>({object,position:object.position.clone(),rotation:object.rotation.clone(),visible:object.visible}));
    const candidates: {source:DiscoverySource;index:number;distance:number}[]=[];
    for(let i=0;i<(instances[0]?.count??0);i++) {
      const position=new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(this.matrices,i*16));
      const p=position.clone().add(new THREE.Vector3(0,1.85,0)).project(camera);
      candidates.push({source:{position},index:i,distance:p.x*p.x+p.y*p.y});
    }
    candidates.sort((a,b)=>a.distance-b.distance);
    this.sources=candidates.map(c=>c.source);this.sourceIndices=candidates.map(c=>c.index);
  }
  update(flatten:number,spread:number,count:number) {
    this.instances.forEach((mesh,i)=>{mesh.visible=this.visibility[i]&&spread<1;});
    const hidden=new Set(this.sourceIndices.slice(0,count));
    const attribute=this.instances[0]?.instanceMatrix;
    if(attribute) {
      const data=attribute.array as Float32Array;data.set(this.matrices);
      for(let i=0;i<this.instances[0].count;i++) {
        const n=i*16;data[n+13]=mix(this.matrices[n+13],-4.6,flatten)-spread*35;
        if(hidden.has(i)&&spread>0) { data[n]=0;data[n+5]=0;data[n+10]=0; }
      }
      attribute.needsUpdate=true;this.instances[0].computeBoundingSphere();
    }
    for(const {object,position,rotation,visible} of this.models) {
      object.visible=visible&&spread<1;
      object.position.copy(position);object.position.y=mix(position.y,-4.6,flatten)-spread*35;
      object.rotation.set(rotation.x*(1-flatten),rotation.y*(1-flatten),rotation.z*(1-flatten));
    }
  }
  restore() {
    this.instances.forEach((mesh,i)=>{mesh.visible=this.visibility[i];});
    const attribute=this.instances[0]?.instanceMatrix;
    if(attribute){(attribute.array as Float32Array).set(this.matrices);attribute.needsUpdate=true;this.instances[0].computeBoundingSphere();}
    for(const {object,position,rotation,visible} of this.models){object.position.copy(position);object.rotation.copy(rotation);object.visible=visible;}
  }
}

/** Shared geometry, camera and projection for WebGL and Canvas2D. */
export class DiscoveryRack {
  readonly root = new THREE.Group();
  readonly motion = new DiscoveryMotion();
  onFrame?: (frame: DiscoveryFrame) => void;
  state: DiscoveryState | null = null;
  private tapes: Tape[] = [];
  private boards = new THREE.Group();
  private entriesKey = "";
  private covers = new Map<string,HTMLImageElement>();
  private origins: DiscoverySource[] = [];
  private initialCamera?: THREE.PerspectiveCamera;
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
    this.clearTapes(); this.displayed=this.state.entries;
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
    const scale=layout.tapeWidth/5, spread=this.motion.spread;
    const target=this.targetCamera;target.aspect=width/height;target.near=.1;target.far=500;
    target.fov=THREE.MathUtils.radToDeg(2*Math.atan(height/(2*scale*140)));
    target.position.set(0,125,Math.sqrt(140*140-125*125));target.lookAt(0,0,0);target.updateProjectionMatrix();target.updateMatrixWorld();
    camera.position.copy(this.initialCamera.position).lerp(target.position,spread);
    camera.quaternion.copy(this.initialCamera.quaternion).slerp(target.quaternion,spread);
    camera.fov=mix(this.initialCamera.fov,target.fov,spread);camera.aspect=width/height;camera.updateProjectionMatrix();camera.updateMatrixWorld();
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
    this.boards.visible=spread>0;
    for(let row=0;row<layout.rows;row++) {
      const z=-(layout.rows-1-row)*.8;
      const base=world(width/2,state.top+22+row*layout.rowStep+layout.tapeHeight+9-state.scroll,z);
      for(let j=0;j<2;j++) {const b=this.boards.children[row*2+j];b.position.copy(base);b.position.y-=8*(1-spread);b.position.z+=j?.36:0;b.scale.y=spread;}
    }
    const phase=this.motion.phase(state);
    let animating=phase!=="ready"&&phase!=="closed"&&phase!=="waiting";
    const rects:DiscoveryFrame["rects"]=[];
    for(let i=0;i<this.tapes.length;i++) {
      const tape=this.tapes[i],cell=layout.cell(i),selected=state.selected===tape.id;
      if(tape.selected!==selected) {tape.selected=selected;drawDiscoveryFace(tape.face,this.displayed[i],this.covers.get(tape.id),selected);tape.texture.needsUpdate=true;drawDiscoveryTop(tape.top,this.displayed[i],selected);tape.topTexture.needsUpdate=true;}
      const lift=state.hovered===tape.id&&!state.selected&&!state.reduced ? .16 : 0;
      tape.lift=state.reduced?0:settle(tape.lift,lift,dt);
      const previousExtraction=tape.extraction;
      tape.extraction=state.reduced?Number(selected):settle(tape.extraction,Number(selected),dt);
      if(selected&&!tape.inspection)this.createInspection(tape,this.displayed[i]);
      if(!selected&&tape.extraction===0)this.clearInspection(tape);
      if(tape.shell&&previousExtraction!==tape.extraction)this.setClarity?.(tape.shell,tape.extraction);
      animating ||= tape.lift!==lift||tape.extraction!==Number(selected);
      const end=world(cell.x+layout.tapeWidth/2,cell.y+layout.tapeHeight-state.scroll,-(layout.rows-1-cell.row)*.8);
      const pose=discoveryEase((tape.extraction-.1)/.9),clearance=discoveryEase(tape.extraction/.35);
      end.lerp(inspectionPosition,pose).addScaledVector(depth,(clearance-pose)*10);
      end.y+=tape.lift-(1-this.motion.swap)*.65;
      const origin=this.origins[i%Math.max(1,this.origins.length)]?.position.clone()??new THREE.Vector3((i%5-2)*5.4,-4.6,(Math.floor(i/5)-4)*.7);
      origin.y=-4.6;
      tape.group.position.copy(origin).lerp(end,spread);
      tape.group.quaternion.setFromEuler(new THREE.Euler(-.08*spread,0,0)).slerp(inspectionRotation,pose);
      tape.group.scale.setScalar(mix(1,inspectionScale,pose)*(.92+.08*this.motion.swap));
      tape.group.visible=spread>0&&this.motion.swap>0;
      const mat=tape.print.material;
      mat.color.setScalar(state.selected && !selected ? .72 : .94+.06*this.motion.labels);
      const artwork=discoveryEase((tape.extraction-.18)/.64);
      mat.opacity=this.motion.labels*(1-artwork);
      tape.topPrint.material.opacity=this.motion.labels*(1-artwork);
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
    this.onFrame?.({phase:this.motion.phase(state),progress:this.motion.time/1.35,rects,contentHeight:layout.contentHeight});
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
        if(!texture?.image)continue;
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
