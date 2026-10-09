import { useEffect, useRef, useState, type CSSProperties } from "react";
import { enqueueMemoryTape, getMemoryTape, getMemoryTapes, type MemoryTape, type TapeDetail, type TapePage, type TapeSong } from "../../backend/memoryTapeAdapter";
import { playbackSessionIdentity, subscribePlaybackConnection } from "../../backend/playbackTransport";
import { playerActions } from "../player/playerStore";
import { duration } from "../library/analyticsDates";
import type { RhineSettings } from "./rhineSettings";
import "./memory-tapes.css";

const STATUS={recording:"正在记录",complete:"完整月份",partial:"资料不完整"} as const;
const COLORS=["#708899","#859486","#909672","#748e7e","#67908e","#6e929d","#76879b","#938473","#a08b70","#8c8178","#838990","#8a8a9a"];
function color(month:string){return {"--memory-accent":COLORS[Number(month.slice(5))-1]} as CSSProperties;}
export function memoryMotion(settings:RhineSettings) {
  return settings.superPerformance||settings.disableCassetteMotionWhilePlaying||settings.renderer==="canvas2d"?"off":settings.reduceCassetteMotionWhilePlaying?"reduced":"full";
}
function TapeFace({tape,back=false}:{tape:MemoryTape;back?:boolean}) {
  return <div className={`memory-cassette ${back?"memory-cassette-back":""}`} style={color(tape.month)} aria-hidden="true">
    <div className="memory-cassette-label"><span>RHINE / MEMORY ARCHIVE</span><strong>{tape.month.replace("-"," / ")}</strong><small>{back?`${tape.trackCount} TRACKS · ${tape.qualifiedPlays} LISTENS`:STATUS[tape.status]}</small></div>
    <div className="memory-tape-window"><i className="memory-reel"/><span/><i className="memory-reel"/></div>
    <div className="memory-tape-foot"><span>{back?"B / INDEX":"A / RECOLLECTION"}</span><b>◦ &nbsp; ▱ &nbsp; ◦</b><span>{tape.month.replace("-","")}</span></div>
  </div>;
}

