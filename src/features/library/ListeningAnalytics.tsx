import { useEffect, useMemo, useState } from "react";
import { getAnalytics, type Analytics } from "../../backend/analyticsAdapter";
import { playbackSessionIdentity, subscribePlaybackConnection } from "../../backend/playbackTransport";
import { chartPoints, dateObject, duration, localDate, presetRange, validRange, type ChartPoint } from "./analyticsDates";
import "./listening-analytics.css";

function Chart({points,mode,label}:{points: readonly ChartPoint[];mode:"bar"|"line";label:string}) {
  const [selected,setSelected]=useState<number|null>(null);
  const max=Math.max(1,...points.map(p=>p.listenedMs));
  const width=Math.max(600,points.length*18), step=width/Math.max(1,points.length);
  const point=selected===null?null:points[selected];
  const describe=(p:ChartPoint)=>`${p.label}${p.end!==p.label?` 至 ${p.end}`:""}：${duration(p.listenedMs)} · ${p.qualifiedPlays} 次有效收听`;
  return <div className="analytics-chart">
    <p className="analytics-chart-detail" aria-live="polite">{point?describe(point):"悬停或用 Tab 聚焦图表查看详情；横向滚动可查看完整区间。"}</p>
    <div className="analytics-chart-scroll" role="group" aria-label={label}>
      <svg width={width} height="190" viewBox={`0 0 ${width} 190`}>
        <line x1="0" y1="150" x2={width} y2="150" className="analytics-axis"/>
        {mode==="line"&&<polyline fill="none" className="analytics-line" points={points.map((p,i)=>`${(i+.5)*step},${150-p.listenedMs/max*130}`).join(" ")}/>}
        {points.map((p,i)=><g key={p.label} tabIndex={0} role="img" aria-label={describe(p)} onMouseEnter={()=>setSelected(i)} onFocus={()=>setSelected(i)} onMouseLeave={()=>setSelected(null)} onBlur={()=>setSelected(null)}>
          <title>{describe(p)}</title>
          <rect x={i*step} y="0" width={step} height="151" fill="transparent"/>
          {mode==="bar"?<rect className="analytics-bar" x={i*step+2} y={150-p.listenedMs/max*130} width={Math.max(2,step-4)} height={Math.max(p.listenedMs>0?2:0,p.listenedMs/max*130)}/>:<circle className="analytics-bar" cx={(i+.5)*step} cy={150-p.listenedMs/max*130} r="3"/>}
          {(i%Math.max(1,Math.ceil(points.length/12))===0||i===points.length-1)&&<text x={(i+.5)*step} y="176" textAnchor="middle">{p.label.slice(5)||p.label}</text>}
        </g>)}
      </svg>
    </div>
    <p>纵轴：收听时长，最高 {duration(max===1?0:max)}。缺失日期以 0 展示，不代表缺失历史中没有收听。</p>
  </div>;
}

function Calendar({data}:{data:Analytics}) {
  const [month,setMonth]=useState(data.endDate.slice(0,7));
  useEffect(()=>setMonth(data.endDate.slice(0,7)),[data.startDate,data.endDate]);
  const values=new Map(data.days.map(d=>[d.date,d]));
  const first=dateObject(`${month}-01`), count=new Date(first.getFullYear(),first.getMonth()+1,0).getDate();
  const offset=(first.getDay()+6)%7, max=Math.max(1,...data.days.map(d=>d.listenedMs));
  const [detail,setDetail]=useState("");
  function move(delta:number){const next=new Date(first);next.setMonth(next.getMonth()+delta);setMonth(localDate(next).slice(0,7));setDetail("");}
  return <section className="analytics-card"><div className="analytics-card-heading"><h2>月度活跃日历</h2><div className="personal-actions">
    <button type="button" aria-label="上个月" disabled={month<=data.startDate.slice(0,7)} onClick={()=>move(-1)}>←</button><span>{month}</span>
    <button type="button" aria-label="下个月" disabled={month>=data.endDate.slice(0,7)} onClick={()=>move(1)}>→</button></div></div>
    <div className="analytics-calendar">{["一","二","三","四","五","六","日"].map(d=><span key={d} className="analytics-weekday">{d}</span>)}
      {Array.from({length:offset},(_,i)=><span key={`pad${i}`}/>)}
      {Array.from({length:count},(_,i)=>{const day=`${month}-${String(i+1).padStart(2,"0")}`, value=values.get(day), ms=value?.listenedMs??0;
        const label=`${day}：${duration(ms)} · ${value?.qualifiedPlays??0} 次有效收听`;
        return <button type="button" key={day} disabled={day<data.startDate||day>data.endDate} aria-label={label} title={label}
          data-level={ms===0?0:Math.max(1,Math.ceil(ms/max*4))} onMouseEnter={()=>setDetail(label)} onFocus={()=>setDetail(label)} onClick={()=>setDetail(label)}>{i+1}</button>;
      })}</div><p aria-live="polite">{detail||"颜色越深，当日收听时长越多；灰色为无已保存时长。"}</p>
  </section>;
}

