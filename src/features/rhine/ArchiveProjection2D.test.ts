import {expect,it} from 'vitest';
import {PerspectiveCamera,Vector3} from 'three';
import {archiveCameraTarget,perspectiveFrame} from './vendor/archive-camera-2d';

it('长焦投影与 Three 相机矩阵一致，射线交点可还原画面坐标',()=>{
 for(const [width,height] of [[1280,720],[960,720],[800,720],[600,900]] as const)for(const detail of [0,.5,1]) {
  const target=archiveCameraTarget(width,height,detail,{x:0,y:1.6537141825,z:-2.17},width<1100);
  const frame=perspectiveFrame(target,width,height,detail),camera=new PerspectiveCamera(target.fov*180/Math.PI,width/height,.1,300);
  camera.position.set(target.eye.x,target.eye.y,target.eye.z);camera.lookAt(target.aim.x,target.aim.y,target.aim.z);camera.updateMatrixWorld();
  for(const p of [[-2.5,3.7,.206],[2.5,0,.206],[5,-4.6,8]] as const) {
   const expected=new Vector3(...p).project(camera),actual=frame.project(p[0],p[1],p[2]);
   expect(actual.x).toBeCloseTo((expected.x+1)*width/2,8);expect(actual.y).toBeCloseTo((1-expected.y)*height/2,8);
  }
  const ground=frame.ground(width*.3,height*.7,-4.6)!;
  const actual=frame.project(ground.x,ground.y,ground.z);expect(actual.x).toBeCloseTo(width*.3,8);expect(actual.y).toBeCloseTo(height*.7,8);
 }
});
it('雾依相机深度变化，同深度侧向远处不会被径向距离洗白',()=>{
 const target=archiveCameraTarget(1280,720,0,{x:0,y:-2,z:-2.17},false),frame=perspectiveFrame(target,1280,720,0);
 const p={...target.aim},far={x:p.x+frame.right.x*40,y:p.y,z:p.z+frame.right.z*40};
 expect(frame.fog(p)).toBe(0);expect(frame.fog(far)).toBeCloseTo(frame.fog(p),10);
 const behind={x:p.x-frame.direction.x*30,y:p.y-frame.direction.y*30,z:p.z-frame.direction.z*30};expect(frame.fog(behind)).toBe(1);
});
