import { Fragment, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref, type CSSProperties } from "react";
import type { CatalogEntity, CatalogEntityPage } from "../../contracts/catalogBrowse";
import type { CatalogSongPage } from "../../contracts/catalog";
import type { RecommendationKind } from "../../backend/catalogDiscoveryAdapter";
import { CatalogDetails, AlbumLink } from "../catalog/CatalogDetails";
import { DiscoveryTabs, DISCOVERY_TABS } from "../catalog/RecommendationPanel";
import { useRecommendations } from "../catalog/useRecommendations";
import { Icon } from "../../components/Icon";
import type { DiscoveryState, DiscoveryFrame } from "./vendor/discovery-layout";
import "./discovery-shelf.css";
import "./discovery-rack.css";

export type DiscoveryHandle = { frame: (frame: DiscoveryFrame) => void };
type Props = { active: boolean; visible?: boolean; accountKey: string; onClose: () => void; onDeck?: () => void; motionDisabled?: boolean;
  onSceneChange?: (state: DiscoveryState) => void; ref?: Ref<DiscoveryHandle> };
export function ArchiveDiscovery(props: Props) { return <DiscoveryContent key={props.accountKey} {...props} />; }

function DiscoveryContent({ active, visible = active, accountKey, onClose, onDeck, motionDisabled = false, onSceneChange, ref }: Props) {
  const [kind,setKind]=useState<RecommendationKind>("guess"),[visited,setVisited]=useState<RecommendationKind[]>(["guess"]);
  const [entity,setEntity]=useState<CatalogEntity|null>(null),[top,setTop]=useState(166);
  const root=useRef<HTMLElement>(null),header=useRef<HTMLDivElement>(null),origin=useRef<HTMLElement|null>(null);
  const current=useRef({active,entity,kind});current.current={active,entity,kind};
  useImperativeHandle(ref,()=>({frame(frame) {
    const section=root.current;if(!section)return;
    section.dataset.phase=frame.phase;
    const pane=section.querySelector<HTMLElement>(`[data-rack-tab="${current.current.kind}"]`);
    const scroller=pane?.querySelector<HTMLElement>(".discovery-rack-scroll"),space=pane?.querySelector<HTMLElement>(".discovery-rack-space");
    if(space)space.style.height=`${frame.contentHeight}px`;
    if(scroller&&frame.phase==="ready"&&current.current.active)scroller.scrollTop=Number(pane?.dataset.scroll??0);
    const dossier=pane?.querySelector<HTMLElement>(".discovery-rack-dossier");
    if(dossier)dossier.style.top=section.clientWidth<800?`${top+Math.min((section.clientHeight-top)*.38,225)+16}px`:"";
    for(const button of pane?.querySelectorAll<HTMLElement>("[data-rack-id]")??[]) {
      const rect=frame.rects.find(r=>r.id===button.dataset.rackId);if(!rect)continue;
      Object.assign(button.style,{left:`${rect.x}px`,top:`${rect.y+(scroller?.scrollTop??0)-top}px`,width:`${rect.width}px`,height:`${rect.height}px`});
    }
  }}),[top]);
  useLayoutEffect(()=>{
    if(!header.current||!visible)return;
    const update=()=>setTop(header.current!.offsetHeight||166);
    update();if(typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(update);observer.observe(header.current);return()=>observer.disconnect();
  },[visible]);
  function open(next:CatalogEntity){origin.current=document.activeElement as HTMLElement;setEntity(next);}
  function back(){setEntity(null);requestAnimationFrame(()=>origin.current?.focus({preventScroll:true}));}
  return <section ref={root} className="rhine-discovery rhine-discovery-rack" aria-label="发现音乐" hidden={!visible} inert={!active}
    data-motion={motionDisabled?"off":"on"} data-details={!!entity} onKeyDown={event=>{
      if(event.key==="Escape"&&!event.nativeEvent.isComposing&&!event.defaultPrevented){event.stopPropagation();if(entity)back();else onClose();}
    }}>
    <div className="discovery-rack-heading" ref={header}>
      <header className="discovery-header"><div><p className="rhine-eyebrow">DISCOVERY / MUSIC ARCHIVE</p><h1>发现音乐</h1></div>
        <nav aria-label="发现页面导航"><button type="button" onClick={onClose}>← 返回档案</button>{onDeck&&<button type="button" onClick={onDeck}>进入磁带机 ↗</button>}</nav></header>
      <div hidden={!!entity}><DiscoveryTabs value={kind} includeNewSongs={false} onChange={value=>{const next=value as RecommendationKind;setKind(next);setVisited(v=>v.includes(next)?v:[...v,next]);}} /></div>
    </div>
    {visited.map(tab=><RecommendationRack key={tab} kind={tab} accountKey={accountKey} active={active&&!entity&&tab===kind}
      hidden={tab!==kind||!!entity} top={top} reduced={motionDisabled} onOpen={open} onDeck={onDeck} onSceneChange={onSceneChange} />)}
    {entity&&<div className="discovery-details"><CatalogDetails key={`${entity.kind}:${entity.id}`} entity={entity} onBack={back} onPlayback={onDeck} active={active} /></div>}
  </section>;
}

function RecommendationRack({kind,accountKey,active,hidden,top,reduced,onOpen,onDeck,onSceneChange}: {
  kind:RecommendationKind;accountKey:string;active:boolean;hidden:boolean;top:number;reduced:boolean;
  onOpen:(entity:CatalogEntity)=>void;onDeck?:()=>void;onSceneChange?:(state:DiscoveryState)=>void;
}) {
  const {page,error,pageNumber,busy,notice,act,refresh,goToPage}=useRecommendations({kind,accountKey,active});
  const [selectedId,setSelected]=useState<string|null>(null),[hovered,setHovered]=useState<string|null>(null),[scroll,setScroll]=useState(0);
  const scroller=useRef<HTMLDivElement>(null),dialog=useRef<HTMLElement>(null),trigger=useRef<HTMLElement|null>(null);
  const items=useMemo(()=>!page?[]:kind==="playlists"?(page as CatalogEntityPage).items.filter(e=>e.kind==="playlist").map(playlist=>({id:`playlist:${playlist.id}`,playlist,song:null})):
    (page as CatalogSongPage).items.map(song=>({id:`song:${song.id}`,song,playlist:null})),[page,kind]);
  const selected=items.find(i=>i.id===selectedId);
  const entries=useMemo(()=>items.map(item=>({id:item.id,kind:item.song?"song" as const:"playlist" as const,title:(item.song??item.playlist!).title,
    subtitle:item.song?item.song.artist:`${item.playlist!.songCount} 首歌曲`,coverCacheKey:(item.song??item.playlist!).coverCacheKey,
    duration:item.song?.durationMs?`${Math.floor(item.song.durationMs/60000)}:${String(Math.floor(item.song.durationMs/1000)%60).padStart(2,"0")}`:undefined})),[items]);
  const revision=useRef(0),previousPage=useRef(page);if(page&&page!==previousPage.current){previousPage.current=page;revision.current++;}
  const state=useMemo<DiscoveryState>(()=>({open:true,ready:!!page||!!error,key:`${accountKey}:${kind}:${pageNumber}:${revision.current}`,entries,selected:selected?.id??null,hovered,scroll,top,reduced}),[accountKey,kind,pageNumber,page,error,entries,selected?.id,hovered,scroll,top,reduced]);
  useEffect(()=>{if(active)onSceneChange?.(state);},[active,state,onSceneChange]);
  useLayoutEffect(()=>{if(!hidden&&scroller.current)scroller.current.scrollTop=scroll;},[hidden,scroll,active]);
  useEffect(()=>{if(selected&&active)dialog.current?.querySelector<HTMLButtonElement>("button")?.focus({preventScroll:true});},[selected?.id,active]);
  function close(){setSelected(null);setHovered(null);requestAnimationFrame(()=>trigger.current?.focus({preventScroll:true}));}
  async function play(){if(selected?.song&&await act(selected.song,"play"))onDeck?.();}
  const label=DISCOVERY_TABS.find(([tab])=>tab===kind)![1];
  return <section className="discovery-rack-pane" data-rack-tab={kind} data-scroll={scroll} aria-label={label} hidden={hidden} style={{"--rack-top":`${top}px`} as CSSProperties}
    onKeyDown={event=>{if(event.key==="Escape"&&selected){event.preventDefault();event.stopPropagation();close();}}}>
    <div className="discovery-toolbar"><p>{accountKey.startsWith("authenticated:")?"当前账号":"登录后可获得个人推荐"}{page&&` · 本页 ${items.length} ${kind==="playlists"?"张歌单":"首"}`}</p>
      <button type="button" aria-label="刷新推荐" disabled={busy||!active} onClick={()=>{close();refresh();}}>↻ 刷新推荐</button></div>
    <div className="discovery-rack-scroll" ref={scroller} style={{overflowY:selected?"hidden":"auto"}} onScroll={e=>{const phase=e.currentTarget.closest<HTMLElement>("[data-phase]")?.dataset.phase;if(active&&(!phase||phase==="ready"))setScroll(e.currentTarget.scrollTop);}} onClick={e=>{if(selected&&e.target===e.currentTarget)close();}}>
      <div className="discovery-rack-space" role="group" aria-label={`${label}磁带架`} onClick={e=>{if(selected&&e.target===e.currentTarget)close();}}>
        {items.map(item=><button type="button" key={item.id} data-rack-id={item.id} className="discovery-rack-hit" tabIndex={selected&&selected.id!==item.id?-1:0}
          aria-hidden={selected&&selected.id!==item.id?true:undefined} aria-label={`选择${item.song?"歌曲":"歌单"} ${(item.song??item.playlist!).title}`} aria-pressed={selected?.id===item.id}
          onPointerEnter={()=>setHovered(item.id)} onPointerLeave={()=>setHovered(null)} onFocus={()=>setHovered(item.id)} onBlur={()=>setHovered(null)}
          onClick={e=>{trigger.current=e.currentTarget;setSelected(item.id);}}><span className="discovery-sr-only">{(item.song??item.playlist!).title}</span></button>)}
      </div>
    </div>
    {(!page||error||!items.length)&&<div className="discovery-rack-state">{error?<p role="alert">推荐暂时不可用，检查网络后可刷新重试。</p>:!page?<p role="status">正在读取推荐…</p>:<p>暂时没有推荐内容，稍后刷新试试。</p>}</div>}
    {selected&&<aside ref={dialog} className="discovery-dossier discovery-rack-dossier" role="dialog" aria-modal="true" aria-label="选中磁带档案" onKeyDown={event=>{
      if(event.key!=="Tab")return;const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const first=buttons[0],last=buttons.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }}><button className="discovery-close" aria-label="收回磁带" onClick={close}>收回磁带 ×</button>
      <p className="rhine-eyebrow">{selected.song?"TRACK":"PLAYLIST"} / {String(items.findIndex(item=>item.id===selected.id)+1).padStart(2,"0")}</p><h2>{(selected.song??selected.playlist!).title}</h2>
      {selected.song?<><dl><div><dt>歌手</dt><dd>{selected.song.artists.length?selected.song.artists.map((artist,index)=><Fragment key={`${artist.id}:${index}`}>{index>0&&" / "}<button onClick={()=>onOpen({kind:"artist",...artist})}>{artist.name}</button></Fragment>):selected.song.artist}</dd></div>
        <div><dt>专辑</dt><dd><AlbumLink track={selected.song} onOpen={onOpen}/></dd></div><div><dt>时长</dt><dd>{entries.find(e=>e.id===selected.id)?.duration??"时长未知"}</dd></div></dl>
        <div className="discovery-dossier-actions"><button className="discovery-primary" disabled={busy||!active} onClick={()=>void play()}><Icon name="play" size={16}/>播放</button><div>
          <button disabled={busy||!active} onClick={()=>void act(selected.song!,"next")}><Icon name="play-next" size={18}/>下一首播放</button><button aria-label="加入队列" disabled={busy||!active} onClick={()=>void act(selected.song!,"enqueue")}>＋ 加入队列</button></div></div></>:
        <><p>{selected.playlist!.songCount} 首歌曲 · {selected.playlist!.listenCount.toLocaleString()} 次播放</p><p className="discovery-description">{selected.playlist!.description}</p><button className="discovery-primary" onClick={()=>onOpen(selected.playlist!)}>查看歌单 ↗</button></>}
      <p className="discovery-notice" role="status">{notice}</p>
    </aside>}
    <footer className="discovery-rack-footer">{!!page?.warningCount&&<span>部分内容暂时不可用，已显示可用推荐。</span>}{kind!=="guess"&&page&&<nav className="discovery-pages" aria-label="推荐分页">
      <button disabled={busy||pageNumber===1||!active} onClick={()=>{close();setScroll(0);goToPage(pageNumber-1);}}>上一页</button><span>第 {pageNumber} 页</span><button disabled={busy||!page.hasMore||pageNumber>=100||!active} onClick={()=>{close();setScroll(0);goToPage(pageNumber+1);}}>下一页</button></nav>}</footer>
  </section>;
}