function Dashboard({data}:{data:Analytics}) {
  const [grain,setGrain]=useState<"day"|"week"|"month">("day");
  const [mode,setMode]=useState<"bar"|"line">("bar");
  const points=useMemo(()=>chartPoints(data,grain),[data,grain]);
  const hours=Array.from({length:24},(_,hour)=>{const row=data.hours.find(h=>h.hour===hour);return {label:`${String(hour).padStart(2,"0")}:00`,end:`${String(hour).padStart(2,"0")}:00`,listenedMs:row?.listenedMs??0,qualifiedPlays:row?.qualifiedPlays??0};});
  return <>
    {!data.storageAvailable&&<p role="alert">部分收听数据未能保存，统计可能不完整。</p>}
    <div className="listening-summary analytics-summary">
      <div><span>区间收听时长</span><strong>{duration(data.totalMs)}</strong></div>
      <div><span>区间有效收听</span><strong>{data.qualifiedPlays} 次</strong></div>
      <div><span>听过的歌曲</span><strong>{data.tracks} 首</strong></div>
      <div><span>活跃天数</span><strong>{data.days.filter(d=>d.listenedMs>0).length} 天</strong></div>
    </div>
    {data.tracks===0&&<p role="status">所选区间没有已保存的收听数据。试试其他日期，或开始听歌。</p>}
    <section className="analytics-card"><div className="analytics-card-heading"><div><span className="section-label">LISTENING ACTIVITY</span><h2>收听趋势</h2></div>
      <div className="personal-actions"><label>聚合粒度 <select value={grain} onChange={e=>setGrain(e.target.value as typeof grain)}><option value="day">按日</option><option value="week">按周</option><option value="month">按月</option></select></label>
        <button type="button" aria-pressed={mode==="bar"} onClick={()=>setMode("bar")}>柱状图</button><button type="button" aria-pressed={mode==="line"} onClick={()=>setMode("line")}>折线图</button></div></div>
      <Chart points={points} mode={mode} label="收听时长趋势图"/>
    </section>
    <div className="analytics-grid"><Calendar data={data}/><section className="analytics-card"><h2>收藏与收听</h2>
      {data.likes===null?<p>喜欢列表尚未载入，暂不能分析收藏与收听的关系。</p>:<>
        <strong className="analytics-feature-number">{data.totalMs?Math.round(data.likes.listenedMs/data.totalMs*100):0}%</strong><p>区间时长来自当前喜欢的歌曲</p>
        <dl className="analytics-facts"><dt>已喜欢歌曲</dt><dd>{data.likes.tracks} 首 · {duration(data.likes.listenedMs)} · {data.likes.qualifiedPlays} 次有效收听</dd>
          <dt>其余歌曲</dt><dd>{data.tracks-data.likes.tracks} 首 · {duration(data.totalMs-data.likes.listenedMs)} · {data.qualifiedPlays-data.likes.qualifiedPlays} 次有效收听</dd></dl>
      </>}<p>按当前已载入的喜欢列表对比，不代表收听时的收藏状态，也不推断收藏与收听的因果关系。</p></section></div>
    <div className="analytics-grid"><section className="analytics-card"><h2>常听歌曲 · TOP 30</h2><p>按有效收听次数、时长排序。</p>
      <ol className="analytics-ranking">{data.songs.map((s,i)=><li key={s.id}><span>{String(i+1).padStart(2,"0")}</span><div><strong>{s.title}</strong><small>{s.artist}</small></div><div><strong>{s.qualifiedPlays} 次</strong><small>{duration(s.listenedMs)}</small></div></li>)}</ol>{!data.songs.length&&<p>暂无歌曲记录。</p>}
    </section><section className="analytics-card"><h2>常听歌手 · TOP 30</h2><p>按曲目保存的歌手字段汇总，合作歌手组合不拆分。</p>
      <ol className="analytics-ranking">{data.artists.map((s,i)=><li key={s.artist}><span>{String(i+1).padStart(2,"0")}</span><div><strong>{s.artist}</strong><small>{s.tracks} 首歌曲</small></div><div><strong>{s.qualifiedPlays} 次</strong><small>{duration(s.listenedMs)}</small></div></li>)}</ol>{!data.artists.length&&<p>暂无歌手记录。</p>}
    </section></div>
    <section className="analytics-card"><h2>一天中的收听习惯</h2><p>按记录时的本机小时汇总区间内的实际收听时长。</p><Chart points={hours} mode="bar" label="24 小时收听分布"/></section>
    <details className="analytics-card analytics-notes"><summary>数据口径与历史范围</summary>
      <p>全部历史累计：{duration(data.lifetimeMs)}，{data.lifetimePlays} 次有效收听。播放启动次数：未采集，不与有效收听次数混用。</p>
      <p>累计听满 30 秒，或短曲的一半（至少 1 秒），记为一次有效收听；暂停、拖动及休眠跳变不计入时长。同一播放过程仅记一次，判定逻辑未变。</p>
      <p>可恢复的分时数据最早从 {new Date(data.retainedFromMs).toLocaleString()} 开始；{new Date(data.upgradedMs).toLocaleString()} 起长期保存。此前已清理的分时数据无法重建，累计值仍保留。边缘日期可能不完整。</p>
      <p>采样时长按落库区间分摊至本地日期及小时，可能有数秒采样归档偏差；有效次数记在达标时刻。切换时区不会重写已归档日期。最近播放最多延迟约 15 秒入库，页面可见时每分钟刷新。</p>
    </details>
  </>;
}

