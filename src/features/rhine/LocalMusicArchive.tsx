import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import type { LocalMusicTrack } from "../../contracts/localMusic";
import { HistoryCassetteArray as SongCassetteArray } from "./HistoryCassetteArray";
import { SongCover } from "./SongCover";
import { NowPlaying } from "./TapeDeck";
import type { RenderQuality } from "./vendor/render-quality";
import type { ArchiveRenderer, RhineFrameLimit } from "./rhineSettings";
import "./history-archive.css";

export type LocalArchiveOptions = {
  renderer?: ArchiveRenderer;
  frameLimit?: RhineFrameLimit;
  spatialUpscaling?: boolean;
  active: boolean; quality: RenderQuality; superPerformance: boolean;
  onBack: () => void; onDeck: () => void;
};
export type LocalMusicArchiveProps = LocalArchiveOptions & {
  state: "idle" | "loading" | "ready" | "error"; liveRuntime: boolean;
  tracks: readonly LocalMusicTrack[]; visibleTracks: readonly LocalMusicTrack[];
  selectedId: string; onSelect: (id: string) => void;
  query: string; onQueryChange: (value: string) => void;
  notice: string; warningCount: number; busy: boolean; importBusy: boolean; armedDeleteId: string;
  onImport: () => void; onReload: () => void; onPlay: (track: LocalMusicTrack) => void;
  onEnqueue: (track: LocalMusicTrack) => void; onDelete: (track: LocalMusicTrack) => void;
};
const PAGE_SIZE = 8;
function duration(ms: number) { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }

