import { useEffect, useState } from "react";
import { SongArtistLinks } from "../artist/SongArtistLinks";
import { getPlaybackHistory, type HistoryEntry } from "../../backend/historyAdapter";
import { playHistoryEntry } from "../player/historyPlayback";
import { usePlayerSelector } from "../player/playerStore";
import "./playback-history.css";

const PAGE_SIZE = 20;
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

export default function PlaybackHistory() {
  const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const generation = usePlayerSelector((state) => state.generation);
  const [entries, setEntries] = useState<readonly HistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!native) return;
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const rows = await getPlaybackHistory();
        if (active) { setEntries(rows); setFailed(false); }
      } catch { if (active) setFailed(true); }
      finally { pending = false; }
    }
    void refresh();
    // Also catches the history commit that follows the native generation update.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [native, generation, retry]);

  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const filtered = (entries ?? []).filter((entry) => `${entry.title} ${entry.artist}`.toLocaleLowerCase("zh-CN").includes(normalized));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  async function play(entry: HistoryEntry) {
    if (busy) return;
    setBusy(true); setNotice("");
    try { await playHistoryEntry(entry); }
    catch { setNotice("这首历史歌曲暂时无法播放，请检查网络或本地文件是否仍存在。"); }
    finally { setBusy(false); setRetry((value) => value + 1); }
  }

  return <section className="catalog-pane playback-history" aria-label="本地播放历史">
    <header className="catalog-pane__header"><div><h1>最近播放</h1><p>仅保存在这台设备 · 同一首歌显示最近一次播放</p></div>
      <button type="button" className="text-button" disabled={!native} onClick={() => setRetry((value) => value + 1)}>刷新历史</button>
    </header>
    <label className="catalog-search"><span className="sr-only">搜索本地历史</span><input type="search" placeholder="搜索历史歌曲或歌手" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></label>
    {notice && <p role="alert">{notice}</p>}
    {!native ? <div className="catalog-empty"><p>请在桌面版查看本地播放历史</p></div>
      : failed ? <div className="catalog-empty" role="alert"><p>本地历史读取失败</p><button className="text-button" onClick={() => setRetry((value) => value + 1)} type="button">重新读取历史</button></div>
      : entries === null ? <div className="catalog-empty" role="status"><p>正在读取本地历史…</p></div>
      : visible.length === 0 ? <div className="catalog-empty"><p>{normalized ? "没有找到匹配的历史歌曲" : "还没有播放记录"}</p><span>{normalized ? "试试其他歌曲名或歌手。" : "播放歌曲后会自动记录，无需登录即可查看。"}</span></div>
      : <><div className="catalog-table-wrap"><table className="catalog-table"><thead><tr><th scope="col">歌曲</th><th scope="col">歌手</th><th scope="col">最近播放</th><th scope="col">操作</th></tr></thead>
        <tbody>{visible.map((entry) => <tr key={entry.id}><td>{entry.title}</td><td><SongArtistLinks track={entry} /></td><td><time dateTime={new Date(entry.playedAtUnixMs).toISOString()}>{dateFormat.format(entry.playedAtUnixMs)}</time></td><td><button type="button" className="text-button" disabled={busy} aria-label={`播放 ${entry.title}`} onClick={() => void play(entry)}>播放</button></td></tr>)}</tbody>
      </table></div><nav className="playback-history__pages" aria-label="历史分页"><button type="button" className="text-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {pages} · {filtered.length} 首</span><button type="button" className="text-button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button></nav></>}
  </section>;
}
