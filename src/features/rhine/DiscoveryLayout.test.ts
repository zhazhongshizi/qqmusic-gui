import { expect, it } from "vitest";
import { DISCOVERY_DURATION, DISCOVERY_WAIT, DiscoveryMotion, discoveryLayout, discoverySlots, type DiscoveryState } from "./vendor/discovery-layout";
const state:DiscoveryState={open:true,ready:false,key:"a",entries:[],selected:null,hovered:null,scroll:0,top:150};
const run=(m:DiscoveryMotion,s:DiscoveryState,n=100)=>{for(let i=0;i<n;i++)m.step(.016,s);};
it("reuses the full flatten/retreat wave for page changes and reverses continuously",()=>{
 const m=new DiscoveryMotion(),page={...state,ready:true,surfaceOnly:true};
 run(m,page,10);expect(m.flatten).toBeGreaterThan(0);expect(m.retreat).toBe(0);
 run(m,page);expect(m.retreat).toBe(1);expect(m.phase(page)).toBe("ready");
 const time=m.time;m.step(.016,{...page,open:false});expect(m.time).toBeCloseTo(time-.016);
 run(m,{...page,open:false});expect(m.phase({...page,open:false})).toBe("closed");
 m.step(0,{...page,reduced:true});expect(m.retreat).toBe(1);
});
it("forms the shelf during loading and only waits after the full entry movement",()=>{
 const m=new DiscoveryMotion();run(m,state,40);expect(m.time).toBeGreaterThan(DISCOVERY_WAIT);expect(m.spread).toBeGreaterThan(0);expect(m.phase(state)).toBe("moving");
 run(m,state);expect(m.time).toBe(DISCOVERY_DURATION);expect(m.spread).toBe(1);expect(m.phase(state)).toBe("waiting");
 const ready={...state,ready:true};m.step(0,ready);expect(m.key).toBe("a");expect(m.contentOpacity).toBe(0);expect(m.phase(ready)).toBe("moving");
 run(m,ready);expect(m.time).toBe(DISCOVERY_DURATION);expect(m.contentOpacity).toBe(1);expect(m.phase(ready)).toBe("ready");
});
it("reverses from the current frame and can re-enter without restarting",()=>{
 const m=new DiscoveryMotion(),ready={...state,ready:true};run(m,ready,45);const midway=m.time;
 m.step(.016,{...ready,open:false});expect(m.time).toBeLessThan(midway);const back=m.time;m.step(.016,ready);expect(m.time).toBeGreaterThan(back);
 run(m,{...ready,open:false});expect(m.time).toBe(0);expect(m.phase({...ready,open:false})).toBe("closed");
});
it("does not sleep on the zero-delta first frame of a reverse transition",()=>{
 const m=new DiscoveryMotion(),ready={...state,ready:true};run(m,ready);
 m.step(0,{...ready,open:false});expect(m.phase({...ready,open:false})).toBe("moving");
});
it("keeps rendering a category replacement after the zero-delta wake frame",()=>{
 const m=new DiscoveryMotion(),ready={...state,ready:true};run(m,ready);
 const replacement={...ready,key:"playlists"};m.step(0,replacement);
 expect(m.phase(replacement)).toBe("moving");run(m,replacement);
 expect(m.key).toBe("playlists");expect(m.phase(replacement)).toBe("ready");
});
it("uses a short entry from other pages while retaining a full reverse transition",()=>{
 const m=new DiscoveryMotion(),ready={...state,ready:true,shortEntry:true};run(m,ready,25);
 expect(m.time).toBe(DISCOVERY_DURATION);m.step(.016,{...ready,open:false});expect(m.time).toBeCloseTo(DISCOVERY_DURATION-.016);
});
it("replaces a category locally without repeating flattening, and supports reduced motion",()=>{
 const m=new DiscoveryMotion(),ready={...state,ready:true};run(m,ready);
 run(m,{...ready,ready:false,key:"b"},4);expect(m.time).toBe(DISCOVERY_DURATION);expect(m.key).toBe("a");
 run(m,{...ready,key:"b"},40);expect(m.key).toBe("b");expect(m.swap).toBe(1);expect(m.time).toBe(DISCOVERY_DURATION);
 m.step(.016,{...ready,open:false,reduced:true});expect(m.time).toBe(0);
});
it.each([0,1,5,9])("lays out %i real entries in centered columns without horizontal overflow",count=>{
 for(const width of [480,800,1280,1920]) {const l=discoveryLayout(width,800,count,150);expect(l.columns).toBeGreaterThanOrEqual(1);expect(l.columns).toBeLessThanOrEqual(3);
 for(let i=0;i<count;i++){const p=l.cell(i);expect(p.x).toBeGreaterThanOrEqual(0);expect(p.x+l.tapeWidth).toBeLessThanOrEqual(width);}
 if(count){const cells=Array.from({length:count},(_,i)=>l.cell(i));expect(Math.min(...cells.map(c=>c.x))).toBeCloseTo(width-Math.max(...cells.map(c=>c.x))-l.tapeWidth);}}
});
it.each([0,1,5,9,12])("uses nine stable slots for %i entries, padding only missing tapes",count=>{
 const entries=Array.from({length:count},(_,i)=>({id:`song:${i}`,title:`曲目 ${i}`,subtitle:"歌手",kind:"song" as const}));
 const slots=discoverySlots(entries);expect(slots).toHaveLength(9);
 expect(slots.filter(entry=>entry.kind!=="blank")).toEqual(entries.slice(0,9));
 expect(slots.filter(entry=>entry.kind==="blank")).toHaveLength(Math.max(0,9-count));
 const layout=discoveryLayout(1920,900,slots.length,150);expect(layout.columns).toBe(3);expect(layout.rows).toBe(3);
});
it("overlaps rear cassettes while aligning the front of each column, including an incomplete row",()=>{
 const l=discoveryLayout(1280,900,5,150),fronts=[];
 expect(l.rowStep).toBeLessThan(l.tapeHeight);
 for(let column=0;column<l.columns;column++) {
  const cells=Array.from({length:5},(_,i)=>({i,p:l.cell(i)})).filter(({i})=>i%l.columns===column);
  expect(new Set(cells.map(({p})=>p.x)).size).toBe(1);
  fronts.push(Math.max(...cells.map(({p})=>p.y)));
 }
 expect(new Set(fronts).size).toBe(1);
});

