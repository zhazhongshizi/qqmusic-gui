import type { ScreenPoint } from './archive-camera-2d';
type Vertex=ScreenPoint & {u:number;v:number};
function triangle(c: CanvasRenderingContext2D,image: HTMLCanvasElement,a: Vertex,b: Vertex,d: Vertex) {
 const du=b.u-a.u,dv=b.v-a.v,eu=d.u-a.u,ev=d.v-a.v,det=du*ev-eu*dv;if(Math.abs(det)<1e-8)return;
 const xx=((b.x-a.x)*ev-(d.x-a.x)*dv)/det,xy=((d.x-a.x)*du-(b.x-a.x)*eu)/det;
 const yx=((b.y-a.y)*ev-(d.y-a.y)*dv)/det,yy=((d.y-a.y)*du-(b.y-a.y)*eu)/det;
 c.save();c.beginPath();
 // Tiny overlap inside the full opaque face clip removes antialiased seams.
 const center={x:(a.x+b.x+d.x)/3,y:(a.y+b.y+d.y)/3};
 for(const [i,p] of [a,b,d].entries()){const dx=p.x-center.x,dy=p.y-center.y,n=Math.max(1,Math.hypot(dx,dy)),x=p.x+.35*dx/n,y=p.y+.35*dy/n;if(i)c.lineTo(x,y);else c.moveTo(x,y)}
 c.closePath();c.clip();c.transform(xx,yx,xy,yy,a.x-xx*a.u-xy*a.v,a.y-yx*a.u-yy*a.v);c.drawImage(image,0,0);c.restore();
}
export function drawTextureQuad(c:CanvasRenderingContext2D,image:HTMLCanvasElement,points:ScreenPoint[],project:(u:number,v:number)=>ScreenPoint,selected=false) {
 const [a,b,e,d]=points,error=Math.hypot(e.x-(b.x+d.x-a.x),e.y-(b.y+d.y-a.y));
 c.save();c.beginPath();c.moveTo(a.x,a.y);for(const p of points.slice(1))c.lineTo(p.x,p.y);c.closePath();c.clip();
 if(error<(selected?.6:12)) {
  // Fit all four corners for distant files: maximum vertex error is error/4.
  const dx=e.x-b.x-d.x+a.x,dy=e.y-b.y-d.y+a.y;
  c.transform((b.x-a.x+dx/2)/image.width,(b.y-a.y+dy/2)/image.width,(d.x-a.x+dx/2)/image.height,(d.y-a.y+dy/2)/image.height,a.x-dx/4,a.y-dy/4);
  const pad=selected?0:2;c.drawImage(image,-pad,-pad,image.width+2*pad,image.height+2*pad);
 }
 else {
  const divisions=selected?Math.min(4,Math.max(1,Math.ceil(Math.sqrt(error/.6)))):1,grid:Vertex[][]=[];
  for(let y=0;y<=divisions;y++){grid[y]=[];for(let x=0;x<=divisions;x++){const u=x/divisions,v=y/divisions;grid[y][x]={...project(u,v),u:u*image.width,v:v*image.height}}}
  for(let y=0;y<divisions;y++)for(let x=0;x<divisions;x++){const a=grid[y][x],b=grid[y][x+1],d=grid[y+1][x],e=grid[y+1][x+1];triangle(c,image,a,b,d);triangle(c,image,b,e,d)}
 }
 c.restore();
}
/** Narrow edge faces have subpixel perspective error; avoid texture subdivision. */
export function drawEdgeTexture(c:CanvasRenderingContext2D,image:HTMLCanvasElement,points:ScreenPoint[]) {
 const [a,b,,d]=points;c.save();c.transform((b.x-a.x)/image.width,(b.y-a.y)/image.width,(d.x-a.x)/image.height,(d.y-a.y)/image.height,a.x,a.y);c.drawImage(image,0,0);c.restore();
}
