import { useEffect, useRef, useState } from "react";
import { changeCollections, previewQueue, switchQueue } from "../../backend/personalAdapter";
import { playbackSessionIdentity, subscribePlaybackConnection } from "../../backend/playbackTransport";
import { usePlayerSelector } from "../player/playerStore";
import { useCollections } from "./useCollections";

const savedTime = (ms?: number) => ms ? new Date(ms).toLocaleString() : "保存时间未知";
export function SavedQueues({ compact = false }: { compact?: boolean }) {
  const { data, error, refresh } = useCollections();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewQueue>> | null>(null);
  const [previewName, setPreviewName] = useState("");
  const [page, setPage] = useState(1);
  const pending = useRef(false);
  const queue = usePlayerSelector(s => s.queue);
  useEffect(refresh, [queue, refresh]);
  useEffect(() => { setPreview(null); }, [selected]);
  useEffect(() => subscribePlaybackConnection(() => { setPreview(null); setSelected(""); setNotice(""); }), []);
  const exists = !!data?.queues.some(q => q.name === name.trim());
  const chosen = data?.queues.find(q => q.name === selected);
  async function run(action: () => Promise<unknown>, message: string) {
    if (pending.current) return;
    const identity = playbackSessionIdentity();
    pending.current = true; setBusy(true); setNotice("");
    try { await action(); if (identity === playbackSessionIdentity()) { setNotice(message); refresh(); } }
    catch { if (identity === playbackSessionIdentity()) setNotice("操作未完成：请检查名称是否重复、队列容量或连接后重试"); }
    finally { pending.current = false; setBusy(false); }
  }
  async function inspect(name?: string) {
    const identity = playbackSessionIdentity();
    const value = await previewQueue(name);
    if (identity === playbackSessionIdentity()) { setPreview(value); setPreviewName(name ?? "上一份队列"); setPage(1); }
  }
  return <section className={`saved-queues${compact ? " saved-queues--compact" : ""}`} aria-label="保存的播放队列"><details open={!compact}><summary>保存的播放队列</summary>
    <form onSubmit={e => { e.preventDefault(); void run(() => changeCollections({ action: "saveQueue", name: name.trim() }), exists ? "已更新保存的队列" : "已保存当前队列"); }}>
      <input aria-label="队列名称" maxLength={40} placeholder="工作、通勤…" value={name} onChange={e => setName(e.target.value)} />
      <button type="submit" disabled={busy || !data || !name.trim() || !queue.length}>{exists ? "更新同名队列" : "保存当前队列"}</button>
    </form>
    <div className="personal-actions"><select aria-label="选择保存的队列" value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}><option value="">选择队列</option>{data?.queues.map(q => <option key={q.name} value={q.name}>{q.name} · {q.count} 首</option>)}</select>
      <button type="button" disabled={busy || !chosen} onClick={() => void run(() => inspect(selected), "")}>预览队列</button>
      <button type="button" disabled={busy || !chosen} onClick={() => void run(() => switchQueue(selected), "队列已切换，点击播放开始收听")}>切换队列</button>
      <button type="button" disabled={busy || !chosen || !name.trim() || exists} onClick={() => void run(async () => { await changeCollections({ action: "renameQueue", name: selected, target: name.trim() }); setSelected(name.trim()); }, "队列已重命名")}>重命名为输入名称</button>
      <button type="button" disabled={busy || !chosen} onClick={() => void run(async () => { await changeCollections({ action: "deleteQueue", name: selected }); setPreview(null); setSelected(""); }, "已删除保存的队列，可撤销最近一次删除")}>删除保存</button>
    </div>
    {chosen && <p>{chosen.count} 首 · {savedTime(chosen.savedAtMs)}</p>}
    {data?.deletedQueue && <p>最近删除：{data.deletedQueue} <button type="button" disabled={busy} onClick={() => void run(() => changeCollections({ action: "undoDeleteQueue" }), "已撤销删除")}>撤销删除</button></p>}
    <div className="personal-actions"><button type="button" disabled={busy || !data?.hasPrevious} onClick={() => void run(() => inspect(), "")}>预览上一份</button><button type="button" disabled={busy || !data?.hasPrevious} onClick={() => void run(() => switchQueue(), "已恢复上一份队列")}>恢复上一份队列</button></div>
    {data?.previous && <p>上一份：{data.previous.count} 首 · {savedTime(data.previous.savedAtMs)}</p>}
    {preview && <div className="queue-preview" aria-label="队列预览"><h3>{previewName} · {preview.items.length} 首</h3><p>{savedTime(preview.savedAtMs)} · 预览不改变播放</p>
      <ol start={(page - 1) * 20 + 1}>{preview.items.slice((page - 1) * 20, page * 20).map((track, i) => <li key={track.id}>{track.title} · {track.artist}{preview.selectedIndex === (page - 1) * 20 + i && "（保存时选中）"}</li>)}</ol>
      {!preview.items.length && <p>这是一份空队列</p>}
      <nav className="personal-actions" aria-label="队列预览分页"><button type="button" disabled={page === 1} onClick={() => setPage(p => p - 1)}>上一页</button><span>第 {page} 页</span><button type="button" disabled={page * 20 >= preview.items.length} onClick={() => setPage(p => p + 1)}>下一页</button><button type="button" onClick={() => setPreview(null)}>关闭预览</button></nav>
    </div>}
    {!compact && <p>队列切换后暂停，保留保存时选中的歌曲；当前队列替换或清空后可恢复上一份。</p>}
    {error && <p role="alert">保存的队列读取失败 <button onClick={refresh} type="button">重试</button></p>}{notice && <p role="status">{notice}</p>}
  </details></section>;
}