it("changes content only at zero opacity, eases both halves and settles within 320ms",()=>{
 const m=new DiscoveryMotion(),ready={...state,ready:true};run(m,ready);
 const next={...ready,key:"radar"};let changed=false;
 for(let i=0;i<20;i++) {
  const key=m.key;m.step(.016,next);
  expect(m.time).toBe(DISCOVERY_DURATION);
  if(m.key!==key){changed=true;expect(m.contentOpacity).toBe(0);}
  expect(m.contentOpacity).toBeGreaterThanOrEqual(0);expect(m.contentOpacity).toBeLessThanOrEqual(1);
 }
 expect(changed).toBe(true);expect(m.key).toBe("radar");expect(m.contentOpacity).toBe(1);expect(m.phase(next)).toBe("ready");
});
it("cancels a pending swap when the latest tab is still loading, then reveals only its data",()=>{
 const m=new DiscoveryMotion(),ready={...state,ready:true};run(m,ready);
 run(m,{...ready,key:"radar"},4);expect(m.key).toBe("a");expect(m.swap).toBeLessThan(1);
 const loading={...ready,key:"playlists",ready:false};m.step(0,loading);
 expect(m.phase(loading)).toBe("moving");run(m,loading,40);
 expect(m.key).toBe("a");expect(m.contentOpacity).toBe(1);expect(m.phase(loading)).toBe("waiting");
 run(m,{...loading,ready:true});expect(m.key).toBe("playlists");expect(m.contentOpacity).toBe(1);
});
it("returns smoothly to the original tab and honors reduced motion during a swap",()=>{
 const m=new DiscoveryMotion(),ready={...state,ready:true};run(m,ready);
 run(m,{...ready,key:"radar"},3);const opacity=m.contentOpacity;
 m.step(.016,ready);expect(m.contentOpacity).toBeGreaterThan(opacity);expect(m.key).toBe("a");
 m.step(.016,{...ready,key:"radar",reduced:true});expect(m.key).toBe("radar");expect(m.contentOpacity).toBe(1);
});

it("continues from the same entry frame when the first response arrives mid-flight",()=>{
 const m=new DiscoveryMotion();run(m,state,50);const time=m.time;
 const ready={...state,ready:true};m.step(0,ready);
 expect(m.time).toBe(time);expect(m.key).toBe("a");expect(m.contentOpacity).toBe(0);
 m.step(.016,ready);expect(m.time).toBeGreaterThan(time);expect(m.contentOpacity).toBeGreaterThan(0);
});
it("can reverse before data arrives and shows the complete waiting shelf with reduced motion",()=>{
 const m=new DiscoveryMotion();run(m,state,45);const time=m.time;
 m.step(.016,{...state,open:false});expect(m.time).toBeLessThan(time);
 run(m,{...state,open:false});expect(m.phase({...state,open:false})).toBe("closed");
 m.step(0,{...state,reduced:true});expect(m.time).toBe(DISCOVERY_DURATION);expect(m.phase(state)).toBe("waiting");
 m.step(0,{...state,ready:true,reduced:true});expect(m.contentOpacity).toBe(1);expect(m.phase({...state,ready:true})).toBe("ready");
});
