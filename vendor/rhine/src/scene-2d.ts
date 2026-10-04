import { ArchiveDrag, ArchivePlaneMomentum, type DragPosition } from "./archive-drag";
import { COLUMN_SPACING, ROW_SPACING, selectionCell, wrap, type ArchiveCell, type ArchiveNavigation } from "./archive-loop";
import { baselineSelectionWave, columnStrength, idleWave, settlingWave, INSPECTION_LIFT, damp, smooth, returnStep } from "./motion";
import { fullMotion, type MotionPreferences } from "./motion-preferences";
import { PlaybackEntry, playbackRipple } from "./playback-entry";
import { archiveCameraTarget, advanceCamera, cameraSettled, perspectiveFrame, type CameraState, type Vector } from "./archive-camera-2d";
import { SHELL, shellTexture, clearShellTexture, floorShadowTexture } from "./cassette-shell-2d";
import { drawTextureQuad, drawEdgeTexture } from "./texture-quad-2d";
import { drawArchiveLabel } from "./archive-label";
import { labelMarkSvg } from "./brand";
import { drawCassetteCover, drawCassetteLabel } from "./cassette-print";
import type { ArchiveTrack } from "./archive-artwork";
import type { RenderQuality } from "./render-quality";

type Point = { x: number; y: number };
type Card = {
  cell: ArchiveCell; index: number; depth: number; front: Point[]; top: Point[]; side: Point[];
  fog: number; selected: boolean; position: Vector; frontFacing: boolean;
  project: (x: number,y: number,z: number)=>Point; frontFog: number[];
  texture?: HTMLCanvasElement;
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const approach = (value: number, target: number, rate: number, dt: number) => {
  const next = lerp(value, target, 1 - Math.exp(-rate * dt));
  return Math.abs(next - target) < .0001 ? target : next;
};
const inside = (p: Point, polygon: Point[]) => {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
};

/** Long-lens perspective with cached material layers; creates only Canvas 2D contexts. */
export class ArchiveScene2D {
  onInvalidate?: () => void;
  onSelect?: (index: number, cell?: ArchiveCell) => void;
  onOpen?: (index: number) => void;
  onPlaybackCassetteOpen?: () => void;
  onNavigate?: (axis: "row" | "lane", direction: number) => void;
  private canvas = document.createElement("canvas");
  private context: CanvasRenderingContext2D;
  private events = new AbortController();
  private disposed = false;
  private dirty = true;
  private last = 0;
  private clock = 0;
  private renderedFrames = 0;
  private wasMoving = false;
  private drawnCards: Card[] = [];
  private fieldCache = new Map<number,Map<number,number>>();
  private edgeGradients = new Map<string,CanvasGradient>();
  private outgoing: {cell:ArchiveCell;lift:{value:number;velocity:number};rotation:number;texture:HTMLCanvasElement;returnY:number|null}[]=[];
  private width = 1;
  private height = 1;
  private motion = fullMotion();
  // ArchiveCanvas pauses updates under the boot overlay. Its first active update
  // must reveal the scene naturally, as the original 3D scene does.
  private revealed = true;
  private presence = 0;
  private mode: "hidden" | "archive" | "detail" = "archive";
  private detail = 0;
  private lift = .4;
  private liftSpring = { value: .4, velocity: 0 };
  private returnY: number | null = null;
  private camera?: CameraState;
  private rotation = 0;
  private targetRotation = 0;
  private pointerId: number | null = null;
  private pointerX = 0;
  private drag = new ArchiveDrag();
  private dragOrigin: DragPosition = { lane: 0, row: 12 };
  private momentum: ArchivePlaneMomentum | null = null;
  private focus: DragPosition = { lane: 0, row: 12 };
  private hover: ArchiveCell | null = null;
  private lastInteraction = 0;
  private pulses: { cell: ArchiveCell; time: number }[] = [];
  private idleGain = 0;
  private waveGain = 0;
  private reducedMix = 0;
  private archivePlayback = false;
  private playing = false;
  private disabledWave = false;
  private reducedWave = false;
  private playbackEntry = new PlaybackEntry();
  private playbackReturn: ArchiveCell | null = null;
  private trackId: string | null = null;
  private trackIndex = 0;
  private track = { title: "", artist: "", cover: null as HTMLImageElement | null };
  private archiveTracks: readonly ArchiveTrack[] = [];
  private covers: (HTMLImageElement | null)[] = [];
  private prints = new Map<string, HTMLCanvasElement>();
  private front = shellTexture('front');
  private clearFront = clearShellTexture();
  private back = shellTexture('back');
  private sideTexture = shellTexture('side');
  private topTexture = shellTexture('top');
  private shadowTexture = floorShadowTexture();
  private labelMark = new Image();
  private archiveLabel = document.createElement('canvas');
  private coverCanvas = document.createElement("canvas");
  private labelCanvas = document.createElement("canvas");
  selectedCell: ArchiveCell = { lane: 0, row: 12 };

  constructor(private container: HTMLElement, private count: number, private titles: readonly string[]) {
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D is unavailable");
    this.context = context;
    this.canvas.setAttribute("aria-label", "音乐档案二维磁带阵列，拖动或方向键选择，Enter 抽取磁带");
    this.canvas.tabIndex = 0;
    this.canvas.style.touchAction = "none";
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.container.appendChild(this.canvas);
    this.coverCanvas.width = this.coverCanvas.height = 512;
    this.labelCanvas.width = 1024; this.labelCanvas.height = 256;
    this.archiveLabel.width=1024;this.archiveLabel.height=440;
    this.bindInput();
    this.resize();
  }
  async load() {
    this.labelMark.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(labelMarkSvg)}`;
    await this.labelMark.decode();
    if(this.disposed)return;
    this.prints.clear();this.invalidate();
  }
  private invalidate() { if (!this.disposed) { this.dirty = true; this.onInvalidate?.(); } }
  resumeUpdates() { this.last = performance.now() / 1000; }
  setQuality(_value: RenderQuality | boolean) {}
  setSuperPerformance(_enabled: boolean) {}
  setMotion(value: MotionPreferences) {
    this.motion = { ...value };
    if (!value.dragMomentum) this.momentum = null;
    if (!value.selectionWave) this.pulses = [];
    if (!value.idleWave) this.idleGain = 0;
    this.invalidate();
  }
  private get reduced() { return Object.values(this.motion).every(value => !value); }
  revealImmediately() { this.revealed = true; this.invalidate(); }
  setMode(mode: "hidden" | "archive" | "detail") {
    if (this.mode === mode) return;
    if(this.mode==='detail'&&mode!=='detail'&&this.rotation!==0)this.returnY=this.heightAt(this.selectedCell)+this.lift;
    this.cancelPointer(); this.hover = null; this.mode = mode;
    if (mode !== "archive") this.pulses = [];
    if (mode !== "detail") this.targetRotation = 0;
    this.invalidate();
  }
  select(index: number, navigation?: ArchiveNavigation) {
    const cell = selectionCell(index, this.selectedCell, navigation);
    if (cell.lane === this.selectedCell.lane && cell.row === this.selectedCell.row) return;
    this.retainSelected();
    this.selectedCell = cell;
    this.lastInteraction = this.clock;
    if (this.motion.selectionWave && !this.archiveTracks.length && !this.drag.active && !this.momentum && !this.archivePlayback)
      this.pulses.push({ cell: { ...cell }, time: this.clock });
    this.invalidate();
  }
  setDeck(active: boolean, playing: boolean) {
    if (active !== this.archivePlayback) {
      this.cancelPointer();
      if (active) {
        this.playbackReturn = { ...this.selectedCell };
        this.playbackEntry.start(); this.waveGain = 0; this.pulses = []; this.trackId = null;
      } else {
        this.playbackEntry.stop(); this.trackId = null;
        if (this.playbackReturn) this.selectedCell = this.playbackReturn;
        this.playbackReturn = null;
      }
    }
    this.archivePlayback = active; this.playing = active && playing; this.invalidate();
  }
  setPlaybackTrack(id: string, index: number, count: number) {
    if (!this.archivePlayback) return;
    if (this.trackId !== null && id !== this.trackId) {
      this.retainSelected();
      const forward = index === (this.trackIndex + 1) % Math.max(1, count);
      const backward = !forward && (index === this.trackIndex - 1 || (this.trackIndex === 0 && index === count - 1));
      this.selectedCell = { ...this.selectedCell, row: this.selectedCell.row + (backward ? -1 : 1) };
      this.waveGain = 0;
      if (this.reducedWave) this.playbackEntry.waveTime = 0;
    }
    this.trackId = id; this.trackIndex = index; this.invalidate();
  }
  private retainSelected() {
    if(this.lift<.03)return;
    this.outgoing=this.outgoing.filter(o=>o.cell.lane!==this.selectedCell.lane||o.cell.row!==this.selectedCell.row);
    this.outgoing.push({cell:{...this.selectedCell},lift:{value:this.lift,velocity:this.liftSpring.velocity},rotation:this.rotation,texture:this.print(wrap(this.selectedCell.row-12,this.count),true),returnY:this.rotation!==0?this.heightAt(this.selectedCell)+this.lift:null});
    if(this.outgoing.length>8)this.outgoing.shift();
    this.lift=this.liftSpring.value=0;this.liftSpring.velocity=0;this.rotation=this.targetRotation=0;this.returnY=null;
  }
  setDisableCassetteMotionWhilePlaying(value: boolean) {
    this.disabledWave = value; if (value) this.waveGain = 0; this.invalidate();
  }
  setReduceCassetteMotionWhilePlaying(value: boolean) { this.reducedWave = value; this.invalidate(); }
  setTrack(title: string, artist: string, cover: HTMLImageElement | null) {
    this.track = { title, artist, cover }; this.prints.delete("playing"); this.invalidate();
  }
  setArchiveTracks(tracks: readonly ArchiveTrack[]) {
    this.archiveTracks = tracks; this.covers = tracks.map(() => null); this.prints.clear(); this.invalidate();
  }
  setArchiveCover(index: number, cover: HTMLImageElement) {
    if (!this.archiveTracks[index]) return;
    this.covers[index] = cover; this.prints.delete(String(index)); this.prints.delete('selected:'+index); this.invalidate();
  }
  resize() {
    this.width = Math.max(1, this.container.clientWidth); this.height = Math.max(1, this.container.clientHeight);
    const ratio = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(2_073_600 / (this.width * this.height)));
    this.canvas.width = Math.max(1, Math.floor(this.width * ratio));
    this.canvas.height = Math.max(1, Math.floor(this.height * ratio));
    this.context.setTransform(this.canvas.width / this.width, 0, 0, this.canvas.height / this.height, 0, 0);
    this.edgeGradients.clear();
    this.container.dataset.renderQuality = JSON.stringify({ renderer: "canvas2d", ratio, width: this.canvas.width, height: this.canvas.height });
    this.invalidate();
  }
  private print(index: number, selected: boolean) {
    const key = selected && this.archivePlayback ? "playing" : selected ? 'selected:'+index : String(index);
    let canvas = this.prints.get(key);
    if (canvas) return canvas;
    canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 474;
    const c = canvas.getContext("2d")!;
    c.drawImage(selected ? this.clearFront : this.front, 0, 0);
    const archive = this.archiveTracks[index];
    const playing = key === "playing";
    const title = playing ? this.track.title : archive?.title ?? this.titles[index] ?? "音乐档案";
    const artist = playing ? this.track.artist : archive?.artist ?? `ARCHIVE / ${String(index + 1).padStart(2, "0")}`;
    if (archive || playing) {
      drawCassetteCover(this.coverCanvas, playing ? this.track.cover : this.covers[index] ?? null, title);
      c.drawImage(this.coverCanvas, 134.4, 66.56, 371.2, 371.2);
    }
    if(archive||playing) {drawCassetteLabel(this.labelCanvas,title,artist);c.drawImage(this.labelCanvas,336,7.68,236.8,58.88)}
    else if(this.labelMark.complete&&this.labelMark.naturalWidth) {drawArchiveLabel(this.archiveLabel,index,title,this.labelMark);c.drawImage(this.archiveLabel,82.56,55.04,126.72,58.88)}
    // Bound long sessions even if a caller supplies a very large archive.
    if(this.prints.size>=32)this.prints.delete(this.prints.keys().next().value!);
    this.prints.set(key, canvas);
    return canvas;
  }
  private selectedPosition(): Vector {
    return {x:(this.selectedCell.lane-this.focus.lane)*COLUMN_SPACING,y:this.heightAt(this.selectedCell)+this.lift,z:(this.selectedCell.row-this.focus.row)*ROW_SPACING-2.17};
  }
  private cameraTarget() {
    return archiveCameraTarget(this.width,this.height,this.detail,this.selectedPosition(),this.container.closest<HTMLElement>('[data-layout]')?.dataset.layout==='compact');
  }
  private frame() {return perspectiveFrame(this.camera??this.cameraTarget(),this.width,this.height,this.detail)}
  private heightAt(cell: ArchiveCell) {
    const cached=this.fieldCache.get(cell.lane)?.get(cell.row);if(cached!==undefined)return cached;
    const row = cell.row - this.selectedCell.row;
    let height = -4.6 + settlingWave(row, 26.56) * columnStrength(cell.lane, this.selectedCell.lane) * this.playbackEntry.shape;
    if (this.idleGain) height += idleWave(cell.row, cell.lane, this.clock) * this.idleGain;
    if (this.waveGain) {
      const distance = Math.hypot(row * ROW_SPACING, (cell.lane - this.selectedCell.lane) * COLUMN_SPACING);
      height += this.waveGain * playbackRipple(distance, this.playbackEntry.waveTime, this.reducedMix);
    }
    for (const pulse of this.pulses)
      height += baselineSelectionWave(Math.hypot(cell.row - pulse.cell.row, (cell.lane - pulse.cell.lane) * 2.2), this.clock - pulse.time);
    if (this.hover?.lane === cell.lane && this.hover.row === cell.row) height += .28;
    let lane=this.fieldCache.get(cell.lane);if(!lane)this.fieldCache.set(cell.lane,lane=new Map());lane.set(cell.row,height);
    return height;
  }
  private card(cell: ArchiveCell, frame: ReturnType<ArchiveScene2D["frame"]>): Card {
    const selected=cell.lane===this.selectedCell.lane&&cell.row===this.selectedCell.row;
    const outgoing=selected?undefined:this.outgoing.find(o=>o.cell.lane===cell.lane&&o.cell.row===cell.row);
    const position={x:(cell.lane-this.focus.lane)*COLUMN_SPACING,y:this.heightAt(cell)+(selected?this.lift:outgoing?.lift.value??0),z:(cell.row-this.focus.row)*ROW_SPACING-2.17};
    const angle=selected?this.rotation:outgoing?.rotation??0,cos=Math.cos(angle),sin=Math.sin(angle);
    const world=(a:number,b:number,c:number)=>({x:position.x+a*cos+c*sin,y:position.y+b,z:position.z-a*sin+c*cos});
    const project=(a:number,b:number,c:number)=>{const p=world(a,b,c);return frame.project(p.x,p.y,p.z)};
    const side=frame.direction.x*cos-frame.direction.z*sin<0?-SHELL.halfWidth:SHELL.halfWidth;
    const frontFacing=frame.direction.x*sin+frame.direction.z*cos>0,z=frontFacing?SHELL.front:SHELL.back;
    const corners=[world(-2.5,3.7,z),world(2.5,3.7,z),world(2.5,0,z),world(-2.5,0,z)];
    return {cell,index:wrap(cell.row-12,this.count),selected,position,project,frontFacing,texture:outgoing?.texture,
      depth:frame.depth(world(0,1.85,0)),fog:frame.fog(world(0,1.85,0)),frontFog:corners.map(frame.fog),
      front:corners.map(p=>frame.project(p.x,p.y,p.z)),
      top:[project(-2.5,3.7,SHELL.back),project(2.5,3.7,SHELL.back),project(2.5,3.7,SHELL.front),project(-2.5,3.7,SHELL.front)],
      side:[project(side,3.7,SHELL.back),project(side,3.7,SHELL.front),project(side,0,SHELL.front),project(side,0,SHELL.back)]};
  }
  private polygon(points: Point[], color: string | CanvasGradient) {
    const c = this.context;
    c.beginPath(); c.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) c.lineTo(points[i].x, points[i].y);
    c.closePath(); c.fillStyle = color; c.fill();
  }
  private edgePaint(card: Card) {
    const top=Math.round((card.side[0].y+card.side[1].y)/32)*16,bottom=Math.round((card.side[2].y+card.side[3].y)/32)*16;
    const fog=Math.round(card.fog*16)/16,key=top+':'+bottom+':'+fog;
    let gradient=this.edgeGradients.get(key);
    if(!gradient) {
      if(this.edgeGradients.size>=128)this.edgeGradients.clear();
      gradient=this.context.createLinearGradient(0,top,0,bottom);
      const tint=(rgb:number[])=>'rgb('+rgb.map((v,i)=>Math.round(lerp(v,[234,229,225][i],fog))).join(',')+')';
      gradient.addColorStop(0,tint([237,233,227]));gradient.addColorStop(.35,tint([224,216,203]));gradient.addColorStop(1,tint([180,161,138]));this.edgeGradients.set(key,gradient);
    }
    return gradient;
  }
  private paint() {
    const c=this.context;c.globalAlpha=1;c.fillStyle='#eae5e1';c.fillRect(0,0,this.width,this.height);
    const frame=this.frame(),cards:Card[]=[];
    let minLane=Infinity,maxLane=-Infinity,minRow=Infinity,maxRow=-Infinity;
    for(const y of [-5.2,1.8])for(const x of [-90,this.width+90])for(const sy of [-90,this.height+90]) {
      const p=frame.ground(x,sy,y);if(!p)continue;
      const lane=p.x/COLUMN_SPACING+this.focus.lane,row=(p.z+2.17)/ROW_SPACING+this.focus.row;
      minLane=Math.min(minLane,lane);maxLane=Math.max(maxLane,lane);minRow=Math.min(minRow,row);maxRow=Math.max(maxRow,row);
    }
    for(let lane=Math.floor(minLane)-1;lane<=Math.ceil(maxLane)+1;lane++)for(let row=Math.floor(minRow)-2;row<=Math.ceil(maxRow)+2;row++) {
      const cell={lane,row},selected=lane===this.selectedCell.lane&&row===this.selectedCell.row;
      const outgoing=this.outgoing.find(o=>o.cell.lane===lane&&o.cell.row===row);
      const x=(lane-this.focus.lane)*COLUMN_SPACING,z=(row-this.focus.row)*ROW_SPACING-2.17,y=this.heightAt(cell)+1.85+(selected?this.lift:outgoing?.lift.value??0);
      const depth=frame.depth({x,y,z});if(depth<.1||depth>frame.far+4)continue;
      const center=frame.project(x,y,z),radius=frame.scale*Math.hypot(2.5,1.85,.336)*Math.hypot(frame.state.eye.x-frame.state.aim.x,frame.state.eye.y-frame.state.aim.y,frame.state.eye.z-frame.state.aim.z)/Math.max(.1,depth-3.2);
      if(center.x+radius< -30||center.x-radius>this.width+30||center.y+radius< -30||center.y-radius>this.height+30)continue;
      const card=this.card({lane,row},frame),points=[...card.front,...card.top,...card.side];
      if(card.depth<.1||card.depth>frame.far+4||points.every(p=>p.x< -30)||points.every(p=>p.x>this.width+30)||points.every(p=>p.y< -30)||points.every(p=>p.y>this.height+30))continue;
      cards.push(card);
    }
    if(!cards.some(card=>card.selected))cards.push(this.card(this.selectedCell,frame));
    for(const o of this.outgoing)if(!cards.some(c=>c.cell.lane===o.cell.lane&&c.cell.row===o.cell.row))cards.push(this.card(o.cell,frame));
    cards.sort((a,b)=>b.depth-a.depth);this.drawnCards=cards;
    const selected=cards.find(card=>card.selected)!;
    if(this.lift>.1) {
      const {x,z}=selected.position,height=Math.max(.1,selected.position.y+4.6+1.85),spread=.35+height*.14;
      const project=(u:number,v:number)=>frame.project(x+height*6/14+(u-.5)*(5+spread),-4.6,z+height*5/14+(v-.5)*(.5+spread));
      c.globalAlpha=.65/(1+height*.2);
      drawTextureQuad(c,this.shadowTexture,[project(0,0),project(1,0),project(1,1),project(0,1)],project);c.globalAlpha=1;
    }
    for(const card of cards) {
      const project=card.project;
      this.polygon(card.front,'#dfd7c9');
      if(card.selected||card.texture) {
        drawEdgeTexture(c,this.sideTexture,card.side);this.polygon(card.side,'rgba(234,229,225,'+card.fog+')');
        drawEdgeTexture(c,this.topTexture,card.top);this.polygon(card.top,'rgba(234,229,225,'+card.fog+')');
      } else {
        this.polygon(card.side,this.edgePaint(card));
        this.polygon(card.top,'rgb('+[246,243,237].map((v,i)=>Math.round(lerp(v,[234,229,225][i],card.fog))).join(',')+')');
      }
      const z=card.frontFacing?SHELL.front:SHELL.back;
      drawTextureQuad(c,card.frontFacing?card.texture??this.print(card.index,card.selected):this.back,card.front,(u,v)=>project(lerp(-2.5,2.5,u),3.7*(1-v),z),card.selected||Boolean(card.texture));
      // Contact occlusion is clipped to its receiving front, not a screen overlay.
      const neighbour={lane:card.cell.lane,row:card.cell.row+1},dy=this.heightAt(neighbour)-card.position.y;
      if(dy>-.2&&card.frontFacing) {
        const h=Math.min(3.55,Math.max(0,3.7+dy-.18));
        this.polygon([project(-2.4,h,z),project(2.4,h,z),project(2.4,Math.max(0,h-.09),z),project(-2.4,Math.max(0,h-.09),z)],'rgba(95,75,48,.07)');
      }
      const lo=Math.min(...card.frontFog),hi=Math.max(...card.frontFog);
      if(hi-lo>.08) {
        const left=(card.frontFog[0]+card.frontFog[3])/2,right=(card.frontFog[1]+card.frontFog[2])/2;
        const a=card.front[0],b=card.front[1],g=c.createLinearGradient(a.x,a.y,b.x,b.y);
        g.addColorStop(0,'rgba(234,229,225,'+left+')');g.addColorStop(1,'rgba(234,229,225,'+right+')');
        this.polygon(card.front,g);
      } else if(card.fog>0)this.polygon(card.front,'rgba(234,229,225,'+card.fog+')');
    }
    c.globalAlpha=1;this.renderedFrames++;
    this.container.dataset.inspection=this.mode==='detail'?this.detail===1&&this.lift===INSPECTION_LIFT?'ready':'lifting':'preview';
    const textures=new Set([this.front,this.clearFront,this.back,this.sideTexture,this.topTexture,this.shadowTexture,this.coverCanvas,this.labelCanvas,this.archiveLabel,...this.prints.values(),...this.outgoing.map(o=>o.texture)]);
    this.container.dataset.archive2d=JSON.stringify({renderedFrames:this.renderedFrames,visibleCards:cards.length,prints:this.prints.size,returningCards:this.outgoing.length,edgeGradients:this.edgeGradients.size,cacheBytes:[...textures].reduce((n,c)=>n+c.width*c.height*4,0),selected:this.selectedCell,waveTime:this.playbackEntry.waveTime,sleeping:false});
  }
  update(time: number): boolean {
    if (this.disposed) return false;
    const dt = Math.min(.05, Math.max(0, time - (this.last || time)));
    this.fieldCache.clear();
    for(const o of this.outgoing) {
      o.rotation=returnStep(o.rotation,dt,!this.motion.detailTransition);
      if(o.returnY!==null&&o.rotation!==0){o.lift.value=o.returnY-this.heightAt(o.cell);o.lift.velocity=0}
      else {o.returnY=null;damp(o.lift,0,this.motion.detailTransition?4.5:35,dt)}
    }
    this.outgoing=this.outgoing.filter(o=>o.lift.value>.0001||Math.abs(o.lift.velocity)>.0002||o.rotation!==0);
    this.last = time; this.clock += dt;
    const detailTarget = Number(this.mode === "detail");
    this.rotation = this.mode==='detail'?approach(this.rotation,this.targetRotation,this.motion.detailTransition?2.8:35,dt):returnStep(this.rotation,dt,!this.motion.detailTransition);
    if (this.momentum) {
      this.momentum.step(dt); this.focus = this.momentum.value;
      this.selectPhysical({ lane: Math.round(this.focus.lane), row: Math.round(this.focus.row) });
      if (this.momentum.phase === "idle") this.momentum = null;
    } else if (!this.drag.active) {
      const rate = this.motion.selectionTransition ? 8 : 1000;
      this.focus.lane = approach(this.focus.lane, this.selectedCell.lane, rate, dt);
      this.focus.row = approach(this.focus.row, this.selectedCell.row, rate, dt);
    }
    if (this.mode !== "detail") this.playbackEntry.update(dt, this.returnY===null && this.rotation===0 && this.lift<.03 && Math.abs(this.liftSpring.velocity)<.2, this.playing, this.reduced, this.rotation===0 && this.playbackEntry.shape<.08 && this.lift<.1);
    if (this.playbackEntry.phase === "inactive" && Math.abs(this.playbackEntry.shape - 1) < .0001) this.playbackEntry.shape = 1;
    const liftTarget = detailTarget ? INSPECTION_LIFT : this.archivePlayback ? .65 * this.playbackEntry.rise : .4;
    if(this.returnY!==null&&this.rotation!==0) {this.liftSpring.value=this.returnY-this.heightAt(this.selectedCell);this.liftSpring.velocity=0}
    else {this.returnY=null;damp(this.liftSpring,liftTarget,!this.motion.detailTransition?35:this.playbackEntry.phase==='inserting'?11:this.archivePlayback&&this.playbackEntry.phase==='rising'?9:4.2,dt)}
    if(Math.abs(this.liftSpring.value-liftTarget)<.0001&&Math.abs(this.liftSpring.velocity)<.0002) {this.liftSpring.value=liftTarget;this.liftSpring.velocity=0}
    this.lift=this.liftSpring.value;
    const cameraDetail=detailTarget?smooth((this.lift-.8)/2.4):this.archivePlayback?0:this.returnY!==null?this.detail:smooth((this.lift-.4)/(INSPECTION_LIFT-.4));
    this.detail=approach(this.detail,cameraDetail,this.motion.detailTransition?2.8:35,dt);
    const wave = this.archivePlayback && this.playing && !detailTarget && !this.disabledWave && !this.reduced && this.playbackEntry.waveStarted;
    this.waveGain = approach(this.waveGain, Number(wave), 3, dt);
    this.reducedMix = approach(this.reducedMix, Number(this.reducedWave), 8, dt);
    const idleEnabled = !this.archivePlayback && !this.archiveTracks.length && !detailTarget && this.motion.idleWave && this.revealed;
    this.idleGain = approach(this.idleGain, Number(idleEnabled && this.clock - this.lastInteraction > 2.5), 4, dt);
    this.pulses = this.pulses.filter(p => this.clock - p.time < 3.2);
    this.fieldCache.clear();
    const reveal = this.revealed && this.mode !== "hidden" ? 1 : 0;
    this.presence = approach(this.presence, reveal, this.reduced ? 1000 : 6, dt);
    this.canvas.style.opacity = String(this.presence);
    const cameraTarget=this.cameraTarget();this.camera=advanceCamera(this.camera,cameraTarget,dt,this.mode==='detail'||this.detail>.01?this.motion.detailTransition:this.motion.selectionTransition);
    const moving = this.outgoing.length>0 || !cameraSettled(this.camera,cameraTarget) || this.detail !== cameraDetail || this.rotation !== this.targetRotation || this.lift !== liftTarget ||
      this.focus.lane !== this.selectedCell.lane || this.focus.row !== this.selectedCell.row || this.presence !== reveal ||
      this.waveGain !== Number(wave) || this.reducedMix !== Number(this.reducedWave) || this.idleGain !== Number(idleEnabled && this.clock - this.lastInteraction > 2.5) ||
      this.pulses.length > 0 || this.drag.active || this.momentum !== null ||
      this.playbackEntry.phase === "inserting" || this.playbackEntry.phase === "rising" ||
      (this.playbackEntry.phase === "inactive" && this.playbackEntry.shape !== 1);
    const ongoing = (idleEnabled || wave) && this.mode!=="hidden";
    if(this.mode==="hidden")return false;
    // ArchiveCanvas owns the shared frame budget for both rendering modes.
    if (moving || ongoing || this.wasMoving) this.dirty = true;
    this.wasMoving = Boolean(moving || ongoing);
    if (this.dirty) {
      this.paint();
      this.dirty = false;
    }
    const continuing = Boolean(this.dirty || moving || ongoing);
    if (!continuing) {
      const state = JSON.parse(this.container.dataset.archive2d ?? "{}");
      state.sleeping = true; this.container.dataset.archive2d = JSON.stringify(state);
    }
    return continuing;
  }
  private selectPhysical(cell: ArchiveCell) {
    if (cell.lane === this.selectedCell.lane && cell.row === this.selectedCell.row) return;
    this.retainSelected();this.selectedCell = cell; this.lastInteraction = this.clock;
    this.onSelect?.(wrap(cell.row - 12, this.count), { ...cell }); this.invalidate();
  }
  private pick(x: number, y: number) {
    const rect = this.canvas.getBoundingClientRect();
    const point = { x: (x - rect.left) * this.width / Math.max(1, rect.width), y: (y - rect.top) * this.height / Math.max(1, rect.height) };
    for (let i = this.drawnCards.length - 1; i >= 0; i--) {
      const card = this.drawnCards[i];
      if ([card.front, card.top, card.side].some(face => inside(point, face))) return card;
    }
    return null;
  }
  private cancelPointer() {
    const pointer = this.pointerId;
    this.pointerId = null; this.drag.active = false; this.momentum = null;
    if (pointer !== null && this.canvas.hasPointerCapture(pointer)) this.canvas.releasePointerCapture(pointer);
  }
  private bindInput() {
    const options = { signal: this.events.signal };
    this.canvas.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !this.revealed || this.mode === "hidden") return;
      this.momentum = null; this.pointerId = event.pointerId; this.pointerX = event.clientX;
      this.canvas.focus({ preventScroll: true }); this.canvas.setPointerCapture(event.pointerId);
      this.dragOrigin = { ...this.focus };
      const frame = this.frame();
      const rect = this.canvas.getBoundingClientRect();
      const sx = rect.width / this.width, sy = rect.height / this.height;
      const p=this.selectedPosition(),center=frame.project(p.x,p.y+1.85,p.z),lane=frame.project(p.x+.01,p.y+1.85,p.z),row=frame.project(p.x,p.y+1.85,p.z+.01);
      this.drag.start(event.clientX,event.clientY,{lane:{x:(lane.x-center.x)*COLUMN_SPACING*100*sx,y:(lane.y-center.y)*COLUMN_SPACING*100*sy},row:{x:(row.x-center.x)*ROW_SPACING*100*sx,y:(row.y-center.y)*ROW_SPACING*100*sy}},event.timeStamp);
      this.invalidate();
    }, options);
    this.canvas.addEventListener("pointermove", event => {
      if (this.pointerId !== null) {
        if (event.pointerId !== this.pointerId) return;
        this.drag.move(event.clientX, event.clientY, event.timeStamp);
        if (this.mode === "detail") {
          this.targetRotation = Math.max(-.7, Math.min(.7, this.targetRotation + (event.clientX - this.pointerX) * .004));
          this.pointerX = event.clientX;
        } else if (!this.archivePlayback && this.drag.active) {
          this.focus = { lane: this.dragOrigin.lane - this.drag.value.lane, row: this.dragOrigin.row - this.drag.value.row };
          this.selectPhysical({ lane: Math.round(this.focus.lane), row: Math.round(this.focus.row) });
        }
      } else if (this.mode === "archive" && !this.archivePlayback) {
        const card = this.pick(event.clientX, event.clientY);
        const hover = card?.cell ?? null;
        if (hover?.lane === this.hover?.lane && hover?.row === this.hover?.row) return;
        this.hover = hover;
      } else return;
      this.lastInteraction = this.clock; this.invalidate();
    }, options);
    const release = (event: PointerEvent, cancelled: boolean) => {
      if (event.pointerId !== this.pointerId) return;
      const moved = this.drag.moved, dragged = this.drag.active;
      this.pointerId = null; this.drag.active = false;
      if (!cancelled && dragged && this.mode === "archive" && !this.archivePlayback) {
        const velocity = this.drag.releaseVelocity(event.timeStamp, !this.motion.dragMomentum);
        this.momentum = new ArchivePlaneMomentum(this.focus, { lane: -velocity.lane, row: -velocity.row });
      } else if (!cancelled && !moved && this.mode === "archive") {
        const card = this.pick(event.clientX, event.clientY);
        if (this.archivePlayback) { if (card?.selected) this.onPlaybackCassetteOpen?.(); }
        else if (card?.selected) this.onOpen?.(card.index);
        else if (card) this.onSelect?.(card.index, { ...card.cell });
      }
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      this.invalidate();
    };
    this.canvas.addEventListener("pointerup", event => release(event, false), options);
    this.canvas.addEventListener("pointercancel", event => release(event, true), options);
    this.canvas.addEventListener("lostpointercapture", event => { if (event.pointerId === this.pointerId) { this.cancelPointer(); this.invalidate(); } }, options);
    this.canvas.addEventListener("pointerleave", () => { this.hover = null; this.invalidate(); }, options);
    this.canvas.addEventListener("wheel", event => {
      if (this.mode !== "archive" || this.archivePlayback || !this.revealed) return;
      event.preventDefault(); this.momentum = null;
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const delta = horizontal ? event.deltaX : event.deltaY;
      if (delta) this.onNavigate?.(horizontal ? "lane" : "row", Math.sign(delta) * Math.min(3, Math.max(1, Math.round(Math.abs(delta) / 100))));
      this.invalidate();
    }, { ...options, passive: false });
    this.canvas.addEventListener("keydown", event => {
      if (this.mode !== "archive" || this.archivePlayback || !this.revealed) return;
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault(); this.momentum = null;
        this.onNavigate?.(event.key === "ArrowLeft" || event.key === "ArrowRight" ? "lane" : "row", event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "Enter") { event.preventDefault(); this.onOpen?.(wrap(this.selectedCell.row - 12, this.count)); }
    }, options);
  }
  dispose() {
    this.disposed = true; this.events.abort(); this.cancelPointer(); this.onInvalidate = undefined;
    this.prints.clear(); this.fieldCache.clear(); this.edgeGradients.clear(); this.outgoing=[]; this.covers = []; this.drawnCards = []; this.canvas.remove();
    for (const canvas of [this.canvas,this.front,this.clearFront,this.back,this.sideTexture,this.topTexture,this.shadowTexture,this.coverCanvas,this.labelCanvas,this.archiveLabel]) canvas.width = canvas.height = 1;
  }
}
