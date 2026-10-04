import { useEffect, useState } from "react";
import { getPlaybackHistory, type HistoryEntry } from "../../backend/historyAdapter";
import { playHistoryEntry } from "../player/historyPlayback";
import { usePlayerSelector } from "../player/playerStore";
import { SongArtistLinks } from "../artist/SongArtistLinks";
import { Icon } from "../../components/Icon";
import { SongCover } from "./SongCover";
import { NowPlaying } from "./TapeDeck";
import { HistoryCassetteArray } from "./HistoryCassetteArray";
import type { RenderQuality } from "./vendor/render-quality";
import type { ArchiveRenderer, RhineFrameLimit } from "./rhineSettings";
import "./history-archive.css";

const PAGE_SIZE = 8;
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

export default function HistoryArchive({ active, quality, superPerformance, renderer, frameLimit, spatialUpscaling, onBack, onDeck }: {
  renderer?: ArchiveRenderer;
  frameLimit?: RhineFrameLimit;
  spatialUpscaling?: boolean;
  active: boolean; quality: RenderQuality; superPerformance: boolean; onBack: () => void; onDeck: () => void;
}) {
  const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const generation = usePlayerSelector(state => state.generation);
  const queue = usePlayerSelector(state => state.queue);
  const [entries, setEntries] = useState<readonly HistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState(false);
  useEffect(() => {
    if (!native || !active) return;
    let alive = true, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try { const rows = await getPlaybackHistory(); if (alive) { setEntries(rows); setFailed(false); } }
      catch { if (alive) setFailed(true); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [native, active, generation, retry]);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (entries ?? []).filter(entry => `${entry.title} ${entry.artist}`.toLocaleLowerCase().includes(needle));
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const queueById = new Map(queue.map(track => [track.id, track]));
  const rows = matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(entry => {
    const current = queueById.get(entry.id);
    return { ...entry, coverCacheKey: entry.coverCacheKey ?? current?.coverCacheKey,
      album: entry.album || current?.album, durationMs: entry.durationMs || current?.durationMs,
      mediaMid: entry.mediaMid };
  });
  const selected = Math.max(0, rows.findIndex(entry => entry.id === selectedId));
  const chosen = rows[selected];
  function select(index: number) { if (rows[index]) setSelectedId(rows[index].id); }
  function open(index: number) { select(index); setDetail(true); }
  async function play(index: number) {
    const entry = rows[index];
    if (!entry || busy) return;
    setSelectedId(entry.id); setBusy(true); setNotice("");
    try { await playHistoryEntry(entry); setNotice(`正在播放：${entry.title}`); }
    catch { setNotice("播放失败，歌曲可能已下架、需要登录或本地文件已不可用"); }
    finally { setBusy(false); }
  }
  function turn(delta: number) { setPage(currentPage + delta); setSelectedId(null); setNotice(""); setDetail(false); }
  return <section className="rhine-history" data-inspecting={detail && !!chosen} aria-label="最近播放磁带阵列">
    <header className="rhine-history-heading">
      <div className="rhine-history-heading-title"><button className="rhine-back" onClick={onBack}>← 返回档案</button><h1>最近播放</h1><span>{matches.length} 首</span><p className="rhine-eyebrow">LISTENING HISTORY</p></div>
      <label className="rhine-history-search"><Icon name="search" size={15} /><span>搜索歌曲或歌手</span><input type="search" aria-label="搜索最近播放" value={query} onChange={event => { setQuery(event.target.value); setPage(0); setSelectedId(null); setDetail(false); }} placeholder="搜索歌曲或歌手" /></label>
    </header>
    {rows.length > 0 ? <HistoryCassetteArray renderer={renderer} frameLimit={frameLimit} spatialUpscaling={spatialUpscaling} tracks={rows} selected={selected} detail={detail && !!chosen} active={active} quality={quality} superPerformance={superPerformance} onSelect={select} onOpen={open} />
      : <div className="rhine-history-empty" role={failed ? "alert" : "status"}>{!native ? "最近播放需要在桌面客户端中使用" : failed ? <>最近播放读取失败 <button onClick={() => setRetry(value => value + 1)}>重试</button></> : entries === null ? "正在读取最近播放…" : needle ? "没有匹配的歌曲" : "还没有播放记录，收听后歌曲会放入磁带阵列"}</div>}
    {chosen && (detail ? <section className="rhine-document rhine-history-document rhine-history-glass" aria-label="历史歌曲档案">
      <i className="rhine-history-screw" aria-hidden="true" /><i className="rhine-history-screw" aria-hidden="true" />
      <button className="rhine-back" onClick={() => setDetail(false)}>← 返回最近播放阵列</button>
      <p className="rhine-eyebrow">TAPE / {String(currentPage * PAGE_SIZE + selected + 1).padStart(3, "0")}</p>
      <h2>{chosen.title}</h2><p><SongArtistLinks track={chosen} /></p>
      <dl className="rhine-history-metadata"><div><dt>上次播放</dt><dd>{dateFormat.format(chosen.playedAtUnixMs)}</dd></div><div><dt>所属专辑</dt><dd>{chosen.album || "暂无专辑信息"}</dd></div></dl>
      <div className="rhine-history-actions"><button className="rhine-history-primary" disabled={busy} onClick={() => void play(selected)} aria-label={`播放 ${chosen.title}`}><Icon name="play" size={16} />{busy ? "正在装载…" : "播放磁带"}</button><button onClick={onDeck}>进入磁带机 ↗</button></div>
    </section> : <section className="rhine-selection rhine-history-selection rhine-history-glass" aria-label="选中歌曲">
      <i className="rhine-history-screw" aria-hidden="true" /><i className="rhine-history-screw" aria-hidden="true" />
      <div className="rhine-history-panel-label"><span>TAPE SELECT / 选中磁带</span><span>{String(currentPage * PAGE_SIZE + selected + 1).padStart(3, "0")} / {String(matches.length).padStart(3, "0")}</span></div>
      <div className="rhine-history-song-head"><SongCover cacheKey={chosen.coverCacheKey} title={chosen.title} /><div><h2>{chosen.title}</h2><SongArtistLinks track={chosen} /></div></div>
      <div className="rhine-history-ruler" aria-hidden="true" />
      <dl className="rhine-history-metadata"><div><dt>上次播放</dt><dd>{dateFormat.format(chosen.playedAtUnixMs)}</dd></div><div><dt>所属专辑</dt><dd>{chosen.album || "暂无专辑信息"}</dd></div></dl>
      <div className="rhine-history-actions"><button className="rhine-history-primary" disabled={busy} onClick={() => void play(selected)} aria-label={`播放 ${chosen.title}`}><Icon name="play" size={16} />{busy ? "正在装载…" : "播放"}</button><button onClick={() => open(selected)} aria-label="抽取磁带 · 查看歌曲 ↗"><svg className="icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v7h16v-7M12 15V3m-4 4 4-4 4 4" /></svg>抽取磁带</button></div>
    </section>)}
    <footer className="rhine-catalog rhine-history-footer" hidden={detail && !!chosen}>
      <div className="rhine-card-list" aria-label="选择最近播放歌曲">{rows.map((entry, index) => <button key={entry.id} aria-label={`选择 ${entry.title}`} aria-pressed={selected === index} onClick={() => select(index)} onDoubleClick={() => open(index)}><SongCover cacheKey={entry.coverCacheKey} title={entry.title} /><span className="rhine-history-card-copy"><strong>{entry.title}</strong><small>{entry.artist}</small></span></button>)}</div>
      <div className="rhine-history-bottom"><span role="status">{notice || (failed ? "刷新失败，保留上次读取的磁带" : "拖动浏览 · 双击抽取")}</span><nav className="rhine-pages" aria-label="最近播放分页"><button disabled={currentPage === 0} onClick={() => turn(-1)}>上一页</button><span>第 {currentPage + 1} / {pages} 页</span><button disabled={currentPage + 1 >= pages} onClick={() => turn(1)}>下一页</button></nav></div>
    </footer>
    {detail && <p className="rhine-history-detail-notice" role="status">{notice}</p>}
    <div className="rhine-history-transport"><NowPlaying onOpen={onDeck} /></div>
  </section>;
}
