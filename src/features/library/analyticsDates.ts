import type { Analytics, Metrics } from "../../backend/analyticsAdapter";
export function localDate(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,"0")}-${String(value.getDate()).padStart(2,"0")}`;
}
export function dateObject(value: string) { return new Date(Number(value.slice(0,4)),Number(value.slice(5,7))-1,Number(value.slice(8,10))); }
export function presetRange(preset: string, now = new Date()) {
  const start=new Date(now);
  if(preset==="week") start.setDate(start.getDate()-6);
  if(preset==="month") start.setDate(1);
  if(preset==="year") start.setMonth(0,1);
  return { start: localDate(start), end: localDate(now) };
}
export function validRange(start: string,end: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)
    && start >= "1970-01-01" && localDate(dateObject(start))===start && localDate(dateObject(end))===end
    && start<=end && (Date.parse(end)-Date.parse(start))/86400000<=365;
}
export function duration(ms: number) {
  const seconds=Math.floor(ms/1000);
  return seconds<60?`${seconds} 秒`:`${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds/60)%60} 分钟`;
}
export interface ChartPoint extends Metrics { label: string; end: string }
export function chartPoints(data: Analytics, grain: "day"|"week"|"month"): ChartPoint[] {
  const byDate=new Map(data.days.map(d=>[d.date,d]));
  const points: ChartPoint[]=[];
  for(let day=dateObject(data.startDate);localDate(day)<=data.endDate;day.setDate(day.getDate()+1)) {
    const key=localDate(day), row=byDate.get(key);
    const week=new Date(day); week.setDate(week.getDate()-(week.getDay()+6)%7);
    const label=grain==="day"?key:grain==="month"?key.slice(0,7):localDate(week);
    let point=points.at(-1);
    if(!point||point.label!==label){point={label,end:key,listenedMs:0,qualifiedPlays:0};points.push(point);}
    point.end=key;point.listenedMs+=row?.listenedMs??0;point.qualifiedPlays+=row?.qualifiedPlays??0;
  }
  return points;
}
