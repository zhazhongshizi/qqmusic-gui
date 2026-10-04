import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface LoggingStatus { enabled: boolean; error: string | null }

export function LoggingSettings() {
  const native = "__TAURI_INTERNALS__" in window;
  const [status, setStatus] = useState<LoggingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!native) return;
    let active = true;
    const refresh = () => {
      void invoke<LoggingStatus>("logging_status").then((value) => {
        if (active) { setStatus(value); setError(""); }
      }, () => { if (active) setError("日志状态读取失败，请重新打开设置"); });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [native]);
  async function toggle() {
    if (!status) return;
    setBusy(true);
    setError("");
    try { setStatus(await invoke<LoggingStatus>("logging_set_enabled", { enabled: !status.enabled })); }
    catch { setError("日志开关保存失败，请检查软件目录写入权限和磁盘空间"); }
    finally { setBusy(false); }
  }
  if (!native) return null;
  return <>
    <div className="fixture-menu__divider" role="separator" />
    <span className="section-label">问题排查</span>
    <button type="button" role="menuitemcheckbox" aria-checked={status?.enabled ?? false}
      disabled={busy || !status} onClick={() => void toggle()}>
      <span>{busy ? "正在保存…" : "诊断日志"}</span><i aria-hidden="true" />
    </button>
    <span className="section-label">日志保存在 exe 同目录的 logs 文件夹，最多约 2 MB。开关会记住；关闭后保留已有日志。</span>
    {error || status?.error ? <span className="fixture-menu__error" role="alert">{error || status?.error}</span> : null}
  </>;
}
