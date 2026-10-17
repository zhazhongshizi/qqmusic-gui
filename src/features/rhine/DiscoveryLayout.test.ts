import { expect, it } from "vitest";
import { DISCOVERY_DURATION, DISCOVERY_WAIT, DiscoveryMotion, discoveryLayout, discoverySlots, type DiscoveryState } from "./vendor/discovery-layout";
const state:DiscoveryState={open:true,ready:false,key:"a",entries:[],selected:null,hovered:null,scroll:0,top:150};
const run=(m:DiscoveryMotion,s:DiscoveryState,n=100)=>{for(let i=0;i<n;i++)m.step(.016,s);};
it("waits at the flat array until recommendations arrive, then completes the 1.5 second path",()=>{
 const m=new DiscoveryMotion();run(m,state);expect(m.time).toBe(DISCOVERY_WAIT);expect(m.spread).toBe(0);expect(m.phase(state)).toBe("waiting");
 run(m,{...state,ready:true});expect(m.time).toBe(DISCOVERY_DURATION);expect(m.spread).toBe(1);
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
