import { useEffect, useRef, useState } from "react";
import { getStatistics, type Statistics, type ShuffleRow } from "../../backend/personalAdapter";
import { playbackSessionIdentity, subscribePlaybackConnection } from "../../backend/playbackTransport";

import { actOnStatisticsTrack, type StatisticsAction } from "../player/statisticsPlayback";
import { ListeningAnalytics } from "./ListeningAnalytics";

type View = "frequent" | "forgotten" | "records" | "shuffle";
const VIEWS = [["frequent", "最近常听"], ["forgotten", "久未听"], ["records", "有效收听记录"], ["shuffle", "智能随机解释"]] as const;
function duration(ms: number) {
  return `${Math.floor(ms / 3_600_000)} 小时 ${Math.floor(ms / 60_000) % 60} 分钟 ${Math.floor(ms / 1000) % 60} 秒`;
}
function reason(row: ShuffleRow) {
  if (row.weight === 0) return "当前歌曲，本次不参与抽取";
  return [
    row.lastPlayedMs === null ? "尚无有效收听记录" : `距上次记录 ${Math.floor(Math.max(0, Date.now() - row.lastPlayedMs) / 86_400_000)} 天`,
    row.liked ? "喜欢加权" : "", row.recent ? "近期播放降权" : "",
  ].filter(Boolean).join(" · ");
}
type Row = { id: string; title: string; artist: string };
function TrackActions({row,busy,onAction}:{row:Row;busy:boolean;onAction:(row:Row,action:StatisticsAction)=>void}) {
  return <div className="personal-actions statistics-track-actions"><button type="button" disabled={busy} aria-label={`播放 ${row.title}`} onClick={()=>onAction(row,"play")}>播放</button><button type="button" disabled={busy} aria-label={`下一首播放 ${row.title}`} onClick={()=>onAction(row,"next")}>下一首</button><button type="button" disabled={busy} aria-label={`加入队列 ${row.title}`} onClick={()=>onAction(row,"enqueue")}>加入队列</button></div>;
}
export function statisticsSince(days: number, now = new Date()) {
  const start=new Date(now);start.setHours(0,0,0,0);start.setDate(start.getDate()-(days-1));return start.getTime();
}
function StatisticsRows({ data, view, days, busy, onAction }: { data: Statistics; view: View; days:number; busy:boolean;onAction:(row:Row,action:StatisticsAction)=>void }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [view, days]);
  if (view === "shuffle") return <>
    <p>{data.shuffle.active ? "智能随机当前生效" : "智能随机当前未生效，以下为按现有规则计算的参考权重"}。
      {!data.shuffle.likesLoaded && "喜欢列表尚未载入，当前不包含喜欢加权。"}
      {data.nextOverride && "已有下一首播放指定，本次会优先播放指定歌曲。"}</p>
    <p>权重依据上次有效收听、喜欢与近期重复计算；概率是下一次抽取的比例，不保证播放顺序。按权重展示前 50 首候选。</p>
    <ul className="personal-list">{data.shuffle.items.slice().sort((a, b) => b.weight - a.weight).slice(0, 50).map(row =>
      <li key={row.id}><div><strong>{row.title}</strong><small>{row.artist} · {reason(row)}</small></div>
        <span>权重 {row.weight.toFixed(2)} · {(row.probability * 100).toFixed(1)}%</span><TrackActions row={row} busy={busy} onAction={onAction}/></li>)}</ul>
    {!data.shuffle.items.length && <p>先加入播放队列，即可查看候选歌曲的权重。</p>}
  </>;
  if (view === "forgotten") {
    const rows = data.forgotten.slice().sort((a, b) => a.lastPlayedMs - b.lastPlayedMs).slice(0, 30);
    return <><p>当前队列中有历史记录的歌曲，按最久未听排序；旧历史仅用于上次播放时间，不折算为收听时长。</p>
      <ul className="personal-list">{rows.map(row => <li key={row.id}><div><strong>{row.title}</strong><small>{row.artist}</small></div>
        <span>{new Date(row.lastPlayedMs).toLocaleDateString()}</span><TrackActions row={row} busy={busy} onAction={onAction}/></li>)}</ul>
      {!rows.length && <p>当前队列还没有可比较的历史记录。</p>}</>;
  }
  if (view === "records") {
    const pages = Math.max(1, Math.ceil(data.events.length / 30));
    const currentPage = Math.min(page, pages);
    return <><p>达到有效收听门槛时记录一次，按时间倒序显示；同一播放过程不会重复计数。</p>
      <ul className="personal-list">{data.events.slice((currentPage - 1) * 30, currentPage * 30).map((row, index) =>
        <li key={`${row.playedAtMs}:${index}`}><div><strong>{row.title}</strong><small>{row.artist}</small></div>
          <span>{new Date(row.playedAtMs).toLocaleString()}</span><TrackActions row={row} busy={busy} onAction={onAction}/></li>)}</ul>
      {!data.events.length && <p>还没有有效收听记录，开始听歌后这里会逐步更新。</p>}
      {pages > 1 && <nav className="personal-actions" aria-label="收听记录分页">
        <button type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <span>第 {currentPage} / {pages} 页</span>
        <button type="button" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button>
      </nav>}</>;
  }
  const rows = data.items.filter(row => row.recentMs > 0).slice().sort((a, b) => b.recentPlays - a.recentPlays || b.recentMs - a.recentMs).slice(0, 30);
  return <><p>按{days === 1 ? "今天" : `近 ${days} 天`}的有效收听次数和时长排序。</p>
    <ul className="personal-list">{rows.map(row => <li key={row.id}><div><strong>{row.title}</strong><small>{row.artist}</small></div>
      <span>{row.recentPlays} 次 · {duration(row.recentMs)}</span><TrackActions row={row} busy={busy} onAction={onAction}/></li>)}</ul>
    {!rows.length && <p>还没有记录，开始听歌后这里会逐步更新。</p>}</>;
}
export function ListeningRecords() {
  const [data, setData] = useState<Statistics | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<View>("frequent");
  const [days,setDays]=useState(30);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  const pending=useRef(false);
  async function act(row:Row,action:StatisticsAction) {
    if(pending.current)return;
    const identity=playbackSessionIdentity();
    pending.current=true;setBusy(true);setNotice("");
    try {await actOnStatisticsTrack(row,action);if(identity===playbackSessionIdentity()){setNotice(`${action==="play"?"正在播放":action==="next"?"下一首播放":"已加入队列"}：${row.title}`);setRevision(r=>r+1);}}
    catch {if(identity===playbackSessionIdentity())setNotice("操作未完成，请检查连接、队列容量或本地文件是否仍存在。");}
    finally {pending.current=false;setBusy(false);}
  }
  const previousIdentity = useRef(playbackSessionIdentity());
  useEffect(() => subscribePlaybackConnection(() => setRevision(r => r + 1)), []);
  useEffect(() => {
    let alive = true;
    const identity = playbackSessionIdentity();
    if (previousIdentity.current !== identity) { setData(null); previousIdentity.current = identity; }
    setError(false);
    let reading=false;
    async function refresh(){
      if(reading)return;reading=true;
      try {const value=await getStatistics(statisticsSince(days));if(alive&&identity===playbackSessionIdentity()){setData(value);setError(false);}}
      catch {if(alive&&identity===playbackSessionIdentity())setError(true);}
      finally {reading=false;}
    }
    void refresh();
    const visibleRefresh=()=>{if(document.visibilityState==="visible")void refresh();};
    const timer=window.setInterval(visibleRefresh,15_000);
    document.addEventListener("visibilitychange",visibleRefresh);
    return () => { alive = false;window.clearInterval(timer);document.removeEventListener("visibilitychange",visibleRefresh); };
  }, [revision,days]);
  return <section className="listening-statistics catalog-pane" aria-label="听歌统计">
    <header><span className="section-label">LISTENING RECORD</span><h1>听歌统计</h1>
      <button type="button" onClick={() => setRevision(r => r + 1)}>刷新统计</button></header>
    <p>从此版本开始累计实际播放进度；暂停、拖动和休眠跳变不计入。累计听满 30 秒，或短曲的一半（至少 1 秒），记为一次有效收听。</p>
    <nav className="personal-actions" aria-label="统计日期范围">{([1,7,30] as const).map(value=><button type="button" key={value} aria-pressed={days===value} onClick={()=>{if(value!==days){setData(null);setDays(value);}else setRevision(r=>r+1);}}>{value===1?"今天":`近 ${value} 天`}</button>)}</nav>
    <p>常听榜和有效收听记录按本地日期筛选，页面可见时自动更新。日期时长从本次升级开始记录，累计时长保留全部历史数据。</p>
    {notice&&<p role="status">{notice}</p>}
    {error ? <p role="alert">统计读取失败 <button type="button" onClick={() => setRevision(r => r + 1)}>重试</button></p> : !data ?
      <p role="status">正在读取统计…</p> : <>
        {!data.storageAvailable && <p role="alert">部分收听数据未能保存，统计可能不完整。</p>}
        <div className="listening-summary">
          <div><strong>{duration(data.totalMs)}</strong><span>累计收听</span></div>
          <div><strong>{data.qualifiedPlays} 次</strong><span>有效收听</span></div>
          <div><strong>{data.startedMs ? new Date(data.startedMs).toLocaleDateString() : "尚未开始"}</strong><span>开始记录</span></div>
        </div>
        <nav className="personal-actions" aria-label="统计分类">{VIEWS.map(([id, label]) =>
          <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}</nav>
        <StatisticsRows data={data} view={view} days={days} busy={busy} onAction={(row,action)=>void act(row,action)} />
      </>}
  </section>;
}

export function ListeningStatistics() {
  const [view,setView]=useState<"analytics"|"records">("analytics");
  return <section className="listening-statistics analytics-shell catalog-pane" aria-label="听歌统计">
    <nav className="personal-actions" aria-label="统计视图">
      <button type="button" aria-pressed={view==="analytics"} onClick={()=>setView("analytics")}>数据分析</button>
      <button type="button" aria-pressed={view==="records"} onClick={()=>setView("records")}>收听记录与队列</button>
    </nav>
    {view==="analytics"?<ListeningAnalytics/>:<ListeningRecords/>}
  </section>;
}
