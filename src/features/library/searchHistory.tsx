import { useEffect, useState } from "react";
import type { CatalogSearchType } from "../../contracts/catalogBrowse";
const KEY="qqmusic_search_history_v1";
const OLD_KEY="qqmusic_rhine_search_history";
const EVENT="qqmusic-search-history";
let revision=0;
export const searchHistoryRevision=()=>revision;
export interface SearchEntry { query: string; type: CatalogSearchType }
const types: readonly string[]=["songs","artists","albums","playlists"];
export function readSearchHistory(): SearchEntry[] {
  try {
    const stored=localStorage.getItem(KEY);
    const raw: unknown=JSON.parse(stored ?? "[]");
    if(stored!==null) return Array.isArray(raw)?raw.filter((v):v is SearchEntry=>!!v&&typeof v==="object"&&Object.keys(v).length===2&&typeof v.query==="string"&&!!v.query.trim()&&v.query.length<=100&&!/[\u0000-\u001f]/.test(v.query)&&types.includes(v.type)).slice(0,10):[];
    const legacy: unknown=JSON.parse(localStorage.getItem(OLD_KEY)??"[]");
    return Array.isArray(legacy)?legacy.filter((v):v is string=>typeof v==="string"&&!!v.trim()&&v.length<=100&&!/[\u0000-\u001f]/.test(v)).slice(0,10).map(query=>({query,type:"songs"})):[];
  }catch{return [];}
}
export function writeSearchHistory(entries: readonly SearchEntry[]) {
  revision++;
  try {localStorage.setItem(KEY,JSON.stringify(entries.slice(0,10)));localStorage.removeItem(OLD_KEY);}catch{/* Browsing remains available if storage is full. */}
  window.dispatchEvent(new Event(EVENT));
}
export function rememberSearch(query: string,type: CatalogSearchType) {
  query=query.trim();if(!query||query.length>100||/[\u0000-\u001f]/.test(query))return;
  writeSearchHistory([{query,type},...readSearchHistory().filter(item=>item.query!==query||item.type!==type)]);
}
export function useSearchHistory() {
  const [entries,setEntries]=useState(readSearchHistory);
  useEffect(()=>{const read=()=>setEntries(readSearchHistory());window.addEventListener(EVENT,read);window.addEventListener("storage",read);return()=>{window.removeEventListener(EVENT,read);window.removeEventListener("storage",read);};},[]);
  return entries;
}
export function SearchHistory({onSelect}: {onSelect:(entry:SearchEntry)=>void}) {
  const entries=useSearchHistory();
  const labels={songs:"歌曲",artists:"歌手",albums:"专辑",playlists:"歌单"};
  return <section className="search-history" aria-label="搜索历史"><div><strong>搜索历史</strong>{entries.length>0&&<button type="button" onClick={()=>writeSearchHistory([])}>清空搜索历史</button>}</div>
    {entries.length?entries.map(entry=><button type="button" key={`${entry.type}:${entry.query}`} onClick={()=>onSelect(entry)}>{entry.query} <small>{labels[entry.type]}</small></button>):<p>最近搜索会显示在这里</p>}</section>;
}
