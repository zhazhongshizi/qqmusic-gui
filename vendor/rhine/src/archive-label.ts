/** Industrial playlist label, shared by the original 3D and Canvas renderer. */
export function drawArchiveLabel(canvas: HTMLCanvasElement, index: number, title: string, mark: CanvasImageSource) {
 const c=canvas.getContext('2d')!;
 c.fillStyle='#e6e2d9';c.fillRect(0,0,1024,440);
 c.fillStyle='#171713';c.fillRect(12,12,1000,6);c.fillRect(12,419,1000,3);
 c.font='bold 81px MiSans';c.fillText('RHINE LAB, LLC.',22,116);
 c.font='32px MiSans';c.fillStyle='#878476';c.fillText(title,25,174,730);
 c.fillStyle='#171713';c.font='bold 130px MiSans';c.fillText('NO.'+String(index+1).padStart(3,'0'),22,360);
 c.fillRect(782,32,221,39);c.fillStyle='#eee9de';c.font='24px MiSans';c.fillText('R L / I S',809,61);
 c.fillStyle='#171713';c.font='bold 64px MiSans';c.fillText('INFO',830,143);c.drawImage(mark,790,242,210,98);
}
