import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hasPlaybackTransport } from "../../backend/playbackTransport";
import { updatesControl, type UpdateRequest, type UpdateSnapshot } from "../../backend/updateAdapter";
import "./update-settings.css";

const messages: Record<UpdateSnapshot["state"], string> = {
  idle: "可手动检查官方稳定版本。", checking: "正在检查更新…", available: "发现新的稳定版本。",
  upToDate: "暂无更新的稳定版本。", unavailable: "暂时无法检查更新，请确认网络后重试。",
  rateLimited: "GitHub 请求暂时受限，请稍后重试。", noRelease: "官方仓库暂未提供稳定发行版本。",
};

export default function UpdateSettings({ presentation = "normal" }: { presentation?: "normal" | "rhine" }) {
  const [open, setOpen] = useState(false), [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true), operation = useRef(false), revision = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal(); let active = true; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!operation.current) {
        const version = revision.current;
        try { const value = await updatesControl({ action: "status" }); if (active && version === revision.current) setSnapshot(value); }
        catch { if (active) setError("更新信息暂时无法读取，请重试。"); }
      }
      if (active) timer = setTimeout(() => void poll(), 1500);
    }
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [open]);
  async function run(request: UpdateRequest) {
    if (operation.current) return;
    operation.current = true; revision.current++; setBusy(true); setError("");
    try { const value = await updatesControl(request); if (mounted.current) setSnapshot(value); }
    catch { if (mounted.current) setError(request.action === "setAutomatic" ? "更新设置未能保存，请重试。" : request.action.startsWith("open") ? "未能打开浏览器，请稍后重试。" : "更新检查未完成，请重试。"); }
    finally { operation.current = false; revision.current++; if (mounted.current) setBusy(false); }
  }
  function close() { dialog.current?.close(); setOpen(false); trigger.current?.focus(); }
  if (!hasPlaybackTransport()) return null;
  const checking = busy || snapshot?.state === "checking";
  return <>
    <button ref={trigger} type="button" className={presentation === "rhine" ? "rhine-update-trigger" : undefined} role={presentation === "normal" ? "menuitem" : undefined} onClick={() => setOpen(true)}>版本与更新</button>
    {open && createPortal(<dialog className="update-dialog" ref={dialog} aria-labelledby="update-title" onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); close(); }}>
      <header><div><span>APPLICATION / RELEASES</span><h2 id="update-title">版本与更新</h2></div><button type="button" aria-label="关闭更新设置" onClick={close}>关闭</button></header>
      {snapshot ? <>
        <p className="update-version">QQMusic GUI <strong>{snapshot.currentVersion}</strong><small>{snapshot.buildChannel === "Debug" ? "Debug · 开发测试版本" : "Release · 发行构建"}</small></p>
        <label className="update-auto"><input type="checkbox" checked={snapshot.automatic} disabled={checking} onChange={e => void run({ action: "setAutomatic", enabled: e.target.checked })} />启动后检查更新</label>
        <p className="update-muted">仅查询官方稳定版本；启动后在后台检查，播放照常进行。</p>
        <div className="update-actions"><button type="button" disabled={checking} onClick={() => void run({ action: "check" })}>{checking ? "正在检查…" : "检查新版本"}</button><button type="button" disabled={busy} onClick={() => void run({ action: "openReleases" })}>官方发行页面 ↗</button></div>
        <p role="status">{messages[snapshot.state]}</p>
        {snapshot.checkedMs !== null && <small>最近检查：{new Date(snapshot.checkedMs).toLocaleString("zh-CN")}</small>}
        {snapshot.release && <section className="update-release" aria-label="官方更新日志"><div><h3>{snapshot.release.name}</h3><small>稳定版 {snapshot.release.version}{snapshot.release.publishedAt ? ` · ${snapshot.release.publishedAt.slice(0, 10)}` : ""}</small></div>
          <p className="update-source">来源：GitHub · zhazhongshizi/qqmusic-gui{snapshot.state === "unavailable" || snapshot.state === "rateLimited" || snapshot.state === "noRelease" ? " · 上次成功读取的发行信息" : ""}</p>
          <pre>{snapshot.release.notes || "此版本没有附带更新说明。"}</pre><button type="button" disabled={busy} onClick={() => void run({ action: "openRelease" })}>打开此版本发行页 ↗</button>
        </section>}
        <details className="update-data"><summary>升级前的数据位置与迁移说明</summary>
          <dl><dt>设置、队列与收听记录</dt><dd>{snapshot.applicationData}</dd><dt>本地音乐及目录索引</dt><dd>{snapshot.localMusic}</dd><dt>智能随机记录</dt><dd>{snapshot.smartShuffle}</dd><dt>数据库升级前快照</dt><dd>{snapshot.migrationBackups}</dd></dl>
          <p>关闭程序后，将新发行包解压到原位置并替换程序文件。保留应用数据目录、local-music 和智能随机记录；外部音乐引用应保留原路径，移动后可在目录管理中重新定位。</p>
          <p>已有数据库需要升级时会先询问，再保存安全快照并迁移。升级后的数据库可能无法由旧版本读取；迁移失败时保留原数据。安全快照只保护数据库，不包含外部音频文件。</p>
        </details>
      </> : <p role="status">正在读取版本信息…</p>}
      {error && <p role="alert">{error}</p>}
    </dialog>, document.body)}
  </>;
}

export function UpdateNotice() {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null), [dismissed, setDismissed] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!hasPlaybackTransport()) return;
    let active = true, running = false, queued = false; let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (running) { queued = true; return; } running = true; clearTimeout(timer);
      try { const value = await updatesControl({ action: "status" }); if (active) { setSnapshot(value); if (value.automatic || value.state === "checking") timer = setTimeout(() => void refresh(), value.checkedMs === null || value.state === "checking" ? 2000 : 60000); } }
      catch { /* Offline or unavailable update service must not affect playback. */ }
      finally { running = false; if (active && queued) { queued = false; void refresh(); } }
    }
    const changed = () => { void refresh(); }; void refresh(); window.addEventListener("updates-changed", changed);
    return () => { active = false; clearTimeout(timer); window.removeEventListener("updates-changed", changed); };
  }, []);
  if (snapshot?.state !== "available" || !snapshot.release || dismissed === snapshot.release.version) return null;
  return createPortal(<aside className="update-notice" aria-label="新版本提示"><p role="status">新稳定版 {snapshot.release.version} 已发布</p><div><button type="button" onClick={() => { setError(false); void updatesControl({ action: "openRelease" }).catch(() => setError(true)); }}>查看官方发行页 ↗</button><button type="button" onClick={() => setDismissed(snapshot.release!.version)}>稍后</button></div>{error && <p role="status">未能打开浏览器，请在设置中重试。</p>}</aside>, document.body);
}
