import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { localCatalog, type CatalogRequest, type CatalogStatus, type ImportMode } from "../../backend/localCatalogAdapter";
import "./local-music-manager.css";

const failureLabels: Record<string, string> = {
  local_music_invalid_file: "文件或目录无法访问",
  local_music_unsupported_format: "不支持的音频格式",
  local_music_file_too_large: "文件超过 4 GiB",
  local_music_metadata_unreadable: "无法读取音频信息，文件可能损坏",
  local_music_codec_unavailable: "设备缺少对应的 OGG 解码器",
  local_music_copy_failed: "复制失败，请检查空间和目录权限",
  local_music_storage_unavailable: "应用媒体目录不可写",
  local_music_storage_conflict: "目录或其他操作发生冲突",
};

export default function LocalMusicManager({ onChanged, disabled = false }: { onChanged: () => Promise<void>; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [mode, setMode] = useState<ImportMode>("reference");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [armed, setArmed] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const revision = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    const version = revision.current;
    try {
      const result = await localCatalog({ action: "status" });
      if (mounted.current && version === revision.current) setStatus(result);
    } catch { if (mounted.current) setNotice("目录信息暂时无法读取，请重试。"); }
  }, []);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await refresh();
      if (active) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [open, refresh]);
  function close() { dialog.current?.close(); setOpen(false); setArmed(""); trigger.current?.focus(); }
  async function run(request: CatalogRequest) {
    if (request.action !== "cancel") setBusy(true);
    setNotice(""); setArmed(""); revision.current++;
    try {
      const result = await localCatalog(request);
      revision.current++;
      if (!mounted.current) {
        if (request.action !== "cancel") window.dispatchEvent(new Event("local-music-updated"));
        return;
      }
      setStatus(result);
      if (request.action !== "cancel") {
        await onChanged();
        setNotice(request.action === "remove" ? "目录索引已移除，原文件和已复制的音乐均保留。"
          : result.scan.cancelled ? "扫描已取消；本轮索引未提交，已完成的复制文件保留。"
          : result.scan.directoryId ? "扫描结束，曲库已刷新。" : "未选择目录。");
      }
    } catch (error) {
      if (mounted.current) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
        setNotice(code === "local_music_storage_conflict" ? "该目录已添加、与现有目录重叠，或另一个导入正在运行。请选择其他目录或稍后重试。"
          : "操作未完成。请检查目录是否可访问、应用目录是否可写，然后重新扫描。");
        await refresh();
      }
    } finally { if (mounted.current && request.action !== "cancel") setBusy(false); }
  }
  const scanning = status?.scan.running ?? false;
  const locked = busy || scanning || disabled;
  return <>
    <button ref={trigger} className="text-button local-manager-trigger" type="button" onClick={() => setOpen(true)}>管理音乐目录</button>
    {open && createPortal(<dialog ref={dialog} className="local-manager" aria-labelledby="local-manager-title" onCancel={event => { event.preventDefault(); close(); }}>
      <header><div><span className="section-label">LOCAL COLLECTION</span><h2 id="local-manager-title">音乐目录</h2></div><button type="button" onClick={close} aria-label="关闭目录管理">关闭</button></header>
      <p>从已有文件夹建立曲库。扫描只在手动添加、重新定位或重新扫描时运行。</p>
      <div className="local-manager-import"><label>目录导入方式<select value={mode} disabled={locked} onChange={e => setMode(e.target.value as ImportMode)}>
        <option value="reference">引用模式 · 不复制文件</option><option value="copy">复制模式 · 保存到应用媒体目录</option></select></label>
        <button type="button" disabled={locked} onClick={() => void run({ action: "add", mode })}>添加音乐目录</button></div>
      <p className="local-manager-hint">{mode === "reference" ? "保留文件原位置；移动文件夹后可用“重新定位”恢复关联。" : "音乐会复制到 EXE 旁的 local-music。原文件保留，需预留磁盘空间。"} 支持 MP3 / FLAC / OGG；跳过链接目录。</p>
      <div className="local-manager-directories">{status?.directories.map(directory => <section key={directory.id} className="local-manager-directory" aria-label={directory.path}>
        <strong title={directory.path}>{directory.path.replace(/^\\\\\?\\/u, "")}</strong>
        <p>{directory.mode === "reference" ? "引用" : "复制"} · {directory.available ? "目录可用" : "目录失效"} · {directory.trackCount} 首{directory.missingCount > 0 ? ` · ${directory.missingCount} 个文件待修复` : ""}</p>
        <small>上次扫描：{directory.lastScanMs === null ? "尚未完成" : new Date(directory.lastScanMs).toLocaleString("zh-CN")}</small>
        <div className="local-manager-actions"><button disabled={locked} onClick={() => void run({ action: "scan", id: directory.id })}>重新扫描</button>
          <button disabled={locked} onClick={() => void run({ action: "relocate", id: directory.id })}>重新定位</button>
          <button disabled={locked} onClick={() => armed === directory.id ? void run({ action: "remove", id: directory.id }) : setArmed(directory.id)}>{armed === directory.id ? "确认仅移除索引" : "移除目录"}</button></div>
      </section>)}</div>
      {status?.directories.length === 0 && <p className="local-manager-empty">还没有添加目录。原有复制导入的音乐继续保留在曲库。</p>}
      {status && (status.scan.running || status.scan.directoryId) && <section className="local-manager-progress" aria-label="扫描进度">
        <p role="status">{scanning ? "正在扫描" : status.scan.cancelled ? "已取消" : "扫描结束"} · 已处理 {status.scan.processed} · 新增 {status.scan.added} · 复用 {status.scan.existing} · 错误 {status.scan.errors}</p>
        {scanning && <button type="button" onClick={() => void run({ action: "cancel" })}>取消扫描</button>}
        {status.scan.errors > 0 && <details><summary>查看错误记录（最多显示 100 项）</summary><ul>{status.scan.failures.map((failure, index) => <li key={index}>{failure.fileName} — {failureLabels[failure.code] ?? "无法处理，请检查文件后重新扫描"}</li>)}</ul></details>}
      </section>}
      <p role="status">{notice || (busy && !scanning ? "正在等待目录选择或处理请求…" : "移除目录仅删除索引，不会删除原文件或复制文件。")}</p>
    </dialog>, document.body)}
  </>;
}