export default function LocalMusicArchive(props: LocalMusicArchiveProps) {
  const { visibleTracks, selectedId, onSelect, query, onQueryChange } = props;
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState(false);
  const selectedPage = Math.floor(Math.max(0, visibleTracks.findIndex(track => track.id === selectedId)) / PAGE_SIZE);
  useEffect(() => { setPage(selectedPage); }, [selectedId, selectedPage]);
  const pages = Math.max(1, Math.ceil(visibleTracks.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const rows = visibleTracks.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selected = Math.max(0, rows.findIndex(track => track.id === selectedId));
  const chosen = rows[selected];
  function select(index: number) { if (rows[index]) onSelect(rows[index].id); }
  function open(index: number) { select(index); setDetail(true); }
  function turn(delta: number) {
    const next = currentPage + delta;
    const first = visibleTracks[next * PAGE_SIZE];
    if (!first) return;
    setPage(next); setDetail(false); onSelect(first.id);
  }
  const metadata = chosen ? <dl className="rhine-history-metadata">
    <div><dt>格式</dt><dd>{chosen.format.toUpperCase()}</dd></div><div><dt>时长</dt><dd>{duration(chosen.durationMs)}</dd></div>
    <div><dt>所属专辑</dt><dd>{chosen.album || "未标注"}</dd></div><div><dt>曲目来源</dt><dd>本地音乐</dd></div>
  </dl> : null;
  const play = chosen ? <button className="rhine-history-primary" disabled={props.busy} onClick={() => props.onPlay(chosen)} aria-label={`播放 ${chosen.title}`}><Icon name="play" size={16} />播放</button> : null;

  return <section className="rhine-history rhine-local-archive" data-inspecting={detail && !!chosen} aria-label="本地音乐磁带阵列">
    <header className="rhine-history-heading">
      <div className="rhine-history-heading-title"><button className="rhine-back" onClick={props.onBack}>← 返回档案</button><h1>本地音乐</h1><span>{visibleTracks.length} 首</span><p className="rhine-eyebrow">LOCAL TAPES</p></div>
      <div className="rhine-local-archive-tools"><button className="rhine-local-import" disabled={!props.liveRuntime || props.busy} onClick={props.onImport}><Icon name="library" size={15} />{props.importBusy ? "正在导入…" : "导入音乐"}</button>
        <label className="rhine-history-search"><Icon name="search" size={15} /><span>搜索本地歌曲</span><input type="search" aria-label="搜索本地歌曲" placeholder="搜索歌曲、歌手或专辑" value={query} onChange={event => { setPage(0); setDetail(false); onQueryChange(event.target.value); }} /></label>
      </div>
    </header>
    {rows.length ? <SongCassetteArray renderer={props.renderer} frameLimit={props.frameLimit} spatialUpscaling={props.spatialUpscaling} tracks={rows} selected={selected} detail={detail && !!chosen} active={props.active} quality={props.quality} superPerformance={props.superPerformance} onSelect={select} onOpen={open} />
      : <div className="rhine-history-empty" role={props.state === "error" ? "alert" : "status"}>
        {!props.liveRuntime ? "请在桌面端导入本地音乐" : props.state === "loading" ? "正在读取本地曲库…" : props.state === "error" ? <>本地曲库暂时不可用 <button onClick={props.onReload}>重新读取</button></> : props.tracks.length ? "没有找到匹配的音乐" : "还没有本地音乐，点击“导入音乐”添加 MP3、FLAC 或 OGG 文件"}
      </div>}
    {chosen && (detail ? <section className="rhine-document rhine-history-document rhine-history-glass" aria-label="本地歌曲档案">
      <i className="rhine-history-screw" aria-hidden="true" /><i className="rhine-history-screw" aria-hidden="true" />
      <button className="rhine-back" onClick={() => setDetail(false)}>← 返回本地音乐阵列</button><p className="rhine-eyebrow">LOCAL TAPE / {String(currentPage * PAGE_SIZE + selected + 1).padStart(3, "0")}</p>
      <h2>{chosen.title}</h2><p>{chosen.artist}</p>{metadata}
      <div className="rhine-history-actions">{play}<button disabled={props.busy} onClick={() => props.onEnqueue(chosen)}><Icon name="queue" size={16} />加入本地队列</button></div>
      <div className="rhine-local-detail-tools"><button className="rhine-back" onClick={props.onDeck}>进入磁带机 ↗</button>
        <button className="rhine-back rhine-local-delete" data-armed={props.armedDeleteId === chosen.id} disabled={props.busy} onClick={() => props.onDelete(chosen)}>{props.armedDeleteId === chosen.id ? `确认删除《${chosen.title}》` : "删除歌曲"}</button>
      </div>
    </section> : <section className="rhine-selection rhine-history-selection rhine-history-glass" aria-label="当前选中本地曲目">
      <i className="rhine-history-screw" aria-hidden="true" /><i className="rhine-history-screw" aria-hidden="true" />
      <div className="rhine-history-panel-label"><span>LOCAL TAPE / 本地磁带</span><span>{String(currentPage * PAGE_SIZE + selected + 1).padStart(3, "0")} / {String(visibleTracks.length).padStart(3, "0")}</span></div>
      <div className="rhine-history-song-head"><SongCover title={chosen.title} /><div><h2>{chosen.title}</h2>{chosen.artist}</div></div><div className="rhine-history-ruler" aria-hidden="true" />{metadata}
      <div className="rhine-history-actions">{play}<button onClick={() => open(selected)}><Icon name="up" size={16} />抽取磁带</button></div>
    </section>)}
    <footer className="rhine-catalog rhine-history-footer" hidden={detail && !!chosen}>
      <div className="rhine-card-list" aria-label="选择本地歌曲">{rows.map((track, index) => <button key={track.id} aria-label={`选择 ${track.title}`} aria-pressed={index === selected} onClick={() => select(index)} onDoubleClick={() => open(index)}><SongCover title={track.title} /><span className="rhine-history-card-copy"><strong>{track.title}</strong><small>{track.artist} · {track.format.toUpperCase()}</small></span></button>)}</div>
      <div className="rhine-history-bottom"><span role="status">{props.notice || (props.warningCount ? `有 ${props.warningCount} 个文件未能加入可播放列表` : "拖动浏览 · 双击抽取")}</span><nav className="rhine-pages" aria-label="本地音乐分页"><button disabled={currentPage === 0 || props.busy} onClick={() => turn(-1)}>上一页</button><span>第 {currentPage + 1} / {pages} 页</span><button disabled={currentPage + 1 >= pages || props.busy} onClick={() => turn(1)}>下一页</button></nav></div>
    </footer>
    {detail && <p className="rhine-history-detail-notice" role="status">{props.notice}</p>}
    <div className="rhine-history-transport"><NowPlaying onOpen={props.onDeck} /></div>
  </section>;
}