export default function MemoryTapeArchive({settings,active=true}:{settings:RhineSettings;active?:boolean}) {
  const [page,setPage]=useState<TapePage|null>(null),[detail,setDetail]=useState<TapeDetail|null>(null);
  const [cursors,setCursors]=useState<(string|null)[]>([null]);const before=cursors.at(-1)??null;
  const [month,setMonth]=useState<string|null>(null),[offset,setOffset]=useState(0),[revision,setRevision]=useState(0);
  const [session,setSession]=useState(0),[listError,setListError]=useState(false),[detailError,setDetailError]=useState(false);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[failed,setFailed]=useState<string[]>([]);
  const [flipped,setFlipped]=useState(false),[loaded,setLoaded]=useState(0);
  const action=useRef(0),pending=useRef(false),selectedButton=useRef<HTMLButtonElement|null>(null);
  const heading=useRef<HTMLHeadingElement>(null),focusDetail=useRef(false);
  useEffect(()=>subscribePlaybackConnection(()=>{
    action.current++;pending.current=false;setBusy(false);setPage(null);setDetail(null);setMonth(null);setCursors([null]);setNotice("");setFailed([]);setSession(s=>s+1);
  }),[]);
  useEffect(()=>{
    const visible=()=>{if(active&&document.visibilityState==="visible"&&!pending.current)setRevision(r=>r+1);};
    const timer=window.setInterval(visible,60000);document.addEventListener("visibilitychange",visible);
    return()=>{clearInterval(timer);document.removeEventListener("visibilitychange",visible);};
  },[active]);
  useEffect(()=>{
    let alive=true;const identity=playbackSessionIdentity();setListError(false);
    void getMemoryTapes(before).then(value=>{if(alive&&identity===playbackSessionIdentity())setPage(value);}).catch(()=>{if(alive&&identity===playbackSessionIdentity())setListError(true);});
    return()=>{alive=false;};
  },[before,revision,session]);
  useEffect(()=>{
    if(!month)return;
    let alive=true;const identity=playbackSessionIdentity();setDetailError(false);
    void getMemoryTape(month,offset).then(value=>{if(alive&&identity===playbackSessionIdentity()){setDetail(value);if(focusDetail.current){focusDetail.current=false;requestAnimationFrame(()=>{if(alive)heading.current?.focus();});}}}).catch(()=>{if(alive&&identity===playbackSessionIdentity())setDetailError(true);});
    return()=>{alive=false;};
  },[month,offset,revision,session]);
  useEffect(()=>()=>{action.current++;},[]);
  function open(tape:MemoryTape,button:HTMLButtonElement){selectedButton.current=button;focusDetail.current=true;setMonth(tape.month);setOffset(0);setDetail(null);setFlipped(false);setLoaded(0);setNotice("");setFailed([]);setRevision(r=>r+1);}
  function eject(){setMonth(null);setDetail(null);setNotice("");setFlipped(false);selectedButton.current?.focus();}
  async function enqueue(songs:readonly TapeSong[],play=false){
    if(pending.current||!month)return;
    const ids=songs.filter(s=>s.availability!=="unavailable").map(s=>s.id);if(!ids.length)return;
    const token=++action.current,identity=playbackSessionIdentity();pending.current=true;setBusy(true);setNotice("");
    try {
      const result=await enqueueMemoryTape(month,ids);
      if(token!==action.current||identity!==playbackSessionIdentity())return;
      setLoaded(v=>v+1);
      if(result.skippedIds.length){setDetail(d=>d?{...d,songs:d.songs.map(s=>result.skippedIds.includes(s.id)?{...s,availability:"unavailable"}:s)}:d);}
      if(play&&result.acceptedIds[0]){
        if(await playerActions.playTrack(result.acceptedIds[0])===false)throw new Error("播放未启动");
        if(token!==action.current||identity!==playbackSessionIdentity())return;
        setFailed(values=>values.filter(id=>!ids.includes(id)));setNotice(`正在回放：${songs[0]?.title??"历史歌曲"}`);
      } else setNotice(`${result.acceptedIds.length} 首已在队列中（已有歌曲不重复添加）${result.skippedIds.length?`；${result.skippedIds.length} 首本地文件不可用，已跳过`:""}。`);
    } catch {
      if(token===action.current&&identity===playbackSessionIdentity()){
        if(play)setFailed(values=>Array.from(new Set([...values,...ids])));
        setNotice(play?"暂时无法播放，请检查登录、网络或文件；歌曲可能已经加入队列，可重试播放。":"加入未完成，请检查连接和队列容量；响应中断时请先查看队列，再手动重试。");
      }
    } finally {if(token===action.current){pending.current=false;setBusy(false);}}
  }
  const current=detail?.tape;
  return <section className="memory-archive" aria-label="回忆磁带" data-motion={memoryMotion(settings)} data-active={active} data-frame-limit={settings.frameLimit}>
    <header className="memory-header"><div><span className="memory-eyebrow">RHINE / PERSONAL ARCHIVE</span><h1>回忆磁带</h1><p>按月收好，你听过的声音。</p></div><button type="button" disabled={busy} onClick={()=>setRevision(r=>r+1)}>刷新档案</button></header>
    <div className="memory-layout"><section className="memory-cabinet" aria-label="月度磁带档案柜">
      <div className="memory-section-title"><span>MONTHLY COLLECTION</span><small>最新月份在前</small></div>
      {listError?<p role="alert">磁带档案读取失败。<button onClick={()=>setRevision(r=>r+1)}>重试档案</button></p>:!page?<p role="status">正在整理月度磁带…</p>:!page.items.length?<div className="memory-empty"><strong>还没有回忆磁带</strong><p>开始听歌后，有记录的月份会自动生成磁带。不会从缺失记录中补造历史。</p></div>:<>
        <div className="memory-shelf">{page.items.map(tape=><button type="button" className="memory-shelf-item" key={tape.month} disabled={busy} aria-pressed={month===tape.month} aria-label={`打开 ${tape.month} 回忆磁带，${STATUS[tape.status]}`} onClick={e=>open(tape,e.currentTarget)}>
          <TapeFace tape={tape}/><span className="memory-shelf-caption"><strong>{tape.month}</strong><span>{duration(tape.totalMs)}</span></span><small>{tape.trackCount} 首 · {STATUS[tape.status]}</small>
        </button>)}</div>
        <nav className="memory-pagination" aria-label="磁带月份分页"><button disabled={busy||cursors.length===1} onClick={()=>{setCursors(v=>v.slice(0,-1));setPage(null);eject();}}>较新月份</button><span>第 {cursors.length} 页</span><button disabled={busy||!page.hasMore} onClick={()=>{const last=page.items.at(-1);if(last){setCursors(v=>[...v,last.month]);setPage(null);eject();}}}>更早月份</button></nav>
      </>}
    </section>
    <section className="memory-detail" aria-label="磁带档案详情" aria-busy={busy}>
      {!month?<div className="memory-empty memory-empty-detail"><span className="memory-empty-reels" aria-hidden="true">◎ ─ ◎</span><h2>从档案柜取出一张磁带</h2><p>查看那个月的收听记录，再把想听的歌放回队列。</p></div>:detailError?<p role="alert">这张磁带读取失败。<button onClick={()=>setRevision(r=>r+1)}>重试磁带</button></p>:!current||!detail?<p role="status">正在打开 {month} 磁带…</p>:<div className="memory-open" key={month}>
        <div className="memory-section-title"><h2 ref={heading} tabIndex={-1}>{current.month} / 回忆档案</h2><button type="button" disabled={busy} onClick={eject}>取出磁带</button></div>
        <div className={`memory-preview ${flipped?"is-flipped":""} ${loaded?"is-loaded":""}`} key={`${month}-${loaded}`}><div className="memory-flip-inner">
          <div className="memory-shell-edge memory-shell-left" aria-hidden="true"/><div className="memory-shell-edge memory-shell-right" aria-hidden="true"/>
          <div className="memory-shell-edge memory-shell-top" aria-hidden="true"/><div className="memory-shell-edge memory-shell-bottom" aria-hidden="true"/>
          <div className="memory-front"><TapeFace tape={current}/></div><div className="memory-back"><TapeFace tape={current} back/></div>
        </div></div>
        <div className="memory-detail-tools"><span className={`memory-status memory-status-${current.status}`}>{STATUS[current.status]}</span><button type="button" aria-pressed={flipped} onClick={()=>setFlipped(v=>!v)}>翻面查看编号</button></div>
        <div className="memory-summary"><strong>{duration(current.totalMs)}</strong><span>{current.qualifiedPlays} 次有效收听 · {current.trackCount} 首歌曲</span></div>
        <dl className="memory-highlights"><dt>最常听的歌</dt><dd>{current.topSong??"暂无曲目"}</dd><dt>最常听的歌手</dt><dd>{current.topArtist??"暂无歌手"}</dd></dl>
        <p className="memory-coverage">{current.status==="recording"?"本月尚未结束，内容会继续更新。":current.status==="partial"?"旧明细或月初记录可能缺失，这是一张部分记录磁带。":"该自然月已结束，数据来自持续保留的收听记录。"}<br/>已保存记录日期：{current.dataStartDate??"无"} — {current.dataEndDate??"无"}。</p>
        <details className="memory-provenance"><summary>归档时间与数据说明</summary><p>首次生成：{new Date(current.generatedMs).toLocaleString()}<br/>统计截止：{new Date(current.cutoffMs).toLocaleString()}</p><p>按记录时本机日期归档；缺失历史不会补造。歌曲和歌手沿用已保存元数据，榜单按有效次数、时长排序。回放入队不改写历史或收藏；再次实际收听会正常记入当前月份。</p></details>
        <div className="memory-track-heading"><h3>月度曲目榜</h3><button type="button" disabled={busy||!detail.songs.some(s=>s.availability!=="unavailable")} onClick={()=>void enqueue(detail.songs)}>本页加入队列</button></div>
        <p className="memory-track-note">跳过已失效的本地文件；在线歌曲的权限和可用性在实际播放时确认。每页最多 50 首。</p>
        {notice&&<p className="memory-notice" role="status">{notice}</p>}
        <ol className="memory-tracks" start={offset+1}>{detail.songs.map((song,i)=><li key={song.id} data-unavailable={song.availability==="unavailable"}>
          <span className="memory-rank">{String(offset+i+1).padStart(2,"0")}</span><div className="memory-track-info"><strong>{song.title}</strong><span>{song.artist}</span><small>{song.qualifiedPlays} 次 · {duration(song.listenedMs)}</small><small>{song.availability==="unavailable"?"不可用 · 本地文件缺失或曲目标识失效":failed.includes(song.id)?"暂时无法播放 · 可重试":song.availability==="local"?"本地文件可读取":"在线曲目 · 播放时确认"}</small></div>
          <div className="memory-track-actions"><button disabled={busy||song.availability==="unavailable"} aria-label={`回放 ${song.title}`} onClick={()=>void enqueue([song],true)}>回放</button><button disabled={busy||song.availability==="unavailable"} aria-label={`加入队列 ${song.title}`} onClick={()=>void enqueue([song])}>＋</button></div>
        </li>)}</ol>
        {!detail.songs.length&&<p>此页暂无可展示曲目。</p>}
        <nav className="memory-pagination" aria-label="磁带曲目分页"><button disabled={busy||offset===0} onClick={()=>{setOffset(v=>v-50);setDetail(null);setNotice("");}}>上一页</button><span>第 {offset/50+1} 页</span><button disabled={busy||!detail.hasMore} onClick={()=>{setOffset(v=>v+50);setDetail(null);setNotice("");}}>下一页</button></nav>
      </div>}
    </section></div>
  </section>;
}
