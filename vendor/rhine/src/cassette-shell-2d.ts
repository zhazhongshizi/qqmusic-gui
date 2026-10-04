export const SHELL={halfWidth:2.5,height:3.7,front:.206,back:-.13,innerHalfWidth:2.4,innerBottom:.125,innerTop:3.595};
function fasteners(c:CanvasRenderingContext2D) {
 for(const [x,y] of [[623,23],[20,455]]) {
  const metal=c.createLinearGradient(x-7,y-7,x+7,y+7);metal.addColorStop(0,'#f4f3e8');metal.addColorStop(.4,'#838d8b');metal.addColorStop(1,'#596567');
  c.fillStyle='#f9f7ee';c.beginPath();c.arc(x,y,7,0,Math.PI*2);c.fill();c.fillStyle=metal;c.beginPath();c.arc(x,y,5.5,0,Math.PI*2);c.fill();
  c.strokeStyle='#444f50';c.lineWidth=1.4;c.beginPath();c.moveTo(x-2.8,y+2.8);c.lineTo(x+2.8,y-2.8);c.stroke();
 }
}
export function shellTexture(face:'front'|'back'|'side'|'top') {
 const canvas=document.createElement('canvas');canvas.width=face==='side'?48:640;canvas.height=face==='top'?48:474;
 const c=canvas.getContext('2d')!,w=canvas.width,h=canvas.height;
 const body=c.createLinearGradient(0,0,0,h);
 body.addColorStop(0,'#ede9e3');body.addColorStop(.22,'#e5dfd5');body.addColorStop(.68,'#cfc3b1');body.addColorStop(1,'#b4a18a');
 c.fillStyle=face==='top'?'#f6f3ed':body;c.fillRect(0,0,w,h);
 if(face==='side') {
  c.fillStyle='#faf7ee';c.fillRect(0,0,3,h);c.fillStyle='#dcd1c0';c.fillRect(w-5,0,5,h);c.fillStyle='#ffffff50';c.fillRect(3,0,2,h);
 } else if(face==='top') {
  c.fillStyle='#ffffff90';c.fillRect(0,h-5,w,3);c.fillStyle='#cbbba53d';c.fillRect(8,6,w-16,8);
 } else {
  // Measured diffuser inset; soft root shading is baked once into the shell.
  c.fillStyle='#b4a38c20';c.fillRect(13,14,w-26,h-30);
  const frost=c.createLinearGradient(0,0,w,0);frost.addColorStop(0,'#ffffff45');frost.addColorStop(.18,'#ffffff0a');frost.addColorStop(.8,'#ffffff10');frost.addColorStop(1,'#ffffff40');
  c.fillStyle=frost;c.fillRect(12,14,w-24,h-30);
  c.strokeStyle='#fcfaf52b';c.lineWidth=1;c.strokeRect(13,14,w-26,h-30);
  c.fillStyle='#fffaf080';c.fillRect(0,0,w,1);c.fillRect(0,0,1,h);c.fillRect(w-1,0,1,h);
  const root=c.createLinearGradient(0,h-24,0,h);root.addColorStop(0,'#55452b00');root.addColorStop(1,'#55452b30');c.fillStyle=root;c.fillRect(0,h-24,w,24);
  if(face==='front') {
   c.fillStyle='#d4c6b1';c.fillRect(28,0,32,29);
   fasteners(c);
  }
 }
 return canvas;
}
/** Selected clear shell: optical centres measured from the source assembly. */
export function clearShellTexture() {
 const canvas=shellTexture('front'),c=canvas.getContext('2d')!;
 c.fillStyle='#e4e0da';c.fillRect(9,8,canvas.width-18,canvas.height-16);
 c.strokeStyle='#cdc7bb60';c.lineWidth=2;c.strokeRect(16,17,canvas.width-32,canvas.height-34);
 for(const [wx,wy,radius,amber] of [[-.38,1.88,.91,0],[1.16,2.49,.48,1]]) {
  const x=(wx+2.5)*128,y=(3.7-wy)*128,r=radius*128;
  const rim=c.createRadialGradient(x-3,y-5,r*.55,x,y,r);
  rim.addColorStop(0,'#e4e0da');rim.addColorStop(.59,'#e4e0da');rim.addColorStop(.69,amber?'#c69464':'#b8ae9e');rim.addColorStop(.77,amber?'#bd8b5c':'#d3ccc0');rim.addColorStop(.88,'#eeeae3');rim.addColorStop(1,'#c7beb065');
  c.fillStyle=rim;c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.fill();
 }
 c.strokeStyle='#c6bcab60';c.lineWidth=5;c.beginPath();c.moveTo(290,350);c.quadraticCurveTo(465,300,453,180);c.stroke();
 c.strokeStyle='#ece8e060';c.lineWidth=2;c.beginPath();c.moveTo(290,347);c.quadraticCurveTo(460,295,451,180);c.stroke();
 c.fillStyle='#d4c6b1';c.fillRect(28,0,32,29);fasteners(c);
 return canvas;
}
/** Soft floor stamp; no live blur/shadowBlur and no per-frame canvas allocation. */
export function floorShadowTexture() {
 const canvas=document.createElement('canvas');canvas.width=128;canvas.height=64;const c=canvas.getContext('2d')!;
 const g=c.createRadialGradient(64,32,1,64,32,64);g.addColorStop(0,'#594a393d');g.addColorStop(.4,'#594a3928');g.addColorStop(1,'#594a3900');
 c.scale(1,.5);c.fillStyle=g;c.fillRect(0,0,128,128);return canvas;
}