export function ListeningAnalytics() {
  const [preset,setPreset]=useState("month");
  const [range,setRange]=useState(()=>presetRange("month"));
  const [draft,setDraft]=useState(range);
  const [validation,setValidation]=useState("");
  const [data,setData]=useState<Analytics|null>(null);
  const [error,setError]=useState(false);
  const [revision,setRevision]=useState(0);
  useEffect(()=>subscribePlaybackConnection(()=>setRevision(r=>r+1)),[]);
  useEffect(()=>{
    let alive=true, reading=false;
    const identity=playbackSessionIdentity();
    setData(null);setError(false);
    async function refresh(){
      if(reading)return;
      // Keep presets aligned when the page stays open across local midnight.
      const current=preset==="custom"?range:presetRange(preset);
      if(current.start!==range.start||current.end!==range.end){setRange(current);setDraft(current);return;}
      reading=true;
      try{const value=await getAnalytics(range.start,range.end);if(alive&&identity===playbackSessionIdentity()){setData(value);setError(false);}}
      catch{if(alive&&identity===playbackSessionIdentity())setError(true);}
      finally{reading=false;}
    }
    void refresh();
    const visible=()=>{if(document.visibilityState==="visible")void refresh();};
    const timer=window.setInterval(visible,60000);document.addEventListener("visibilitychange",visible);
    return()=>{alive=false;clearInterval(timer);document.removeEventListener("visibilitychange",visible);};
  },[range.start,range.end,preset,revision]);
  function choose(value:string){const next=presetRange(value);setPreset(value);setRange(next);setDraft(next);setValidation("");setRevision(r=>r+1);}
  return <div className="analytics-body">
    <header className="analytics-card-heading"><div><span className="section-label">YOUR MUSIC, OVER TIME</span><h1>听歌统计 2.0</h1><p>让每一次收听，留下可回顾的记录。</p></div><button type="button" onClick={()=>setRevision(r=>r+1)}>刷新分析</button></header>
    <nav className="personal-actions" aria-label="分析日期预设">{([["today","今天"],["week","近 7 天"],["month","本月"],["year","今年"]] as const).map(([id,label])=><button type="button" key={id} aria-pressed={preset===id} onClick={()=>choose(id)}>{label}</button>)}</nav>
    <form className="personal-actions analytics-range" onSubmit={e=>{e.preventDefault();if(!validRange(draft.start,draft.end)){setValidation("请选择有效的起止日期，开始不晚于结束，最多 366 天。");return;}setValidation("");setPreset("custom");setRange({...draft});setRevision(r=>r+1);}}>
      <label>开始日期 <input type="date" min="1970-01-01" value={draft.start} onChange={e=>setDraft({...draft,start:e.target.value})}/></label>
      <label>结束日期 <input type="date" min="1970-01-01" value={draft.end} onChange={e=>setDraft({...draft,end:e.target.value})}/></label><button type="submit">应用日期</button>
    </form>
    {validation&&<p role="alert">{validation}</p>}
    <p>统计区间：{range.start} 至 {range.end}（含首尾日期）。旧版仅保留约 31 天明细，更早的日期可能缺失；全部历史累计仍保留。</p>
    {error?<p role="alert">分析读取失败。<button type="button" onClick={()=>setRevision(r=>r+1)}>重试分析</button></p>:!data?<p role="status">正在聚合收听数据…</p>:<Dashboard data={data}/>}
  </div>;
}
